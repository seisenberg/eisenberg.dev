"""Blocked addresses, the delivery log, and per-user push scoping at the handler level."""
import json
import logging

import pytest

import inbox
import push
from config import PushConfig
from helpers import (ALIAS, BOB, DOMAIN, OWNER_MIXED, inbound_message, make_config, owner_reply, ses_record,
                     simple_message)
from test_push import APPLE, FCM, MOZILLA, VAPID_KEY, FakeSend

TOKEN1 = f"{1:032x}"
RELAY1 = f"reply-{TOKEN1}@{DOMAIN}"
OTHER = "shop@eisenberg.dev"
SECOND_DOMAIN = "second.example"


@pytest.fixture
def send():
    return FakeSend()


@pytest.fixture
def processor(make_processor, send, db):
    db.add_subscription(FCM)
    processor = make_processor(mail_domains=(DOMAIN, SECOND_DOMAIN))
    processor.notifier = push.PushNotifier(PushConfig(vapid_private_key=VAPID_KEY), send=send)
    return processor


def deliver(processor, s3, message_id="in-1", raw=None, recipients=(ALIAS,), **record_kwargs):
    s3.put(message_id, inbound_message() if raw is None else raw)
    record = ses_record(message_id, recipients, **record_kwargs)
    return processor.process_record(record), record


# ------------------------------------------------------------------------------------------
# blocked addresses
# ------------------------------------------------------------------------------------------
def test_mail_to_a_blocked_address_is_not_stored_forwarded_or_notified(processor, s3, ses, db, send):
    db.block(ALIAS)
    outcome, _ = deliver(processor, s3, recipients=("Cool_Stuff@Eisenberg.dev",))
    assert outcome == "blocked"
    assert db.inbox == {} and db.tokens == {} and ses.sent == [] and ses.bounces == [] and send.calls == []
    assert s3.gets == []                                           # not even fetched
    assert db.blocked[ALIAS] == {"count": 1, "last": "now"}
    assert db.inbox_log == {"in-1": "blocked"}
    deliver(processor, s3, "in-2")
    assert db.blocked[ALIAS]["count"] == 2


def test_blocked_recipient_is_removed_and_the_rest_processed_normally(processor, s3, ses, db, send):
    db.block(OTHER)
    outcome, record = deliver(processor, s3, recipients=("Shop@Eisenberg.dev", "Cool_Stuff@Eisenberg.dev"))
    assert outcome == "forwarded"
    row = db.inbox["in-1"]
    # the stored event only lists the recipients that remain (original spelling kept) ...
    assert row["event"]["receipt"]["recipients"] == ["Cool_Stuff@Eisenberg.dev"]
    assert row["event"]["mail"] == record["ses"]["mail"]
    assert record["ses"]["receipt"]["recipients"] == ["Shop@Eisenberg.dev", "Cool_Stuff@Eisenberg.dev"]   # input untouched
    assert row["meta"] == {"blocked_recipients": [OTHER], "forwarded": True, "notified": True}
    # ... and everything else behaves as if the mail had only been sent to the remaining address
    assert db.tokens[TOKEN1]["alias_address"] == ALIAS
    assert ses.sent[0]["Source"] == f"reply-{TOKEN1}@{DOMAIN}"
    forwarded = ses.sent[0]["Data"]
    assert b"X-Eisenmail-Recipients: " + ALIAS.encode() + b"\r\n" in forwarded and OTHER.encode() not in forwarded.split(b"\r\n\r\n")[0]
    assert json.loads(send.calls[0]["payload"])["address"] == ALIAS
    assert db.blocked[OTHER]["count"] == 1
    assert sorted(db.address_rules) == sorted([ALIAS, OTHER])
    assert db.inbox_log == {"in-1": "forwarded"}


def test_blocked_primary_alias_moves_the_alias_to_the_next_recipient(processor, s3, ses, db):
    db.block(ALIAS)
    db.set_rule(OTHER, forward_style="attach")
    assert deliver(processor, s3, recipients=(ALIAS, OTHER))[0] == "forwarded"
    assert db.tokens[TOKEN1]["alias_address"] == OTHER
    assert b"Subject: FW " + OTHER.encode() in ses.sent[0]["Data"]


def test_first_mail_to_an_address_is_never_blocked(processor, s3, db):
    assert deliver(processor, s3)[0] == "forwarded"
    assert db.blocked == {} and ALIAS in db.address_rules


def test_junk_to_a_blocked_address_is_not_stored(processor, s3, ses, db, send):
    db.block(ALIAS)
    assert deliver(processor, s3, "in-1", spam="FAIL")[0] == "blocked"
    assert db.inbox == {}
    # junk for a mix of blocked and other recipients is stored for the others only
    outcome, _ = deliver(processor, s3, "in-2", recipients=(ALIAS, OTHER), spf="FAIL")
    assert outcome == "junk"
    row = db.inbox["in-2"]
    assert row["kind"] == "junk" and row["event"]["receipt"]["recipients"] == [OTHER]
    assert row["meta"] == {"blocked_recipients": [ALIAS]}
    assert ses.sent == [] and send.calls == []
    assert OTHER not in db.address_rules                           # junk still creates no rule


def test_virus_and_dmarc_reject_are_decided_before_blocking(processor, s3, ses, db):
    db.block(ALIAS)
    assert deliver(processor, s3, "in-1", virus="FAIL")[0] == "dropped_virus"
    assert deliver(processor, s3, "in-2", dmarc="FAIL", dmarc_policy="reject")[0] == "bounced"
    assert db.blocked[ALIAS]["count"] == 0
    assert ses.bounces[0]["BouncedRecipientInfoList"] == [{"Recipient": ALIAS, "BounceType": "ContentRejected"}]


def test_relay_shaped_recipient_is_never_blocked(processor, s3, ses, db, send):
    deliver(processor, s3, "in-1")
    db.block(ALIAS)
    db.blocked[RELAY1] = {"count": 0, "last": None}               # even if a row somehow said so
    ses.sent.clear()
    s3.put("reply-in-1", owner_reply(RELAY1))
    record = ses_record("reply-in-1", [RELAY1], from_header=f"Owner Private <{OWNER_MIXED}>")
    assert processor.process_record(record) == "relayed"
    assert [s["Destinations"] for s in ses.sent] == [[BOB]]
    assert db.blocked[RELAY1]["count"] == 0


def test_recipients_on_other_domains_are_not_looked_up(processor, s3, db):
    db.block("x@elsewhere.example")
    assert deliver(processor, s3, recipients=("x@elsewhere.example", ALIAS))[0] == "forwarded"
    assert db.blocked["x@elsewhere.example"]["count"] == 0


def test_blocked_lookup_failure_fails_the_record_and_logs_nothing(processor, s3, ses, db):
    db.fail = lambda name: RuntimeError("db down") if name == "record_blocked" else None
    with pytest.raises(RuntimeError):
        deliver(processor, s3)
    assert db.inbox == {} and db.inbox_log == {} and ses.sent == []


# ------------------------------------------------------------------------------------------
# delivery log
# ------------------------------------------------------------------------------------------
def test_every_finished_record_is_logged_with_its_outcome(processor, s3, ses, db):
    big = simple_message() + b"y" * (inbox.SIZE_FALLBACK_MIN_BYTES + 1)
    db.block("blocked@eisenberg.dev")
    db.set_rule("quiet@eisenberg.dev", forward=False, notify=False)

    assert deliver(processor, s3, "in-virus", virus="FAIL")[0] == "dropped_virus"
    assert deliver(processor, s3, "in-bounce", dmarc="FAIL", dmarc_policy="reject")[0] == "bounced"
    assert deliver(processor, s3, "in-junk", spam="FAIL")[0] == "junk"
    assert deliver(processor, s3, "in-blocked", recipients=("blocked@eisenberg.dev",))[0] == "blocked"
    assert deliver(processor, s3, "in-stored", recipients=("quiet@eisenberg.dev",))[0] == "stored"
    outcome, record = deliver(processor, s3, "in-forwarded")
    assert outcome == "forwarded"
    ses.fail = lambda kwargs: RuntimeError("Message length is more than 10485760 bytes") if len(kwargs["Data"]) > 100_000 else None
    assert deliver(processor, s3, "in-notice", raw=big)[0] == "forwarded_notice"
    ses.fail = None

    owner = dict(from_header=f"Owner Private <{OWNER_MIXED}>")
    s3.put("reply-1", owner_reply(RELAY1))
    reply = ses_record("reply-1", [RELAY1], **owner)
    assert processor.process_record(reply) == "relayed"
    assert db.inbox_log["reply-1"] == "relayed"
    assert processor.process_record(reply) == "relay_duplicate"
    leaky = owner_reply(RELAY1).replace(b'multipart/mixed; boundary="_004_outer_"',
                                        b'multipart/signed; protocol="application/pkcs7-signature"; boundary="_004_outer_"')
    s3.put("reply-2", leaky)
    assert processor.process_record(ses_record("reply-2", [RELAY1], **owner)) == "relay_blocked"
    assert db.inbox_log["in-forwarded"] == "forwarded"
    assert processor.process_record(record) == "duplicate"

    assert db.inbox_log == {
        "in-virus": "dropped_virus", "in-bounce": "bounced", "in-junk": "junk", "in-blocked": "blocked",
        "in-stored": "stored", "in-forwarded": "duplicate", "in-notice": "forwarded_notice",
        "reply-1": "relay_duplicate", "reply-2": "relay_blocked",
    }


def test_a_record_that_raises_is_not_logged(processor, s3, ses, db):
    s3.put("in-ok", inbound_message())
    event = {"Records": [ses_record("in-missing", [ALIAS]), ses_record("in-ok", [ALIAS])]}
    with pytest.raises(inbox.RecordsFailed):
        processor.process_event(event)
    assert db.inbox_log == {"in-ok": "forwarded"}

    s3.put("in-send-fails", inbound_message())
    ses.fail = lambda kwargs: ConnectionError("unreachable")
    with pytest.raises(ConnectionError):
        processor.process_record(ses_record("in-send-fails", [ALIAS]))
    assert "in-send-fails" not in db.inbox_log and "in-send-fails" in db.inbox     # stored, replayable by the retry


def test_delivery_log_failure_does_not_fail_the_record(processor, s3, ses, db, caplog):
    db.fail = lambda name: RuntimeError("log table gone: detail") if name == "log_outcome" else None
    with caplog.at_level(logging.ERROR, logger="eisenmail"):
        assert deliver(processor, s3)[0] == "forwarded"
        assert processor.process_event({"Records": [ses_record("in-1", [ALIAS])]}) == ["duplicate"]
    assert db.inbox_log == {} and len(ses.sent) == 1
    assert "could not write the delivery log (RuntimeError)" in caplog.text and "detail" not in caplog.text


# ------------------------------------------------------------------------------------------
# push: unread badge and per-user visibility
# ------------------------------------------------------------------------------------------
def payloads_by_endpoint(send):
    return {c["subscription"]["endpoint"]: json.loads(c["payload"]) for c in send.calls}


def test_owner_and_member_get_different_badges(processor, s3, ses, db, send):
    db.add_user(2, role="member", domains=[SECOND_DOMAIN])
    db.add_subscription(APPLE, user_id=2)
    db.indexed_unread = [[DOMAIN], [DOMAIN], [SECOND_DOMAIN], [DOMAIN, SECOND_DOMAIN]]      # 4 unread, 2 visible to the member
    deliver(processor, s3, "in-1", recipients=(ALIAS,))                                      # owner only
    assert payloads_by_endpoint(send) == {FCM: {**payloads_by_endpoint(send)[FCM], "badge": 5}}

    send.calls.clear()
    deliver(processor, s3, "in-2", recipients=(f"shop@{SECOND_DOMAIN}",))                  # both
    payloads = payloads_by_endpoint(send)
    assert payloads[FCM]["badge"] == 6          # 4 indexed + in-1 + in-2 (not indexed yet)
    assert payloads[APPLE]["badge"] == 3        # 2 indexed for its domain + in-2
    assert payloads[APPLE]["address"] == f"shop@{SECOND_DOMAIN}"
    assert {k: v for k, v in payloads[FCM].items() if k != "badge"} == {k: v for k, v in payloads[APPLE].items() if k != "badge"}


def test_member_is_not_notified_for_another_domain(processor, s3, ses, db, send):
    db.add_user(2, role="member", domains=["Second.Example"])
    db.add_subscription(APPLE, user_id=2)
    db.add_user(3, role="member", domains=None)                    # a member without domains sees nothing
    db.add_subscription(MOZILLA, user_id=3)
    assert deliver(processor, s3, recipients=(ALIAS,))[0] == "forwarded"
    assert send.endpoints == [FCM]
    assert db.push_subscriptions[APPLE]["failure_count"] == 0 and db.push_subscriptions[APPLE]["last_success_at"] is None
    assert db.inbox["in-1"]["meta"]["notified"] is True


def test_member_is_notified_when_any_remaining_recipient_is_on_its_domain(processor, s3, ses, db, send):
    db.add_user(2, role="member", domains=[SECOND_DOMAIN])
    db.add_subscription(APPLE, user_id=2)
    deliver(processor, s3, "in-1", recipients=(ALIAS, f"shop@{SECOND_DOMAIN}"))
    assert sorted(send.endpoints) == sorted([FCM, APPLE])
    # each sees an address it is allowed to see: the member is not shown the owner's alias on the other domain
    payloads = payloads_by_endpoint(send)
    assert payloads[FCM]["address"] == ALIAS
    assert payloads[APPLE]["address"] == f"shop@{SECOND_DOMAIN}"
    assert ALIAS not in json.dumps(payloads[APPLE])

    send.calls.clear()
    db.block(f"shop@{SECOND_DOMAIN}")                               # the member's only recipient is blocked
    deliver(processor, s3, "in-2", recipients=(ALIAS, f"shop@{SECOND_DOMAIN}"))
    assert send.endpoints == [FCM]


def test_unknown_role_is_treated_like_a_member(processor, s3, db, send):
    db.add_user(2, role="admin", domains=None)
    db.add_subscription(APPLE, user_id=2)
    deliver(processor, s3)
    assert send.endpoints == [FCM]


def test_badge_is_computed_once_per_visibility_scope(processor, s3, db, send):
    db.add_user(2, role="member", domains=[DOMAIN])
    db.add_user(3, role="member", domains=[DOMAIN.upper()])         # same scope as user 2
    db.add_user(4, role="owner")
    for n, user in enumerate((1, 2, 2, 3, 4, 4)):
        db.add_subscription(f"https://fcm.googleapis.com/fcm/send/{n}", user_id=user)
    counted = []
    original = db.count_unread
    db.count_unread = lambda domains=None: (counted.append(domains), original(domains))[1]
    deliver(processor, s3)
    assert len(send.calls) == 7
    assert counted.count(None) == 1 and counted.count([DOMAIN]) == 1 and len(counted) == 2


def test_orphan_subscription_is_removed(processor, s3, db, send):
    db.add_subscription(APPLE, user_id=99)                         # user 99 was deleted
    deliver(processor, s3)
    assert list(db.push_subscriptions) == [FCM] and send.endpoints == [FCM]


def test_badge_is_omitted_when_the_count_fails(processor, s3, ses, db, send, caplog):
    db.fail = lambda name: RuntimeError("count failed: detail") if name == "count_unread" else None
    with caplog.at_level(logging.WARNING, logger="eisenmail.push"):
        assert deliver(processor, s3)[0] == "forwarded"
    (call,) = send.calls
    payload = json.loads(call["payload"])
    assert "badge" not in payload and payload["title"] == "Bob Smith"
    assert db.inbox["in-1"]["meta"]["notified"] is True
    assert "sending without badge" in caplog.text and "detail" not in caplog.text


def test_orphan_cleanup_failure_does_not_stop_the_push(processor, s3, db, send):
    db.fail = lambda name: RuntimeError("x") if name == "delete_orphan_push_subscriptions" else None
    deliver(processor, s3)
    assert send.endpoints == [FCM]


def test_badge_is_capped_and_payload_stays_small(processor, s3, db, send):
    db.indexed_unread = [[DOMAIN]] * 12000
    raw = simple_message(from_header=f"{'N' * 300} <bob@sender.example>", subject="🚲" * 600)
    deliver(processor, s3, raw=raw)
    text = send.calls[0]["payload"]
    assert json.loads(text)["badge"] == 9999
    assert len(text.encode("utf-8")) <= push.MAX_PAYLOAD_BYTES


# ------------------------------------------------------------------------------------------
# event routing
# ------------------------------------------------------------------------------------------
def test_lambda_handler_routes_ses_and_reconcile_events(monkeypatch, s3, ses, db):
    import reconcile
    monkeypatch.setattr(inbox, "_singletons", {})
    monkeypatch.setattr(inbox, "get_config", lambda: make_config())
    monkeypatch.setattr(inbox, "get_s3", lambda: s3)
    monkeypatch.setattr(inbox, "get_ses", lambda: ses)
    monkeypatch.setattr(inbox, "get_db", lambda: db)
    calls = []
    monkeypatch.setattr(reconcile, "run", lambda processor, context: calls.append((processor, context)) or {"listed": 0})

    s3.put("in-1", inbound_message())
    assert inbox.lambda_handler({"Records": [ses_record("in-1", [ALIAS])]}, "ctx") is None
    assert db.inbox_log == {"in-1": "forwarded"} and calls == []

    assert inbox.lambda_handler({"eisenmail": "reconcile"}, "ctx") == {"listed": 0}
    assert len(calls) == 1 and calls[0][1] == "ctx" and isinstance(calls[0][0], inbox.Processor)

    # anything else is not a reconcile request
    assert inbox.lambda_handler({"eisenmail": "something-else"}, "ctx") is None
    assert inbox.lambda_handler({"eisenmail": "reconcile", "Records": []}, "ctx") is None
    assert len(calls) == 1
