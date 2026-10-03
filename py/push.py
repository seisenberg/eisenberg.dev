"""Web Push notifications for stored inbound mail.

`PushNotifier.notify()` sends one small JSON payload to every row of push_subscriptions (written
by the node backend) and records the result per subscription:

    2xx                 last_success_at = now(), failure_count = 0
    404 / 410           the subscription is gone: row deleted
    anything else       failure_count + 1   (other statuses, timeouts, connection/encryption errors)

Safety properties
* SSRF: an endpoint is only ever requested when it is https, has no userinfo, and its host is (a
  subdomain of) one of the known push services or a PUSH_ENDPOINT_ALLOW suffix. Everything else
  is skipped and logged. Redirects are never followed.
* Scoped: a subscription belongs to a webmail user. An owner is notified of everything; a member
  only of mail to one of its domains, and its badge (unread count) only counts those domains.
  Subscriptions of users that no longer exist are deleted.
* Bounded: at most MAX_SUBSCRIPTIONS per message, REQUEST_TIMEOUT per request, TIME_BUDGET overall.
* Quiet: payloads, keys and full endpoints are never logged (the endpoint path is the secret that
  lets anyone push to that browser); only the host is.

The network call sits behind an injectable `send(subscription, payload, *, subject, ttl, timeout)
-> HTTP status` so tests can fake it. The real one (PywebpushSender) imports pywebpush lazily, so
this module imports without it.
"""
from __future__ import annotations

import inspect
import json
import logging
import re
import time
from typing import Any, Callable, Dict, Iterable, Mapping, Optional, Sequence, Union
from urllib.parse import quote

import relay
from config import PushConfig, is_vapid_private_key

log = logging.getLogger("eisenmail.push")

ALLOWED_HOST_SUFFIXES = (
    "push.apple.com",                       # Safari / iOS web apps
    "fcm.googleapis.com",                   # Chrome, Edge (Chromium), Android
    "updates.push.services.mozilla.com",    # Firefox
    "notify.windows.com",                   # Edge legacy / Windows
)
TTL_SECONDS = 86400
REQUEST_TIMEOUT = 5.0
MAX_SUBSCRIPTIONS = 40          # overall ceiling per message
MAX_PER_USER = 5                # so one user's subscriptions cannot crowd out another's
TIME_BUDGET = 12.0
MAX_PAYLOAD_BYTES = 2000
TITLE_MAX = 80
BODY_MAX = 140
BADGE_MAX = 9999

# scheme://host[:port]/path with a strict host alphabet: no userinfo, no backslashes, no
# whitespace, so every URL parser agrees on which host this is.
_ENDPOINT_RE = re.compile(r"^(https?)://([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::([0-9]{1,5}))?/[!-\[\]-~]*$")
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost")


class PushUnavailable(RuntimeError):
    """Push cannot work at all right now (no usable VAPID key). Not the subscription's fault."""


# --------------------------------------------------------------------------------------------
# endpoint allow-list
# --------------------------------------------------------------------------------------------
def endpoint_host(endpoint: Any) -> str:
    """Host of an endpoint for log lines; never the path."""
    m = _ENDPOINT_RE.match(str(endpoint or ""))
    return m.group(2).lower() if m else "(malformed)"


def _host_in(host: str, suffixes: Sequence[str]) -> bool:
    return any(host == s or host.endswith("." + s) for s in (x.strip(".").lower() for x in suffixes) if s)


def check_endpoint(endpoint: Any, extra_suffixes: Sequence[str] = (), *, allow_insecure_loopback: bool = False) -> Optional[str]:
    """None when the endpoint may be requested, otherwise the reason it may not.

    `allow_insecure_loopback` exists for the test-suite only: it permits plain http, and only to
    127.0.0.1 / localhost, and only when that host is also listed in `extra_suffixes`. It is a
    constructor argument of PushNotifier that no configuration or environment variable sets."""
    m = _ENDPOINT_RE.match(str(endpoint or ""))
    if not m:
        return "malformed endpoint"
    scheme, host, port = m.group(1).lower(), m.group(2).lower(), m.group(3)
    if ".." in host:
        return "malformed endpoint"
    builtin, extra = _host_in(host, ALLOWED_HOST_SUFFIXES), _host_in(host, extra_suffixes)
    if not (builtin or extra):
        return "host not allowed"
    if scheme != "https" and not (allow_insecure_loopback and extra and host in _LOOPBACK_HOSTS):
        return "not https"
    if port not in (None, "443") and not extra:
        return "port not allowed"
    return None


# --------------------------------------------------------------------------------------------
# payload
# --------------------------------------------------------------------------------------------
def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: max(limit - 1, 0)].rstrip() + "\N{HORIZONTAL ELLIPSIS}"


def build_payload(msg, alias: str, ses_message_id: str, badge: Optional[int] = None) -> str:
    """The notification JSON (always under MAX_PAYLOAD_BYTES of UTF-8).

    title = sender display name or address, body = subject; both go through the same cleaning
    as forwarded headers, so no control characters (CR/LF, NUL, escapes) can get in.
    `badge` (the subscriber's unread count, capped at BADGE_MAX) is left out when None."""
    title = relay.clean_display_name(relay.sender_label(msg), TITLE_MAX)
    body = _truncate(relay.clean_header_text(relay.header_value(msg, "Subject", ""), limit=4000), BODY_MAX)
    address = relay.clean_header_text(alias, limit=254)
    payload = {
        "title": title or "unknown sender",
        "body": body or "(no subject)",
        "address": address,
        "url": "/mail?box=inbox&address=" + quote(address, safe=""),
        "tag": relay.clean_header_text(ses_message_id, limit=128),
    }
    if badge is not None:
        payload["badge"] = max(0, min(int(badge), BADGE_MAX))

    def encode() -> str:
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))

    for field, floor in (("body", 20), ("title", 10)):
        while len(encode().encode("utf-8")) > MAX_PAYLOAD_BYTES and len(payload[field]) > floor:
            payload[field] = _truncate(payload[field], max(floor, len(payload[field]) - 16))
    if len(encode().encode("utf-8")) > MAX_PAYLOAD_BYTES:  # absurdly long address
        payload["address"], payload["url"] = "", "/mail?box=inbox"
    return encode()


# --------------------------------------------------------------------------------------------
# the real sender
# --------------------------------------------------------------------------------------------
def load_vapid_key(cfg: PushConfig) -> str:
    """The VAPID private key from the environment value or from SSM (SecureString)."""
    if cfg.vapid_private_key:
        key = cfg.vapid_private_key
    elif cfg.vapid_private_key_ssm:
        import boto3

        response = boto3.client("ssm").get_parameter(Name=cfg.vapid_private_key_ssm, WithDecryption=True)
        key = str(response["Parameter"]["Value"])
    else:
        raise PushUnavailable("no VAPID key configured")
    key = key.strip()
    if not is_vapid_private_key(key):
        raise PushUnavailable("the VAPID key is not the base64url of a raw 32-byte private key")
    return key


class PywebpushSender:
    """Encrypts (aes128gcm) and POSTs one notification with pywebpush; returns the HTTP status."""

    def __init__(self, key_loader: Callable[[], str]):
        self._key_loader = key_loader
        self._vapid = None
        self._session = None

    def _prepare(self):
        if self._vapid is None:
            try:
                key = self._key_loader()
                from py_vapid import Vapid

                self._vapid = Vapid.from_string(key)
            except PushUnavailable:
                raise
            except Exception as exc:
                raise PushUnavailable(f"cannot load the VAPID key ({type(exc).__name__})") from None
        if self._session is None:
            import requests

            class NoRedirectSession(requests.Session):
                def request(self, method, url, **kwargs):
                    kwargs["allow_redirects"] = False      # a push service never needs one
                    return super().request(method, url, **kwargs)

            session = NoRedirectSession()
            session.trust_env = False                      # no proxies / netrc from the environment
            self._session = session
        return self._vapid, self._session

    def __call__(self, subscription: Mapping[str, Any], payload: str, *, subject: str, ttl: int, timeout: float) -> int:
        vapid, session = self._prepare()
        from pywebpush import WebPushException, webpush

        try:
            response = webpush(
                subscription_info=subscription,
                data=payload,
                vapid_private_key=vapid,
                vapid_claims={"sub": subject},             # fresh dict: pywebpush adds aud/exp to it
                content_encoding="aes128gcm",
                ttl=ttl,
                timeout=timeout,
                requests_session=session,
            )
        except WebPushException as exc:
            if getattr(exc, "response", None) is not None:
                return int(exc.response.status_code)
            raise
        return int(response.status_code)


# --------------------------------------------------------------------------------------------
# notifier
# --------------------------------------------------------------------------------------------
class PushNotifier:
    def __init__(
        self,
        cfg: PushConfig,
        *,
        send: Optional[Callable[..., int]] = None,
        key_loader: Callable[[PushConfig], str] = load_vapid_key,
        clock: Callable[[], float] = time.monotonic,
        allow_insecure_loopback: bool = False,
    ):
        self.cfg = cfg
        self._send = send if send is not None else PywebpushSender(lambda: key_loader(cfg))
        self._clock = clock
        self._allow_insecure_loopback = allow_insecure_loopback    # tests only, see check_endpoint

    def subject(self, default_domain: str) -> str:
        return self.cfg.subject or f"mailto:postmaster@{default_domain}"

    def notify(
        self,
        db: Any,
        payload: Union[str, Callable[..., str]],
        default_domain: str,
        recipient_domains: Optional[Iterable[str]] = None,
    ) -> Dict[str, int]:
        """Push to every subscription that may see this message.

        `payload` is either the finished JSON, or a function (badge) or (badge, scope) -> JSON; with
        a function the unread count is looked up once per distinct visibility (scope None = all mail,
        for owners; otherwise a member's frozenset of domains) and passed in. `recipient_domains` are the receiving domains of the message:
        a member is only notified when one of them is in the member's domains.
        Returns counts: sent / gone / failed / skipped / filtered."""
        counts = {"sent": 0, "gone": 0, "failed": 0, "skipped": 0, "filtered": 0}
        subject = self.subject(default_domain)
        message_domains = frozenset(str(d).lower() for d in (recipient_domains or ()))
        start = self._clock()
        try:
            removed = db.delete_orphan_push_subscriptions()
            if removed:
                log.info("push: %d subscription(s) of deleted users removed", removed)
        except Exception as exc:
            log.warning("push: could not remove orphaned subscriptions (%s)", type(exc).__name__)
        subscriptions = list(db.list_push_subscriptions(MAX_SUBSCRIPTIONS, MAX_PER_USER))[:MAX_SUBSCRIPTIONS]
        # a payload function may take (badge) or (badge, scope); with the scope it can show a member
        # only an address on the member's own domains
        takes_scope = callable(payload) and len(inspect.signature(payload).parameters) >= 2
        payloads: Dict[Optional[frozenset], str] = {}
        for index, row in enumerate(subscriptions):
            remaining = TIME_BUDGET - (self._clock() - start)
            if remaining <= 0:
                counts["skipped"] += len(subscriptions) - index
                log.warning("push: time budget used up, %d subscription(s) skipped", len(subscriptions) - index)
                break

            # None = sees everything (owner); otherwise the set of domains this user may see
            scope: Optional[frozenset] = None
            if row.get("role") != "owner":
                scope = frozenset(str(d).lower() for d in (row.get("domains") or ()))
                if not (scope & message_domains):
                    counts["filtered"] += 1
                    continue
            if scope not in payloads:
                if isinstance(payload, str):
                    payloads[scope] = payload
                else:
                    badge = self._badge(db, scope)
                    payloads[scope] = payload(badge, scope) if takes_scope else payload(badge)
            body = payloads[scope]

            endpoint = str(row["endpoint"])
            host = endpoint_host(endpoint)
            reason = check_endpoint(endpoint, self.cfg.endpoint_allow,
                                    allow_insecure_loopback=self._allow_insecure_loopback)
            if reason is not None:
                counts["skipped"] += 1
                log.warning("push: subscription on host %s skipped (%s)", host, reason)
                continue

            status: Optional[int] = None
            try:
                status = self._send(
                    {"endpoint": endpoint, "keys": {"p256dh": row["p256dh"], "auth": row["auth"]}},
                    body,
                    subject=subject,
                    ttl=TTL_SECONDS,
                    timeout=min(REQUEST_TIMEOUT, max(1.0, remaining)),
                )
            except PushUnavailable as exc:
                counts["skipped"] += len(subscriptions) - index
                log.error("push: unavailable (%s); nothing sent", exc)
                break
            except Exception as exc:
                log.warning("push: request to %s failed (%s)", host, type(exc).__name__)

            if status is not None and 200 <= status < 300:
                counts["sent"] += 1
                db.push_succeeded(endpoint)
            elif status in (404, 410):
                counts["gone"] += 1
                log.info("push: subscription on %s is gone (%d); removed", host, status)
                db.delete_push_subscription(endpoint)
            else:
                counts["failed"] += 1
                if status is not None:
                    log.warning("push: %s answered %d", host, status)
                db.push_failed(endpoint)
        return counts

    @staticmethod
    def _badge(db: Any, scope: Optional[frozenset]) -> Optional[int]:
        """Unread count for one visibility scope; None (no badge) when it cannot be determined."""
        try:
            return min(int(db.count_unread(None if scope is None else sorted(scope))), BADGE_MAX)
        except Exception as exc:
            log.warning("push: unread count failed (%s); sending without badge", type(exc).__name__)
            return None
