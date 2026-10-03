import logging

import pytest

import config

BASE = {
    "FORWARD_TO": "Owner.Private@Mailbox.Example, second@private.example ,",
    "MAIL_BUCKET": "mail-bucket",
    "POSTGRES_DB_HOST": "db.internal",
    "POSTGRES_DB_NAME": "emails",
    "POSTGRES_DB_USER": "mail",
    "POSTGRES_DB_PASSWORD": "s3cret",
}


def test_defaults():
    cfg = config.load(BASE)
    assert cfg.forward_to == ("owner.private@mailbox.example", "second@private.example")
    assert cfg.owner_addresses == cfg.forward_to            # default
    assert cfg.private_addresses == cfg.forward_to
    assert cfg.mail_bucket == "mail-bucket" and cfg.mail_prefix == "email-inbox/"
    assert cfg.mail_domains == () and cfg.fallback_domain is None
    assert not hasattr(cfg, "forward_style")                 # per-address rule now, not a setting
    assert cfg.db == config.DbConfig("db.internal", 5432, "emails", "mail", "s3cret", None)
    assert cfg.tunnel is None


def test_everything_set():
    cfg = config.load({
        **BASE,
        "OWNER_ADDRESSES": "Owner@Private.Example",
        "MAIL_PREFIX": "inbox/",
        "MAIL_DOMAINS": "Eisenberg.dev, second.example",
        "POSTGRES_DB_PORT": "6543",
        "POSTGRES_DB_SSLMODE": "require",
        "SSH_TUNNEL_HOST": "bastion.internal",
        "SSH_TUNNEL_PORT": "2222",
        "SSH_TUNNEL_USER": "tunnel",
        "SSH_TUNNEL_KEY_SSM": "/eisenmail/tunnel-key",
        "SSH_TUNNEL_HOST_KEY": "ssh-ed25519 AAAA",
    })
    assert cfg.owner_addresses == ("owner@private.example",)
    assert cfg.private_addresses == ("owner@private.example", "owner.private@mailbox.example", "second@private.example")
    assert cfg.mail_prefix == "inbox/"
    assert cfg.mail_domains == ("eisenberg.dev", "second.example") and cfg.fallback_domain == "eisenberg.dev"
    assert (cfg.db.port, cfg.db.sslmode) == (6543, "require")
    assert cfg.tunnel == config.TunnelConfig(host="bastion.internal", user="tunnel", port=2222,
                                             key_ssm="/eisenmail/tunnel-key", key_path=None,
                                             host_key="ssh-ed25519 AAAA")


def test_tunnel_defaults_and_legacy_key_path():
    cfg = config.load({**BASE, "SSH_TUNNEL_HOST": "bastion", "SSH_TUNNEL_USER": "u", "SSH_TUNNEL_KEY_PATH": "/k",
                       "SSH_TUNNEL_ALLOW_UNPINNED": "1"})
    assert (cfg.tunnel.port, cfg.tunnel.key_path, cfg.tunnel.key_ssm, cfg.tunnel.host_key) == (22, "/k", None, None)


@pytest.mark.parametrize("missing", ["FORWARD_TO", "MAIL_BUCKET", "POSTGRES_DB_HOST", "POSTGRES_DB_NAME",
                                     "POSTGRES_DB_USER", "POSTGRES_DB_PASSWORD"])
def test_required_settings(missing):
    env = {k: v for k, v in BASE.items() if k != missing}
    with pytest.raises(config.ConfigError, match=missing):
        config.load(env)


@pytest.mark.parametrize("extra,match", [
    ({"FORWARD_TO": "not-an-address"}, "FORWARD_TO"),
    ({"OWNER_ADDRESSES": "a@b, @nope"}, "OWNER_ADDRESSES"),
    ({"MAIL_DOMAINS": "eisenberg.dev, private.example"}, "mail loop"),
    ({"POSTGRES_DB_PORT": "abc"}, "POSTGRES_DB_PORT"),
    ({"POSTGRES_DB_PORT": "70000"}, "POSTGRES_DB_PORT"),
    ({"SSH_TUNNEL_HOST": "bastion", "SSH_TUNNEL_KEY_SSM": "/k"}, "SSH_TUNNEL_USER"),
    ({"SSH_TUNNEL_HOST": "bastion", "SSH_TUNNEL_USER": "u"}, "exactly one"),
    ({"SSH_TUNNEL_HOST": "bastion", "SSH_TUNNEL_USER": "u", "SSH_TUNNEL_KEY_SSM": "/k",
      "SSH_TUNNEL_KEY_PATH": "/p"}, "exactly one"),
])
def test_invalid_settings(extra, match):
    with pytest.raises(config.ConfigError, match=match):
        config.load({**BASE, **extra})


def test_error_messages_never_contain_values():
    with pytest.raises(config.ConfigError) as error:
        config.load({**BASE, "FORWARD_TO": "secret-but-broken"})
    assert "secret-but-broken" not in str(error.value)


def test_load_reads_os_environ_by_default(monkeypatch):
    for key, value in BASE.items():
        monkeypatch.setenv(key, value)
    for key in ("OWNER_ADDRESSES", "MAIL_PREFIX", "MAIL_DOMAINS", "FORWARD_STYLE", "SSH_TUNNEL_HOST",
                "POSTGRES_DB_PORT", "POSTGRES_DB_SSLMODE", "POSTGRES_DB_PASSWORD_SSM", "VAPID_PRIVATE_KEY",
                "VAPID_PRIVATE_KEY_SSM"):
        monkeypatch.delenv(key, raising=False)
    assert config.load().mail_bucket == "mail-bucket"


def test_tunnel_requires_a_pinned_host_key():
    env = {**BASE, "SSH_TUNNEL_HOST": "bastion", "SSH_TUNNEL_USER": "u", "SSH_TUNNEL_KEY_SSM": "/k"}
    with pytest.raises(config.ConfigError, match="SSH_TUNNEL_HOST_KEY"):
        config.load(env)
    assert config.load({**env, "SSH_TUNNEL_HOST_KEY": "ssh-ed25519 AAAA"}).tunnel.host_key == "ssh-ed25519 AAAA"


# ------------------------------------------------------------------------------------------
# web push
# ------------------------------------------------------------------------------------------
VAPID = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"      # base64url of bytes 1..32


def test_push_is_off_without_a_key():
    assert config.load(BASE).push is None
    assert config.load({**BASE, "VAPID_SUBJECT": "mailto:x@y.example", "PUSH_ENDPOINT_ALLOW": "a.example"}).push is None


def test_push_settings():
    cfg = config.load({**BASE, "VAPID_PRIVATE_KEY": VAPID})
    assert cfg.push == config.PushConfig(vapid_private_key=VAPID)
    assert cfg.push.subject is None and cfg.push.endpoint_allow == ()

    cfg = config.load({**BASE, "VAPID_PRIVATE_KEY_SSM": "/eisenmail/vapid", "VAPID_SUBJECT": "mailto:me@eisenberg.dev",
                       "PUSH_ENDPOINT_ALLOW": "Push.Internal.Example, 127.0.0.1"})
    assert cfg.push.vapid_private_key is None and cfg.push.vapid_private_key_ssm == "/eisenmail/vapid"
    assert cfg.push.subject == "mailto:me@eisenberg.dev"
    assert cfg.push.endpoint_allow == ("push.internal.example", "127.0.0.1")
    assert config.load({**BASE, "VAPID_PRIVATE_KEY": VAPID + "=", "VAPID_SUBJECT": "https://eisenberg.dev/contact"}).push


@pytest.mark.parametrize("extra,match", [
    ({"VAPID_PRIVATE_KEY": VAPID, "VAPID_PRIVATE_KEY_SSM": "/k"}, "at most one"),
    ({"VAPID_PRIVATE_KEY": "too-short"}, "VAPID_PRIVATE_KEY"),
    ({"VAPID_PRIVATE_KEY": VAPID + "AAAA"}, "VAPID_PRIVATE_KEY"),
    ({"VAPID_PRIVATE_KEY": "-----BEGIN EC PRIVATE KEY-----"}, "VAPID_PRIVATE_KEY"),
    ({"VAPID_PRIVATE_KEY": VAPID, "VAPID_SUBJECT": "postmaster@eisenberg.dev"}, "VAPID_SUBJECT"),
    ({"VAPID_PRIVATE_KEY": VAPID, "VAPID_SUBJECT": "http://eisenberg.dev"}, "VAPID_SUBJECT"),
    ({"VAPID_PRIVATE_KEY": VAPID, "PUSH_ENDPOINT_ALLOW": "https://evil.example/x"}, "PUSH_ENDPOINT_ALLOW"),
    ({"VAPID_PRIVATE_KEY": VAPID, "PUSH_ENDPOINT_ALLOW": "*.example"}, "PUSH_ENDPOINT_ALLOW"),
])
def test_invalid_push_settings(extra, match):
    with pytest.raises(config.ConfigError, match=match):
        config.load({**BASE, **extra})


def test_the_vapid_key_never_shows_up_in_reprs_or_errors():
    cfg = config.load({**BASE, "VAPID_PRIVATE_KEY": VAPID})
    assert VAPID not in repr(cfg) and VAPID not in repr(cfg.push)
    with pytest.raises(config.ConfigError) as error:
        config.load({**BASE, "VAPID_PRIVATE_KEY": "secret-but-broken"})
    assert "secret-but-broken" not in str(error.value)


def test_no_environment_variable_enables_plain_http_push():
    import push
    env = {**BASE, "VAPID_PRIVATE_KEY": VAPID, "PUSH_ENDPOINT_ALLOW": "127.0.0.1,localhost",
           "PUSH_ALLOW_HTTP": "1", "PUSH_ALLOW_INSECURE": "1", "ALLOW_INSECURE_LOOPBACK": "1"}
    notifier = push.PushNotifier(config.load(env).push)
    assert notifier._allow_insecure_loopback is False
    assert push.check_endpoint("http://127.0.0.1:8080/x", notifier.cfg.endpoint_allow) == "not https"


# ------------------------------------------------------------------------------------------
# FORWARD_STYLE is gone
# ------------------------------------------------------------------------------------------
def test_forward_style_env_is_ignored_with_one_warning(caplog, monkeypatch):
    monkeypatch.setattr(config, "_warned_forward_style", False)
    with caplog.at_level(logging.WARNING, logger="eisenmail.config"):
        for value in ("attach", "fancy", "inline"):                  # not validated any more either
            cfg = config.load({**BASE, "FORWARD_STYLE": value})
            assert not hasattr(cfg, "forward_style")
    warnings = [r.getMessage() for r in caplog.records if "FORWARD_STYLE" in r.getMessage()]
    assert len(warnings) == 1 and "per address" in warnings[0]


def test_no_warning_without_forward_style(caplog, monkeypatch):
    monkeypatch.setattr(config, "_warned_forward_style", False)
    with caplog.at_level(logging.WARNING, logger="eisenmail.config"):
        config.load(BASE)
        config.load({**BASE, "FORWARD_STYLE": "  "})
    assert caplog.records == []


# ------------------------------------------------------------------------------------------
# database password
# ------------------------------------------------------------------------------------------
def test_database_password_from_ssm():
    env = {k: v for k, v in BASE.items() if k != "POSTGRES_DB_PASSWORD"}
    cfg = config.load({**env, "POSTGRES_DB_PASSWORD_SSM": "/eisenmail/db-password"})
    assert cfg.db.password is None and cfg.db.password_ssm == "/eisenmail/db-password"


def test_exactly_one_database_password_source():
    env = {k: v for k, v in BASE.items() if k != "POSTGRES_DB_PASSWORD"}
    for extra in ({}, {"POSTGRES_DB_PASSWORD": "pw", "POSTGRES_DB_PASSWORD_SSM": "/p"}, {"POSTGRES_DB_PASSWORD": " "}):
        with pytest.raises(config.ConfigError, match="exactly one of POSTGRES_DB_PASSWORD / POSTGRES_DB_PASSWORD_SSM"):
            config.load({**env, **extra})
    with pytest.raises(config.ConfigError):
        config.DbConfig("h", 5432, "n", "u", password="pw", password_ssm="/p")


def test_the_database_password_never_shows_up_in_reprs():
    cfg = config.load(BASE)
    assert cfg.db.password == "s3cret"
    assert "s3cret" not in repr(cfg) and "s3cret" not in repr(cfg.db)
