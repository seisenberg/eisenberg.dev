"""relay.py: helpers and the forward (inbound -> owner) builders."""
import pytest

import relay
from helpers import (ALIAS, ATTACHMENT, BOB, DOMAIN, FIXED_NOW, INBOUND_BODY, OWNER, RELAY_ADDR, TOKEN, crlf,
                     inbound_message, simple_message)


def params(**overrides):
    values = dict(forward_to=(OWNER,), alias=ALIAS, sender=RELAY_ADDR, recipients=(ALIAS,),
                  ses_message_id="ses-in-1", now=FIXED_NOW)
    values.update(overrides)
    return relay.ForwardParams(**values)


# ------------------------------------------------------------------------------------------
# small helpers
# ------------------------------------------------------------------------------------------
def test_split_raw_crlf_lf_and_missing_body():
    assert relay.split_raw(b"A: 1\r\nB: 2\r\n\r\nbody\r\n\r\nmore") == (b"A: 1\r\nB: 2", b"body\r\n\r\nmore")
    assert relay.split_raw(b"A: 1\nB: 2\n\nbody\n") == (b"A: 1\nB: 2", b"body\n")
    assert relay.split_raw(b"A: 1\r\nB: 2\r\n") == (b"A: 1\r\nB: 2\r\n", b"")
    assert relay.split_raw(b"\r\nonly body") == (b"", b"only body")


def test_content_header_block_keeps_only_content_headers_with_folding():
    head = crlf(
        "Received: x\n"
        "Content-Type: multipart/mixed;\n"
        '\tboundary="abc"\n'
        "X-Evil: 1\n"
        " Content-Type: text/evil\n"          # continuation of X-Evil, not a header
        "content-transfer-encoding: 8bit\n"
        "Content-Type: text/html\n"           # duplicate: dropped
        "MIME-Version: 1.0\n"
        "Content-ID: <a@b>\n"
        "Content-Language: en\n"
        "Content-Disposition: inline\n"
        "Content-Description: not on the list"
    ).encode()
    block, has_mime = relay.content_header_block(head)
    assert has_mime
    assert block == crlf(
        "Content-Type: multipart/mixed;\n"
        '\tboundary="abc"\n'
        "content-transfer-encoding: 8bit\n"
        "MIME-Version: 1.0\n"
        "Content-ID: <a@b>\n"
        "Content-Language: en\n"
        "Content-Disposition: inline\n"
    ).encode()


def test_content_header_block_lf_only_input_becomes_crlf():
    block, has_mime = relay.content_header_block(b"Subject: x\nContent-Type: text/plain\n")
    assert block == b"Content-Type: text/plain\r\n" and not has_mime


@pytest.mark.parametrize("value,expected", [
    ("Bob\r\nBcc: x@y", "Bob Bcc: x@y"),
    ("a\x00b\x1bc\x7f", "abc"),
    ("  many   spaces\t\there ", "many spaces here"),
    ("line\u2028sep", "line sep"),
    (None, ""),
])
def test_clean_header_text(value, expected):
    assert relay.clean_header_text(value) == expected


def test_clean_display_name_strips_quotes_brackets_and_bidi():
    assert relay.clean_display_name('"Bob" <evil@x>\\ \u202egnp.exe') == "Bob evil@x gnp.exe"


def test_find_relay_recipient():
    assert relay.find_relay_recipient([ALIAS, RELAY_ADDR.upper()]) == (TOKEN, RELAY_ADDR)
    assert relay.find_relay_recipient([ALIAS]) is None
    assert relay.find_relay_recipient([f"reply-{TOKEN[:-1]}@{DOMAIN}"]) is None          # 31 hex
    assert relay.find_relay_recipient([f"reply-{TOKEN}0@{DOMAIN}"]) is None              # 33 hex
    assert relay.find_relay_recipient([f"xreply-{TOKEN}@{DOMAIN}"]) is None
    assert relay.find_relay_recipient([f"reply-{'g' * 32}@{DOMAIN}"]) is None
    assert relay.find_relay_recipient([f"reply-{TOKEN}@other.example"], (DOMAIN,)) is None
    assert relay.find_relay_recipient([f"reply-{TOKEN}@other.example"]) == (TOKEN, f"reply-{TOKEN}@other.example")


def test_pick_alias_respects_mail_domains():
    assert relay.pick_alias(["x@other.example", "Cool@Eisenberg.dev"], ("eisenberg.dev",)) == "cool@eisenberg.dev"
    assert relay.pick_alias(["x@other.example", "cool@eisenberg.dev"]) == "x@other.example"
    assert relay.pick_alias(["x@other.example"], ("eisenberg.dev",)) is None
    assert relay.pick_alias([]) is None


def test_extract_correspondent_prefers_reply_to():
    msg = relay.parse(simple_message(extra="Reply-To: Support Desk <tickets@help.example>\r\n"))
    assert relay.extract_correspondent(msg) == relay.Correspondent("tickets@help.example", "Support Desk")
    msg = relay.parse(simple_message(extra="Reply-To: tickets@help.example\r\n"))
    assert relay.extract_correspondent(msg) == relay.Correspondent("tickets@help.example", "Bob Smith")
    msg = relay.parse(simple_message())
    assert relay.extract_correspondent(msg) == relay.Correspondent(BOB, "Bob Smith")
    msg = relay.parse(simple_message(from_header="bob@sender.example"))
    assert relay.extract_correspondent(msg) == relay.Correspondent(BOB, None)


@pytest.mark.parametrize("from_header", ["", "undisclosed", "<>", "Bob <not an address>", "=?utf-8?q?x?="])
def test_extract_correspondent_none_when_unusable(from_header):
    assert relay.extract_correspondent(relay.parse(simple_message(from_header=from_header))) is None


def test_verdict_accepts_object_and_string_shapes():
    receipt = {"spfVerdict": {"status": "fail"}, "dmarcPolicy": "reject", "x": None, "y": {}}
    assert relay.verdict(receipt, "spfVerdict") == "FAIL"
    assert relay.verdict(receipt, "dmarcPolicy") == "REJECT"
    assert relay.verdict(receipt, "x") == relay.verdict(receipt, "y") == relay.verdict(receipt, "missing") == ""
    assert relay.verdict(None, "spfVerdict") == ""


# ------------------------------------------------------------------------------------------
# inline forward
# ------------------------------------------------------------------------------------------
def test_inline_forward_rewrites_headers_and_keeps_body_bytes():
    raw = inbound_message()
    out = relay.build_forward(raw, params(), "inline")
    head, body = relay.split_raw(out)
    assert body == INBOUND_BODY                      # byte for byte, incl. preamble and 8bit text

    msg = relay.parse(out)
    names = [k.lower() for k in msg.keys()]
    assert sorted(names) == sorted([
        "from", "to", "subject", "date", "message-id", "in-reply-to", "references",
        "x-eisenmail-original-from", "x-eisenmail-original-to", "x-eisenmail-recipients",
        "x-eisenmail-message-id", "x-auto-response-suppress", "mime-version", "content-type",
    ])
    (sender,) = msg["From"].addresses
    assert sender.addr_spec == RELAY_ADDR
    assert sender.display_name == f"Bob Smith via {ALIAS}"
    assert [a.addr_spec for a in msg["To"].addresses] == [OWNER]
    assert msg["Subject"] == "Hello about the bike"
    assert msg["Date"] == "Tue, 01 Sep 2026 10:00:00 -0400"
    assert msg["Message-ID"] != "<orig-1@sender.example>" and str(msg["Message-ID"]).endswith(f"@{DOMAIN}>")
    assert msg["In-Reply-To"] == "<earlier-0@eisenberg.dev>"
    assert msg["References"] == "<root@sender.example> <earlier-0@eisenberg.dev>"
    assert msg["X-Eisenmail-Original-From"] == "Bob Smith <bob@sender.example>"
    assert msg["X-Eisenmail-Original-To"] == "Cool Stuff <cool_stuff@eisenberg.dev>"
    assert msg["X-Eisenmail-Recipients"] == ALIAS
    assert msg["X-Eisenmail-Message-Id"] == "ses-in-1"
    assert msg["X-Auto-Response-Suppress"] == "OOF, AutoReply"
    # the original boundary line survives verbatim (folded with a tab)
    assert b'Content-Type: multipart/mixed;\r\n\tboundary="----=_Part_42"\r\n' in head + b"\r\n"
    for gone in (b"Received:", b"DKIM-Signature", b"X-Mailer", b"Return-Path", b"orig-1@sender.example"):
        assert gone not in head

    # and it still parses into the same parts
    text, attachment = list(msg.iter_parts())
    assert "café ☕" in text.get_content()
    assert attachment.get_payload(decode=True) == ATTACHMENT
    assert attachment.get_filename() == "blob.bin"


def test_inline_forward_of_message_without_content_headers():
    raw = simple_message(body="plain ascii body\r\n")
    out = relay.build_forward(raw, params())
    head, body = relay.split_raw(out)
    assert body == b"plain ascii body\r\n"
    assert b"MIME-Version: 1.0" in head and b"Content-Type" not in head
    assert relay.parse(out)["Date"] == "Sat, 03 Oct 2026 12:00:00 +0000"   # no original Date -> now


def test_inline_forward_lf_only_message():
    raw = b"From: Bob <bob@sender.example>\nSubject: lf\nContent-Type: text/plain; charset=utf-8\n\nline1\nline2\n"
    out = relay.build_forward(raw, params())
    head, body = relay.split_raw(out)
    assert body == b"line1\nline2\n"
    assert b"\n" not in head.replace(b"\r\n", b"")
    assert relay.parse(out)["Subject"] == "lf"


def test_forward_display_name_non_ascii_and_address_only():
    out = relay.build_forward(simple_message(from_header="=?utf-8?b?SsO8cmdlbiBNw7xsbGVy?= <j@sender-de.example>"), params())
    assert b"J\xc3\xbcrgen" not in relay.split_raw(out)[0]            # header stays 7bit
    assert relay.parse(out)["From"].addresses[0].display_name == f"Jürgen Müller via {ALIAS}"

    out = relay.build_forward(simple_message(from_header="bob@sender.example"), params())
    assert relay.parse(out)["From"].addresses[0].display_name == f"bob@sender.example via {ALIAS}"


def test_forward_without_parseable_from_uses_fallback_label():
    out = relay.build_forward(simple_message(from_header=""), params(sender=f"noreply@{DOMAIN}"))
    (sender,) = relay.parse(out)["From"].addresses
    assert sender.addr_spec == f"noreply@{DOMAIN}"
    assert sender.display_name == f"unknown sender via {ALIAS}"


INJECTIONS = [
    # RFC 2047 encoded-words that decode to CR LF + a header
    "=?utf-8?q?Evil=0D=0ABcc=3A_victim=40x.example?= <evil@sender.example>",
    "=?utf-8?b?RXZpbA0KQmNjOiB2aWN0aW1AeC5leGFtcGxl?= <evil@sender.example>",
    '"Evil\\" <x@y> \\"" <evil@sender.example>',
    "=?utf-8?q?=22_=3Cowner=40x=3E=0A=0ABody?= <evil@sender.example>",
]


@pytest.mark.parametrize("style", ["inline", "attach"])
@pytest.mark.parametrize("from_header", INJECTIONS)
def test_forward_neutralises_header_injection_in_display_name(from_header, style):
    raw = simple_message(from_header=from_header, subject="=?utf-8?q?Hi=0D=0ABcc:_victim@x.example=0D=0A=0D=0Abody?=")
    out = relay.build_forward(raw, params(), style)
    head, _ = relay.split_raw(out)
    msg = relay.parse(out)
    names = [k.lower() for k in msg.keys()]
    assert "bcc" not in names and "cc" not in names
    assert names.count("from") == names.count("to") == names.count("subject") == 1
    (sender,) = msg["From"].addresses
    assert sender.addr_spec == RELAY_ADDR
    assert sender.display_name.endswith(f" via {ALIAS}")
    assert [a.addr_spec for a in msg["To"].addresses] == [OWNER]
    assert "\r" not in str(msg["Subject"]) and "\n" not in str(msg["Subject"])
    assert "Bcc: victim@x.example" in str(msg["Subject"])          # still there, but as subject text
    # no header line of the new block starts with an injected name
    for line in head.split(b"\r\n"):
        assert not line.lower().startswith((b"bcc", b"body"))
    # hostile headers must not break the other entry points either
    assert relay.extract_correspondent(relay.parse(raw)).address == "evil@sender.example"


def test_hostile_from_header_does_not_raise_anywhere():
    raw = simple_message(from_header="=?utf-8?q?Evil=0D=0ABcc=3A_victim=40x.example?= <evil@sender.example>")
    msg = relay.parse(raw)
    with pytest.raises(ValueError):
        msg["From"]                                   # the stdlib parser itself raises ...
    assert relay.header_values(msg, "From")           # ... our accessors do not
    assert relay.header_addresses(msg, "From")[0][1] == "evil@sender.example"
    assert relay.relay_refusal_reason(msg, {"dmarcVerdict": {"status": "PASS"}}, ["evil@sender.example"]) == \
        "malformed From header"


# ------------------------------------------------------------------------------------------
# attach forward + notice
# ------------------------------------------------------------------------------------------
def test_attach_forward_layout():
    raw = inbound_message()
    out = relay.build_forward(raw, params(), "attach")
    assert raw in out                                              # original attached verbatim
    msg = relay.parse(out)
    assert msg["Subject"] == f"FW {ALIAS}: Hello about the bike"
    (sender,) = msg["From"].addresses
    assert (sender.display_name, sender.addr_spec) == (f"Bob Smith via {ALIAS}", RELAY_ADDR)
    assert [a.addr_spec for a in msg["To"].addresses] == [OWNER]
    assert msg.get_content_type() == "multipart/mixed"
    summary, attached = list(msg.iter_parts())
    assert summary.get_content_type() == "multipart/alternative"
    plain, markup = list(summary.iter_parts())
    assert plain.get_content_type() == "text/plain" and "From: Bob Smith <bob@sender.example>" in plain.get_content()
    assert markup.get_content_type() == "text/html" and "&lt;bob@sender.example&gt;" in markup.get_content()
    assert attached.get_content_type() == "message/rfc822"
    inner = attached.get_payload(0)
    assert inner["Message-ID"] == "<orig-1@sender.example>"
    assert [p for p in inner.walk() if p.get_filename() == "blob.bin"][0].get_payload(decode=True) == ATTACHMENT


def test_attach_forward_declares_7bit_for_ascii_original():
    out = relay.build_forward(simple_message(), params(), "attach")
    assert b"Content-Transfer-Encoding: 7bit\r\n\r\nFrom: Bob Smith" in out


def test_unknown_style_rejected():
    with pytest.raises(ValueError):
        relay.build_forward(simple_message(), params(), "fancy")


def test_too_large_notice_is_small_and_keeps_relay_from():
    raw = inbound_message()
    out = relay.build_too_large_notice(raw, params())
    msg = relay.parse(out)
    assert len(out) < 2000
    assert msg["From"].addresses[0].addr_spec == RELAY_ADDR
    assert msg["Subject"] == "Hello about the bike"
    assert "too large to forward" in msg.get_content() and "webmail" in msg.get_content()
    assert msg["X-Eisenmail-Message-Id"] == "ses-in-1"
