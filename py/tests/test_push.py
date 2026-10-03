"""push.py: endpoint allow-list, payload, result handling, and the real pywebpush code path."""
import base64
import http.server
import json
import logging
import threading
import time

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

import push
import relay
from config import PushConfig
from helpers import ALIAS, FakeDB, simple_message

FCM = "https://fcm.googleapis.com/fcm/send/SECRET-PATH-1"
APPLE = "https://web.push.apple.com/SECRET-PATH-2"
MOZILLA = "https://updates.push.services.mozilla.com/wpush/v2/SECRET-PATH-3"
WINDOWS = "https://wns2-by3p.notify.windows.com/w/?token=SECRET%2fPATH-4"


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64u_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def new_vapid_key() -> tuple[str, ec.EllipticCurvePrivateKey]:
    key = ec.generate_private_key(ec.SECP256R1())
    return b64u(key.private_numbers().private_value.to_bytes(32, "big")), key


VAPID_KEY, VAPID_PRIVATE = new_vapid_key()


class FakeSend:
    """Stands in for the network call: records every request, answers from a script."""

    def __init__(self, *answers, default=201):
        self.answers, self.default, self.calls = list(answers), default, []

    def __call__(self, subscription, payload, *, subject, ttl, timeout):
        self.calls.append(dict(subscription=subscription, payload=payload, subject=subject, ttl=ttl, timeout=timeout))
        answer = self.answers.pop(0) if self.answers else self.default
        if isinstance(answer, BaseException):
            raise answer
        return answer

    @property
    def endpoints(self):
        return [c["subscription"]["endpoint"] for c in self.calls]


def notifier(send, **kwargs):
    cfg = kwargs.pop("cfg", None) or PushConfig(vapid_private_key=VAPID_KEY, endpoint_allow=kwargs.pop("allow", ()))
    return push.PushNotifier(cfg, send=send, **kwargs)


@pytest.fixture
def db():
    return FakeDB()


# ------------------------------------------------------------------------------------------
# SSRF guard
# ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("endpoint", [FCM, APPLE, MOZILLA, WINDOWS,
                                      "https://FCM.GoogleApis.com/fcm/send/x",
                                      "https://fcm.googleapis.com:443/fcm/send/x",
                                      "https://api.push.apple.com/3/device/x"])
def test_known_push_services_are_allowed(endpoint):
    assert push.check_endpoint(endpoint) is None


@pytest.mark.parametrize("endpoint,reason", [
    ("http://fcm.googleapis.com/fcm/send/x", "not https"),
    ("https://evil.example/fcm.googleapis.com/x", "host not allowed"),
    ("https://fcm.googleapis.com.evil.example/x", "host not allowed"),
    ("https://evilfcm.googleapis.com/x", "host not allowed"),
    ("https://googleapis.com/x", "host not allowed"),
    ("https://apple.com/x", "host not allowed"),
    ("https://169.254.169.254/latest/meta-data/", "host not allowed"),
    ("https://localhost/x", "host not allowed"),
    ("https://127.0.0.1/x", "host not allowed"),
    ("https://fcm.googleapis.com:8443/x", "port not allowed"),
    ("https://fcm.googleapis.com@evil.example/x", "malformed endpoint"),
    ("https://user:pw@fcm.googleapis.com/x", "malformed endpoint"),
    ("https://evil.example\\@fcm.googleapis.com/x", "malformed endpoint"),
    ("https://fcm.googleapis.com\\.evil.example/x", "malformed endpoint"),
    ("https://evil.example#@fcm.googleapis.com/x", "malformed endpoint"),
    ("https://evil.example?fcm.googleapis.com/x", "malformed endpoint"),
    ("https://fcm.googleapis.com", "malformed endpoint"),
    ("https://fcm.googleapis.com/a b", "malformed endpoint"),
    ("https://fcm.googleapis.com/a\r\nHost: evil.example", "malformed endpoint"),
    ("https://fcm..googleapis.com/x", "malformed endpoint"),
    ("https://[::1]/x", "malformed endpoint"),
    ("ftp://fcm.googleapis.com/x", "malformed endpoint"),
    ("file:///etc/passwd", "malformed endpoint"),
    ("//fcm.googleapis.com/x", "malformed endpoint"),
    ("", "malformed endpoint"),
    (None, "malformed endpoint"),
])
def test_everything_else_is_refused(endpoint, reason):
    assert push.check_endpoint(endpoint) == reason


def test_extra_allowed_suffixes_and_the_test_only_http_switch():
    assert push.check_endpoint("https://push.internal.example/x", ("internal.example",)) is None
    assert push.check_endpoint("https://push.internal.example:8443/x", ("internal.example",)) is None
    assert push.check_endpoint("https://internal.example.evil.example/x", ("internal.example",)) == "host not allowed"
    # plain http: never from configuration alone ...
    assert push.check_endpoint("http://127.0.0.1:8080/x", ("127.0.0.1",)) == "not https"
    assert push.check_endpoint("http://push.internal.example/x", ("internal.example",)) == "not https"
    # ... only with the constructor switch, only for loopback, only when loopback is allow-listed
    assert push.check_endpoint("http://127.0.0.1:8080/x", ("127.0.0.1",), allow_insecure_loopback=True) is None
    assert push.check_endpoint("http://127.0.0.1:8080/x", (), allow_insecure_loopback=True) == "host not allowed"
    assert push.check_endpoint("http://push.internal.example/x", ("internal.example",),
                               allow_insecure_loopback=True) == "not https"
    assert push.check_endpoint("http://fcm.googleapis.com/x", ("127.0.0.1",), allow_insecure_loopback=True) == "not https"


def test_endpoint_host_never_returns_the_path():
    assert push.endpoint_host(FCM) == "fcm.googleapis.com"
    assert push.endpoint_host("https://user:secret@evil.example/x") == "(malformed)"
    assert push.endpoint_host(None) == "(malformed)"


# ------------------------------------------------------------------------------------------
# payload
# ------------------------------------------------------------------------------------------
def payload_for(raw: bytes, alias: str = ALIAS, message_id: str = "ses-in-1") -> dict:
    text = push.build_payload(relay.parse(raw), alias, message_id)
    assert len(text.encode("utf-8")) < 2048
    return json.loads(text)


def test_payload_content():
    assert payload_for(simple_message(subject="Hello about the bike")) == {
        "title": "Bob Smith",
        "body": "Hello about the bike",
        "address": ALIAS,
        "url": "/mail?box=inbox&address=cool_stuff%40eisenberg.dev",
        "tag": "ses-in-1",
    }


def test_payload_sender_falls_back_to_address_then_placeholder():
    assert payload_for(simple_message(from_header="bob@sender.example"))["title"] == "bob@sender.example"
    assert payload_for(simple_message(from_header=""))["title"] == "unknown sender"


def test_payload_decodes_rfc2047_sender_and_subject():
    raw = simple_message(from_header="=?utf-8?b?SsO8cmdlbiBNw7xsbGVy?= <j@sender-de.example>",
                         subject="=?iso-8859-1?q?Gr=FC=DFe_aus_K=F6ln?=")
    payload = payload_for(raw)
    assert payload["title"] == "Jürgen Müller" and payload["body"] == "Grüße aus Köln"


def test_payload_strips_control_characters():
    raw = simple_message(
        from_header="=?utf-8?q?Evil=0D=0A=00=1B=5B31m_=22Name=22_=3Cx=3E?= <evil@sender.example>",
        subject="=?utf-8?q?line1=0D=0Aline2=00=07=09tab=E2=80=A8sep?=",
    )
    text = push.build_payload(relay.parse(raw), ALIAS, "id\r\n1")
    payload = json.loads(text)
    assert payload["title"] == "Evil [31m Name x"
    assert payload["body"] == "line1 line2 tab sep"
    assert payload["tag"] == "id 1"
    for value in payload.values():
        assert not any(ord(ch) < 32 or ord(ch) == 127 for ch in value)
    assert "\\r" not in text and "\\n" not in text and "\\u0000" not in text and "\\u001b" not in text


def test_payload_length_caps():
    raw = simple_message(from_header=f"{'N' * 300} <bob@sender.example>", subject="S" * 5000)
    payload = payload_for(raw)
    assert len(payload["title"]) == 80
    assert len(payload["body"]) == 140 and payload["body"].endswith("…") and payload["body"].startswith("SSS")
    assert payload_for(simple_message(subject="S" * 140))["body"] == "S" * 140      # exactly at the cap: untouched


def test_payload_empty_subject():
    assert payload_for(simple_message(subject=""))["body"] == "(no subject)"
    assert payload_for(simple_message(subject="=?utf-8?q?=0D=0A?="))["body"] == "(no subject)"
    raw = b"From: Bob <bob@sender.example>\r\n\r\nno subject header at all\r\n"
    assert payload_for(raw)["body"] == "(no subject)"


def test_payload_stays_under_2kb_with_four_byte_characters():
    emoji_name = "=?utf-8?b?" + base64.b64encode(("😀" * 200).encode()).decode() + "?="
    emoji_subject = "=?utf-8?b?" + base64.b64encode(("🚲" * 600).encode()).decode() + "?="
    alias = "a" * 64 + "+tag@" + "sub." * 40 + "eisenberg.dev"
    text = push.build_payload(relay.parse(simple_message(from_header=f"{emoji_name} <b@sender.example>",
                                                         subject=emoji_subject)), alias, "m" * 300)
    assert len(text.encode("utf-8")) <= push.MAX_PAYLOAD_BYTES
    payload = json.loads(text)
    assert payload["title"].startswith("😀") and payload["body"].startswith("🚲")
    assert payload["address"] == alias and len(payload["tag"]) == 128


def test_payload_url_encodes_the_alias():
    payload = payload_for(simple_message(), alias="a+b&c=d@eisenberg.dev")
    assert payload["address"] == "a+b&c=d@eisenberg.dev"
    assert payload["url"] == "/mail?box=inbox&address=a%2Bb%26c%3Dd%40eisenberg.dev"


# ------------------------------------------------------------------------------------------
# result handling (fake sender)
# ------------------------------------------------------------------------------------------
def test_success_resets_failure_count(db):
    db.add_subscription(FCM, p256dh="P", auth="A", failure_count=3)
    send = FakeSend(201)
    counts = notifier(send).notify(db, '{"title":"x"}', "eisenberg.dev")
    assert counts == {"sent": 1, "gone": 0, "failed": 0, "skipped": 0}
    assert send.calls == [dict(subscription={"endpoint": FCM, "keys": {"p256dh": "P", "auth": "A"}},
                               payload='{"title":"x"}', subject="mailto:postmaster@eisenberg.dev",
                               ttl=86400, timeout=5.0)]
    assert db.push_subscriptions[FCM]["failure_count"] == 0 and db.push_subscriptions[FCM]["last_success_at"] == "now"


@pytest.mark.parametrize("status", [200, 201, 202, 204])
def test_any_2xx_is_success(db, status):
    db.add_subscription(FCM)
    assert notifier(FakeSend(status)).notify(db, "{}", "d")["sent"] == 1


@pytest.mark.parametrize("status", [404, 410])
def test_gone_subscription_is_deleted(db, status):
    db.add_subscription(FCM)
    db.add_subscription(APPLE, failure_count=1)
    counts = notifier(FakeSend(status, 201)).notify(db, "{}", "d")
    assert counts == {"sent": 1, "gone": 1, "failed": 0, "skipped": 0}
    assert list(db.push_subscriptions) == [APPLE]


@pytest.mark.parametrize("answer", [500, 502, 429, 400, 401, 403, 413, 301, 307,
                                    TimeoutError("timed out"), ConnectionError("reset"), ValueError("bad p256dh")])
def test_other_failures_increment_failure_count(db, answer, caplog):
    db.add_subscription(FCM, failure_count=2)
    db.add_subscription(MOZILLA, failure_count=5)
    with caplog.at_level(logging.DEBUG, logger="eisenmail.push"):
        counts = notifier(FakeSend(answer, 201)).notify(db, '{"body":"PAYLOAD-TEXT"}', "d")
    assert counts == {"sent": 1, "gone": 0, "failed": 1, "skipped": 0}
    assert db.push_subscriptions[FCM]["failure_count"] == 3 and db.push_subscriptions[FCM]["last_success_at"] is None
    assert db.push_subscriptions[MOZILLA]["failure_count"] == 0
    assert "fcm.googleapis.com" in caplog.text
    for secret in ("SECRET-PATH", "PAYLOAD-TEXT", VAPID_KEY, "p256dh-key", "auth-secret", "timed out", "bad p256dh"):
        assert secret not in caplog.text


@pytest.mark.parametrize("endpoint", [
    "https://evil.example/hook",
    "http://fcm.googleapis.com/fcm/send/x",
    "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "https://fcm.googleapis.com@evil.example/x",
    "http://127.0.0.1:8080/x",
])
def test_disallowed_endpoints_are_never_requested(db, endpoint, caplog):
    db.add_subscription(endpoint)
    db.add_subscription(FCM)
    send = FakeSend()
    with caplog.at_level(logging.WARNING, logger="eisenmail.push"):
        counts = notifier(send).notify(db, "{}", "d")
    assert send.endpoints == [FCM]
    assert counts == {"sent": 1, "gone": 0, "failed": 0, "skipped": 1}
    assert db.push_subscriptions[endpoint]["failure_count"] == 0          # untouched: not ours to judge
    assert "skipped" in caplog.text and "/hook" not in caplog.text and "meta-data" not in caplog.text


def test_push_endpoint_allow_extends_the_list_but_not_to_http(db):
    db.add_subscription("https://push.internal.example/x")
    db.add_subscription("http://push.internal.example/y")
    send = FakeSend()
    notifier(send, allow=("internal.example",)).notify(db, "{}", "d")
    assert send.endpoints == ["https://push.internal.example/x"]


def test_time_budget_skips_the_remaining_subscriptions(db):
    for i in range(6):
        db.add_subscription(f"https://fcm.googleapis.com/fcm/send/{i}")
    now = [100.0]

    def slow_send(subscription, payload, *, subject, ttl, timeout):
        timeouts.append(timeout)
        now[0] += 5.0                                   # every request takes 5 seconds
        return 201

    timeouts = []
    counts = notifier(slow_send, clock=lambda: now[0]).notify(db, "{}", "d")
    assert counts == {"sent": 3, "gone": 0, "failed": 0, "skipped": 3}
    assert timeouts == [5.0, 5.0, 2.0]                  # the last request only gets what is left of the 12 s
    assert sum(1 for s in db.push_subscriptions.values() if s["last_success_at"]) == 3


def test_at_most_twenty_subscriptions_per_message(db):
    for i in range(25):
        db.add_subscription(f"https://fcm.googleapis.com/fcm/send/{i:02d}")
    send = FakeSend()
    assert notifier(send).notify(db, "{}", "d")["sent"] == 20
    assert len(send.calls) == 20


def test_no_subscriptions_is_a_no_op(db):
    send = FakeSend()
    assert notifier(send).notify(db, "{}", "d") == {"sent": 0, "gone": 0, "failed": 0, "skipped": 0}
    assert send.calls == []


def test_configured_subject_wins_over_default(db):
    db.add_subscription(FCM)
    send = FakeSend()
    cfg = PushConfig(vapid_private_key=VAPID_KEY, subject="mailto:owner@eisenberg.dev")
    notifier(send, cfg=cfg).notify(db, "{}", "other.example")
    assert send.calls[0]["subject"] == "mailto:owner@eisenberg.dev"


def test_unusable_key_sends_nothing_and_blames_no_subscription(db, caplog):
    db.add_subscription(FCM)
    db.add_subscription(APPLE)
    cfg = PushConfig(vapid_private_key_ssm="/eisenmail/vapid")
    made_requests = []
    notifier_ = push.PushNotifier(cfg, key_loader=lambda c: (_ for _ in ()).throw(push.PushUnavailable("no key")))
    notifier_._send._session = made_requests                        # would blow up if it were ever used
    with caplog.at_level(logging.ERROR, logger="eisenmail.push"):
        counts = notifier_.notify(db, "{}", "d")
    assert counts == {"sent": 0, "gone": 0, "failed": 0, "skipped": 2}
    assert all(s["failure_count"] == 0 for s in db.push_subscriptions.values())
    assert "unavailable" in caplog.text


def test_vapid_key_loading(monkeypatch):
    assert push.load_vapid_key(PushConfig(vapid_private_key=VAPID_KEY)) == VAPID_KEY

    import boto3
    calls = []

    class FakeSSM:
        def __init__(self, value):
            self.value = value

        def get_parameter(self, **kwargs):
            calls.append(kwargs)
            return {"Parameter": {"Value": self.value}}

    monkeypatch.setattr(boto3, "client", lambda name: FakeSSM(VAPID_KEY + "\n"))
    assert push.load_vapid_key(PushConfig(vapid_private_key_ssm="/eisenmail/vapid")) == VAPID_KEY
    assert calls == [{"Name": "/eisenmail/vapid", "WithDecryption": True}]

    monkeypatch.setattr(boto3, "client", lambda name: FakeSSM("-----BEGIN EC PRIVATE KEY-----"))
    with pytest.raises(push.PushUnavailable) as error:
        push.load_vapid_key(PushConfig(vapid_private_key_ssm="/eisenmail/vapid"))
    assert "BEGIN" not in str(error.value)


# ------------------------------------------------------------------------------------------
# the real pywebpush code path against a local HTTP server
# ------------------------------------------------------------------------------------------
class PushService:
    """A push service on 127.0.0.1: records requests, answers with a scripted status."""

    def __init__(self):
        self.requests, self.statuses, self.delay = [], [], 0.0
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                outer.requests.append({"path": self.path, "headers": dict(self.headers.items()), "body": body})
                time.sleep(outer.delay)
                status = outer.statuses.pop(0) if outer.statuses else 201
                self.send_response(status)
                if status in (301, 302, 307, 308):
                    self.send_header("Location", f"http://127.0.0.1:{outer.port}/redirected")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def service():
    server = PushService()
    yield server
    server.close()


class Subscriber:
    """A browser's push subscription: P-256 key pair + auth secret."""

    def __init__(self):
        import os
        self.private = ec.generate_private_key(ec.SECP256R1())
        self.auth = os.urandom(16)
        self.p256dh = b64u(self.private.public_key().public_bytes(serialization.Encoding.X962,
                                                                   serialization.PublicFormat.UncompressedPoint))

    def decrypt(self, body: bytes) -> bytes:
        import http_ece
        return http_ece.decrypt(body, private_key=self.private, auth_secret=self.auth, version="aes128gcm")


def real_notifier():
    # The only place plain http is ever enabled: a constructor argument, here, for loopback.
    cfg = PushConfig(vapid_private_key=VAPID_KEY, subject="mailto:postmaster@eisenberg.dev",
                     endpoint_allow=("127.0.0.1",))
    return push.PushNotifier(cfg, allow_insecure_loopback=True)


def test_real_pywebpush_request(service, db):
    subscriber = Subscriber()
    endpoint = f"http://127.0.0.1:{service.port}/push/v1/SECRET-PATH"
    db.add_subscription(endpoint, p256dh=subscriber.p256dh, auth=b64u(subscriber.auth), failure_count=2)
    payload = push.build_payload(relay.parse(simple_message(subject="Grüße 🚲")), ALIAS, "ses-in-1")

    counts = real_notifier().notify(db, payload, "eisenberg.dev")

    assert counts == {"sent": 1, "gone": 0, "failed": 0, "skipped": 0}
    assert db.push_subscriptions[endpoint]["failure_count"] == 0
    assert db.push_subscriptions[endpoint]["last_success_at"] == "now"
    (request,) = service.requests
    headers = {k.lower(): v for k, v in request["headers"].items()}
    assert request["path"] == "/push/v1/SECRET-PATH"
    assert headers["content-encoding"] == "aes128gcm"
    assert headers["ttl"] == "86400"

    # Authorization: vapid t=<JWT signed with our key>, k=<our public key>
    scheme, _, params = headers["authorization"].partition(" ")
    assert scheme == "vapid"
    fields = dict(item.strip().split("=", 1) for item in params.split(","))
    public = VAPID_PRIVATE.public_key()
    assert b64u_decode(fields["k"]) == public.public_bytes(serialization.Encoding.X962,
                                                           serialization.PublicFormat.UncompressedPoint)
    header_b64, claims_b64, signature_b64 = fields["t"].split(".")
    assert json.loads(b64u_decode(header_b64))["alg"] == "ES256"
    claims = json.loads(b64u_decode(claims_b64))
    assert claims["aud"] == f"http://127.0.0.1:{service.port}"
    assert claims["sub"] == "mailto:postmaster@eisenberg.dev"
    assert time.time() < claims["exp"] <= time.time() + 24 * 3600
    signature = b64u_decode(signature_b64)
    der = encode_dss_signature(int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big"))
    public.verify(der, f"{header_b64}.{claims_b64}".encode(), ec.ECDSA(hashes.SHA256()))   # raises if forged

    # the body is opaque on the wire and decrypts, with the subscriber's keys, to our JSON
    assert b"bike" not in request["body"] and ALIAS.encode() not in request["body"]
    decrypted = subscriber.decrypt(request["body"])
    assert decrypted.decode("utf-8") == payload
    assert json.loads(decrypted) == {
        "title": "Bob Smith", "body": "Grüße 🚲", "address": ALIAS,
        "url": "/mail?box=inbox&address=cool_stuff%40eisenberg.dev", "tag": "ses-in-1",
    }


def test_real_statuses_and_no_redirect_following(service, db):
    subscribers = {}
    for name in ("gone", "missing", "broken", "moved", "fine"):
        subscribers[name] = f"http://127.0.0.1:{service.port}/push/{name}"
        sub = Subscriber()
        db.add_subscription(subscribers[name], p256dh=sub.p256dh, auth=b64u(sub.auth))
    service.statuses = [410, 404, 500, 307, 201]

    counts = real_notifier().notify(db, '{"title":"x"}', "eisenberg.dev")

    assert counts == {"sent": 1, "gone": 2, "failed": 2, "skipped": 0}
    assert sorted(db.push_subscriptions) == sorted([subscribers["broken"], subscribers["moved"], subscribers["fine"]])
    assert db.push_subscriptions[subscribers["broken"]]["failure_count"] == 1
    assert db.push_subscriptions[subscribers["moved"]]["failure_count"] == 1
    assert db.push_subscriptions[subscribers["fine"]]["last_success_at"] == "now"
    paths = [r["path"] for r in service.requests]
    assert paths == ["/push/gone", "/push/missing", "/push/broken", "/push/moved", "/push/fine"]
    assert "/redirected" not in paths                                   # the 307 was not followed


def test_real_timeout_counts_as_failure(service, db, monkeypatch):
    monkeypatch.setattr(push, "REQUEST_TIMEOUT", 0.3)
    sub = Subscriber()
    endpoint = f"http://127.0.0.1:{service.port}/push/slow"
    db.add_subscription(endpoint, p256dh=sub.p256dh, auth=b64u(sub.auth))
    service.delay = 1.5
    started = time.monotonic()
    counts = real_notifier().notify(db, "{}", "eisenberg.dev")
    assert time.monotonic() - started < 1.4
    assert counts == {"sent": 0, "gone": 0, "failed": 1, "skipped": 0}
    assert db.push_subscriptions[endpoint]["failure_count"] == 1


def test_real_sender_with_garbage_subscriber_keys_is_a_failure_not_a_crash(service, db):
    endpoint = f"http://127.0.0.1:{service.port}/push/garbage"
    db.add_subscription(endpoint, p256dh="not-a-key", auth="x")
    counts = real_notifier().notify(db, "{}", "eisenberg.dev")
    assert counts == {"sent": 0, "gone": 0, "failed": 1, "skipped": 0}
    assert service.requests == [] and db.push_subscriptions[endpoint]["failure_count"] == 1


def test_real_sender_does_not_treat_a_key_that_looks_like_a_path_as_a_file(service, db, tmp_path, monkeypatch):
    # pywebpush reads the key from disk when the string is an existing path; we never give it a string
    key_named_file = tmp_path / VAPID_KEY
    key_named_file.write_text("not a key")
    monkeypatch.chdir(tmp_path)
    sub = Subscriber()
    endpoint = f"http://127.0.0.1:{service.port}/push/x"
    db.add_subscription(endpoint, p256dh=sub.p256dh, auth=b64u(sub.auth))
    assert real_notifier().notify(db, "{}", "eisenberg.dev")["sent"] == 1


def test_module_and_handler_import_without_pywebpush_installed():
    """pywebpush, py_vapid and requests are only imported when a real push is sent."""
    import os
    import subprocess
    import sys

    code = (
        "import sys\n"
        "for name in ('pywebpush', 'py_vapid', 'requests', 'aiohttp', 'http_ece'):\n"
        "    sys.modules[name] = None            # any import attempt raises ImportError\n"
        "import inbox, push\n"
        "from config import PushConfig\n"
        "sent = []\n"
        "class DB:\n"
        "    def list_push_subscriptions(self, limit): return [dict(endpoint='https://fcm.googleapis.com/x', p256dh='p', auth='a')]\n"
        "    def push_succeeded(self, endpoint): sent.append(endpoint)\n"
        f"n = push.PushNotifier(PushConfig(vapid_private_key='{VAPID_KEY}'), send=lambda *a, **k: 201)\n"
        "assert n.notify(DB(), '{}', 'd')['sent'] == 1 and sent\n"
    )
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    result = subprocess.run([sys.executable, "-c", code], cwd=root, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
