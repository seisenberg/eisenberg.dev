"""reconcile.py: rebuilding the SES notification from a stored message, and the scheduled replay."""
import logging
from datetime import datetime, timedelta, timezone

import pytest

import reconcile
import relay
from helpers import ALIAS, BOB, DOMAIN, FIXED_NOW, OWNER, OWNER_MIXED, crlf, inbound_message, owner_reply, ses_record

OTHER = "shop@eisenberg.dev"
TOKEN1 = f"{1:032x}"
RELAY1 = f"reply-{TOKEN1}@{DOMAIN}"
HOUR = timedelta(hours=1)


def mid(n: int) -> str:
    """A name that looks like an SES message id."""
    return f"ses{n:037d}"


def stored(
    message_id: str,
    *,
    rcpt: str | None = ALIAS,
    spam: str | None = "PASS",
    virus: str | None = "PASS",
    spf: str | None = "pass",
    dkim: str | None = "pass",
    dmarc: str | None = "pass",
    received_spf: bool = True,
    receipt: bool = True,
    to: str = "Cool Stuff <cool_stuff@eisenberg.dev>",
    from_header: str = "Bob Smith <bob@sender.example>",
    subject: str = "Hello about the bike",
    original_headers: str = "",
    body: str = "Is the bike still available?\n",
    return_path: str = "<bob@sender.example>",
) -> bytes:
    """A message as SES stores it in S3: SES's own headers first, then the message as it was sent."""
    spf_text = "(spfCheck: domain of sender.example designates 198.51.100.7 as permitted sender) " \
               "client-ip=198.51.100.7; envelope-from=bob@sender.example; helo=mail.sender.example;"
    lines = [f"Return-Path: {return_path}",
             "Received: from mail.sender.example (mail.sender.example [198.51.100.7])",
             f" by inbound-smtp.us-east-1.amazonaws.com with SMTP id {message_id}"]
    if rcpt:
        lines.append(f" for {rcpt};")
    lines.append(" Tue, 01 Sep 2026 14:00:01 +0000 (UTC)")
    if spam:
        lines.append(f"X-SES-Spam-Verdict: {spam}")
    if virus:
        lines.append(f"X-SES-Virus-Verdict: {virus}")
    if received_spf and spf:
        lines.append(f"Received-SPF: {spf} {spf_text}")
    if spf or dkim or dmarc:
        lines.append("Authentication-Results: amazonses.com;")
        if spf:
            lines.append(f" spf={spf} {spf_text}")
        if dkim:
            lines.append(f" dkim={dkim} header.i=@sender.example;")
        if dmarc:
            lines.append(f" dmarc={dmarc} header.from=sender.example;")
    if receipt:
        lines.append("X-SES-RECEIPT: AEFBQUFBQUFBQUFBRXhhbXBsZVJlY2VpcHREYXRhT25seQ==")
        lines.append("X-SES-DKIM-SIGNATURE: a=rsa-sha256; q=dns/txt; b=EXAMPLEONLY; c=relaxed/simple;")
    lines += ["Received: from laptop.sender.example (laptop.sender.example [203.0.113.9])",
              " by mail.sender.example with ESMTPSA id 77 for <someone-else@eisenberg.dev>;",
              " Tue, 01 Sep 2026 14:00:00 +0000"]
    head = "\n".join(lines) + "\n" + original_headers + (
        f"From: {from_header}\nTo: {to}\nSubject: {subject}\nMessage-ID: <orig-{message_id}@sender.example>\n"
        "Date: Tue, 01 Sep 2026 10:00:00 -0400\n\n"
    )
    return crlf(head + body).encode("utf-8")


def rebuild(raw: bytes, message_id: str = mid(1), domains=(DOMAIN,)):
    return reconcile.rebuild_notification(raw, message_id, FIXED_NOW - HOUR, domains)


def verdicts(notification) -> dict:
    return {k: v["status"] for k, v in notification["receipt"].items() if k.endswith("Verdict")}


# ------------------------------------------------------------------------------------------
# header parsing
# ------------------------------------------------------------------------------------------
def test_rebuild_from_a_clean_message():
    n = rebuild(stored(mid(1)))
    assert n["reconciled"] is True
    assert n["mail"]["messageId"] == mid(1)
    assert n["mail"]["source"] == "bob@sender.example"
    assert n["mail"]["timestamp"] == "2026-10-03T11:00:00.000Z" == n["receipt"]["timestamp"]
    assert n["mail"]["commonHeaders"] == {"from": ["Bob Smith <bob@sender.example>"],
                                          "to": ["Cool Stuff <cool_stuff@eisenberg.dev>"],
                                          "subject": "Hello about the bike"}
    assert n["receipt"]["recipients"] == [ALIAS]
    assert verdicts(n) == {"spamVerdict": "PASS", "virusVerdict": "PASS", "spfVerdict": "PASS",
                           "dkimVerdict": "PASS", "dmarcVerdict": "PASS"}
    assert "dmarcPolicy" not in n["receipt"]                       # never reconstructed: a replay never bounces


@pytest.mark.parametrize("kwargs,expected", [
    (dict(spam="FAIL"), {"spamVerdict": "FAIL"}),
    (dict(spam="GRAY", virus="FAIL"), {"spamVerdict": "GRAY", "virusVerdict": "FAIL"}),
    (dict(spam="PROCESSING_FAILED"), {"spamVerdict": "PROCESSING_FAILED"}),
    (dict(spf="fail"), {"spfVerdict": "FAIL"}),
    (dict(spf="softfail"), {"spfVerdict": "GRAY"}),
    (dict(spf="none", dkim="none", dmarc="none"), {"spfVerdict": "GRAY", "dkimVerdict": "GRAY", "dmarcVerdict": "GRAY"}),
    (dict(dkim="fail"), {"dkimVerdict": "FAIL"}),
    (dict(dkim="permerror"), {"dkimVerdict": "GRAY"}),
    (dict(dmarc="fail"), {"dmarcVerdict": "FAIL"}),
    (dict(dmarc="bestguesspass"), {"dmarcVerdict": "GRAY"}),
])
def test_verdict_mapping(kwargs, expected):
    result = verdicts(rebuild(stored(mid(1), **kwargs)))
    assert {k: result[k] for k in expected} == expected


def test_missing_and_unparseable_verdicts_are_left_out():
    n = rebuild(stored(mid(1), spam=None, virus=None, spf=None, dkim=None, dmarc=None))
    assert verdicts(n) == {} and n["receipt"]["recipients"] == [ALIAS]
    n = rebuild(stored(mid(1), spam="maybe", virus="CLEAN?"))
    assert "spamVerdict" not in n["receipt"] and "virusVerdict" not in n["receipt"]
    n = rebuild(stored(mid(1), dkim=None))
    assert verdicts(n) == {"spamVerdict": "PASS", "virusVerdict": "PASS", "spfVerdict": "PASS", "dmarcVerdict": "PASS"}


def test_spf_falls_back_to_received_spf_and_authserv_id_must_be_ses():
    raw = stored(mid(1)).replace(b"Authentication-Results: amazonses.com;", b"Authentication-Results: mx.other.example;")
    assert verdicts(rebuild(raw)) == {"spamVerdict": "PASS", "virusVerdict": "PASS", "spfVerdict": "PASS"}
    raw = stored(mid(1), spf="fail").replace(b"Authentication-Results: amazonses.com;", b"Authentication-Results: mx.other.example;")
    assert verdicts(rebuild(raw))["spfVerdict"] == "FAIL"


def test_forged_headers_lower_in_the_message_are_ignored():
    forged = (
        "Authentication-Results: amazonses.com; spf=pass; dkim=pass header.i=@bank.example; dmarc=pass header.from=bank.example;\n"
        "X-SES-Spam-Verdict: PASS\n"
        "X-SES-Virus-Verdict: PASS\n"
        f"Received: from x by inbound-smtp.us-east-1.amazonaws.com with SMTP id {mid(1)} for victim@eisenberg.dev; Tue\n"
        "Return-Path: <ceo@bank.example>\n"
    )
    raw = stored(mid(1), spam="FAIL", virus="FAIL", spf="fail", dkim="fail", dmarc="fail", original_headers=forged)
    n = rebuild(raw)
    assert verdicts(n) == {"spamVerdict": "FAIL", "virusVerdict": "FAIL", "spfVerdict": "FAIL",
                           "dkimVerdict": "FAIL", "dmarcVerdict": "FAIL"}
    assert n["receipt"]["recipients"] == [ALIAS] and n["mail"]["source"] == "bob@sender.example"


def test_forged_headers_cannot_fill_in_for_headers_ses_did_not_write():
    # SES wrote no verdict headers at all; the sender's own headers start with look-alikes
    forged = "X-SES-Virus-Verdict: PASS\nX-SES-Spam-Verdict: PASS\nAuthentication-Results: amazonses.com; dmarc=pass;\n"
    raw = stored(mid(1), spam=None, virus=None, spf=None, dkim=None, dmarc=None, original_headers=forged)
    raw = raw.replace(b"Received: from laptop.sender.example (laptop.sender.example [203.0.113.9])\r\n"
                      b" by mail.sender.example with ESMTPSA id 77 for <someone-else@eisenberg.dev>;\r\n"
                      b" Tue, 01 Sep 2026 14:00:00 +0000\r\n", b"")
    assert b"X-SES-DKIM-SIGNATURE: a=rsa-sha256; q=dns/txt; b=EXAMPLEONLY; c=relaxed/simple;\r\nX-SES-Virus-Verdict: PASS" in raw
    assert verdicts(rebuild(raw)) == {}


def test_top_block_is_only_trusted_when_it_names_this_message():
    raw = stored(mid(2))                                            # stored under a different name
    n = rebuild(raw, mid(1), domains=(DOMAIN,))
    assert verdicts(n) == {} and n["mail"]["source"] == ""
    assert n["receipt"]["recipients"] == [ALIAS]                   # only from To/Cc on our domains
    assert rebuild(raw, mid(1), domains=())["receipt"]["recipients"] == []

    not_ses = b"From: Bob <bob@sender.example>\r\nTo: x@elsewhere.example\r\nSubject: s\r\n\r\nbody\r\n"
    n = rebuild(not_ses)
    assert verdicts(n) == {} and n["receipt"]["recipients"] == []


def test_folded_headers_are_unfolded():
    raw = stored(mid(1)).replace(b"Authentication-Results: amazonses.com;\r\n spf=pass",
                                 b"Authentication-Results:\r\n\tamazonses.com;\r\n\tspf=pass")
    raw = raw.replace(b" dmarc=pass header.from=sender.example;", b" dmarc=fail\r\n  (p=NONE sp=NONE; nested (comment))\r\n header.from=sender.example;")
    raw = raw.replace(b"X-SES-Virus-Verdict: PASS", b"X-SES-Virus-Verdict:\r\n PASS")
    n = rebuild(raw)
    assert verdicts(n)["spfVerdict"] == "PASS" and verdicts(n)["dmarcVerdict"] == "FAIL" and verdicts(n)["virusVerdict"] == "PASS"
    assert reconcile.unfolded_headers(raw)[1][1].endswith(f"with SMTP id {mid(1)} for {ALIAS}; Tue, 01 Sep 2026 14:00:01 +0000 (UTC)")


def test_several_dkim_results_pass_when_any_passes():
    raw = stored(mid(1)).replace(b" dkim=pass header.i=@sender.example;",
                                 b" dkim=fail header.i=@list.example;\r\n dkim=pass header.i=@sender.example;")
    assert verdicts(rebuild(raw))["dkimVerdict"] == "PASS"


def test_recipients_from_received_then_to_and_cc_on_our_domains():
    raw = stored(mid(1), rcpt="<Hidden@Eisenberg.dev>",
                 to=f"Cool Stuff <{ALIAS}>, friend@elsewhere.example, HIDDEN@eisenberg.dev",
                 original_headers=f"Cc: Shop <{OTHER}>, other@second.example\n")
    assert rebuild(raw, domains=(DOMAIN,))["receipt"]["recipients"] == ["hidden@eisenberg.dev", ALIAS, OTHER]
    assert rebuild(raw, domains=(DOMAIN, "second.example"))["receipt"]["recipients"] == [
        "hidden@eisenberg.dev", ALIAS, OTHER, "other@second.example"]
    assert rebuild(raw, domains=())["receipt"]["recipients"] == ["hidden@eisenberg.dev"]      # no MAIL_DOMAINS: Received only


def test_no_recipient_in_received_and_none_in_to():
    raw = stored(mid(1), rcpt=None, to="undisclosed-recipients:;")
    assert rebuild(raw)["receipt"]["recipients"] == []
    raw = stored(mid(1), rcpt=None)
    assert rebuild(raw)["receipt"]["recipients"] == [ALIAS]


def test_hostile_headers_do_not_break_the_rebuild():
    raw = stored(mid(1), from_header="=?utf-8?q?Evil=0D=0ABcc=3A_victim=40x.example?= <evil@sender.example>",
                 to="=?utf-8?q?a=0D=0Ab?= <cool_stuff@eisenberg.dev>", return_path="<>")
    n = rebuild(raw)
    assert n["receipt"]["recipients"] == [ALIAS] and n["mail"]["source"] == ""
    assert len(n["mail"]["commonHeaders"]["from"]) == 1


# ------------------------------------------------------------------------------------------
# the run
# ------------------------------------------------------------------------------------------
class Context:
    def __init__(self, *remaining_ms):
        self.remaining = list(remaining_ms)

    def get_remaining_time_in_millis(self):
        return self.remaining.pop(0) if len(self.remaining) > 1 else self.remaining[0]


def put(s3, n: int, age: timedelta = 2 * HOUR, **kwargs) -> str:
    message_id = mid(n)
    s3.put(message_id, stored(message_id, **kwargs), FIXED_NOW - age)
    return message_id


def test_replays_a_message_that_was_never_processed(processor, s3, ses, db):
    lost = put(s3, 1)
    summary = reconcile.run(processor, Context(60_000))
    assert summary == {"listed": 1, "missing": 1, "replayed": 1, "unroutable": 0, "failed": 0}
    row = db.inbox[lost]
    assert row["kind"] == "inbound" and row["s3_key"] == f"email-inbox/{lost}"
    assert row["event"]["reconciled"] is True
    assert row["event"]["mail"]["timestamp"] == "2026-10-03T10:00:00.000Z"
    assert row["event"]["receipt"]["recipients"] == [ALIAS]
    assert row["meta"] == {"forwarded": True, "notified": False}
    assert db.inbox_log == {lost: "forwarded"}
    (sent,) = ses.sent
    assert sent["Destinations"] == [OWNER]
    assert relay.parse(sent["Data"])["Subject"] == "Hello about the bike"
    assert db.tokens[TOKEN1]["correspondent"] == BOB and db.address_rules[ALIAS]["forward"] is True
    assert ses.bounces == []


def test_running_twice_replays_once(processor, s3, ses, db):
    put(s3, 1)
    put(s3, 2, virus="FAIL")
    first = reconcile.run(processor)
    assert first == {"listed": 2, "missing": 2, "replayed": 2, "unroutable": 0, "failed": 0}
    gets = len(s3.gets)
    second = reconcile.run(processor)
    assert second == {"listed": 2, "missing": 0, "replayed": 0, "unroutable": 0, "failed": 0}
    assert len(ses.sent) == 1 and len(db.inbox) == 1 and len(s3.gets) == gets
    assert db.inbox_log == {mid(1): "forwarded", mid(2): "dropped_virus"}


def test_age_window(make_processor, s3, db):
    put(s3, 1, age=timedelta(minutes=5))             # too young: SES may still be retrying
    put(s3, 2, age=timedelta(minutes=19, seconds=59))
    in_window = [put(s3, 3, age=timedelta(minutes=20)), put(s3, 4, age=timedelta(hours=71, minutes=59))]
    put(s3, 5, age=timedelta(hours=72, seconds=1))   # too old
    put(s3, 6, age=timedelta(days=30))
    summary = reconcile.run(make_processor())
    assert summary["listed"] == 2 and summary["replayed"] == 2
    assert sorted(db.inbox_log) == sorted(in_window)

    put(s3, 7, age=timedelta(hours=5))
    summary = reconcile.run(make_processor(reconcile_max_age_hours=4))
    assert summary["listed"] == 1 and summary["missing"] == 0      # only mid(3), already handled


def test_only_names_that_look_like_ses_message_ids(processor, s3, db):
    good = put(s3, 1)
    old = FIXED_NOW - 2 * HOUR
    for name in ("AMAZON_SES_SETUP_NOTIFICATION", "short1", "a" * 61, mid(2).upper(), mid(3) + ".eml", "sub/" + mid(4), ""):
        s3.put_key("email-inbox/" + name, stored(mid(9)), old)
    s3.put_key("other-prefix/" + mid(5), stored(mid(5)), old)
    s3.put_key("email-inbox-archive/" + mid(6), stored(mid(6)), old)
    summary = reconcile.run(processor)
    assert summary["listed"] == 1 and list(db.inbox_log) == [good]
    assert all(call["Prefix"] == "email-inbox/" for call in s3.list_calls)


def test_listing_is_paginated(processor, s3, db):
    ids = [put(s3, n) for n in range(1, 8)]
    s3.page_size = 3
    summary = reconcile.run(processor)
    assert summary["listed"] == 7 and summary["replayed"] == 7
    assert [c["ContinuationToken"] for c in s3.list_calls] == [None, "3", "6"]
    assert sorted(db.inbox_log) == sorted(ids)


def test_already_handled_messages_are_not_replayed(processor, s3, ses, db):
    logged = put(s3, 1)                 # finished without a row (virus, bounce, blocked, ...)
    db.log_outcome(logged, "blocked")
    stored_id = put(s3, 2)              # in lambda_inbox (e.g. the log write failed)
    db.insert_inbox(stored_id, "k", {}, b"raw", "junk")
    relayed = put(s3, 3)                # an owner reply that was relayed: only known as relay_source_id
    db.insert_inbox("relay-out-1", None, {}, b"raw", "relay_out", {"relay_source_id": relayed})
    lost = put(s3, 4)
    summary = reconcile.run(processor)
    assert summary == {"listed": 4, "missing": 1, "replayed": 1, "unroutable": 0, "failed": 0}
    assert db.inbox_log == {logged: "blocked", lost: "forwarded"}
    assert s3.gets == [f"email-inbox/{lost}", f"email-inbox/{lost}"]


def test_batch_cap_replays_the_oldest_first(make_processor, s3, db):
    ids = {n: put(s3, n, age=timedelta(hours=n)) for n in range(1, 8)}       # mid(7) is the oldest
    summary = reconcile.run(make_processor(reconcile_batch=3))
    assert summary == {"listed": 7, "missing": 7, "replayed": 3, "unroutable": 0, "failed": 0}
    assert sorted(db.inbox_log) == sorted([ids[7], ids[6], ids[5]])
    summary = reconcile.run(make_processor(reconcile_batch=3))
    assert summary["missing"] == 4 and sorted(db.inbox_log) == sorted(ids[n] for n in (2, 3, 4, 5, 6, 7))


def test_stops_when_lambda_time_is_running_out(processor, s3, db, caplog):
    for n in range(1, 6):
        put(s3, n, age=timedelta(hours=n))
    with caplog.at_level(logging.WARNING, logger="eisenmail.reconcile"):
        summary = reconcile.run(processor, Context(60_000, 25_000, 19_999))
    assert summary == {"listed": 5, "missing": 5, "replayed": 2, "unroutable": 0, "failed": 0}
    assert "out of time" in caplog.text
    # no context / a context without the method: no time limit
    assert reconcile.run(processor, object())["replayed"] == 3


def test_one_failing_message_does_not_stop_the_others_and_nothing_is_raised(processor, s3, ses, db, caplog):
    first, bad, last = put(s3, 1, age=3 * HOUR), put(s3, 2, age=2 * HOUR), put(s3, 3, age=HOUR)
    ses.fail = lambda kwargs: ConnectionError("unreachable") if bad.encode() in kwargs["Data"] else None
    with caplog.at_level(logging.ERROR, logger="eisenmail.reconcile"):
        summary = reconcile.run(processor)
    assert summary == {"listed": 3, "missing": 3, "replayed": 2, "unroutable": 0, "failed": 1}
    assert db.inbox_log == {first: "forwarded", last: "forwarded"}
    assert f"reconcile {bad}: FAILED" in caplog.text

    # the failed one is stored (it shows in the webmail) but its forward never went out
    assert db.inbox[bad]["meta"] == {"notified": False}

    ses.fail = None                                   # the next run picks it up again and completes the forward
    summary = reconcile.run(processor)
    assert summary == {"listed": 3, "missing": 1, "replayed": 1, "unroutable": 0, "failed": 0}
    assert db.inbox_log[bad] == "forwarded" and len(ses.sent) == 3 and len(db.inbox) == 3
    assert db.inbox[bad]["meta"] == {"notified": False, "forwarded": True}
    assert len(db.tokens) == 3                         # the token of the failed attempt was reused
    assert reconcile.run(processor)["missing"] == 0


def test_legacy_rows_without_meta_are_left_alone(processor, s3, ses, db):
    old = put(s3, 1)
    db.insert_inbox(old, "k", {}, b"raw", "inbound")              # stored by an earlier version: meta is null
    assert reconcile.run(processor)["missing"] == 0 and ses.sent == []


def test_unroutable_message_is_logged_and_skipped(processor, s3, ses, db):
    lost = put(s3, 1, rcpt=None, to="undisclosed-recipients:;")
    summary = reconcile.run(processor)
    assert summary == {"listed": 1, "missing": 1, "replayed": 0, "unroutable": 1, "failed": 0}
    assert db.inbox_log == {lost: "reconcile_unroutable"} and db.inbox == {} and ses.sent == []
    assert reconcile.run(processor)["missing"] == 0


def test_replayed_verdicts_decide_junk_virus_and_never_bounce(processor, s3, ses, db):
    junk = put(s3, 1, spam="FAIL")
    spf = put(s3, 2, spf="fail")
    virus = put(s3, 3, virus="FAIL")
    unknown_virus = put(s3, 4, virus=None)            # no virus verdict to read: junk, not clean
    dmarc = put(s3, 5, dmarc="fail")                  # no policy known on a replay: never bounced
    reconcile.run(processor)
    assert db.inbox_log == {junk: "junk", spf: "junk", virus: "dropped_virus", unknown_virus: "junk", dmarc: "forwarded"}
    assert db.inbox[unknown_virus]["kind"] == "junk" and db.inbox[unknown_virus]["event"]["reconciled"] is True
    assert virus not in db.inbox and ses.bounces == [] and len(ses.sent) == 1


def test_forged_verdicts_do_not_rescue_replayed_junk(processor, s3, ses, db):
    forged = "Authentication-Results: amazonses.com; spf=pass; dkim=pass; dmarc=pass;\nX-SES-Spam-Verdict: PASS\n"
    lost = put(s3, 1, spam="FAIL", dkim="fail", original_headers=forged)
    reconcile.run(processor)
    assert db.inbox_log == {lost: "junk"} and ses.sent == []


def test_replayed_owner_reply_is_never_relayed(processor, s3, ses, db):
    # a real forward first, so the token exists and a relay would be possible
    s3.put("in-1", inbound_message(), FIXED_NOW)
    assert processor.process_record(ses_record("in-1", [ALIAS])) == "forwarded"
    ses.sent.clear()

    # the owner's reply was never processed; its stored copy has every header a relay would need
    message_id = mid(1)
    reply = owner_reply(RELAY1)
    ses_block = stored(message_id, rcpt=RELAY1, return_path=f"<{OWNER}>").split(b"Received: from laptop.sender.example")[0]
    s3.put(message_id, ses_block + reply, FIXED_NOW - 2 * HOUR)
    notification = reconcile.rebuild_notification(ses_block + reply, message_id, FIXED_NOW, (DOMAIN,))
    assert notification["receipt"]["dmarcVerdict"] == {"status": "PASS"}
    assert notification["receipt"]["recipients"] == [RELAY1]
    assert OWNER_MIXED in notification["mail"]["commonHeaders"]["from"][0]

    summary = reconcile.run(processor)
    assert summary["replayed"] == 1
    assert ses.to(BOB) == []                                         # the correspondent gets nothing
    assert not any(row["kind"] == "relay_out" for row in db.inbox.values())
    assert db.tokens[TOKEN1]["use_count"] == 0
    assert db.inbox[message_id]["kind"] == "inbound"                # ordinary inbound via the refused-relay path
    assert db.inbox_log[message_id] == "forwarded"
    assert [s["Destinations"] for s in ses.sent] == [[OWNER]]
    assert RELAY1 not in db.address_rules

    # the same record arriving as a real SES event would have been relayed
    s3.put(mid(2), reply)
    live = ses_record(mid(2), [RELAY1], from_header=f"Owner Private <{OWNER_MIXED}>")
    assert processor.process_record(live) == "relayed" and db.inbox_log[mid(2)] == "relayed"


def test_replayed_auto_reply_to_a_relay_address_is_stored_only(processor, s3, ses, db):
    message_id = mid(1)
    reply = owner_reply(RELAY1, extra_headers="Auto-Submitted: auto-replied\n")
    ses_block = stored(message_id, rcpt=RELAY1).split(b"Received: from laptop.sender.example")[0]
    s3.put(message_id, ses_block + reply, FIXED_NOW - 2 * HOUR)
    reconcile.run(processor)
    assert db.inbox_log == {message_id: "stored"} and ses.sent == []
    assert db.inbox[message_id]["meta"]["forward_skipped"] == "loop"


def test_replay_respects_blocked_addresses_and_rules(processor, s3, ses, db):
    db.block(ALIAS)
    db.set_rule(OTHER, forward=False, notify=False)
    blocked = put(s3, 1)
    quiet = put(s3, 2, rcpt=OTHER, to=OTHER)
    reconcile.run(processor)
    assert db.inbox_log == {blocked: "blocked", quiet: "stored"} and ses.sent == []


def test_handled_lookup_is_one_call_for_the_whole_listing(processor, s3, db):
    for n in range(1, 4):
        put(s3, n)
    seen = []
    original = db.handled_message_ids
    db.handled_message_ids = lambda ids: (seen.append(list(ids)), original(ids))[1]
    reconcile.run(processor)
    assert seen == [[mid(1), mid(2), mid(3)]]                        # one lookup for the whole listing


def test_naive_last_modified_is_treated_as_utc(processor, s3, db):
    message_id = mid(1)
    s3.put(message_id, stored(message_id), (FIXED_NOW - 2 * HOUR).replace(tzinfo=None))
    assert reconcile.run(processor)["replayed"] == 1
    assert db.inbox[message_id]["event"]["mail"]["timestamp"] == "2026-10-03T10:00:00.000Z"
    assert reconcile._iso(datetime(2026, 1, 2, 3, 4, 5, 678000, tzinfo=timezone(timedelta(hours=2)))) == "2026-01-02T01:04:05.678Z"
