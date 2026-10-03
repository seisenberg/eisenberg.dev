"""inbox.py: per-record orchestration with fake S3 / SES / database."""
import logging
import os
import re
import subprocess
import sys

import pytest

import inbox
import relay
from helpers import (ALIAS, ATTACHMENT, BOB, DOMAIN, FIXED_NOW, INBOUND_BODY, OWNER, OWNER_MIXED, OWNER_SECRETS,
                     b64, inbound_message, owner_reply, ses_record, simple_message, text_parts, top_header_names)

TOKEN1 = f"{1:032x}"          # first token the test token factory hands out
RELAY1 = f"reply-{TOKEN1}@{DOMAIN}"
OWNER_FROM = f"Owner Private <{OWNER_MIXED}>"


def deliver(processor, s3, message_id, raw, recipients=(ALIAS,), **record_kwargs):
    s3.put(message_id, raw)
    record = ses_record(message_id, recipients, **record_kwargs)
    return processor.process_record(record), record


def receive_from_bob(processor, s3, message_id="in-1"):
    outcome, record = deliver(processor, s3, message_id, inbound_message())
    assert outcome == "forwarded"
    return record


def reply_from_owner(processor, s3, message_id="reply-in-1", raw=None, relay_addr=RELAY1, **record_kwargs):
    record_kwargs.setdefault("from_header", OWNER_FROM)
    raw = owner_reply(relay_addr) if raw is None else raw
    return deliver(processor, s3, message_id, raw, recipients=(relay_addr,), **record_kwargs)


# ------------------------------------------------------------------------------------------
# import safety / wiring
# ------------------------------------------------------------------------------------------
def test_import_needs_no_aws_no_database_and_no_configuration():
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AWS_", "POSTGRES_", "SSH_TUNNEL", "FORWARD", "MAIL_"))}
    code = (
        "import socket\n"
        "def boom(*a, **k): raise RuntimeError('network used at import time')\n"
        "socket.socket.connect = boom; socket.create_connection = boom\n"
        "import inbox, relay, config, db\n"
        "assert inbox._singletons == {}\n"
        "assert callable(inbox.lambda_handler)\n"
    )
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    result = subprocess.run([sys.executable, "-c", code], cwd=root, env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_lambda_handler_uses_lazily_created_dependencies(monkeypatch, s3, ses, db):
    from helpers import make_config
    monkeypatch.setattr(inbox, "_singletons", {})
    monkeypatch.setattr(inbox, "get_config", lambda: make_config())
    monkeypatch.setattr(inbox, "get_s3", lambda: s3)
    monkeypatch.setattr(inbox, "get_ses", lambda: ses)
    monkeypatch.setattr(inbox, "get_db", lambda: db)
    s3.put("in-1", inbound_message())
    assert inbox.lambda_handler({"Records": [ses_record("in-1", [ALIAS])]}, None) is None
    assert db.inbox["in-1"]["kind"] == "inbound" and len(ses.sent) == 1
    assert inbox.lambda_handler({"Records": []}, None) is None
    assert inbox.lambda_handler({}, None) is None


# ------------------------------------------------------------------------------------------
# normal inbound
# ------------------------------------------------------------------------------------------
def test_inbound_inline_forward(processor, s3, ses, db):
    raw = inbound_message()
    outcome, record = deliver(processor, s3, "in-1", raw, recipients=("Cool_Stuff@Eisenberg.dev",))
    assert outcome == "forwarded"

    row = db.inbox["in-1"]
    assert row["kind"] == "inbound"
    assert row["s3_key"] == "email-inbox/in-1"
    assert row["email_raw"] == raw
    assert row["event"] == record["ses"]                 # the full notification, nothing removed
    assert row["meta"] == {"forwarded": True, "notified": False}

    assert list(db.tokens) == [TOKEN1]
    token = db.tokens[TOKEN1]
    assert token["inbox_message_id"] == "in-1"
    assert token["alias_address"] == ALIAS
    assert token["correspondent"] == BOB and token["correspondent_name"] == "Bob Smith"
    assert token["orig_message_id"] == "<orig-1@sender.example>"
    assert token["orig_references"] == "<root@sender.example> <earlier-0@eisenberg.dev>"
    assert token["subject"] == "Hello about the bike"
    assert token["use_count"] == 0

    (sent,) = ses.sent
    assert sent["Source"] == RELAY1
    assert sent["Destinations"] == [OWNER]
    msg = relay.parse(sent["Data"])
    (sender,) = msg["From"].addresses
    assert (sender.display_name, sender.addr_spec) == (f"Bob Smith via {ALIAS}", RELAY1)
    assert [a.addr_spec for a in msg["To"].addresses] == [OWNER]
    assert msg["Subject"] == "Hello about the bike"
    assert msg["X-Eisenmail-Message-Id"] == "in-1"
    assert msg["X-Eisenmail-Recipients"] == ALIAS
    assert msg["X-Auto-Response-Suppress"] == "OOF, AutoReply"
    assert msg["Message-ID"] != "<orig-1@sender.example>"
    assert msg["In-Reply-To"] == "<earlier-0@eisenberg.dev>"
    # original body and attachment survive byte for byte
    assert relay.split_raw(sent["Data"])[1] == INBOUND_BODY
    (attachment,) = [p for p in msg.walk() if p.get_filename() == "blob.bin"]
    assert attachment.get_payload(decode=True) == ATTACHMENT
    assert not ses.bounces


def test_inbound_attach_forward(make_processor, s3, ses, db):
    raw = inbound_message()
    db.set_rule(ALIAS, forward_style="attach")
    outcome, _ = deliver(make_processor(), s3, "in-1", raw)
    assert outcome == "forwarded"
    assert db.inbox["in-1"]["kind"] == "inbound" and TOKEN1 in db.tokens
    (sent,) = ses.sent
    assert sent["Source"] == RELAY1 and sent["Destinations"] == [OWNER]
    msg = relay.parse(sent["Data"])
    assert msg["Subject"] == f"FW {ALIAS}: Hello about the bike"
    (sender,) = msg["From"].addresses
    assert (sender.display_name, sender.addr_spec) == (f"Bob Smith via {ALIAS}", RELAY1)
    assert [a.addr_spec for a in msg["To"].addresses] == [OWNER]
    assert raw in sent["Data"]
    assert [p.get_content_type() for p in msg.iter_parts()] == ["multipart/alternative", "message/rfc822"]


def test_inbound_forwards_to_every_forward_address(make_processor, s3, ses):
    processor = make_processor(forward_to=(OWNER, "second@private.example"))
    deliver(processor, s3, "in-1", inbound_message())
    (sent,) = ses.sent
    assert sent["Destinations"] == [OWNER, "second@private.example"]
    assert [a.addr_spec for a in relay.parse(sent["Data"])["To"].addresses] == [OWNER, "second@private.example"]


def test_missing_verdicts_are_not_failures(processor, s3, ses, db):
    s3.put("in-1", inbound_message())
    record = {"ses": {"mail": {"messageId": "in-1"}, "receipt": {"recipients": [ALIAS]}}}
    assert processor.process_record(record) == "forwarded"
    assert db.inbox["in-1"]["kind"] == "inbound" and len(ses.sent) == 1


def test_alias_is_first_recipient_in_mail_domains(make_processor, s3, ses, db):
    processor = make_processor(mail_domains=(DOMAIN, "second.example"))
    outcome, _ = deliver(processor, s3, "in-1", inbound_message(),
                         recipients=("someone@elsewhere.example", "Shop@Second.Example", ALIAS))
    assert outcome == "forwarded"
    assert db.tokens[TOKEN1]["alias_address"] == "shop@second.example"
    assert ses.sent[0]["Source"] == f"reply-{TOKEN1}@second.example"
    msg = relay.parse(ses.sent[0]["Data"])
    assert msg["From"].addresses[0].display_name == "Bob Smith via shop@second.example"
    assert msg["X-Eisenmail-Recipients"] == f"someone@elsewhere.example, shop@second.example, {ALIAS}"


def test_no_recipient_in_mail_domains_forwards_from_fallback_domain_without_token(processor, s3, ses, db):
    outcome, _ = deliver(processor, s3, "in-1", inbound_message(), recipients=("x@elsewhere.example",))
    assert outcome == "forwarded"
    assert db.tokens == {}
    assert ses.sent[0]["Source"] == f"noreply@{DOMAIN}"


@pytest.mark.parametrize("from_header", ["", "undisclosed-recipients", "<>"])
def test_no_parseable_from_forwards_without_relay_token(processor, s3, ses, db, from_header):
    outcome, _ = deliver(processor, s3, "in-1", simple_message(from_header=from_header))
    assert outcome == "forwarded"
    assert db.inbox["in-1"]["kind"] == "inbound"
    assert db.tokens == {}
    (sent,) = ses.sent
    assert sent["Source"] == f"noreply@{DOMAIN}"
    assert relay.parse(sent["Data"])["From"].addresses[0].addr_spec == f"noreply@{DOMAIN}"


def test_hostile_headers_do_not_break_processing(processor, s3, ses, db):
    raw = simple_message(from_header="=?utf-8?q?Evil=0D=0ABcc=3A_victim=40x.example?= <evil@sender.example>",
                         subject="=?utf-8?q?Hi=0D=0ABcc:_victim@x.example?=")
    outcome, _ = deliver(processor, s3, "in-1", raw)
    assert outcome == "forwarded"
    (sent,) = ses.sent
    assert sent["Destinations"] == [OWNER]
    names = top_header_names(sent["Data"])
    assert "bcc" not in names and names.count("from") == 1
    token = db.tokens[TOKEN1]
    assert token["correspondent"] == "evil@sender.example"
    assert "\r" not in token["correspondent_name"] + token["subject"]
    assert "\n" not in token["correspondent_name"] + token["subject"]


# ------------------------------------------------------------------------------------------
# verdicts
# ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("verdict", ["spf", "dkim", "spam"])
def test_failed_verdict_is_stored_as_junk_and_not_forwarded(processor, s3, ses, db, verdict):
    raw = inbound_message()
    outcome, record = deliver(processor, s3, "in-1", raw, **{verdict: "FAIL"})
    assert outcome == "junk"
    row = db.inbox["in-1"]
    assert (row["kind"], row["email_raw"], row["s3_key"]) == ("junk", raw, "email-inbox/in-1")
    assert row["event"] == record["ses"]
    assert ses.sent == [] and ses.bounces == [] and db.tokens == {}
    # idempotent on retry
    assert processor.process_record(record) == "junk"
    assert len(db.inbox) == 1


def test_junk_to_a_relay_address_is_never_relayed(processor, s3, ses, db):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    outcome, _ = reply_from_owner(processor, s3, spf="FAIL")
    assert outcome == "junk"
    assert db.inbox["reply-in-1"]["kind"] == "junk" and ses.sent == []


def test_virus_is_dropped_without_touching_s3_or_database(processor, s3, ses, db):
    s3.put("in-1", inbound_message())
    assert processor.process_record(ses_record("in-1", [ALIAS], virus="FAIL", spam="FAIL")) == "dropped_virus"
    assert s3.gets == [] and db.inbox == {} and db.tokens == {} and ses.sent == [] and ses.bounces == []


@pytest.mark.parametrize("policy", ["reject", "REJECT", {"status": "REJECT"}])
def test_dmarc_reject_bounces_and_stores_nothing(processor, s3, ses, db, policy):
    s3.put("in-1", inbound_message())
    record = ses_record("in-1", ["Cool_Stuff@Eisenberg.dev"], dmarc="FAIL", dmarc_policy=policy)
    assert processor.process_record(record) == "bounced"
    (bounce,) = ses.bounces
    assert bounce["OriginalMessageId"] == "in-1"
    assert bounce["BounceSender"] == f"mailer-daemon@{DOMAIN}"
    assert bounce["MessageDsn"] == {"ReportingMta": f"dns; {DOMAIN}", "ArrivalDate": FIXED_NOW, "ExtensionFields": []}
    assert bounce["BouncedRecipientInfoList"] == [
        {"Recipient": "Cool_Stuff@Eisenberg.dev", "BounceType": "ContentRejected"}]
    assert "DMARC" in bounce["Explanation"]
    assert s3.gets == [] and db.inbox == {} and ses.sent == []


@pytest.mark.parametrize("policy", [None, "none", "quarantine", {"status": "NONE"}])
def test_dmarc_fail_without_reject_policy_is_forwarded(processor, s3, ses, db, policy):
    outcome, _ = deliver(processor, s3, "in-1", inbound_message(), dmarc="FAIL", dmarc_policy=policy)
    assert outcome == "forwarded" and not ses.bounces and db.inbox["in-1"]["kind"] == "inbound"


# ------------------------------------------------------------------------------------------
# multi-record events and retries
# ------------------------------------------------------------------------------------------
def test_one_bad_record_does_not_stop_the_others(processor, s3, ses, db, caplog):
    s3.put("in-1", inbound_message(message_id="<m1@sender.example>"))
    s3.put("in-3", inbound_message(message_id="<m3@sender.example>"))
    s3.put("in-4", inbound_message())
    event = {"Records": [
        ses_record("in-1", [ALIAS]),
        ses_record("in-2-missing-in-s3", [ALIAS]),
        ses_record("in-3", [ALIAS]),
        {"ses": {"receipt": {}}},                         # malformed: no mail.messageId
        ses_record("in-4", [ALIAS], spam="FAIL"),
    ]}
    with caplog.at_level(logging.INFO, logger="eisenmail"):
        with pytest.raises(inbox.RecordsFailed) as failure:
            processor.process_event(event)
    assert "2 of 5 record(s) failed" in str(failure.value) and "in-2-missing-in-s3" in str(failure.value)
    assert sorted(db.inbox) == ["in-1", "in-3", "in-4"]
    assert [db.inbox[k]["kind"] for k in ("in-1", "in-3", "in-4")] == ["inbound", "inbound", "junk"]
    assert len(ses.sent) == 2
    assert "record in-2-missing-in-s3: FAILED" in caplog.text
    # nothing from the mail itself ends up in the log
    assert "bike" not in caplog.text and BOB not in caplog.text


def test_event_without_failures_returns_outcomes(processor, s3):
    s3.put("in-1", inbound_message())
    assert processor.process_event({"Records": [ses_record("in-1", [ALIAS])]}) == ["forwarded"]


def test_retry_does_not_store_or_forward_twice(processor, s3, ses, db):
    record = receive_from_bob(processor, s3)
    assert processor.process_record(record) == "duplicate"
    assert processor.process_record(record) == "duplicate"
    assert len(db.inbox) == 1 and len(db.tokens) == 1 and len(ses.sent) == 1


def test_retry_after_failed_forward_sends_exactly_once_with_the_same_token(processor, s3, ses, db):
    s3.put("in-1", inbound_message())
    record = ses_record("in-1", [ALIAS])
    ses.fail = lambda kwargs: ConnectionError("SES endpoint unreachable")
    with pytest.raises(ConnectionError):
        processor.process_record(record)
    assert db.inbox["in-1"]["meta"] == {"notified": False} and list(db.tokens) == [TOKEN1] and ses.sent == []

    ses.fail = None
    assert processor.process_record(record) == "forwarded"
    assert list(db.tokens) == [TOKEN1]                     # token of the first attempt is reused
    assert [s["Source"] for s in ses.sent] == [RELAY1]
    assert processor.process_record(record) == "duplicate"
    assert len(ses.sent) == 1


def test_retry_after_failed_token_insert(processor, s3, ses, db):
    s3.put("in-1", inbound_message())
    record = ses_record("in-1", [ALIAS])
    db.fail = lambda name: RuntimeError("db down") if name == "create_token" else None
    with pytest.raises(RuntimeError):
        processor.process_record(record)
    assert "in-1" in db.inbox and db.tokens == {} and ses.sent == []
    db.fail = None
    assert processor.process_record(record) == "forwarded"
    assert len(db.tokens) == 1 and len(ses.sent) == 1


# ------------------------------------------------------------------------------------------
# size fallback
# ------------------------------------------------------------------------------------------
class FakeClientError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(f"An error occurred ({code}): {message}")
        self.response = {"Error": {"Code": code, "Message": message}, "ResponseMetadata": {"HTTPStatusCode": status}}


@pytest.mark.parametrize("error", [
    FakeClientError("InvalidParameterValue", "Message length is more than 10485760 bytes long: '10912345'."),
    FakeClientError("MessageRejected", "Message size exceeds the maximum allowed"),
    FakeClientError("RequestEntityTooLarge", "", status=413),
    RuntimeError("Request body too large"),
])
def test_oversized_forward_falls_back_to_notice(processor, s3, ses, db, error):
    big = simple_message(body="x" * 76 + "\r\n") + b"y" * (inbox.SIZE_FALLBACK_MIN_BYTES + 1)
    ses.fail = lambda kwargs: error if len(kwargs["Data"]) > 100_000 else None
    outcome, _ = deliver(processor, s3, "in-1", big)
    assert outcome == "forwarded_notice"
    (sent,) = ses.sent
    assert sent["Source"] == RELAY1 and sent["Destinations"] == [OWNER]
    msg = relay.parse(sent["Data"])
    assert "too large to forward" in msg.get_content() and len(sent["Data"]) < 2000
    assert msg["Subject"] == "Plain"
    assert msg["From"].addresses[0].addr_spec == RELAY1    # the owner can still reply through the relay
    assert db.inbox["in-1"]["meta"] == {"forwarded": True, "notified": False} and TOKEN1 in db.tokens


@pytest.mark.parametrize("error,big", [
    (FakeClientError("MessageRejected", "Email address is not verified."), True),
    (FakeClientError("Throttling", "Maximum sending rate exceeded."), True),
    (FakeClientError("Throttling", "Daily message quota exceeded."), True),
    (FakeClientError("LimitExceededException", "Message size limit exceeded"), True),
    (ConnectionError("connection reset"), True),
    # a "size" error for a small message is not believable: fail the record, let Lambda retry
    (FakeClientError("InvalidParameterValue", "Message length is more than 10485760 bytes long"), False),
])
def test_other_send_errors_fail_the_record(processor, s3, ses, db, error, big):
    raw = simple_message() + (b"y" * (inbox.SIZE_FALLBACK_MIN_BYTES + 1) if big else b"")
    ses.fail = lambda kwargs: error
    with pytest.raises(type(error)):
        deliver(processor, s3, "in-1", raw)
    assert ses.sent == []
    assert db.inbox["in-1"]["meta"] == {"notified": False}                 # stored, forward still pending for the retry


# ------------------------------------------------------------------------------------------
# reply relay
# ------------------------------------------------------------------------------------------
def test_authorised_reply_is_relayed_to_the_correspondent(processor, s3, ses, db):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    outcome, record = reply_from_owner(processor, s3)
    assert outcome == "relayed"

    (sent,) = ses.sent
    assert sent["Source"] == ALIAS
    assert sent["Destinations"] == [BOB]
    data = sent["Data"]
    msg = relay.parse(data)
    assert set(top_header_names(data)) <= relay.RELAY_ALLOWED_HEADERS
    assert str(msg["From"]) == ALIAS
    (to,) = msg["To"].addresses
    assert (to.display_name, to.addr_spec) == ("Bob Smith", BOB)
    assert msg["Subject"] == "Re: Hello about the bike"
    assert msg["In-Reply-To"] == "<orig-1@sender.example>"
    assert msg["References"] == "<root@sender.example> <earlier-0@eisenberg.dev> <orig-1@sender.example>"
    assert str(msg["Message-ID"]).endswith(f"@{DOMAIN}>")

    low = data.lower()
    assert OWNER.encode() not in low
    assert not re.search(rb"reply-[0-9a-f]{32}", low)
    for secret in OWNER_SECRETS:
        assert secret.lower().encode() not in low
    for _, text in text_parts(data):
        assert OWNER not in text.lower() and "reply-0" not in text.lower()
    (attachment,) = [p for p in msg.walk() if p.get_content_type() == "application/pdf"]
    assert attachment.get_payload(decode=True) == ATTACHMENT

    # stored as relay_out; the owner's own message is NOT stored as inbound and not forwarded back
    assert sorted(db.inbox) == ["in-1", "relay-ses-out-1"]
    row = db.inbox["relay-ses-out-1"]
    assert row["kind"] == "relay_out"
    assert row["email_raw"] == data
    assert row["event"] == record["ses"]
    assert row["s3_key"] is None
    assert row["meta"] == {"from": ALIAS, "to": [BOB], "cc": [], "bcc": [],
                           "in_reply_to_raw_id": "in-1", "relay_source_id": "reply-in-1"}
    assert db.tokens[TOKEN1]["use_count"] == 1 and db.tokens[TOKEN1]["last_used_at"] is not None
    assert len(db.tokens) == 1
    assert ses.to(OWNER) == []


def test_relay_in_attach_mode_strips_the_fw_segment(make_processor, s3, ses, db):
    db.set_rule(ALIAS, forward_style="attach")
    processor = make_processor()
    receive_from_bob(processor, s3)
    ses.sent.clear()
    raw = owner_reply(RELAY1, subject=f"Re: FW {ALIAS}: Hello about the bike")
    outcome, _ = reply_from_owner(processor, s3, raw=raw)
    assert outcome == "relayed"
    assert relay.parse(ses.sent[0]["Data"])["Subject"] == "Re: Hello about the bike"


def test_relay_retry_is_idempotent(processor, s3, ses, db):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    outcome, record = reply_from_owner(processor, s3)
    assert outcome == "relayed"
    assert processor.process_record(record) == "relay_duplicate"
    assert len(ses.sent) == 1 and db.tokens[TOKEN1]["use_count"] == 1
    assert sorted(db.inbox) == ["in-1", "relay-ses-out-1"]


def test_token_can_be_used_for_several_replies(processor, s3, ses, db):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    assert reply_from_owner(processor, s3, "reply-in-1")[0] == "relayed"
    assert reply_from_owner(processor, s3, "reply-in-2")[0] == "relayed"
    assert [s["Destinations"] for s in ses.sent] == [[BOB], [BOB]]
    assert db.tokens[TOKEN1]["use_count"] == 2


def test_reply_goes_to_reply_to_when_the_original_had_one(processor, s3, ses, db):
    raw = inbound_message(extra_headers="Reply-To: Bob Private <bob.other@sender-two.example>\n")
    deliver(processor, s3, "in-1", raw)
    ses.sent.clear()
    assert reply_from_owner(processor, s3)[0] == "relayed"
    assert ses.sent[0]["Destinations"] == ["bob.other@sender-two.example"]
    assert relay.parse(ses.sent[0]["Data"])["To"].addresses[0].display_name == "Bob Private"


def assert_handled_as_normal_inbound(ses, db, message_id="reply-in-1", forwarded=True):
    """The refused relay attempt is an ordinary inbound mail to the reply-... address."""
    assert ses.to(BOB) == []                                         # never reaches the correspondent
    assert db.inbox[message_id]["kind"] == "inbound"
    assert not any(row["kind"] == "relay_out" for row in db.inbox.values())
    assert db.tokens[TOKEN1]["use_count"] == 0
    if forwarded:
        (sent,) = ses.sent
        assert sent["Destinations"] == [OWNER]
        assert relay.parse(sent["Data"])["X-Eisenmail-Message-Id"] == message_id
        assert relay.parse(sent["Data"])["X-Eisenmail-Recipients"] == RELAY1
    else:
        assert ses.sent == []


@pytest.mark.parametrize("from_header", [
    "Mallory <mallory@evil.example>",
    f'"{OWNER}" <mallory@evil.example>',
    f"{OWNER_MIXED}, mallory@evil.example",
    f"x{OWNER}",
])
def test_relay_refused_for_wrong_sender(processor, s3, ses, db, caplog, from_header):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    with caplog.at_level(logging.WARNING, logger="eisenmail"):
        outcome, _ = reply_from_owner(processor, s3, raw=owner_reply(RELAY1, from_header=from_header),
                                      from_header=from_header)
    assert outcome == "forwarded"
    assert_handled_as_normal_inbound(ses, db)
    assert "relay refused" in caplog.text
    assert "Yes, it is still available" not in caplog.text            # reason only, no content


def test_relay_refused_when_ses_saw_a_different_from_header(processor, s3, ses, db):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    outcome, _ = reply_from_owner(processor, s3, from_header="Mallory <mallory@evil.example>")
    assert outcome == "forwarded"
    assert_handled_as_normal_inbound(ses, db)


@pytest.mark.parametrize("dmarc", ["FAIL", "GRAY", "PROCESSING_FAILED", None])
def test_relay_refused_unless_dmarc_pass(processor, s3, ses, db, dmarc):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    outcome, _ = reply_from_owner(processor, s3, dmarc=dmarc)
    assert outcome == "forwarded"
    assert_handled_as_normal_inbound(ses, db)


def test_relay_refused_for_unknown_token(processor, s3, ses, db):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    unknown = f"reply-{'f' * 32}@{DOMAIN}"
    outcome, _ = reply_from_owner(processor, s3, relay_addr=unknown)
    assert outcome == "forwarded"
    assert ses.to(BOB) == []
    assert db.inbox["reply-in-1"]["kind"] == "inbound"
    assert not any(row["kind"] == "relay_out" for row in db.inbox.values())
    assert ses.sent[0]["Destinations"] == [OWNER]


@pytest.mark.parametrize("header", [
    "Auto-Submitted: auto-replied\n",
    "X-Autoreply: yes\n",
    "X-Autorespond: yes\n",
    "Precedence: bulk\n",
    "Precedence: auto_reply\n",
])
def test_auto_reply_is_never_relayed_and_not_bounced_back_to_the_owner(processor, s3, ses, db, header):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    outcome, _ = reply_from_owner(processor, s3, raw=owner_reply(RELAY1, extra_headers=header))
    assert outcome == "stored"
    # stored as normal inbound, but not forwarded: forwarding an auto-reply to the mailbox that
    # produced it would be answered again, forever
    assert_handled_as_normal_inbound(ses, db, forwarded=False)
    assert len(db.tokens) == 1


BOUNCE = (
    b"Return-Path: <>\r\n"
    b"From: MAILER-DAEMON@bounces.example\r\n"
    b"To: " + RELAY1.encode() + b"\r\n"
    b"Subject: Delivery Status Notification (Failure)\r\n"
    b"Message-ID: <dsn-1@bounces.example>\r\n"
    b'Content-Type: multipart/report; report-type=delivery-status; boundary="dsn"\r\n\r\n'
    b"--dsn\r\nContent-Type: text/plain\r\n\r\nThe recipient's mailbox is full.\r\n"
    b"--dsn\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; a.amazonses.com\r\n\r\n"
    b"Final-Recipient: rfc822; " + OWNER.encode() + b"\r\nAction: failed\r\nStatus: 5.2.2\r\n\r\n--dsn--\r\n"
)


def test_bounce_of_a_forward_is_stored_but_not_forwarded_again(processor, s3, ses, db):
    # our forwards are sent From/Source the relay address, so their bounces come back to it
    receive_from_bob(processor, s3)
    ses.sent.clear()
    outcome, _ = deliver(processor, s3, "bounce-1", BOUNCE, recipients=(RELAY1,),
                         from_header="MAILER-DAEMON@bounces.example", dmarc="GRAY")
    assert outcome == "stored"
    assert db.inbox["bounce-1"]["kind"] == "inbound" and ses.sent == [] and len(db.tokens) == 1


def test_bounce_to_an_ordinary_alias_is_forwarded_normally(processor, s3, ses, db):
    # e.g. a relayed reply that could not be delivered: the owner should see it
    raw = BOUNCE.replace(RELAY1.encode(), ALIAS.encode())
    outcome, _ = deliver(processor, s3, "bounce-2", raw, from_header="MAILER-DAEMON@bounces.example", dmarc="GRAY")
    assert outcome == "forwarded" and ses.sent[0]["Destinations"] == [OWNER]


def test_leak_check_failure_sends_notice_and_nothing_to_the_correspondent(processor, s3, ses, db, caplog):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    leaky = (b"--_004_outer_\r\nContent-Type: application/octet-stream; name=\"export.dat\"\r\n"
             b"Content-Transfer-Encoding: base64\r\n\r\n" + b64(b"\x00\x01owner=" + OWNER_MIXED.encode() + b"\x02").encode())
    with caplog.at_level(logging.ERROR, logger="eisenmail"):
        outcome, _ = reply_from_owner(processor, s3, raw=owner_reply(RELAY1, extra_parts=leaky))
    assert outcome == "relay_blocked"
    assert ses.to(BOB) == []
    (notice,) = ses.sent
    assert notice["Destinations"] == [OWNER]
    assert notice["Source"] == f"mailer-daemon@{DOMAIN}"
    msg = relay.parse(notice["Data"])
    assert msg["From"].addresses[0].addr_spec == f"mailer-daemon@{DOMAIN}"
    assert msg["Subject"] == "Not delivered: Hello about the bike"
    assert "NOT delivered" in msg.get_content() and "private address found in part" in msg.get_content()
    assert sorted(db.inbox) == ["in-1"]                                # nothing stored for the blocked reply
    assert db.tokens[TOKEN1]["use_count"] == 0
    assert "relay reply NOT sent" in caplog.text and OWNER not in caplog.text.lower()


def test_any_leak_error_blocks_the_send(processor, s3, ses, db, monkeypatch):
    receive_from_bob(processor, s3)
    ses.sent.clear()

    def explode(raw_bytes, private_addresses, relay_address, **kwargs):
        assert list(private_addresses) == [OWNER] and relay_address == RELAY1
        raise relay.LeakError("relay address found in part 1 (text/plain) body")

    monkeypatch.setattr(relay, "assert_no_leak", explode)
    assert reply_from_owner(processor, s3)[0] == "relay_blocked"
    assert ses.to(BOB) == [] and [s["Destinations"] for s in ses.sent] == [[OWNER]]


def test_rewrite_crash_blocks_the_send_too(processor, s3, ses, db, monkeypatch):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    monkeypatch.setattr(relay, "build_relay_reply", lambda raw, p: (_ for _ in ()).throw(KeyError("boom")))
    assert reply_from_owner(processor, s3)[0] == "relay_blocked"
    assert ses.to(BOB) == []
    assert "could not be rewritten (KeyError)" in relay.parse(ses.sent[0]["Data"]).get_content()


def test_signed_reply_is_blocked_with_notice(processor, s3, ses, db):
    receive_from_bob(processor, s3)
    ses.sent.clear()
    raw = owner_reply(RELAY1).replace(b'multipart/mixed; boundary="_004_outer_"',
                                      b'multipart/signed; protocol="application/pkcs7-signature"; boundary="_004_outer_"')
    assert reply_from_owner(processor, s3, raw=raw)[0] == "relay_blocked"
    assert ses.to(BOB) == []
    assert "signed or encrypted" in relay.parse(ses.sent[0]["Data"]).get_content()


def test_private_addresses_include_forward_targets_that_are_not_owners(make_processor, s3, ses, db):
    # FORWARD_TO has a second mailbox that may not use the relay but must still never leak
    processor = make_processor(forward_to=(OWNER, "archive@private.example"), owner_addresses=(OWNER,))
    receive_from_bob(processor, s3)
    ses.sent.clear()
    text = f"cc'ing ARCHIVE@private.example\n\nFrom: Bob Smith via {ALIAS} <{RELAY1}>\nTo: {OWNER}\n"
    outcome, _ = reply_from_owner(processor, s3, raw=owner_reply(RELAY1, text=text, html="<p>ok</p>"))
    assert outcome == "relayed"
    data = ses.to(BOB)[0]["Data"]
    assert b"private.example" not in data.lower()
    assert f"cc'ing {ALIAS}" in dict(text_parts(data))["text/plain"]
