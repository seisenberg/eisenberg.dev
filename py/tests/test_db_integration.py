"""Opt-in: db.Database against a real Postgres with db/schema.sql applied.

    EISENMAIL_TEST_DSN=postgresql://user:pw@127.0.0.1:5432/throwaway .venv/bin/python -m pytest -q tests/test_db_integration.py

Use a THROWAWAY database: the schema is applied to it (idempotent) and rows are inserted and
deleted. Skipped when EISENMAIL_TEST_DSN is not set.
"""
import os
import pathlib
import uuid

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict

import db as dbmod
from config import DbConfig

DSN = os.environ.get("EISENMAIL_TEST_DSN")
pytestmark = pytest.mark.skipif(not DSN, reason="EISENMAIL_TEST_DSN not set")

SCHEMA = pathlib.Path(__file__).resolve().parents[2] / "db" / "schema.sql"


@pytest.fixture
def database():
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute(SCHEMA.read_text())
    info = conninfo_to_dict(DSN)
    cfg = DbConfig(host=info.get("host", "127.0.0.1"), port=int(info.get("port", 5432)), name=info["dbname"],
                   user=info["user"], password=info.get("password", ""), sslmode=info.get("sslmode"))
    database = dbmod.Database(cfg)
    yield database
    database.close()


@pytest.fixture
def ids():
    prefix = f"it-{uuid.uuid4().hex}"
    yield prefix
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("delete from relay_tokens where token like %s or inbox_message_id like %s",
                     [prefix[3:] + "%", prefix + "%"])
        conn.execute("delete from lambda_inbox where message_id like %s", [prefix + "%"])


def test_full_round_trip(database, ids):
    inbound_id = f"{ids}-in"
    raw = bytes(range(256)) + b"\x00 raw mime"
    event = {"mail": {"messageId": inbound_id, "note": "nul \u0000 inside"}, "receipt": {"recipients": ["a@b"]}}

    assert database.get_inbox_meta(inbound_id) is None
    assert database.insert_inbox(inbound_id, "email-inbox/x", event, raw, "inbound") is True
    assert database.insert_inbox(inbound_id, "email-inbox/x", event, raw, "inbound") is False
    assert database.get_inbox_meta(inbound_id) == {"kind": "inbound", "meta": {}}
    database.merge_inbox_meta(inbound_id, {"forwarded": True})
    database.merge_inbox_meta(inbound_id, {"other": 1})
    assert database.get_inbox_meta(inbound_id) == {"kind": "inbound", "meta": {"forwarded": True, "other": 1}}

    token = ids[3:]                       # 32 hex chars
    assert len(token) == 32
    assert database.get_token(token) is None and database.find_token_for_message(inbound_id) is None
    fields = dict(token=token, inbox_message_id=inbound_id, alias_address="cool@eisenberg.dev",
                  correspondent="bob@sender.example", correspondent_name="Bob", orig_message_id="<m@x>",
                  orig_references="<r@x>", subject="Hello")
    database.create_token(**fields)
    database.create_token(**fields)        # idempotent
    assert database.get_token(token) == fields
    assert database.find_token_for_message(inbound_id) == fields
    database.touch_token(token)
    database.touch_token(token)

    relay_id = f"{ids}-relay"
    meta = {"from": "cool@eisenberg.dev", "to": ["bob@sender.example"], "cc": [], "bcc": [],
            "in_reply_to_raw_id": inbound_id, "relay_source_id": f"{ids}-src"}
    assert database.relay_already_sent(f"{ids}-src") is False
    assert database.insert_inbox(relay_id, None, event, b"rewritten", "relay_out", meta) is True
    assert database.relay_already_sent(f"{ids}-src") is True
    assert database.relay_already_sent(inbound_id) is False
    assert database.insert_inbox(f"{ids}-junk", "k", event, raw, "junk") is True

    with psycopg.connect(DSN) as conn:
        row = conn.execute("select kind, s3_key, event, email_raw, meta, processed_at from lambda_inbox "
                           "where message_id = %s", [inbound_id]).fetchone()
        assert row[0] == "inbound" and row[1] == "email-inbox/x" and bytes(row[3]) == raw and row[5] is None
        assert row[2] == {"mail": {"messageId": inbound_id, "note": "nul  inside"}, "receipt": {"recipients": ["a@b"]}}
        relay_row = conn.execute("select kind, meta, email_raw, s3_key from lambda_inbox where message_id = %s",
                                 [relay_id]).fetchone()
        assert relay_row[0] == "relay_out" and relay_row[1] == meta and bytes(relay_row[2]) == b"rewritten"
        assert relay_row[3] is None
        used = conn.execute("select use_count, last_used_at is not null from relay_tokens where token = %s",
                            [token]).fetchone()
        assert used == (2, True)


def test_address_rules_are_materialised_from_the_defaults(database, ids):
    first, second, third = (f"{ids}-{n}@eisenberg.dev" for n in ("a", "b", "c"))

    def rule(forward, notify, style):
        return {"forward": forward, "notify": notify, "forward_style": style}

    with psycopg.connect(DSN, autocommit=True) as conn:
        saved = conn.execute("select default_forward, default_notify, default_forward_style from mail_settings").fetchone()
        try:
            conn.execute("update mail_settings set default_forward = true, default_notify = false, "
                         "default_forward_style = 'attach'")
            assert database.get_mail_defaults() == rule(True, False, "attach")
            assert database.resolve_address_rule(first) == rule(True, False, "attach")

            conn.execute("update mail_settings set default_forward = false, default_notify = true, "
                         "default_forward_style = 'inline'")
            assert database.resolve_address_rule(first) == rule(True, False, "attach")     # existing row kept
            assert database.resolve_address_rule(second) == rule(False, True, "inline")    # new row, new defaults

            conn.execute("update address_rules set forward = false, notify = false, forward_style = 'inline' "
                         "where address = %s", [first])
            assert database.resolve_address_rule(first) == rule(False, False, "inline")    # webmail edit wins

            conn.execute("delete from mail_settings")                                      # "should not happen"
            assert database.get_mail_defaults() == rule(True, True, "inline")
            assert database.resolve_address_rule(third) == rule(True, True, "inline")
            assert conn.execute("select count(*) from address_rules where address = %s", [third]).fetchone() == (0,)
            assert database.resolve_address_rule(second) == rule(False, True, "inline")
        finally:
            conn.execute("delete from mail_settings")
            conn.execute("insert into mail_settings (id, default_forward, default_notify, default_forward_style) "
                         "values (true, %s, %s, %s)", saved or (True, True, "inline"))
            conn.execute("delete from address_rules where address like %s", [ids + "%"])


def test_rotated_password_is_refetched_from_ssm(ids):
    """A role whose password changes under a live Database, with a fake SSM handing out the values.
    Skipped where the server does not check passwords (trust auth) or roles cannot be created."""
    info = conninfo_to_dict(DSN)
    role = "eisenmail_it_" + ids[3:15]
    host, port = info.get("host", "127.0.0.1"), int(info.get("port", 5432))
    with psycopg.connect(DSN, autocommit=True) as admin:
        try:
            admin.execute(f"create role {role} login password 'first-pw'")
        except psycopg.errors.InsufficientPrivilege:
            pytest.skip("cannot create roles with this DSN")
        try:
            admin.execute(f"grant select, insert, update, delete on all tables in schema public to {role}")
            try:
                psycopg.connect(host=host, port=port, dbname=info["dbname"], user=role, password="wrong",
                                connect_timeout=5).close()
                pytest.skip("server accepts any password (trust authentication)")
            except psycopg.OperationalError as exc:
                assert dbmod.is_auth_failure(exc)                      # the real error is recognised

            fetched = []

            def fake_ssm(cfg):
                fetched.append(cfg.password_ssm)
                return "first-pw" if len(fetched) == 1 else "second-pw"

            cfg = DbConfig(host=host, port=port, name=info["dbname"], user=role, password_ssm="/eisenmail/db-password")
            database = dbmod.Database(cfg, password_loader=fake_ssm)
            try:
                assert database.relay_already_sent(f"{ids}-x") is False
                assert database.relay_already_sent(f"{ids}-x") is False
                assert len(fetched) == 1                                # cached

                admin.execute(f"alter role {role} password 'second-pw'")
                admin.execute("select pg_terminate_backend(pid) from pg_stat_activity where usename = %s", [role])
                # connection dropped -> reconnect with the cached password is refused -> the parameter
                # is fetched again -> the same statement succeeds
                assert database.relay_already_sent(f"{ids}-x") is False
                assert database.relay_already_sent(f"{ids}-x") is False
                assert len(fetched) == 2
            finally:
                database.close()
        finally:
            admin.execute(f"drop owned by {role}")
            admin.execute(f"drop role {role}")


def test_push_subscription_bookkeeping(database, ids):
    endpoints = [f"https://fcm.googleapis.com/fcm/send/{ids}-{n}" for n in range(3)]
    with psycopg.connect(DSN, autocommit=True) as conn:
        try:
            for n, endpoint in enumerate(endpoints):
                conn.execute("insert into push_subscriptions (endpoint, p256dh, auth, user_id, failure_count) "
                             "values (%s, %s, %s, 1, %s)", [endpoint, f"p{n}", f"a{n}", 3 - n])
            listed = [r for r in database.list_push_subscriptions(20) if r["endpoint"] in endpoints]
            assert [r["endpoint"] for r in listed] == endpoints[::-1]                # healthiest first
            assert listed[0] == {"endpoint": endpoints[2], "p256dh": "p2", "auth": "a2"}
            assert len(database.list_push_subscriptions(1)) == 1

            database.push_failed(endpoints[0])
            database.push_succeeded(endpoints[1])
            database.delete_push_subscription(endpoints[2])
            database.delete_push_subscription(endpoints[2])                          # already gone: fine
            rows = conn.execute("select endpoint, failure_count, last_success_at is not null from push_subscriptions "
                                "where endpoint like %s order by endpoint", [f"%{ids}%"]).fetchall()
            assert rows == [(endpoints[0], 4, False), (endpoints[1], 0, True)]
        finally:
            conn.execute("delete from push_subscriptions where endpoint like %s", [f"%{ids}%"])


def test_reconnects_after_the_server_kills_the_connection(database, ids):
    assert database.relay_already_sent(f"{ids}-nothing") is False
    with psycopg.connect(DSN, autocommit=True) as admin:
        admin.execute("select pg_terminate_backend(%s)", [database._conn.info.backend_pid])
    assert database.insert_inbox(f"{ids}-after", None, {"a": 1}, b"x", "junk") is True     # reconnected, retried


def test_database_through_the_ssh_tunnel(ids):
    """psycopg -> 127.0.0.1:<ephemeral> -> SshTunnel -> in-process sshd -> the real Postgres."""
    import io

    import paramiko

    from config import TunnelConfig
    from test_db import SshTestServer, key_line

    host_key, client_key = paramiko.ECDSAKey.generate(), paramiko.ECDSAKey.generate()
    server = SshTestServer(host_key, client_key, forward=True)
    buffer = io.StringIO()
    client_key.write_private_key(buffer)
    info = conninfo_to_dict(DSN)
    cfg = DbConfig(host=info.get("host", "127.0.0.1"), port=int(info.get("port", 5432)), name=info["dbname"],
                   user=info["user"], password=info.get("password", ""))
    tunnel_cfg = TunnelConfig(host="127.0.0.1", port=server.port, user="tunnel", key_ssm="/unused",
                              host_key=key_line(host_key))
    database = dbmod.Database(
        cfg, tunnel_cfg,
        tunnel_factory=lambda c, host, port: dbmod.SshTunnel(c, host, port, key_loader=lambda _: buffer.getvalue()),
    )
    try:
        raw = bytes(range(256)) * 2000                                    # ~0.5 MB through the tunnel
        assert database.insert_inbox(f"{ids}-tunnel", None, {"via": "tunnel"}, raw, "junk") is True
        assert database.get_inbox_meta(f"{ids}-tunnel") == {"kind": "junk", "meta": {}}
        assert server.interface.destinations[0] == (cfg.host, cfg.port)
        # tunnel dies (Lambda freeze / bastion restart): next statement rebuilds tunnel + connection
        first_port = database._tunnel.local_port
        for transport in server.transports:
            transport.close()
        assert database.insert_inbox(f"{ids}-tunnel-2", None, {"via": "tunnel"}, b"x", "junk") is True
        assert database._tunnel.is_active() and len(server.transports) == 2
    finally:
        database.close()
        server.close()
