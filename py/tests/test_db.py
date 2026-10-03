"""db.py: host key pinning, reconnect-once, and the paramiko tunnel against an in-process SSH server."""
import io
import logging
import socket
import threading

import paramiko
import psycopg
import pytest

import db as dbmod
from config import DbConfig, TunnelConfig

DB = DbConfig(host="10.0.0.5", port=5432, name="emails", user="mail", password="pw", sslmode=None)


# ------------------------------------------------------------------------------------------
# pinned host keys
# ------------------------------------------------------------------------------------------
def key_line(key: paramiko.PKey) -> str:
    return f"{key.get_name()} {key.get_base64()}"


@pytest.fixture(scope="module")
def host_key():
    return paramiko.ECDSAKey.generate()


@pytest.fixture(scope="module")
def other_key():
    return paramiko.ECDSAKey.generate()


@pytest.fixture(scope="module")
def client_key():
    return paramiko.ECDSAKey.generate()


def test_parse_pinned_host_keys_formats(host_key, other_key):
    line = key_line(host_key)
    blob = host_key.asbytes()
    assert dbmod.parse_pinned_host_keys(line) == [(host_key.get_name(), blob)]
    assert dbmod.parse_pinned_host_keys(f"{line} comment here") == [(host_key.get_name(), blob)]
    assert dbmod.parse_pinned_host_keys(f"bastion.example,10.0.0.1 {line}") == [(host_key.get_name(), blob)]
    assert dbmod.parse_pinned_host_keys(f"ssh-bastion.example {line}") == [(host_key.get_name(), blob)]
    two = dbmod.parse_pinned_host_keys(f"# old\n{line}\n\n{key_line(other_key)}\n")
    assert [b for _, b in two] == [blob, other_key.asbytes()]
    assert dbmod.parse_pinned_host_keys(f"{line}\\n{key_line(other_key)}") == two      # literal \n from an env file


@pytest.mark.parametrize("text", ["", "   ", "ssh-ed25519", "ssh-ed25519 not-base64!!", "garbage here",
                                  "ssh-ed25519 AAAAB3NzaC1yc2E="])     # type/blob mismatch
def test_parse_pinned_host_keys_rejects_garbage(text):
    with pytest.raises(dbmod.TunnelError):
        dbmod.parse_pinned_host_keys(text)


def test_host_key_matches(host_key, other_key):
    pinned = dbmod.parse_pinned_host_keys(key_line(host_key))
    assert dbmod.host_key_matches(pinned, host_key.get_name(), host_key.asbytes())
    assert not dbmod.host_key_matches(pinned, other_key.get_name(), other_key.asbytes())
    assert not dbmod.host_key_matches(pinned, "ssh-ed25519", host_key.asbytes())
    assert not dbmod.host_key_matches([], host_key.get_name(), host_key.asbytes())


def test_private_key_parsing(client_key):
    buffer = io.StringIO()
    client_key.write_private_key(buffer)
    parsed = dbmod.parse_private_key(buffer.getvalue())
    assert parsed.asbytes() == client_key.asbytes()
    with pytest.raises(dbmod.TunnelError):
        dbmod.parse_private_key("not a key")


def test_key_loader_reads_file_and_requires_a_source(tmp_path):
    path = tmp_path / "key"
    path.write_text("KEYDATA")
    assert dbmod.load_private_key_text(TunnelConfig(host="h", user="u", key_path=str(path))) == "KEYDATA"
    with pytest.raises(dbmod.TunnelError):
        dbmod.load_private_key_text(TunnelConfig(host="h", user="u"))


def test_key_loader_reads_ssm_securestring(monkeypatch):
    import boto3
    calls = []

    class FakeSSM:
        def get_parameter(self, **kwargs):
            calls.append(kwargs)
            return {"Parameter": {"Value": "KEY FROM SSM"}}

    monkeypatch.setattr(boto3, "client", lambda name: FakeSSM() if name == "ssm" else None)
    cfg = TunnelConfig(host="h", user="u", key_ssm="/eisenmail/tunnel-key")
    assert dbmod.load_private_key_text(cfg) == "KEY FROM SSM"
    assert calls == [{"Name": "/eisenmail/tunnel-key", "WithDecryption": True}]


# ------------------------------------------------------------------------------------------
# Database: lazy connect, reconnect once
# ------------------------------------------------------------------------------------------
class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params):
        self.conn.owner.statements.append((self.conn.number, sql, params))
        error = self.conn.owner.errors.pop(0) if self.conn.owner.errors else None
        if error is not None:
            raise error

    def fetchall(self):
        return list(self.conn.owner.rows)


class FakeConnection:
    def __init__(self, owner, number):
        self.owner, self.number, self.closed = owner, number, False

    def cursor(self, row_factory=None):
        return FakeCursor(self)

    def close(self):
        self.closed = True


class FakeConnect:
    def __init__(self):
        self.calls, self.connections, self.statements, self.errors, self.rows = [], [], [], [], []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        conn = FakeConnection(self, len(self.calls))
        self.connections.append(conn)
        return conn


class FakeTunnel:
    instances = []

    def __init__(self, cfg, remote_host, remote_port):
        self.cfg, self.remote, self.started, self.stopped = cfg, (remote_host, remote_port), False, False
        self.local_port = 40000 + len(FakeTunnel.instances)
        FakeTunnel.instances.append(self)

    def start(self):
        self.started = True
        return self.local_port

    def is_active(self):
        return self.started and not self.stopped

    def stop(self):
        self.stopped = True


def test_database_connects_lazily_with_configured_settings():
    connect = FakeConnect()
    database = dbmod.Database(DbConfig("db.internal", 6543, "emails", "mail", "pw", "require"), connect=connect)
    assert connect.calls == []                                     # nothing at construction
    connect.rows = [{"message_id": "m1"}]
    assert database.insert_inbox("m1", "k", {"a": 1}, b"raw", "inbound") is True
    assert connect.calls == [dict(host="db.internal", port=6543, dbname="emails", user="mail", password="pw",
                                  autocommit=True, connect_timeout=10, sslmode="require")]
    connect.rows = []
    assert database.insert_inbox("m1", "k", {"a": 1}, b"raw", "inbound") is False     # conflict -> no row returned
    assert len(connect.calls) == 1                                 # connection reused
    number, sql, params = connect.statements[0]
    assert "on conflict (message_id) do nothing" in sql and sql.count("%s") == len(params) == 6
    assert params[0] == "m1" and params[3] == b"raw" and params[4] == "inbound" and params[5] is None


@pytest.mark.parametrize("error", [psycopg.OperationalError("server closed the connection"),
                                   psycopg.InterfaceError("connection already closed")])
def test_database_reconnects_once(error, caplog):
    connect = FakeConnect()
    database = dbmod.Database(DB, connect=connect)
    connect.rows = [{"found": 1}]
    connect.errors = [error]
    with caplog.at_level(logging.WARNING, logger="eisenmail.db"):
        assert database.relay_already_sent("src-1") is True
    assert len(connect.calls) == 2 and connect.connections[0].closed
    assert [n for n, _, _ in connect.statements] == [1, 2]         # retried on the new connection
    assert "reconnecting once" in caplog.text


def test_database_gives_up_after_second_failure_and_recovers_later():
    connect = FakeConnect()
    database = dbmod.Database(DB, connect=connect)
    connect.errors = [psycopg.OperationalError("down"), psycopg.OperationalError("still down")]
    with pytest.raises(psycopg.OperationalError, match="still down"):
        database.touch_token("t")
    assert len(connect.calls) == 2 and all(c.closed for c in connect.connections)
    database.touch_token("t")                                       # next call connects afresh
    assert len(connect.calls) == 3


def test_database_does_not_retry_other_errors():
    connect = FakeConnect()
    database = dbmod.Database(DB, connect=connect)
    connect.errors = [psycopg.errors.UniqueViolation("duplicate")]
    with pytest.raises(psycopg.errors.UniqueViolation):
        database.touch_token("t")
    assert len(connect.calls) == 1 and len(connect.statements) == 1


def test_database_uses_tunnel_and_rebuilds_it_on_reconnect():
    FakeTunnel.instances = []
    connect = FakeConnect()
    tunnel_cfg = TunnelConfig(host="bastion", user="u", key_ssm="/k")
    database = dbmod.Database(DB, tunnel_cfg, connect=connect, tunnel_factory=FakeTunnel)
    assert FakeTunnel.instances == []                               # lazy
    connect.errors = [psycopg.OperationalError("tunnel dropped")]
    database.touch_token("t")
    first, second = FakeTunnel.instances
    assert first.remote == second.remote == ("10.0.0.5", 5432)      # POSTGRES_DB_HOST/PORT as seen from the SSH host
    assert first.stopped and second.started and not second.stopped
    assert [(c["host"], c["port"]) for c in connect.calls] == [("127.0.0.1", 40000), ("127.0.0.1", 40001)]
    database.close()
    assert second.stopped


def test_database_operations_shape():
    connect = FakeConnect()
    database = dbmod.Database(DB, connect=connect)
    connect.rows = []
    assert database.get_token("t") is None
    assert database.find_token_for_message("m") is None
    assert database.get_inbox_meta("m") is None
    assert database.relay_already_sent("m") is False
    connect.rows = [{"kind": "inbound", "meta": None}]
    assert database.get_inbox_meta("m") == {"kind": "inbound", "meta": {}}
    database.merge_inbox_meta("m", {"forwarded": True})
    database.create_token(token="t", inbox_message_id="m", alias_address="a@b", correspondent="c@d",
                          correspondent_name=None, orig_message_id=None, orig_references=None, subject=None)
    for _, sql, params in connect.statements:
        assert sql.count("%s") == len(params)
    assert "meta->>'relay_source_id'" in connect.statements[3][1]


def test_delivery_rule_and_push_statements():
    connect = FakeConnect()
    database = dbmod.Database(DB, connect=connect)

    connect.rows = []                                              # mail_settings row missing
    fallback = {"forward": True, "notify": True, "forward_style": "inline"}
    assert database.get_mail_defaults() == fallback
    assert database.resolve_address_rule("a@eisenberg.dev") == fallback
    connect.rows = [{"default_forward": False, "default_notify": True, "default_forward_style": "attach"}]
    assert database.get_mail_defaults() == {"forward": False, "notify": True, "forward_style": "attach"}
    connect.rows = [{"forward": False, "notify": True, "forward_style": "attach"}]
    assert database.resolve_address_rule("a@eisenberg.dev") == {"forward": False, "notify": True,
                                                               "forward_style": "attach"}

    connect.rows = [{"endpoint": "https://fcm.googleapis.com/x", "p256dh": "p", "auth": "a", "role": "owner",
                     "domains": None}]
    assert database.list_push_subscriptions(20) == connect.rows
    assert "join webmail_users u on u.id = s.user_id" in connect.statements[-1][1]
    database.push_succeeded("e")
    database.push_failed("e")
    database.delete_push_subscription("e")

    statements = [sql for _, sql, _ in connect.statements]
    for _, sql, params in connect.statements:
        assert sql.count("%s") == len(params)
    materialise = statements[1]
    assert materialise == ("insert into address_rules (address, forward, notify, forward_style) "
                           "select %s, default_forward, default_notify, default_forward_style from mail_settings "
                           "on conflict (address) do nothing")
    assert "limit %s" in statements[-4] and connect.statements[-4][2] == (5, 20)   # (per user, overall)
    assert "last_success_at = now(), failure_count = 0" in statements[-3]
    assert "failure_count = failure_count + 1" in statements[-2]
    assert statements[-1].startswith("delete from push_subscriptions where endpoint = %s")


def test_blocked_log_reconcile_and_unread_statements():
    connect = FakeConnect()
    database = dbmod.Database(DB, connect=connect)

    assert database.record_blocked([]) == [] and connect.statements == []          # nothing to look up
    connect.rows = [{"address": "a@eisenberg.dev"}]
    assert database.record_blocked(["a@eisenberg.dev", "b@eisenberg.dev"]) == ["a@eisenberg.dev"]
    _, sql, params = connect.statements[-1]
    assert sql == ("update address_rules set blocked_count = blocked_count + 1, last_blocked_at = now() "
                   "where blocked and address = any(%s) returning address")
    assert params == (["a@eisenberg.dev", "b@eisenberg.dev"],)

    database.log_outcome("m1", "forwarded")
    _, sql, params = connect.statements[-1]
    assert sql == ("insert into inbox_log (message_id, outcome) values (%s, %s) "
                   "on conflict (message_id) do update set outcome = excluded.outcome, at = now()")
    assert params == ("m1", "forwarded")

    connect.rows = [{"id": "m1"}, {"id": "m3"}]
    before = len(connect.statements)
    assert database.handled_message_ids([f"m{n}" for n in range(1, 1202)]) == {"m1", "m3"}
    batches = connect.statements[before:]
    assert [len(params[0]) for _, _, params in batches] == [500, 500, 201]             # = any($1), in batches
    assert all(sql.count("= any(%s)") == 3 and len(params) == 3 for _, sql, params in batches)
    assert "meta->>'relay_source_id'" in batches[0][1] and "inbox_log" in batches[0][1]
    assert database.handled_message_ids([]) == set()

    connect.rows = [{"unread": 12}]
    assert database.count_unread() == 12
    assert connect.statements[-1][2] == () and "domains &&" not in connect.statements[-1][1]
    assert database.count_unread(["Shop.Example"]) == 12
    _, sql, params = connect.statements[-1]
    assert params == (["shop.example"], ["shop.example"]) and "domains && %s" in sql and "processed_at is null" in sql

    connect.rows = [{"endpoint": "e1"}, {"endpoint": "e2"}]
    assert database.delete_orphan_push_subscriptions() == 2
    assert "not exists (select 1 from webmail_users u where u.id = s.user_id)" in connect.statements[-1][1]


# ------------------------------------------------------------------------------------------
# database password from SSM
# ------------------------------------------------------------------------------------------
SSM_DB = DbConfig(host="10.0.0.5", port=5432, name="emails", user="mail", password_ssm="/eisenmail/db-password")


class FakeSSMPassword:
    """Stands in for the SSM lookup: hands out the scripted values, counts the fetches."""

    def __init__(self, *values):
        self.values, self.calls = list(values), []

    def __call__(self, cfg):
        self.calls.append(cfg.password_ssm)
        return self.values.pop(0) if len(self.values) > 1 else self.values[0]


def auth_error():
    return psycopg.OperationalError('connection failed: FATAL:  password authentication failed for user "mail"')


class RejectingConnect(FakeConnect):
    """Like the server: refuses to connect with any password other than the current one."""

    def __init__(self, current):
        super().__init__()
        self.current = current

    def __call__(self, **kwargs):
        if kwargs["password"] != self.current:
            self.calls.append(kwargs)
            raise auth_error()
        return super().__call__(**kwargs)


def test_ssm_password_is_fetched_lazily_and_cached():
    connect, loader = FakeConnect(), FakeSSMPassword("pw-1")
    database = dbmod.Database(SSM_DB, connect=connect, password_loader=loader)
    assert loader.calls == []                                          # nothing at construction
    database.touch_token("t")
    database.touch_token("t")
    assert loader.calls == ["/eisenmail/db-password"]
    assert connect.calls[0]["password"] == "pw-1"

    connect.errors = [psycopg.OperationalError("server closed the connection unexpectedly")]
    database.touch_token("t")                                          # ordinary reconnect: cached value reused
    assert len(connect.calls) == 2 and connect.calls[1]["password"] == "pw-1"
    assert loader.calls == ["/eisenmail/db-password"]


def test_env_password_never_touches_ssm():
    connect, loader = FakeConnect(), FakeSSMPassword("unused")
    database = dbmod.Database(DB, connect=connect, password_loader=loader)
    database.touch_token("t")
    assert loader.calls == [] and connect.calls[0]["password"] == "pw"


def test_rotated_password_is_refetched_once_on_authentication_failure(caplog):
    connect, loader = RejectingConnect("pw-1"), FakeSSMPassword("pw-1", "pw-2")
    database = dbmod.Database(SSM_DB, connect=connect, password_loader=loader)
    database.touch_token("t")
    assert len(loader.calls) == 1

    connect.current = "pw-2"                                           # rotated; our connection gets dropped
    connect.errors = [psycopg.OperationalError("terminating connection due to administrator command")]
    with caplog.at_level(logging.WARNING, logger="eisenmail.db"):
        database.touch_token("t")     # dropped -> reconnect with the stale password refused -> refetch -> works
        database.touch_token("t")
    assert [c["password"] for c in connect.calls] == ["pw-1", "pw-1", "pw-2"]
    assert len(loader.calls) == 2                                      # exactly one refetch
    assert "refetching the password from SSM" in caplog.text
    assert "pw-1" not in caplog.text and "pw-2" not in caplog.text


def test_authentication_failure_at_first_connect_refetches_once_then_gives_up():
    connect, loader = RejectingConnect("the-real-one"), FakeSSMPassword("stale", "still-wrong")
    database = dbmod.Database(SSM_DB, connect=connect, password_loader=loader)
    with pytest.raises(psycopg.OperationalError, match="authentication failed"):
        database.touch_token("t")
    assert [c["password"] for c in connect.calls] == ["stale", "still-wrong"]      # one refetch, one retry
    assert len(loader.calls) == 2

    loader.values = ["the-real-one"]                                    # fixed in SSM: the next call recovers
    database.touch_token("t")
    assert connect.calls[-1]["password"] == "the-real-one" and len(loader.calls) == 3


def test_authentication_failure_with_env_password_does_not_look_at_ssm():
    connect, loader = RejectingConnect("other"), FakeSSMPassword("unused")
    database = dbmod.Database(DB, connect=connect, password_loader=loader)
    with pytest.raises(psycopg.OperationalError):
        database.touch_token("t")
    assert loader.calls == [] and len(connect.calls) == 2


@pytest.mark.parametrize("error,expected", [
    (auth_error(), True),
    (psycopg.OperationalError("FATAL:  PAM authentication failed for user \"mail\""), True),
    (psycopg.OperationalError("connection refused"), False),
    (psycopg.OperationalError("server closed the connection unexpectedly"), False),
    (psycopg.InterfaceError("connection already closed"), False),
])
def test_is_auth_failure(error, expected):
    assert dbmod.is_auth_failure(error) is expected


def test_default_password_loader_reads_the_securestring(monkeypatch):
    import boto3
    calls = []

    class FakeSSM:
        def get_parameter(self, **kwargs):
            calls.append(kwargs)
            return {"Parameter": {"Value": "pw-from-ssm\n"}}

    monkeypatch.setattr(boto3, "client", lambda name: FakeSSM() if name == "ssm" else None)
    assert dbmod.load_db_password(SSM_DB) == "pw-from-ssm"
    assert calls == [{"Name": "/eisenmail/db-password", "WithDecryption": True}]

    connect = FakeConnect()
    dbmod.Database(SSM_DB, connect=connect).touch_token("t")           # default loader wired in
    assert connect.calls[0]["password"] == "pw-from-ssm"


def test_password_is_not_in_reprs():
    assert "pw" not in repr(DB).replace("password_ssm", "")
    assert "password=" not in repr(DB)


def test_jsonb_strips_nul_escapes():
    wrapped = dbmod._jsonb({"subject": "a\u0000b", "when": __import__("datetime").datetime(2026, 1, 1)})
    assert wrapped.dumps(wrapped.obj) == '{"subject": "ab", "when": "2026-01-01 00:00:00"}'
    assert dbmod._jsonb(None) is None


# ------------------------------------------------------------------------------------------
# the real tunnel against an in-process paramiko SSH server
# ------------------------------------------------------------------------------------------
class _SshServer(paramiko.ServerInterface):
    def __init__(self, allowed_key):
        self.allowed_key = allowed_key
        self.auth_attempts = 0
        self.destinations = []
        self.by_channel = {}

    def get_allowed_auths(self, username):
        return "publickey"

    def check_auth_publickey(self, username, key):
        self.auth_attempts += 1
        ok = username == "tunnel" and key.asbytes() == self.allowed_key.asbytes()
        return paramiko.AUTH_SUCCESSFUL if ok else paramiko.AUTH_FAILED

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        self.destinations.append(destination)
        self.by_channel[chanid] = destination
        return paramiko.OPEN_SUCCEEDED


class SshTestServer:
    """Accepts SSH connections on 127.0.0.1. A direct-tcpip channel echoes upper-cased data, or,
    with forward=True, is connected to the requested destination like a real sshd."""

    def __init__(self, host_key, client_key, forward=False):
        self.forward = forward
        self.interface = _SshServer(client_key)
        self.host_key = host_key
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(5)
        self.port = self.listener.getsockname()[1]
        self.transports = []
        threading.Thread(target=self._accept_loop, daemon=True).start()

    def _accept_loop(self):
        while True:
            try:
                client, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(client,), daemon=True).start()

    def _serve(self, client):
        transport = paramiko.Transport(client)
        self.transports.append(transport)
        transport.add_server_key(self.host_key)
        try:
            transport.start_server(server=self.interface)
        except Exception:
            return
        while transport.is_active():
            channel = transport.accept(0.2)
            if channel is not None:
                target = self._pipe if self.forward else self._echo
                threading.Thread(target=target, args=(channel,), daemon=True).start()

    def _pipe(self, channel):
        import select
        upstream = socket.create_connection(self.interface.by_channel[channel.get_id()], timeout=5)
        try:
            while True:
                readable, _, _ = select.select([channel, upstream], [], [], 5)
                if channel in readable:
                    data = channel.recv(65536)
                    if not data:
                        break
                    upstream.sendall(data)
                if upstream in readable:
                    data = upstream.recv(65536)
                    if not data:
                        break
                    channel.sendall(data)
        except Exception:
            pass
        finally:
            upstream.close()
            channel.close()

    @staticmethod
    def _echo(channel):
        try:
            while True:
                data = channel.recv(65536)
                if not data:
                    break
                channel.sendall(data.upper())
        except Exception:
            pass
        finally:
            channel.close()

    def close(self):
        self.listener.close()
        for transport in self.transports:
            transport.close()


@pytest.fixture
def ssh_server(host_key, client_key):
    server = SshTestServer(host_key, client_key)
    yield server
    server.close()


def make_tunnel(server, client_key, host_key_line=None, key=None):
    buffer = io.StringIO()
    (key or client_key).write_private_key(buffer)
    cfg = TunnelConfig(host="127.0.0.1", port=server.port, user="tunnel", key_ssm="/unused", host_key=host_key_line)
    return dbmod.SshTunnel(cfg, "10.0.0.5", 5432, key_loader=lambda c: buffer.getvalue(), timeout=5)


def roundtrip(port: int, payload: bytes) -> bytes:
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        sock.sendall(payload)
        received = b""
        while len(received) < len(payload):
            chunk = sock.recv(65536)
            if not chunk:
                break
            received += chunk
        return received


def test_tunnel_forwards_through_pinned_server(ssh_server, host_key, client_key):
    tunnel = make_tunnel(ssh_server, client_key, key_line(host_key))
    try:
        port = tunnel.start()
        assert tunnel.is_active() and port == tunnel.local_port
        assert tunnel._server.server_address[0] == "127.0.0.1"          # never 0.0.0.0
        assert roundtrip(port, b"select 1") == b"SELECT 1"
        big = b"abc" * 100_000
        assert roundtrip(port, big) == big.upper()                       # second connection, larger than one read
        assert ssh_server.interface.destinations == [("10.0.0.5", 5432)] * 2
    finally:
        tunnel.stop()
    assert not tunnel.is_active()
    with pytest.raises(OSError):
        socket.create_connection(("127.0.0.1", port), timeout=1)


def test_tunnel_refuses_wrong_host_key_before_authenticating(ssh_server, other_key, client_key):
    tunnel = make_tunnel(ssh_server, client_key, key_line(other_key))
    with pytest.raises(dbmod.HostKeyMismatch):
        tunnel.start()
    assert ssh_server.interface.auth_attempts == 0                       # our key was never offered
    assert not tunnel.is_active()
    with pytest.raises(dbmod.TunnelError):
        tunnel.local_port


def test_tunnel_refuses_when_pinned_key_type_is_not_offered(ssh_server, client_key):
    ed25519_pin = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPVnN0hW6L7Ue9eLQkNq5vqUOXWbdC5oVnTqVFkd0Wst"
    tunnel = make_tunnel(ssh_server, client_key, ed25519_pin)
    with pytest.raises((paramiko.SSHException, dbmod.TunnelError, EOFError)):
        tunnel.start()
    assert ssh_server.interface.auth_attempts == 0 and not tunnel.is_active()


def test_tunnel_malformed_pin_never_connects(ssh_server, client_key):
    tunnel = make_tunnel(ssh_server, client_key, "ssh-ed25519 definitely-not-a-key")
    with pytest.raises(dbmod.TunnelError):
        tunnel.start()
    assert ssh_server.transports == []


def test_tunnel_without_pin_warns_once(ssh_server, client_key, caplog, monkeypatch):
    monkeypatch.setattr(dbmod, "_warned_unpinned", False)
    with caplog.at_level(logging.WARNING, logger="eisenmail.db"):
        for _ in range(2):
            tunnel = make_tunnel(ssh_server, client_key, None)
            try:
                assert roundtrip(tunnel.start(), b"ping") == b"PING"
            finally:
                tunnel.stop()
    warnings = [r for r in caplog.records if "SSH_TUNNEL_HOST_KEY is not set" in r.getMessage()]
    assert len(warnings) == 1


def test_tunnel_rejected_client_key(ssh_server, host_key, other_key, client_key):
    tunnel = make_tunnel(ssh_server, client_key, key_line(host_key), key=other_key)
    with pytest.raises(paramiko.SSHException):
        tunnel.start()
    assert not tunnel.is_active()
