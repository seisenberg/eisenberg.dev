"""Postgres access for the eisenmail inbound Lambda (psycopg 3), optionally through an SSH tunnel.

Nothing here runs at import time. `Database` connects lazily on first use and, when a statement
fails with psycopg.OperationalError / InterfaceError (stale connection after a Lambda freeze,
tunnel dropped, server restart), tears the connection and tunnel down, reconnects and retries
that statement ONCE. Every statement is a single autocommit statement, and the callers are
idempotent, so a retry is safe.

The tunnel is implemented directly on paramiko (Transport + direct-tcpip channels + a small
local forwarding server bound to 127.0.0.1 on an ephemeral port). With SSH_TUNNEL_HOST_KEY set,
the server's host key must match the pinned key or the tunnel refuses to authenticate.
"""
from __future__ import annotations

import base64
import binascii
import hmac
import io
import json
import logging
import select
import socket
import socketserver
import threading
from typing import Any, Callable, List, Mapping, Optional, Sequence, Tuple

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from config import DbConfig, TunnelConfig

log = logging.getLogger("eisenmail.db")

RECONNECT_ERRORS = (psycopg.OperationalError, psycopg.InterfaceError)
# what applies when mail_settings has no row ("should not happen")
NO_SETTINGS_RULE = {"forward": True, "notify": True, "forward_style": "inline"}


class TunnelError(RuntimeError):
    pass


class HostKeyMismatch(TunnelError):
    """The SSH server presented a key that is not the pinned SSH_TUNNEL_HOST_KEY."""


# --------------------------------------------------------------------------------------------
# host key pinning
# --------------------------------------------------------------------------------------------
_KEY_TYPE_PREFIXES = ("ssh-", "ecdsa-", "sk-", "rsa-")


def parse_pinned_host_keys(text: str) -> List[Tuple[str, bytes]]:
    """Parse SSH_TUNNEL_HOST_KEY: one or more lines of `[host] <keytype> <base64> [comment]`.

    Returns [(keytype, key blob)]. Raises TunnelError if nothing usable is found, so a typo can
    never silently disable pinning."""
    keys: List[Tuple[str, bytes]] = []
    for line in (text or "").replace("\\n", "\n").splitlines():
        fields = line.split()
        if not fields or fields[0].startswith("#"):
            continue
        for i, field in enumerate(fields[:-1]):
            if not field.startswith(_KEY_TYPE_PREFIXES):
                continue
            try:
                blob = base64.b64decode(fields[i + 1], validate=True)
            except (binascii.Error, ValueError):
                continue
            # the blob starts with its own length-prefixed type name; it must agree
            name = field.encode("ascii", "replace")
            if blob[:4] == len(name).to_bytes(4, "big") and blob[4:4 + len(name)] == name:
                keys.append((field, blob))
                break
        else:
            raise TunnelError("SSH_TUNNEL_HOST_KEY: expected '<keytype> <base64 key>' (known_hosts format)")
    if not keys:
        raise TunnelError("SSH_TUNNEL_HOST_KEY is set but contains no key")
    return keys


def host_key_matches(pinned: Sequence[Tuple[str, bytes]], key_type: str, key_blob: bytes) -> bool:
    return any(key_type == t and hmac.compare_digest(key_blob, blob) for t, blob in pinned)


def _negotiation_names(key_type: str) -> Tuple[str, ...]:
    # an RSA host key is pinned as "ssh-rsa" but negotiated under its signature algorithm names
    if key_type == "ssh-rsa":
        return ("rsa-sha2-512", "rsa-sha2-256", "ssh-rsa")
    return (key_type,)


# --------------------------------------------------------------------------------------------
# private key loading
# --------------------------------------------------------------------------------------------
def load_private_key_text(cfg: TunnelConfig) -> str:
    """Private key text from SSM (SecureString, decrypted) or from a file."""
    if cfg.key_ssm:
        import boto3  # only needed here; keeps module import free of AWS

        response = boto3.client("ssm").get_parameter(Name=cfg.key_ssm, WithDecryption=True)
        return response["Parameter"]["Value"]
    if cfg.key_path:
        with open(cfg.key_path, "r", encoding="utf-8") as handle:
            return handle.read()
    raise TunnelError("no SSH key configured (SSH_TUNNEL_KEY_SSM or SSH_TUNNEL_KEY_PATH)")


def load_db_password(cfg: DbConfig) -> str:
    """The database password from its SSM SecureString (POSTGRES_DB_PASSWORD_SSM)."""
    import boto3

    response = boto3.client("ssm").get_parameter(Name=cfg.password_ssm, WithDecryption=True)
    return str(response["Parameter"]["Value"]).rstrip("\r\n")


def is_auth_failure(exc: BaseException) -> bool:
    """True when the server refused the credentials (wrong / rotated password)."""
    if getattr(exc, "sqlstate", None) in ("28P01", "28000"):
        return True
    return "authentication failed" in str(exc).lower()


def parse_private_key(text: str):
    import paramiko

    text = text.strip() + "\n"
    for cls in (paramiko.Ed25519Key, paramiko.ECDSAKey, paramiko.RSAKey):
        try:
            return cls.from_private_key(io.StringIO(text))
        except (paramiko.SSHException, ValueError, TypeError, IndexError, UnicodeError):
            continue
    raise TunnelError("SSH tunnel key is not a usable (unencrypted) ed25519/ecdsa/rsa private key")


# --------------------------------------------------------------------------------------------
# tunnel
# --------------------------------------------------------------------------------------------
class _ForwardServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    transport = None
    remote: Tuple[str, int] = ("", 0)
    channel_timeout = 10.0


class _ForwardHandler(socketserver.BaseRequestHandler):
    def handle(self):
        server: _ForwardServer = self.server  # type: ignore[assignment]
        try:
            channel = server.transport.open_channel(
                "direct-tcpip", server.remote, self.request.getpeername(), timeout=server.channel_timeout
            )
        except Exception as exc:
            log.error("ssh tunnel: cannot open channel to database: %s", type(exc).__name__)
            return
        try:
            while True:
                readable, _, _ = select.select([self.request, channel], [], [], 30)
                if self.request in readable:
                    data = self.request.recv(65536)
                    if not data:
                        break
                    channel.sendall(data)
                if channel in readable:
                    data = channel.recv(65536)
                    if not data:
                        break
                    self.request.sendall(data)
                if channel.closed:
                    break
        except (OSError, EOFError):
            pass
        finally:
            channel.close()


_warned_unpinned = False


class SshTunnel:
    """Forwards 127.0.0.1:<ephemeral port> to (remote_host, remote_port) as seen from the SSH host."""

    def __init__(
        self,
        cfg: TunnelConfig,
        remote_host: str,
        remote_port: int,
        *,
        key_loader: Callable[[TunnelConfig], str] = load_private_key_text,
        timeout: float = 10.0,
    ):
        self.cfg = cfg
        self.remote = (remote_host, int(remote_port))
        self._key_loader = key_loader
        self._timeout = timeout
        self._transport = None
        self._server: Optional[_ForwardServer] = None
        self._thread: Optional[threading.Thread] = None

    @property
    def local_port(self) -> int:
        if self._server is None:
            raise TunnelError("tunnel is not started")
        return self._server.server_address[1]

    def is_active(self) -> bool:
        return bool(self._transport is not None and self._transport.is_active() and self._server is not None)

    def start(self) -> int:
        import paramiko

        global _warned_unpinned
        cfg = self.cfg
        pinned = parse_pinned_host_keys(cfg.host_key) if cfg.host_key else None
        pkey = parse_private_key(self._key_loader(cfg))

        sock = socket.create_connection((cfg.host, cfg.port), timeout=self._timeout)
        transport = paramiko.Transport(sock)
        try:
            if pinned:
                # only negotiate host key algorithms the pinned key(s) can satisfy
                options = transport.get_security_options()
                wanted = [n for t, _ in pinned for n in _negotiation_names(t)]
                usable = tuple(dict.fromkeys(n for n in wanted if n in options.key_types))
                if usable:
                    options.key_types = usable
            transport.start_client(timeout=self._timeout)
            server_key = transport.get_remote_server_key()
            if pinned:
                if not host_key_matches(pinned, server_key.get_name(), server_key.asbytes()):
                    raise HostKeyMismatch(
                        f"SSH host key of {cfg.host} ({server_key.get_name()}) does not match SSH_TUNNEL_HOST_KEY"
                    )
            elif not _warned_unpinned:
                _warned_unpinned = True
                log.warning(
                    "SSH_TUNNEL_HOST_KEY is not set: the SSH server's host key is NOT verified "
                    "(vulnerable to man-in-the-middle). Pin it, e.g. the output of `ssh-keyscan -t ed25519 %s`.",
                    cfg.host,
                )
            transport.auth_publickey(cfg.user, pkey)
            if not transport.is_authenticated():
                raise TunnelError("SSH authentication failed")
            transport.set_keepalive(30)
        except BaseException:
            transport.close()
            raise

        server = _ForwardServer(("127.0.0.1", 0), _ForwardHandler)
        server.transport = transport
        server.remote = self.remote
        server.channel_timeout = self._timeout
        thread = threading.Thread(target=server.serve_forever, name="eisenmail-ssh-tunnel", daemon=True)
        thread.start()
        self._transport, self._server, self._thread = transport, server, thread
        return self.local_port

    def stop(self) -> None:
        server, transport = self._server, self._transport
        self._server = self._transport = self._thread = None
        if server is not None:
            try:
                server.shutdown()
                server.server_close()
            except Exception:
                pass
        if transport is not None:
            try:
                transport.close()
            except Exception:
                pass


# --------------------------------------------------------------------------------------------
# database
# --------------------------------------------------------------------------------------------
def _jsonb(value: Any):
    if value is None:
        return None
    # Postgres jsonb cannot store \u0000
    return Jsonb(value, dumps=lambda obj: json.dumps(obj, default=str).replace("\\u0000", ""))


class Database:
    """The handful of statements the Lambda needs. tests/ uses an in-memory fake with the same
    public methods (everything below `# -- operations`)."""

    def __init__(
        self,
        db: DbConfig,
        tunnel: Optional[TunnelConfig] = None,
        *,
        connect: Callable[..., Any] = psycopg.connect,
        tunnel_factory: Callable[..., SshTunnel] = SshTunnel,
        password_loader: Callable[[DbConfig], str] = load_db_password,
        connect_timeout: int = 10,
    ):
        self._db = db
        self._tunnel_cfg = tunnel
        self._connect = connect
        self._tunnel_factory = tunnel_factory
        self._password_loader = password_loader
        self._password_cache: Optional[str] = None      # SSM value, kept for the life of the container
        self._connect_timeout = connect_timeout
        self._conn = None
        self._tunnel: Optional[SshTunnel] = None

    # -- connection management -----------------------------------------------------------
    def _password(self) -> Optional[str]:
        if not self._db.password_ssm:
            return self._db.password
        if self._password_cache is None:
            self._password_cache = self._password_loader(self._db)
        return self._password_cache

    def _ensure(self):
        if self._conn is not None:
            return self._conn
        host, port = self._db.host, self._db.port
        if self._tunnel_cfg is not None:
            if self._tunnel is None or not self._tunnel.is_active():
                if self._tunnel is not None:
                    self._tunnel.stop()
                self._tunnel = self._tunnel_factory(self._tunnel_cfg, self._db.host, self._db.port)
                self._tunnel.start()
            host, port = "127.0.0.1", self._tunnel.local_port
        kwargs = dict(
            host=host,
            port=port,
            dbname=self._db.name,
            user=self._db.user,
            password=self._password(),
            autocommit=True,
            connect_timeout=self._connect_timeout,
        )
        if self._db.sslmode:
            kwargs["sslmode"] = self._db.sslmode
        self._conn = self._connect(**kwargs)
        return self._conn

    def close(self) -> None:
        conn, tunnel = self._conn, self._tunnel
        self._conn = self._tunnel = None
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        if tunnel is not None:
            tunnel.stop()

    def _run(self, sql: str, params: Sequence[Any] = (), *, fetch: bool = True) -> List[Mapping[str, Any]]:
        """Run one statement. A lost connection is re-established once and the statement retried.
        Separately, when the password comes from SSM and the server refuses it, the parameter is
        fetched again once (it may have been rotated) and the statement retried."""
        reconnected = refetched = False
        while True:
            try:
                conn = self._ensure()
                with conn.cursor(row_factory=dict_row) as cur:
                    cur.execute(sql, tuple(params))
                    return cur.fetchall() if fetch else []
            except RECONNECT_ERRORS as exc:
                self.close()
                if self._db.password_ssm and is_auth_failure(exc):
                    self._password_cache = None        # never keep a password the server refused
                    if refetched:
                        raise
                    refetched = True
                    log.warning("database authentication failed; refetching the password from SSM once")
                    continue
                if reconnected:
                    raise
                reconnected = True
                log.warning("database connection problem (%s); reconnecting once", type(exc).__name__)

    # -- operations ------------------------------------------------------------------------
    def insert_inbox(self, message_id: str, s3_key: Optional[str], event: Any, email_raw: bytes,
                     kind: str, meta: Optional[Mapping[str, Any]] = None) -> bool:
        """Insert a raw message. False when a row with this message_id already exists."""
        rows = self._run(
            "insert into lambda_inbox (message_id, s3_key, event, email_raw, kind, meta) "
            "values (%s, %s, %s, %s, %s, %s) on conflict (message_id) do nothing returning message_id",
            [message_id, s3_key, _jsonb(event), email_raw, kind, _jsonb(meta)],
        )
        return bool(rows)

    def get_inbox_meta(self, message_id: str) -> Optional[Mapping[str, Any]]:
        """{'kind': ..., 'meta': {...}} of a stored message, None when it does not exist."""
        rows = self._run("select kind, meta from lambda_inbox where message_id = %s", [message_id])
        if not rows:
            return None
        return {"kind": rows[0]["kind"], "meta": rows[0]["meta"] or {}}

    def merge_inbox_meta(self, message_id: str, meta: Mapping[str, Any]) -> None:
        self._run(
            "update lambda_inbox set meta = coalesce(meta, '{}'::jsonb) || %s where message_id = %s",
            [_jsonb(meta), message_id],
            fetch=False,
        )

    def relay_already_sent(self, relay_source_id: str) -> bool:
        """True when a relay_out row for this inbound SES message id exists (retry idempotency)."""
        rows = self._run(
            "select 1 as found from lambda_inbox where kind = 'relay_out' and meta->>'relay_source_id' = %s limit 1",
            [relay_source_id],
        )
        return bool(rows)

    def create_token(self, *, token: str, inbox_message_id: Optional[str], alias_address: str,
                     correspondent: str, correspondent_name: Optional[str], orig_message_id: Optional[str],
                     orig_references: Optional[str], subject: Optional[str]) -> None:
        self._run(
            "insert into relay_tokens (token, inbox_message_id, alias_address, correspondent, "
            "correspondent_name, orig_message_id, orig_references, subject) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s) on conflict (token) do nothing",
            [token, inbox_message_id, alias_address, correspondent, correspondent_name,
             orig_message_id, orig_references, subject],
            fetch=False,
        )

    def get_token(self, token: str) -> Optional[Mapping[str, Any]]:
        rows = self._run(
            "select token, inbox_message_id, alias_address, correspondent, correspondent_name, "
            "orig_message_id, orig_references, subject from relay_tokens where token = %s",
            [token],
        )
        return rows[0] if rows else None

    def find_token_for_message(self, inbox_message_id: str) -> Optional[Mapping[str, Any]]:
        """Token created for a stored inbound message (used when a failed forward is retried)."""
        rows = self._run(
            "select token, inbox_message_id, alias_address, correspondent, correspondent_name, "
            "orig_message_id, orig_references, subject from relay_tokens "
            "where inbox_message_id = %s order by created_at limit 1",
            [inbox_message_id],
        )
        return rows[0] if rows else None

    # -- delivery rules ---------------------------------------------------------------------
    def get_mail_defaults(self) -> Mapping[str, Any]:
        """mail_settings defaults: {"forward", "notify", "forward_style"}.
        forward=True / notify=True / "inline" when the single row is missing."""
        rows = self._run("select default_forward, default_notify, default_forward_style from mail_settings limit 1")
        if not rows:
            return dict(NO_SETTINGS_RULE)
        return {
            "forward": bool(rows[0]["default_forward"]),
            "notify": bool(rows[0]["default_notify"]),
            "forward_style": rows[0]["default_forward_style"],
        }

    def resolve_address_rule(self, address: str) -> Mapping[str, Any]:
        """Rule of a receiving address: {"forward", "notify", "forward_style"}. Created from the
        current defaults the first time the address receives mail (later changes of the defaults
        do not touch existing rows)."""
        self._run(
            "insert into address_rules (address, forward, notify, forward_style) "
            "select %s, default_forward, default_notify, default_forward_style from mail_settings "
            "on conflict (address) do nothing",
            [address],
            fetch=False,
        )
        rows = self._run("select forward, notify, forward_style from address_rules where address = %s", [address])
        if not rows:  # mail_settings has no row: nothing was materialised
            return dict(NO_SETTINGS_RULE)
        return {
            "forward": bool(rows[0]["forward"]),
            "notify": bool(rows[0]["notify"]),
            "forward_style": rows[0]["forward_style"],
        }

    # -- web push ------------------------------------------------------------------------------
    def delete_orphan_push_subscriptions(self) -> int:
        """Remove subscriptions whose user no longer exists. Returns how many were removed."""
        rows = self._run(
            "delete from push_subscriptions s "
            "where not exists (select 1 from webmail_users u where u.id = s.user_id) returning s.endpoint"
        )
        return len(rows)

    def list_push_subscriptions(self, limit: int = 40, per_user: int = 5) -> List[Mapping[str, Any]]:
        """Subscriptions to notify, with their user's visibility (role, domains).

        At most `per_user` per user (that user's healthiest), so one user with many subscriptions
        cannot crowd another user's devices out; owners are listed before members; `limit` is the
        overall ceiling. Subscriptions without a user are not listed."""
        return self._run(
            "select endpoint, p256dh, auth, role, domains from ("
            "  select s.endpoint, s.p256dh, s.auth, u.role, u.domains, s.failure_count, s.last_success_at, s.created_at,"
            "         row_number() over (partition by s.user_id order by s.failure_count,"
            "                            s.last_success_at desc nulls last, s.created_at desc) as rank_for_user"
            "    from push_subscriptions s join webmail_users u on u.id = s.user_id"
            ") ranked where rank_for_user <= %s "
            "order by (role <> 'owner'), failure_count, last_success_at desc nulls last, created_at desc limit %s",
            [int(per_user), int(limit)],
        )

    def count_unread(self, domains: Optional[Sequence[str]] = None) -> int:
        """Unread inbox messages: indexed ones (messages) plus inbound mail the web side has not
        indexed yet (lambda_inbox.processed_at is null). `domains` restricts both to mail for
        those receiving domains (a member's view); None counts everything (an owner's view)."""
        if domains is None:
            rows = self._run(
                "select (select count(*) from messages where mailbox = 'inbox' and not is_read) "
                "+ (select count(*) from lambda_inbox where kind = 'inbound' and processed_at is null) as unread"
            )
        else:
            wanted = [str(d).lower() for d in domains]
            rows = self._run(
                "select (select count(*) from messages where mailbox = 'inbox' and not is_read and domains && %s) "
                "+ (select count(*) from lambda_inbox i where i.kind = 'inbound' and i.processed_at is null "
                "and exists (select 1 from jsonb_array_elements_text("
                "case when jsonb_typeof(i.event->'receipt'->'recipients') = 'array' "
                "then i.event->'receipt'->'recipients' else '[]'::jsonb end) as r(address) "
                "where lower(split_part(r.address, '@', 2)) = any(%s))) as unread",
                [wanted, wanted],
            )
        return int(rows[0]["unread"]) if rows else 0

    def push_succeeded(self, endpoint: str) -> None:
        self._run(
            "update push_subscriptions set last_success_at = now(), failure_count = 0 where endpoint = %s",
            [endpoint],
            fetch=False,
        )

    def push_failed(self, endpoint: str) -> None:
        self._run(
            "update push_subscriptions set failure_count = failure_count + 1 where endpoint = %s",
            [endpoint],
            fetch=False,
        )

    def delete_push_subscription(self, endpoint: str) -> None:
        self._run("delete from push_subscriptions where endpoint = %s", [endpoint], fetch=False)

    # -- blocked addresses, delivery log, reconcile ------------------------------------------------
    def record_blocked(self, addresses: Sequence[str]) -> List[str]:
        """Which of `addresses` are blocked. Each hit is counted (blocked_count, last_blocked_at)."""
        if not addresses:
            return []
        rows = self._run(
            "update address_rules set blocked_count = blocked_count + 1, last_blocked_at = now() "
            "where blocked and address = any(%s) returning address",
            [list(addresses)],
        )
        return [row["address"] for row in rows]

    def log_outcome(self, message_id: str, outcome: str) -> None:
        """One row per SES message the handler has finished with (the reconcile job reads it)."""
        self._run(
            "insert into inbox_log (message_id, outcome) values (%s, %s) "
            "on conflict (message_id) do update set outcome = excluded.outcome, at = now()",
            [message_id, outcome],
            fetch=False,
        )

    def handled_message_ids(self, message_ids: Sequence[str]) -> set:
        """The subset of `message_ids` that needs no replay: logged in inbox_log, stored in
        lambda_inbox, or recorded as the source of a relayed reply.

        One kind of stored row still counts as unhandled: an inbound row whose forward step never
        finished (meta has "notified" but no "forwarded": the store succeeded, the forward raised
        on every retry). Replaying it completes the forward; the row itself is not written again."""
        handled: set = set()
        ids = list(message_ids)
        for start in range(0, len(ids), 500):
            batch = ids[start:start + 500]
            rows = self._run(
                "select message_id as id from inbox_log where message_id = any(%s) "
                "union select message_id from lambda_inbox where message_id = any(%s) "
                "and not (kind = 'inbound' and coalesce(meta ? 'notified' and not meta ? 'forwarded', false)) "
                "union select meta->>'relay_source_id' from lambda_inbox "
                "where kind = 'relay_out' and meta->>'relay_source_id' = any(%s)",
                [batch, batch, batch],
            )
            handled.update(row["id"] for row in rows)
        return handled

    def touch_token(self, token: str) -> None:
        self._run(
            "update relay_tokens set last_used_at = now(), use_count = use_count + 1 where token = %s",
            [token],
            fetch=False,
        )
