"""inbox.py: per-address delivery rules (forward / notify) and the Web Push step."""
import base64
import json
import logging

import pytest

import inbox
import push
import relay
from config import PushConfig
from helpers import ALIAS, BOB, DOMAIN, OWNER, OWNER_MIXED, inbound_message, make_config, owner_reply, ses_record
from test_push import APPLE, FCM, VAPID_KEY, FakeSend

TOKEN1 = f"{1:032x}"
RELAY1 = f"reply-{TOKEN1}@{DOMAIN}"
OTHER = "shop@eisenberg.dev"
DONE = {"forwarded": True, "notified": True}


@pytest.fixture
def send():
    return FakeSend()


@pytest.fixture
def processor(make_processor, send, db):
    """A processor with Web Push enabled (fake network) and one subscribed browser."""
    db.add_subscription(FCM)
    processor = make_processor()
    processor.notifier = push.PushNotifier(PushConfig(vapid_private_key=VAPID_KEY), send=send)
    return processor


def deliver(processor, s3, message_id="in-1", raw=None, recipients=(ALIAS,), **record_kwargs):
    s3.put(message_id, inbound_message() if raw is None else raw)
    record = ses_record(message_id, recipients, **record_kwargs)
    return processor.process_record(record), record


def rule(db, address, forward=True, notify=True, forward_style="inline"):
    db.set_rule(address, forward, notify, forward_style)


# ------------------------------------------------------------------------------------------
# materialising rules
# ------------------------------------------------------------------------------------------
def test_first_mail_materialises_the_rule_from_the_defaults(processor, s3, ses, db, send):
    assert db.address_rules == {}
    outcome, _ = deliver(processor, s3, recipients=("Cool_Stuff@Eisenberg.dev",))
    assert outcome == "forwarded"
    assert db.address_rules == {ALIAS: {"forward": True, "notify": True, "forward_style": "inline"}}
    assert len(ses.sent) == 1 and len(send.calls) == 1
    assert db.inbox["in-1"]["meta"] == DONE


def test_changed_defaults_only_affect_addresses_not_seen_before(processor, s3, ses, db, send):
    deliver(processor, s3, "in-1")
    db.mail_settings.update(default_forward=False, default_notify=False)

    assert deliver(processor, s3, "in-2")[0] == "forwarded"              # known address keeps its rule
    assert db.address_rules[ALIAS] == {"forward": True, "notify": True, "forward_style": "inline"}
    assert len(ses.sent) == 2 and len(send.calls) == 2

    assert deliver(processor, s3, "in-3", recipients=(OTHER,))[0] == "stored"   # new address: new defaults
    assert db.address_rules[OTHER] == {"forward": False, "notify": False, "forward_style": "inline"}
    assert len(ses.sent) == 2 and len(send.calls) == 2
    assert db.inbox["in-3"]["meta"] == {"forwarded": False, "forward_skipped": "rule", "notified": False}


def test_rule_edited_in_the_webmail_is_respected_and_not_overwritten(processor, s3, ses, db, send):
    deliver(processor, s3, "in-1")
    rule(db, ALIAS, forward=False, notify=True)                           # owner switches forwarding off
    assert deliver(processor, s3, "in-2")[0] == "stored"
    assert db.address_rules[ALIAS] == {"forward": False, "notify": True, "forward_style": "inline"}
    assert len(ses.sent) == 1 and len(send.calls) == 2


def test_missing_mail_settings_row_means_forward_and_notify(processor, s3, ses, db, send):
    db.mail_settings = None
    assert deliver(processor, s3)[0] == "forwarded"
    assert db.address_rules == {}                                         # nothing to materialise from
    assert len(ses.sent) == 1 and len(send.calls) == 1


def test_only_our_ordinary_recipients_get_a_rule(make_processor, s3, db):
    processor = make_processor(mail_domains=(DOMAIN,))
    deliver(processor, s3, recipients=("someone@elsewhere.example", ALIAS, OTHER.upper(), ALIAS))
    assert sorted(db.address_rules) == sorted([ALIAS, OTHER])


# ------------------------------------------------------------------------------------------
# forward on / off
# ------------------------------------------------------------------------------------------
def test_forward_off_stores_without_token_or_forward(processor, s3, ses, db, send):
    rule(db, ALIAS, forward=False, notify=False)
    raw = inbound_message()
    outcome, record = deliver(processor, s3, raw=raw)
    assert outcome == "stored"
    row = db.inbox["in-1"]
    assert (row["kind"], row["email_raw"], row["s3_key"], row["event"]) == ("inbound", raw, "email-inbox/in-1", record["ses"])
    assert row["meta"] == {"forwarded": False, "forward_skipped": "rule", "notified": False}
    assert db.tokens == {} and ses.sent == [] and ses.bounces == [] and send.calls == []


def test_mixed_recipients_forward_when_any_rule_forwards(processor, s3, ses, db, send):
    rule(db, ALIAS, forward=False, notify=False)
    rule(db, OTHER, forward=True, notify=False)
    assert deliver(processor, s3, recipients=(ALIAS, OTHER))[0] == "forwarded"
    assert len(ses.sent) == 1 and send.calls == []
    assert db.tokens[TOKEN1]["alias_address"] == ALIAS                    # primary alias is still the first recipient
    assert db.inbox["in-1"]["meta"] == {"forwarded": True, "notified": False}


def test_mixed_recipients_notify_when_any_rule_notifies(processor, s3, ses, db, send):
    rule(db, ALIAS, forward=False, notify=False)
    rule(db, OTHER, forward=False, notify=True)
    assert deliver(processor, s3, recipients=(ALIAS, OTHER))[0] == "stored"
    assert ses.sent == [] and len(send.calls) == 1
    assert db.inbox["in-1"]["meta"] == {"forwarded": False, "forward_skipped": "rule", "notified": True}


def test_too_large_and_no_token_fallbacks_only_apply_when_forwarding(processor, s3, ses, db, send):
    rule(db, ALIAS, forward=False, notify=False)
    ses.fail = lambda kwargs: AssertionError("SES must not be called")
    big = b"From: \r\nSubject: x\r\n\r\n" + b"y" * (inbox.SIZE_FALLBACK_MIN_BYTES + 1)     # no usable From, oversized
    assert deliver(processor, s3, raw=big)[0] == "stored"
    assert ses.sent == [] and db.tokens == {}


# ------------------------------------------------------------------------------------------
# forward style per address
# ------------------------------------------------------------------------------------------
def style_of(sent) -> str:
    """Which layout a forward has: attach forwards carry the original as message/rfc822."""
    msg = relay.parse(sent["Data"])
    attached = [p.get_content_type() for p in msg.walk()].count("message/rfc822") == 1
    assert attached == str(msg["Subject"]).startswith("FW ")
    return "attach" if attached else "inline"


def test_default_style_is_materialised_from_mail_settings(processor, s3, ses, db):
    db.mail_settings["default_forward_style"] = "attach"
    assert deliver(processor, s3)[0] == "forwarded"
    assert db.address_rules[ALIAS] == {"forward": True, "notify": True, "forward_style": "attach"}
    assert style_of(ses.sent[0]) == "attach"
    assert relay.parse(ses.sent[0]["Data"])["Subject"] == f"FW {ALIAS}: Hello about the bike"


def test_inline_is_the_default_style(processor, s3, ses, db):
    deliver(processor, s3)
    assert db.address_rules[ALIAS]["forward_style"] == "inline" and style_of(ses.sent[0]) == "inline"
    assert relay.parse(ses.sent[0]["Data"])["Subject"] == "Hello about the bike"


def test_per_address_style_overrides_the_default(processor, s3, ses, db):
    rule(db, ALIAS, forward_style="attach")
    deliver(processor, s3, "in-1")
    assert style_of(ses.sent[0]) == "attach" and db.mail_settings["default_forward_style"] == "inline"
    rule(db, ALIAS, forward_style="inline")                                # owner switches it back
    deliver(processor, s3, "in-2")
    assert style_of(ses.sent[1]) == "inline"


def test_flipping_the_default_style_does_not_change_a_known_address(processor, s3, ses, db):
    deliver(processor, s3, "in-1")
    db.mail_settings["default_forward_style"] = "attach"
    deliver(processor, s3, "in-2")                                          # known address: still inline
    deliver(processor, s3, "in-3", recipients=(OTHER,))                     # new address: attach
    assert [style_of(s) for s in ses.sent] == ["inline", "inline", "attach"]
    assert db.address_rules[ALIAS]["forward_style"] == "inline"
    assert db.address_rules[OTHER]["forward_style"] == "attach"


def test_two_addresses_with_different_styles_in_one_event(processor, s3, ses, db):
    rule(db, ALIAS, forward_style="attach")
    rule(db, OTHER, forward_style="inline")
    s3.put("in-1", inbound_message(message_id="<m1@sender.example>"))
    s3.put("in-2", inbound_message(message_id="<m2@sender.example>"))
    event = {"Records": [ses_record("in-1", [ALIAS]), ses_record("in-2", [OTHER])]}
    assert processor.process_event(event) == ["forwarded", "forwarded"]
    by_id = {str(relay.parse(s["Data"])["X-Eisenmail-Message-Id"]): style_of(s) for s in ses.sent}
    assert by_id == {"in-1": "attach", "in-2": "inline"}


@pytest.mark.parametrize("first,second,expected", [
    # (forward, style) of the primary alias, of the second recipient -> style of the one forward
    ((True, "attach"), (True, "inline"), "attach"),          # primary alias forwards: its style
    ((True, "inline"), (True, "attach"), "inline"),
    ((False, "attach"), (True, "inline"), "inline"),         # primary does not forward: first one that does
    ((False, "inline"), (True, "attach"), "attach"),
])
def test_multi_recipient_message_uses_the_style_of_the_forwarding_address(processor, s3, ses, db, first, second, expected):
    rule(db, ALIAS, forward=first[0], forward_style=first[1])
    rule(db, OTHER, forward=second[0], forward_style=second[1])
    assert deliver(processor, s3, recipients=(ALIAS, OTHER))[0] == "forwarded"
    (sent,) = ses.sent
    assert style_of(sent) == expected


def test_third_recipient_in_envelope_order_decides_when_the_first_two_do_not_forward(processor, s3, ses, db):
    third, fourth = "third@eisenberg.dev", "fourth@eisenberg.dev"
    rule(db, ALIAS, forward=False, forward_style="inline")
    rule(db, OTHER, forward=False, forward_style="inline")
    rule(db, third, forward=True, forward_style="attach")
    rule(db, fourth, forward=True, forward_style="inline")
    deliver(processor, s3, recipients=(ALIAS, OTHER, third, fourth))
    assert style_of(ses.sent[0]) == "attach"


@pytest.mark.parametrize("value", ["fancy", "", None, "ATTACHMENT", 7])
def test_unknown_style_value_falls_back_to_inline(processor, s3, ses, db, value):
    rule(db, ALIAS, forward_style=value)
    assert deliver(processor, s3)[0] == "forwarded"
    assert style_of(ses.sent[0]) == "inline"


def test_style_value_is_matched_leniently(processor, s3, ses, db):
    rule(db, ALIAS, forward_style=" Attach ")
    deliver(processor, s3)
    assert style_of(ses.sent[0]) == "attach"


def test_relay_shaped_recipient_uses_the_default_style(processor, s3, ses, db):
    db.mail_settings["default_forward_style"] = "attach"
    unknown = f"reply-{'e' * 32}@{DOMAIN}"
    assert deliver(processor, s3, recipients=(unknown,))[0] == "forwarded"
    assert style_of(ses.sent[0]) == "attach" and db.address_rules == {}


def test_no_rule_fallback_uses_the_default_style(processor, s3, ses, db):
    db.mail_settings["default_forward_style"] = "attach"
    assert deliver(processor, s3, recipients=("x@elsewhere.example",))[0] == "forwarded"    # not on our domains
    assert style_of(ses.sent[0]) == "attach" and db.address_rules == {}
    assert ses.sent[0]["Source"] == f"noreply@{DOMAIN}"


def test_missing_mail_settings_row_means_inline(processor, s3, ses, db):
    db.mail_settings = None
    deliver(processor, s3, "in-1")
    deliver(processor, s3, "in-2", recipients=(f"reply-{'e' * 32}@{DOMAIN}",))
    assert [style_of(s) for s in ses.sent] == ["inline", "inline"]


def test_retry_of_a_failed_forward_uses_the_current_style(processor, s3, ses, db):
    rule(db, ALIAS, forward_style="attach")
    s3.put("in-1", inbound_message())
    record = ses_record("in-1", [ALIAS])
    ses.fail = lambda kwargs: ConnectionError("unreachable")
    with pytest.raises(ConnectionError):
        processor.process_record(record)
    ses.fail = None
    assert processor.process_record(record) == "forwarded"
    assert style_of(ses.sent[0]) == "attach" and len(ses.sent) == 1


# -- the reply path does not care what the rule says now -------------------------------------
def reply(processor, s3, ses, subject, message_id="reply-in-1"):
    ses.sent.clear()
    s3.put(message_id, owner_reply(RELAY1, subject=subject))
    record = ses_record(message_id, [RELAY1], from_header=f"Owner Private <{OWNER_MIXED}>")
    assert processor.process_record(record) == "relayed"
    (sent,) = ses.sent
    assert sent["Destinations"] == [BOB]
    return str(relay.parse(sent["Data"])["Subject"])


def test_reply_to_an_attach_forward_after_the_rule_became_inline(processor, s3, ses, db):
    rule(db, ALIAS, forward_style="attach")
    deliver(processor, s3)
    assert relay.parse(ses.sent[0]["Data"])["Subject"] == f"FW {ALIAS}: Hello about the bike"
    rule(db, ALIAS, forward_style="inline")                                # changed after the forward went out
    db.mail_settings["default_forward_style"] = "inline"
    assert reply(processor, s3, ses, f"Re: FW {ALIAS}: Hello about the bike") == "Re: Hello about the bike"


def test_reply_to_an_inline_forward_after_the_rule_became_attach(processor, s3, ses, db):
    deliver(processor, s3)
    rule(db, ALIAS, forward_style="attach")
    db.mail_settings["default_forward_style"] = "attach"
    assert reply(processor, s3, ses, "Re: Hello about the bike") == "Re: Hello about the bike"


def test_inline_forward_of_a_subject_that_looks_like_our_prefix_is_not_stripped(processor, s3, ses, db):
    # the correspondent's own subject happens to contain "FW <alias>: "
    deliver(processor, s3, raw=inbound_message(subject=f"FW {ALIAS}: price list"))
    rule(db, ALIAS, forward_style="attach")
    assert reply(processor, s3, ses, f"Re: FW {ALIAS}: price list") == f"Re: FW {ALIAS}: price list"


def test_attach_forward_of_a_subject_that_looks_like_our_prefix_loses_only_ours(processor, s3, ses, db):
    rule(db, ALIAS, forward_style="attach")
    deliver(processor, s3, raw=inbound_message(subject=f"FW {ALIAS}: price list"))
    assert relay.parse(ses.sent[0]["Data"])["Subject"] == f"FW {ALIAS}: FW {ALIAS}: price list"
    rule(db, ALIAS, forward_style="inline")
    assert reply(processor, s3, ses, f"RE: FW {ALIAS}: FW {ALIAS}: price list") == f"RE: FW {ALIAS}: price list"


# ------------------------------------------------------------------------------------------
# notify on / off
# ------------------------------------------------------------------------------------------
def test_notify_sends_the_payload_to_every_subscription(processor, s3, ses, db, send):
    db.add_subscription(APPLE)
    outcome, _ = deliver(processor, s3)
    assert outcome == "forwarded"
    assert sorted(send.endpoints) == sorted([FCM, APPLE])
    call = send.calls[0]
    assert json.loads(call["payload"]) == {
        "title": "Bob Smith", "body": "Hello about the bike", "address": ALIAS,
        "url": "/mail?box=inbox&address=cool_stuff%40eisenberg.dev", "tag": "in-1", "badge": 1,
    }
    assert call["ttl"] == 86400 and call["timeout"] == 5.0
    assert call["subject"] == f"mailto:postmaster@{DOMAIN}"
    assert db.inbox["in-1"]["meta"] == DONE


def test_notify_off(processor, s3, ses, db, send):
    rule(db, ALIAS, forward=True, notify=False)
    assert deliver(processor, s3)[0] == "forwarded"
    assert send.calls == [] and len(ses.sent) == 1
    assert db.inbox["in-1"]["meta"] == {"forwarded": True, "notified": False}


def test_forward_off_notify_on(processor, s3, ses, db, send):
    rule(db, ALIAS, forward=False, notify=True)
    assert deliver(processor, s3)[0] == "stored"
    assert ses.sent == [] and db.tokens == {} and len(send.calls) == 1
    assert db.inbox["in-1"]["meta"] == {"forwarded": False, "forward_skipped": "rule", "notified": True}


def test_vapid_subject_falls_back_to_the_alias_domain_without_mail_domains(make_processor, s3, db, send):
    db.add_subscription(FCM)
    processor = make_processor(mail_domains=())
    processor.notifier = push.PushNotifier(PushConfig(vapid_private_key=VAPID_KEY), send=send)
    deliver(processor, s3, recipients=("x@second.example",))
    assert send.calls[0]["subject"] == "mailto:postmaster@second.example"


def test_push_disabled_without_a_key(make_processor, s3, ses, db, send):
    db.add_subscription(FCM)
    processor = make_processor()                                           # notifier is None
    assert deliver(processor, s3)[0] == "forwarded"
    assert send.calls == [] and db.inbox["in-1"]["meta"] == {"forwarded": True, "notified": False}
    assert db.push_subscriptions[FCM]["failure_count"] == 0


def test_get_notifier_logs_once_when_no_key_is_configured(monkeypatch, caplog):
    monkeypatch.setattr(inbox, "_singletons", {})
    monkeypatch.setattr(inbox, "get_config", lambda: make_config())
    with caplog.at_level(logging.INFO, logger="eisenmail"):
        assert inbox.get_notifier() is None
        assert inbox.get_notifier() is None
    assert caplog.text.count("web push is disabled") == 1


def test_get_notifier_builds_the_real_notifier_without_test_switches(monkeypatch):
    monkeypatch.setattr(inbox, "_singletons", {})
    cfg = make_config(push=PushConfig(vapid_private_key=VAPID_KEY, endpoint_allow=("127.0.0.1",)))
    monkeypatch.setattr(inbox, "get_config", lambda: cfg)
    notifier = inbox.get_notifier()
    assert isinstance(notifier, push.PushNotifier) and inbox.get_notifier() is notifier
    assert notifier._allow_insecure_loopback is False                      # plain http cannot be configured in
    assert isinstance(notifier._send, push.PywebpushSender)


# ------------------------------------------------------------------------------------------
# what never forwards / notifies / creates rules
# ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("verdict", ["spf", "dkim", "spam"])
def test_junk_is_never_notified_and_creates_no_rule(processor, s3, ses, db, send, verdict):
    assert deliver(processor, s3, **{verdict: "FAIL"})[0] == "junk"
    assert send.calls == [] and ses.sent == [] and db.address_rules == {}
    assert db.inbox["in-1"]["meta"] is None


def test_virus_and_dmarc_reject_are_never_notified(processor, s3, ses, db, send):
    assert deliver(processor, s3, "in-1", virus="FAIL")[0] == "dropped_virus"
    assert deliver(processor, s3, "in-2", dmarc="FAIL", dmarc_policy="reject")[0] == "bounced"
    assert send.calls == [] and db.address_rules == {} and db.inbox == {}


def test_authorised_relay_reply_ignores_rules_and_is_never_notified(processor, s3, ses, db, send):
    deliver(processor, s3, "in-1")
    send.calls.clear()
    ses.sent.clear()
    db.mail_settings.update(default_forward=False, default_notify=True)
    rule(db, ALIAS, forward=False, notify=True)
    s3.put("reply-in-1", owner_reply(RELAY1))
    record = ses_record("reply-in-1", [RELAY1], from_header=f"Owner Private <{OWNER_MIXED}>")
    assert processor.process_record(record) == "relayed"
    assert [s["Destinations"] for s in ses.sent] == [[BOB]]
    assert send.calls == []
    assert list(db.address_rules) == [ALIAS]                               # no rule row for the relay address
    assert db.inbox["relay-ses-out-1"]["kind"] == "relay_out"


def test_refused_relay_attempt_uses_the_defaults_without_creating_a_rule(processor, s3, ses, db, send):
    deliver(processor, s3, "in-1")
    send.calls.clear()
    ses.sent.clear()
    s3.put("x-1", owner_reply(RELAY1, from_header="Mallory <mallory@evil.example>"))
    record = ses_record("x-1", [RELAY1], from_header="Mallory <mallory@evil.example>")
    assert processor.process_record(record) == "forwarded"                 # defaults: forward + notify
    assert len(ses.sent) == 1 and len(send.calls) == 1
    assert list(db.address_rules) == [ALIAS]
    assert json.loads(send.calls[0]["payload"])["address"] == RELAY1

    db.mail_settings.update(default_forward=False, default_notify=False)
    s3.put("x-2", owner_reply(RELAY1, from_header="Mallory <mallory@evil.example>"))
    record = ses_record("x-2", [RELAY1], from_header="Mallory <mallory@evil.example>")
    assert processor.process_record(record) == "stored"
    assert len(ses.sent) == 1 and len(send.calls) == 1
    assert db.inbox["x-2"]["meta"] == {"forwarded": False, "forward_skipped": "rule", "notified": False}
    assert list(db.address_rules) == [ALIAS]


def test_relay_shaped_plus_ordinary_recipient_combines_default_and_rule(processor, s3, ses, db, send):
    db.mail_settings.update(default_forward=False, default_notify=False)
    rule(db, ALIAS, forward=False, notify=True)
    unknown = f"reply-{'e' * 32}@{DOMAIN}"
    assert deliver(processor, s3, recipients=(unknown, ALIAS))[0] == "stored"
    assert len(send.calls) == 1 and ses.sent == []
    assert list(db.address_rules) == [ALIAS]


def test_loop_guard_suppresses_the_forward_and_the_notification(processor, s3, ses, db, send):
    deliver(processor, s3, "in-1")
    send.calls.clear()
    ses.sent.clear()
    s3.put("auto-1", owner_reply(RELAY1, extra_headers="Auto-Submitted: auto-replied\n"))
    record = ses_record("auto-1", [RELAY1], from_header=f"Owner Private <{OWNER_MIXED}>")
    assert processor.process_record(record) == "stored"
    assert ses.sent == []
    assert db.inbox["auto-1"]["meta"] == {"forwarded": False, "forward_skipped": "loop", "notified": False}
    assert send.calls == []                                                # automatic mail is not worth a push
    assert processor.process_record(record) == "duplicate"
    assert send.calls == []


# ------------------------------------------------------------------------------------------
# retries
# ------------------------------------------------------------------------------------------
def test_retry_of_store_only_message_is_idempotent(processor, s3, ses, db, send):
    rule(db, ALIAS, forward=False, notify=True)
    outcome, record = deliver(processor, s3)
    assert outcome == "stored"
    rule(db, ALIAS, forward=True, notify=True)                             # even if the rule changes meanwhile
    assert processor.process_record(record) == "duplicate"
    assert processor.process_record(record) == "duplicate"
    assert len(db.inbox) == 1 and ses.sent == [] and db.tokens == {} and len(send.calls) == 1


def test_retry_does_not_notify_twice(processor, s3, ses, db, send):
    outcome, record = deliver(processor, s3)
    assert outcome == "forwarded"
    assert processor.process_record(record) == "duplicate"
    assert len(send.calls) == 1 and len(ses.sent) == 1 and len(db.tokens) == 1


def test_failed_forward_still_notifies_once_and_retry_only_forwards(processor, s3, ses, db, send):
    s3.put("in-1", inbound_message())
    record = ses_record("in-1", [ALIAS])
    ses.fail = lambda kwargs: ConnectionError("SES endpoint unreachable")
    with pytest.raises(ConnectionError):
        processor.process_record(record)
    assert len(send.calls) == 1                                            # the mail is stored: tell the owner
    assert db.inbox["in-1"]["meta"] == {"notified": True}

    ses.fail = None
    assert processor.process_record(record) == "forwarded"
    assert len(send.calls) == 1 and len(ses.sent) == 1 and list(db.tokens) == [TOKEN1]
    assert db.inbox["in-1"]["meta"] == DONE
    assert processor.process_record(record) == "duplicate"


def test_retry_after_crash_between_forward_and_notify(processor, s3, ses, db, send):
    """The forward went out and was recorded, then the invocation died before the push step."""
    s3.put("in-1", inbound_message())
    record = ses_record("in-1", [ALIAS])
    original = processor._notify_step
    processor._notify_step = lambda *a, **k: (_ for _ in ()).throw(SystemExit("lambda timed out"))
    with pytest.raises(SystemExit):
        processor.process_record(record)
    assert db.inbox["in-1"]["meta"] == {"forwarded": True} and len(ses.sent) == 1

    processor._notify_step = original
    assert processor.process_record(record) == "forwarded"
    assert len(ses.sent) == 1 and len(send.calls) == 1                     # no second forward, one push
    assert db.inbox["in-1"]["meta"] == DONE


def test_retry_after_crash_between_store_and_rule_decision(processor, s3, ses, db, send):
    s3.put("in-1", inbound_message())
    record = ses_record("in-1", [ALIAS])
    rule(db, ALIAS, forward=False, notify=True)
    db.fail = lambda name: RuntimeError("db down") if name == "resolve_address_rule" else None
    with pytest.raises(RuntimeError):
        processor.process_record(record)
    assert db.inbox["in-1"]["meta"] is None and send.calls == []
    db.fail = None
    assert processor.process_record(record) == "stored"
    assert ses.sent == [] and len(send.calls) == 1
    assert processor.process_record(record) == "duplicate"


# ------------------------------------------------------------------------------------------
# push problems never fail the record
# ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("answer", [500, 410, TimeoutError("slow"), RuntimeError("boom")])
def test_push_errors_do_not_fail_the_record(processor, s3, ses, db, send, answer):
    send.answers.append(answer)
    assert deliver(processor, s3)[0] == "forwarded"
    assert len(ses.sent) == 1 and db.inbox["in-1"]["meta"] == DONE


def test_database_error_inside_the_push_step_does_not_fail_the_record(processor, s3, ses, db, send, caplog):
    db.fail = lambda name: RuntimeError("db down: secret detail") if name == "list_push_subscriptions" else None
    with caplog.at_level(logging.ERROR, logger="eisenmail"):
        outcome, record = deliver(processor, s3)
    assert outcome == "forwarded" and len(ses.sent) == 1
    assert db.inbox["in-1"]["meta"] == {"forwarded": True}                 # push step did not complete
    assert "push step failed (RuntimeError)" in caplog.text and "secret detail" not in caplog.text


def test_payload_builder_crash_does_not_fail_the_record(processor, s3, ses, db, monkeypatch):
    monkeypatch.setattr(push, "build_payload", lambda *a: (_ for _ in ()).throw(ValueError("bad")))
    assert deliver(processor, s3)[0] == "forwarded"
    assert len(ses.sent) == 1


def test_push_step_runs_after_the_forward(processor, s3, ses, db, send):
    order = []
    original_send = ses.send_raw_email
    ses.send_raw_email = lambda **kw: (order.append("forward"), original_send(**kw))[1]
    processor.notifier._send = lambda *a, **k: (order.append("push"), 201)[1]
    deliver(processor, s3)
    assert order == ["forward", "push"]


def test_nothing_sensitive_is_logged(processor, s3, ses, db, send, caplog):
    with caplog.at_level(logging.DEBUG):
        processor.process_event({"Records": [deliver(processor, s3)[1]]})
    for secret in ("SECRET-PATH", "Hello about the bike", "Bob Smith", VAPID_KEY, "p256dh-key", "auth-secret", OWNER):
        assert secret not in caplog.text


# ------------------------------------------------------------------------------------------
# per-address forward targets (an address that forwards to a group)
# ------------------------------------------------------------------------------------------
ANN = "ann@partners.example"
RAJ = "raj@elsewhere.example"
TEAM = "team@eisenberg.dev"


def group_reply(sender, relay_addr=RELAY1, quoted=""):
    """A reply written in a group member's own mailbox, quoting the forward they received."""
    text = (
        "We can do Thursday.\n\n"
        f"On Tue, Bob Smith via {TEAM} <{relay_addr}> wrote:\n"
        f"> To: {ANN}, {RAJ}\n{quoted}"
        "> Is the bike still available?\n"
    )
    return owner_reply(relay_addr, from_header=f"Member <{sender}>", text=text, html=f"<p>{text}</p>", attachment=None)


def test_an_address_forwards_to_its_own_mailboxes_instead_of_the_default(processor, s3, ses, db, send):
    db.set_rule(TEAM, forward_to=[ANN, RAJ])
    outcome, _ = deliver(processor, s3, recipients=(TEAM,))
    assert outcome == "forwarded"
    (sent,) = ses.sent
    assert sent["Destinations"] == [ANN, RAJ]
    assert [a.addr_spec for a in relay.parse(sent["Data"])["To"].addresses] == [ANN, RAJ]
    assert OWNER.encode() not in sent["Data"].lower()                    # the default mailbox is not involved
    assert db.tokens[TOKEN1]["forwarded_to"] == [ANN, RAJ]
    # an address without its own list still goes to the default, and only OWNER_ADDRESSES may answer it
    deliver(processor, s3, "in-2")
    assert ses.sent[1]["Destinations"] == [OWNER]
    assert db.tokens[f"{2:032x}"]["forwarded_to"] is None


def test_addresses_with_different_mailboxes_get_separate_forwards(processor, s3, ses, db, send):
    """One message to several addresses: the people behind one address neither see the mailboxes
    of another nor get a token that answers as it."""
    db.set_rule(TEAM, forward_to=[ANN, RAJ])
    db.set_rule(OTHER, forward_to=[RAJ.upper()])
    db.set_rule("quiet@eisenberg.dev", forward=False, forward_to=["never@private.example"])
    db.set_rule("also@eisenberg.dev", forward_to=[RAJ, ANN.upper()])          # the same people as TEAM
    outcome, _ = deliver(processor, s3, recipients=(ALIAS, TEAM, OTHER, "quiet@eisenberg.dev", "also@eisenberg.dev"))
    assert outcome == "forwarded"
    assert [sent["Destinations"] for sent in ses.sent] == [[OWNER], [ANN, RAJ], [RAJ], [RAJ, ANN]]
    for sent in ses.sent:
        shown = {a.addr_spec for a in relay.parse(sent["Data"])["To"].addresses}
        assert shown == set(sent["Destinations"])
        for other in {OWNER, ANN, RAJ} - shown:
            assert other.encode() not in sent["Data"].lower()
    tokens = {row["alias_address"]: row for row in db.tokens.values()}
    assert sorted(tokens) == sorted([ALIAS, TEAM, OTHER, "also@eisenberg.dev"])
    assert tokens[ALIAS]["forwarded_to"] is None
    assert tokens[TEAM]["forwarded_to"] == [ANN, RAJ] and tokens[OTHER]["forwarded_to"] == [RAJ]
    assert db.inbox["in-1"]["meta"]["forwarded"] is True

    # Ann is on TEAM's list: she cannot answer through the owner's forward of the same message
    ses.sent.clear()
    owners = f"reply-{tokens[ALIAS]['token']}@{DOMAIN}"
    outcome, _ = deliver(processor, s3, "reply-in-1", group_reply(ANN, owners), recipients=(owners,),
                         from_header=f"Member <{ANN}>")
    assert outcome != "relayed" and ses.to(BOB) == []
    # through her own forward she answers as TEAM
    ses.sent.clear()
    teams = f"reply-{tokens[TEAM]['token']}@{DOMAIN}"
    outcome, _ = deliver(processor, s3, "reply-in-2", group_reply(ANN, teams), recipients=(teams,),
                         from_header=f"Member <{ANN}>")
    assert outcome == "relayed" and ses.sent[0]["Source"] == TEAM


def test_addresses_sharing_the_default_mailbox_still_get_one_forward(processor, s3, ses, db, send):
    deliver(processor, s3, recipients=(ALIAS, OTHER))
    assert [sent["Destinations"] for sent in ses.sent] == [[OWNER]]
    assert [row["alias_address"] for row in db.tokens.values()] == [ALIAS]


def test_a_retry_only_sends_the_forwards_that_are_missing(processor, s3, ses, db, send):
    db.set_rule(TEAM, forward_to=[ANN])
    ses.fail = lambda kwargs: ConnectionError("down") if kwargs["Destinations"] == [ANN] else None
    with pytest.raises(ConnectionError):
        deliver(processor, s3, recipients=(ALIAS, TEAM))
    assert [sent["Destinations"] for sent in ses.sent] == [[OWNER]]
    assert "forwarded" not in db.inbox["in-1"]["meta"]
    ses.fail = None
    assert deliver(processor, s3, recipients=(ALIAS, TEAM))[0] == "forwarded"
    assert [sent["Destinations"] for sent in ses.sent] == [[OWNER], [ANN]]     # the owner's is not sent twice
    assert len(db.tokens) == 2 and db.inbox["in-1"]["meta"]["forwarded"] is True
    assert deliver(processor, s3, recipients=(ALIAS, TEAM))[0] == "duplicate"


def test_a_default_mailbox_that_is_not_an_owner_address_cannot_answer(make_processor, s3, ses, db):
    """FORWARD_TO may hold a mailbox that only receives (an archive); OWNER_ADDRESSES decides."""
    archive = "archive@corp.example"
    processor = make_processor(forward_to=(OWNER, archive), owner_addresses=(OWNER,))
    deliver(processor, s3)
    assert ses.sent[0]["Destinations"] == [OWNER, archive]
    ses.sent.clear()
    outcome, _ = deliver(processor, s3, "reply-in-1", group_reply(archive), recipients=(RELAY1,),
                         from_header=f"Member <{archive}>")
    assert outcome != "relayed" and ses.to(BOB) == []


def test_a_correspondent_who_is_on_a_list_can_be_answered(processor, s3, ses, db, send):
    """Ann, a member of the group, writes to the group address herself."""
    db.set_rule(TEAM, forward_to=[ANN, RAJ])
    db.set_rule(OTHER, forward_to=["ob@sender.example"])                     # the tail of bob@sender.example
    s3.put("in-1", inbound_message(from_header=f"Ann <{ANN}>"))
    assert processor.process_record(ses_record("in-1", (TEAM,), from_header=f"Ann <{ANN}>")) == "forwarded"
    ses.sent.clear()
    outcome, _ = deliver(processor, s3, "reply-in-1", group_reply(RAJ), recipients=(RELAY1,),
                         from_header=f"Member <{RAJ}>")
    assert outcome == "relayed"
    (sent,) = ses.sent
    assert sent["Destinations"] == [ANN] and RAJ.encode() not in sent["Data"].lower()

    # a list mailbox that is the tail of the correspondent's address does not block the reply ...
    deliver(processor, s3, "in-2")                                           # from bob@sender.example, default mailbox
    ses.sent.clear()
    relay2 = f"reply-{2:032x}@{DOMAIN}"
    assert deliver(processor, s3, "reply-in-2", owner_reply(relay2), recipients=(relay2,),
                   from_header=f"Owner Private <{OWNER_MIXED}>")[0] == "relayed"
    assert ses.sent[0]["Destinations"] == [BOB]
    # ... but that mailbox on its own is still caught
    assert relay.assert_no_leak(b"To: bob@sender.example\r\n\r\nhi", ["ob@sender.example"], None,
                                allow=("bob@sender.example",)) is None
    with pytest.raises(relay.LeakError):
        relay.assert_no_leak(b"To: bob@sender.example\r\n\r\nask ob@sender.example", ["ob@sender.example"], None,
                             allow=("bob@sender.example",))


def test_a_reply_that_cannot_be_sent_is_reported_to_its_writer_only(processor, s3, ses, db, send):
    db.set_rule(TEAM, forward_to=[ANN, RAJ])
    deliver(processor, s3, recipients=(TEAM,))
    ses.sent.clear()
    leaky = (b"--_004_outer_\r\nContent-Type: application/octet-stream; name=\"export.dat\"\r\n"
             b"Content-Transfer-Encoding: base64\r\n\r\n" + base64.b64encode(b"\x00to=" + RAJ.encode() + b"\x02"))
    raw = owner_reply(RELAY1, extra_parts=leaky)                              # written by the owner
    assert deliver(processor, s3, "reply-in-1", raw, recipients=(RELAY1,),
                   from_header=f"Owner Private <{OWNER_MIXED}>")[0] == "relay_blocked"
    (notice,) = ses.sent
    assert notice["Destinations"] == [OWNER] and ses.to(BOB) == []


def test_mail_to_a_relay_address_is_not_announced_to_the_members_of_that_domain(processor, s3, ses, db, send):
    """A refused relay attempt is mail from a private mailbox: only the owner hears of it."""
    db.users[2] = {"role": "member", "domains": [DOMAIN]}
    db.add_subscription(APPLE, user_id=2)
    db.set_rule(TEAM, forward_to=[ANN])
    deliver(processor, s3, recipients=(TEAM,))
    assert len(send.calls) == 2                                               # ordinary mail: owner and member
    send.calls.clear()
    deliver(processor, s3, "reply-in-1", group_reply(RAJ), recipients=(RELAY1,), from_header=f"Member <{RAJ}>")
    assert len(send.calls) == 1


@pytest.mark.parametrize("bad", [
    ["loop@eisenberg.dev"],                       # one of our own receiving addresses: a mail loop
    ["ann@partners.example\nBcc: x@evil.example"],
    ["not an address"],
    [],
])
def test_unusable_targets_fall_back_to_the_default_mailbox(processor, s3, ses, db, send, bad):
    db.set_rule(TEAM, forward_to=bad)
    assert deliver(processor, s3, recipients=(TEAM,))[0] == "forwarded"
    assert ses.sent[0]["Destinations"] == [OWNER]


def test_a_group_member_can_answer_and_no_private_address_reaches_the_correspondent(processor, s3, ses, db, send):
    db.set_rule(TEAM, forward_to=[ANN, RAJ])
    db.set_rule(OTHER, forward_to=["third@private.example"])
    deliver(processor, s3, recipients=(TEAM,))
    ses.sent.clear()
    quoted = "> Cc: third@private.example\n"
    outcome, _ = deliver(processor, s3, "reply-in-1", group_reply(RAJ, quoted=quoted), recipients=(RELAY1,),
                         from_header=f"Member <{RAJ}>")
    assert outcome == "relayed"
    (sent,) = ses.sent
    assert sent["Source"] == TEAM and sent["Destinations"] == [BOB]
    low = sent["Data"].lower()
    for private in (ANN, RAJ, OWNER, "third@private.example"):
        assert private.encode() not in low
    assert b"we can do thursday" in low


def test_only_the_mailboxes_a_forward_went_to_may_answer_it(processor, s3, ses, db, send):
    db.set_rule(TEAM, forward_to=[ANN])
    db.set_rule(OTHER, forward_to=[RAJ])
    deliver(processor, s3, recipients=(TEAM,))                             # token 1: went to ANN only
    ses.sent.clear()
    # RAJ is a forward target of another address, not of this message
    outcome, _ = deliver(processor, s3, "reply-in-1", group_reply(RAJ), recipients=(RELAY1,),
                         from_header=f"Member <{RAJ}>")
    assert outcome == "forwarded"                                         # refused: handled as ordinary inbound
    assert ses.to(BOB) == []
    assert db.tokens[TOKEN1]["use_count"] == 0
    # the owner can always answer, also for a group address
    ses.sent.clear()
    outcome, _ = deliver(processor, s3, "reply-in-2", owner_reply(RELAY1), recipients=(RELAY1,),
                         from_header=f"Owner Private <{OWNER_MIXED}>")
    assert outcome == "relayed" and ses.sent[0]["Destinations"] == [BOB]


def test_a_group_member_needs_dmarc_pass_like_the_owner(processor, s3, ses, db, send):
    db.set_rule(TEAM, forward_to=[ANN])
    deliver(processor, s3, recipients=(TEAM,))
    ses.sent.clear()
    outcome, _ = deliver(processor, s3, "reply-in-1", group_reply(ANN), recipients=(RELAY1,),
                         from_header=f"Member <{ANN}>", dmarc="FAIL")
    assert outcome != "relayed" and ses.to(BOB) == []
