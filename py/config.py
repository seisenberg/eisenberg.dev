"""Settings for the eisenmail inbound Lambda. Everything comes from environment variables;
there are no secrets, hostnames or addresses in code.

Required
    FORWARD_TO              comma list: the owner's private mailbox(es) forwards are sent to
    MAIL_BUCKET             S3 bucket the SES receipt rule stores raw mail in
    POSTGRES_DB_HOST        database host (with a tunnel: the host as seen FROM the SSH server,
                            usually 127.0.0.1)
    POSTGRES_DB_NAME, POSTGRES_DB_USER
    POSTGRES_DB_PASSWORD    the database password, or
    POSTGRES_DB_PASSWORD_SSM  name of an SSM SecureString holding it (preferred: no secret in the
                            Lambda environment); exactly one of the two

Optional
    OWNER_ADDRESSES         comma list allowed to use the reply relay (default: FORWARD_TO)
    MAIL_PREFIX             S3 key prefix (default "email-inbox/"); key = prefix + SES messageId
    MAIL_DOMAINS            comma list of our receiving domains; first = fallback domain
    POSTGRES_DB_PORT        default 5432
    POSTGRES_DB_SSLMODE     passed to libpq when set
    SSH_TUNNEL_HOST         when set, the database is reached through an SSH tunnel
    SSH_TUNNEL_PORT         default 22
    SSH_TUNNEL_USER         required with SSH_TUNNEL_HOST
    SSH_TUNNEL_KEY_SSM      SSM SecureString parameter holding the private key (preferred)
    SSH_TUNNEL_KEY_PATH     private key file (legacy); exactly one of the two key sources
    SSH_TUNNEL_HOST_KEY     pinned server public key, known_hosts format ("ssh-ed25519 AAAA...");
                            required with a tunnel unless SSH_TUNNEL_ALLOW_UNPINNED=1
    VAPID_PRIVATE_KEY       Web Push: base64url of the raw 32-byte P-256 private key (the format
                            the node `web-push` package generates). Push is off without a key.
    VAPID_PRIVATE_KEY_SSM   SSM SecureString holding the same; at most one of the two
    VAPID_SUBJECT           "mailto:..." or "https://..." contact for the push services
                            (default mailto:postmaster@<first MAIL_DOMAINS entry, else alias domain>)
    PUSH_ENDPOINT_ALLOW     comma list of extra allowed push host suffixes (tests / self-hosted)
    RECONCILE_MAX_AGE_HOURS scheduled replay looks at stored mail up to this old (default 72)
    RECONCILE_BATCH         at most this many messages are replayed per run (default 25)

No longer a setting: FORWARD_STYLE. The forward layout is a per-address rule now
(address_rules.forward_style, default from mail_settings.default_forward_style, edited in the
webmail). A leftover FORWARD_STYLE variable is ignored with one warning.
"""
from __future__ import annotations

import base64
import binascii
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Mapping, Optional, Tuple

log = logging.getLogger("eisenmail.config")
_warned_forward_style = False


class ConfigError(RuntimeError):
    """A required setting is missing or a setting has an invalid value."""


@dataclass(frozen=True)
class DbConfig:
    host: str
    port: int
    name: str
    user: str
    password: Optional[str] = field(default=None, repr=False)
    sslmode: Optional[str] = None
    password_ssm: Optional[str] = None      # SSM SecureString name; fetched at first connect

    def __post_init__(self):
        if self.password and self.password_ssm:
            raise ConfigError("set exactly one of POSTGRES_DB_PASSWORD / POSTGRES_DB_PASSWORD_SSM")


@dataclass(frozen=True)
class TunnelConfig:
    host: str
    user: str
    port: int = 22
    key_ssm: Optional[str] = None
    key_path: Optional[str] = None
    host_key: Optional[str] = None


@dataclass(frozen=True)
class PushConfig:
    """Web Push settings. Exists only when a VAPID key (or its SSM parameter) is configured."""
    vapid_private_key: Optional[str] = field(default=None, repr=False)
    vapid_private_key_ssm: Optional[str] = None
    subject: Optional[str] = None
    endpoint_allow: Tuple[str, ...] = ()

    def __post_init__(self):
        if bool(self.vapid_private_key) == bool(self.vapid_private_key_ssm):
            raise ConfigError("set exactly one of VAPID_PRIVATE_KEY / VAPID_PRIVATE_KEY_SSM to enable push")
        if self.vapid_private_key and not is_vapid_private_key(self.vapid_private_key):
            raise ConfigError("VAPID_PRIVATE_KEY must be the base64url of a raw 32-byte P-256 private key")
        if self.subject is not None and not re.match(r"^(mailto:[^\s@]+@[^\s@]+|https://\S+)$", self.subject):
            raise ConfigError("VAPID_SUBJECT must be a mailto: or https:// URI")
        for suffix in self.endpoint_allow:
            if not re.match(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$", suffix):
                raise ConfigError("PUSH_ENDPOINT_ALLOW must be a comma list of host names")


def is_vapid_private_key(value: str) -> bool:
    """True for the base64url (padding optional) encoding of exactly 32 bytes."""
    text = value.strip()
    if not re.match(r"^[A-Za-z0-9_-]+=*$", text):
        return False
    try:
        raw = base64.urlsafe_b64decode(text.rstrip("=") + "=" * (-len(text.rstrip("=")) % 4))
    except (binascii.Error, ValueError):
        return False
    return len(raw) == 32


@dataclass(frozen=True)
class Config:
    forward_to: Tuple[str, ...]
    mail_bucket: str
    owner_addresses: Tuple[str, ...] = ()
    mail_prefix: str = "email-inbox/"
    mail_domains: Tuple[str, ...] = ()
    db: Optional[DbConfig] = None
    tunnel: Optional[TunnelConfig] = None
    push: Optional[PushConfig] = None
    reconcile_max_age_hours: int = 72
    reconcile_batch: int = 25

    def __post_init__(self):
        if not self.forward_to:
            raise ConfigError("FORWARD_TO must contain at least one address")
        if not self.owner_addresses:
            object.__setattr__(self, "owner_addresses", tuple(self.forward_to))
        for address in self.forward_to:
            if address.rpartition("@")[2].lower() in self.mail_domains:
                # the forward would be received by this Lambda again and forwarded again, forever
                raise ConfigError("FORWARD_TO must not contain an address in one of MAIL_DOMAINS (mail loop)")

    @property
    def private_addresses(self) -> Tuple[str, ...]:
        """Every address that must never reach a correspondent (owner + forward targets)."""
        seen = dict.fromkeys(self.owner_addresses + self.forward_to)
        return tuple(seen)

    @property
    def fallback_domain(self) -> Optional[str]:
        return self.mail_domains[0] if self.mail_domains else None


def _list(value: Optional[str]) -> Tuple[str, ...]:
    """Comma list -> lowercased, de-duplicated tuple (order kept)."""
    items = [item.strip().lower() for item in (value or "").split(",")]
    return tuple(dict.fromkeys(item for item in items if item))


def _require(env: Mapping[str, str], name: str) -> str:
    value = (env.get(name) or "").strip()
    if not value:
        raise ConfigError(f"missing required environment variable {name}")
    return value


def _optional(env: Mapping[str, str], name: str) -> Optional[str]:
    value = (env.get(name) or "").strip()
    return value or None


def _port(env: Mapping[str, str], name: str, default: int) -> int:
    raw = _optional(env, name)
    if raw is None:
        return default
    try:
        port = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a port number") from None
    if not 0 < port < 65536:
        raise ConfigError(f"{name} must be a port number")
    return port


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = _optional(env, name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a positive whole number") from None
    if value < 1:
        raise ConfigError(f"{name} must be a positive whole number")
    return value


def _addresses(env: Mapping[str, str], name: str, required: bool) -> Tuple[str, ...]:
    values = _list(env.get(name))
    if required and not values:
        raise ConfigError(f"missing required environment variable {name}")
    for value in values:
        local, _, domain = value.rpartition("@")
        if not local or not domain or any(ch.isspace() for ch in value):
            raise ConfigError(f"{name} contains an invalid address")
    return values


def load(env: Optional[Mapping[str, str]] = None) -> Config:
    """Build the Config from the environment. Raises ConfigError on missing/invalid settings."""
    global _warned_forward_style
    env = os.environ if env is None else env

    if _optional(env, "FORWARD_STYLE") and not _warned_forward_style:
        _warned_forward_style = True
        log.warning(
            "FORWARD_STYLE is ignored: the forward style is now set per address in the webmail "
            "(address_rules.forward_style, default mail_settings.default_forward_style)"
        )

    db_password = _optional(env, "POSTGRES_DB_PASSWORD")
    db_password_ssm = _optional(env, "POSTGRES_DB_PASSWORD_SSM")
    if bool(db_password) == bool(db_password_ssm):
        raise ConfigError("set exactly one of POSTGRES_DB_PASSWORD / POSTGRES_DB_PASSWORD_SSM")

    forward_to = _addresses(env, "FORWARD_TO", required=True)
    owner_addresses = _addresses(env, "OWNER_ADDRESSES", required=False) or forward_to

    db = DbConfig(
        host=_require(env, "POSTGRES_DB_HOST"),
        port=_port(env, "POSTGRES_DB_PORT", 5432),
        name=_require(env, "POSTGRES_DB_NAME"),
        user=_require(env, "POSTGRES_DB_USER"),
        password=db_password,
        sslmode=_optional(env, "POSTGRES_DB_SSLMODE"),
        password_ssm=db_password_ssm,
    )

    tunnel = None
    tunnel_host = _optional(env, "SSH_TUNNEL_HOST")
    if tunnel_host:
        key_ssm = _optional(env, "SSH_TUNNEL_KEY_SSM")
        key_path = _optional(env, "SSH_TUNNEL_KEY_PATH")
        if bool(key_ssm) == bool(key_path):
            raise ConfigError(
                "set exactly one of SSH_TUNNEL_KEY_SSM / SSH_TUNNEL_KEY_PATH when SSH_TUNNEL_HOST is set"
            )
        tunnel_user = _require(env, "SSH_TUNNEL_USER")
        host_key = _optional(env, "SSH_TUNNEL_HOST_KEY")
        if not host_key and _optional(env, "SSH_TUNNEL_ALLOW_UNPINNED") != "1":
            # Without a pinned key anyone on the network path can impersonate the tunnel host and
            # capture the database password.
            raise ConfigError(
                "SSH_TUNNEL_HOST_KEY is required with SSH_TUNNEL_HOST "
                "(ssh-keyscan -t ed25519 <host>); set SSH_TUNNEL_ALLOW_UNPINNED=1 to override"
            )
        tunnel = TunnelConfig(
            host=tunnel_host,
            port=_port(env, "SSH_TUNNEL_PORT", 22),
            user=tunnel_user,
            key_ssm=key_ssm,
            key_path=key_path,
            host_key=host_key,
        )

    push = None
    vapid_key = _optional(env, "VAPID_PRIVATE_KEY")
    vapid_key_ssm = _optional(env, "VAPID_PRIVATE_KEY_SSM")
    if vapid_key and vapid_key_ssm:
        raise ConfigError("set at most one of VAPID_PRIVATE_KEY / VAPID_PRIVATE_KEY_SSM")
    if vapid_key or vapid_key_ssm:
        push = PushConfig(
            vapid_private_key=vapid_key,
            vapid_private_key_ssm=vapid_key_ssm,
            subject=_optional(env, "VAPID_SUBJECT"),
            endpoint_allow=_list(env.get("PUSH_ENDPOINT_ALLOW")),
        )

    prefix = env.get("MAIL_PREFIX")
    return Config(
        forward_to=forward_to,
        owner_addresses=owner_addresses,
        mail_bucket=_require(env, "MAIL_BUCKET"),
        mail_prefix="email-inbox/" if prefix is None else prefix.strip(),
        mail_domains=_list(env.get("MAIL_DOMAINS")),
        db=db,
        tunnel=tunnel,
        push=push,
        reconcile_max_age_hours=_positive_int(env, "RECONCILE_MAX_AGE_HOURS", 72),
        reconcile_batch=_positive_int(env, "RECONCILE_BATCH", 25),
    )
