"""relay.py: the reply relay (owner -> correspondent). The security-sensitive part."""
import base64
import re

import pytest

import relay
from helpers import (ALIAS, ATTACHMENT, BOB, DOMAIN, OWNER, OWNER_MIXED, OWNER_SECRETS, RELAY_ADDR, TOKEN, b64, crlf,
                     owner_reply, quoted_html, quoted_text, relay_params, simple_message, text_parts,
                     top_header_names)

PASS = {"dmarcVerdict": {"status": "PASS"}, "spfVerdict": {"status": "PASS"}, "dkimVerdict": {"status": "PASS"},
        "spamVerdict": {"status": "PASS"}, "virusVerdict": {"status": "PASS"}}


def build(raw=None, **overrides):
    p = relay_params(**overrides)
    out = relay.build_relay_reply(owner_reply() if raw is None else raw, p)
    relay.assert_no_leak(out, p.private_addresses, p.relay_address, allow=(p.alias_address,))
    return out


def assert_clean(out: bytes):
    low = out.lower()
    assert OWNER.encode() not in low
    assert not re.search(rb"reply-[0-9a-f]{32}", low)
    assert TOKEN.encode() not in low
    for secret in OWNER_SECRETS:
        assert secret.lower().encode() not in low
    for _, text in text_parts(out):
        assert OWNER not in text.lower()
        assert not re.search(r"reply-[0-9a-f]{32}", text.lower())
        assert " via " not in text


# ------------------------------------------------------------------------------------------
# headers
# ------------------------------------------------------------------------------------------
def test_relay_reply_headers_are_exactly_the_allowed_set():
    out = build()
    msg = relay.parse(out)
    names = top_header_names(out)
    assert set(names) <= relay.RELAY_ALLOWED_HEADERS
    assert sorted(names) == sorted(["from", "to", "subject", "date", "message-id", "in-reply-to", "references",
                                    "mime-version", "content-type", "content-language"])
    assert len(names) == len(set(names))

    (sender,) = msg["From"].addresses
    assert (sender.display_name, sender.addr_spec) == ("", ALIAS)
    (to,) = msg["To"].addresses
    assert (to.display_name, to.addr_spec) == ("Bob Smith", BOB)
    assert msg["Subject"] == "Re: Hello about the bike"
    assert msg["Date"] == "Sat, 03 Oct 2026 12:00:00 +0000"
    assert re.fullmatch(r"<[0-9a-f-]{36}@eisenberg\.dev>", msg["Message-ID"])
    assert msg["In-Reply-To"] == "<orig-1@sender.example>"
    assert msg["References"] == "<root@sender.example> <earlier-0@eisenberg.dev> <orig-1@sender.example>"
    assert msg["Content-Language"] == "en-US"
    assert msg.get_content_type() == "multipart/mixed" and msg.get_boundary() == "_004_outer_"


def test_relay_reply_contains_nothing_private():
    out = build()
    assert_clean(out)
    # nothing from the owner's header block: not the names, not the values
    head, _ = relay.split_raw(out)
    for name in (b"received", b"x-originating-ip", b"user-agent", b"thread-index", b"dkim-signature",
                 b"return-path", b"bcc", b"\ncc:"):
        assert name not in head.lower()
    assert b"forward-id@eisenberg.dev" not in out          # the owner's In-Reply-To/References are replaced
    assert b"X-Attachment-Id" not in out and b"f_secret_1" not in out   # non Content-* header of an inner part


def test_relay_reply_without_stored_name_or_threading():
    out = build(correspondent_name=None, orig_message_id=None, orig_references=None)
    msg = relay.parse(out)
    assert str(msg["To"]) == BOB
    assert "In-Reply-To" not in msg and "References" not in msg


def test_relay_reply_references_are_sanitised():
    out = build(orig_message_id="<orig-1@sender.example>\r\nBcc: x@y.example",
                orig_references="<a@b>\r\nX-Injected: 1 <c@d> garbage")
    msg = relay.parse(out)
    assert set(top_header_names(out)) <= relay.RELAY_ALLOWED_HEADERS
    assert msg["In-Reply-To"] == "<orig-1@sender.example>"
    assert msg["References"] == "<a@b> <c@d> <orig-1@sender.example>"


def test_relay_reply_message_without_mime_headers():
    raw = crlf(
        f"From: {OWNER_MIXED}\nTo: {RELAY_ADDR}\nSubject: Re: Hello about the bike\n"
        "X-Mailer: PrivatePhone 1.0\n\n"
        f"ok!\n\nOn Tuesday {RELAY_ADDR} wrote to {OWNER}:\n> hi\n"
    ).encode()
    out = build(raw)
    assert_clean(out)
    assert b"PrivatePhone" not in out
    assert set(top_header_names(out)) <= relay.RELAY_ALLOWED_HEADERS
    ((ctype, text),) = text_parts(out)
    assert ctype == "text/plain"
    assert f"On Tuesday {BOB} wrote to {ALIAS}:" in text


# ------------------------------------------------------------------------------------------
# subject
# ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("owner_subject,expected", [
    ("Re: Hello about the bike", "Re: Hello about the bike"),
    (f"Re: FW {ALIAS}: Hello", "Re: Hello"),
    (f"RE: fw {ALIAS.upper()}:Hello", "RE: Hello"),
    (f"FW {ALIAS}: ", "Re: Hello about the bike"),
    ("", "Re: Hello about the bike"),
    ("Re: FW other@eisenberg.dev: Hello", "Re: FW other@eisenberg.dev: Hello"),
    (f"Re: ask {OWNER_MIXED} or {RELAY_ADDR}", f"Re: ask {ALIAS} or {BOB}"),
    ("=?utf-8?q?Re:_Hi=0D=0ABcc:_victim@x.example?=", "Re: Hi Bcc: victim@x.example"),
])
def test_relay_subject(owner_subject, expected):
    out = build(owner_reply(subject=owner_subject))
    assert relay.parse(out)["Subject"] == expected
    assert set(top_header_names(out)) <= relay.RELAY_ALLOWED_HEADERS


@pytest.mark.parametrize("stored,owner_subject,expected", [
    # attach-style forward: exactly the segment we added goes away, whatever the address rule says today
    ("Hello", f"Re: FW {ALIAS}: Hello", "Re: Hello"),
    ("Hello", f"AW: FW  {ALIAS} : Hello", "AW: Hello"),
    (None, f"Re: FW {ALIAS}: no subject", "Re: no subject"),
    # inline-style forward: nothing was added, nothing is removed
    ("Hello", "Re: Hello", "Re: Hello"),
    (f"FW {ALIAS}: price list", f"Re: FW {ALIAS}: price list", f"Re: FW {ALIAS}: price list"),
    (f"Fwd: FW {ALIAS}: a, FW {ALIAS}: b", f"Re: Fwd: FW {ALIAS}: a, FW {ALIAS}: b", f"Re: Fwd: FW {ALIAS}: a, FW {ALIAS}: b"),
    # attach-style forward of a subject that already contained the pattern: only ours (the first) goes
    (f"FW {ALIAS}: price list", f"Re: FW {ALIAS}: FW {ALIAS}: price list", f"Re: FW {ALIAS}: price list"),
    # another address's prefix is never ours
    ("Hello", "Re: FW other@eisenberg.dev: Hello", "Re: FW other@eisenberg.dev: Hello"),
    # the owner rewrote the subject
    ("Hello", "Something else entirely", "Something else entirely"),
])
def test_relay_subject_decision_is_independent_of_configuration(stored, owner_subject, expected):
    p = relay_params(subject=stored)
    assert relay.relay_subject(owner_subject, p) == expected
    assert relay.parse(build(owner_reply(subject=owner_subject), subject=stored))["Subject"] == expected


def test_relay_subject_empty_with_stored_re_prefix():
    out = build(owner_reply(subject=""), subject="RE: already a reply")
    assert relay.parse(out)["Subject"] == "RE: already a reply"


def test_relay_header_injection_via_stored_values():
    out = build(correspondent_name='Bob"\r\nBcc: victim@x.example\r\n\r\nbody <x@y>', subject="S\r\nBcc: v@x.example")
    msg = relay.parse(out)
    assert set(top_header_names(out)) <= relay.RELAY_ALLOWED_HEADERS
    (to,) = msg["To"].addresses
    assert to.addr_spec == BOB and "\n" not in to.display_name and "\r" not in to.display_name


@pytest.mark.parametrize("field,value", [("correspondent", "bob@sender.example\r\nBcc: v@x.example"),
                                         ("correspondent", "not-an-address"),
                                         ("alias_address", "alias\r\n@eisenberg.dev")])
def test_relay_refuses_invalid_stored_addresses(field, value):
    with pytest.raises(relay.UnsafeReplyError):
        relay.build_relay_reply(owner_reply(), relay_params(**{field: value}))


# ------------------------------------------------------------------------------------------
# body scrubbing
# ------------------------------------------------------------------------------------------
def test_scrub_outlook_quoted_block_text_and_html():
    out = build()
    parts = dict(text_parts(out))
    plain, markup = parts["text/plain"], parts["text/html"]
    assert f"From: Bob Smith <{BOB}>" in plain
    assert f"To: {ALIAS} <{ALIAS}>" in plain
    assert "Yes, it is still available. ¡Olé!" in plain
    assert "Is the bike still available?" in plain
    assert f"<b>From:</b> Bob Smith &lt;{BOB}&gt;<br>" in markup
    assert f'<b>To:</b> {ALIAS} &lt;<a href="mailto:{ALIAS}">{ALIAS}</a>&gt;<br>' in markup
    assert "¡Olé!" in markup


CHARSET_TEXT = {
    "utf-8": "Grüße ☕ señor",
    "iso-8859-1": "Grüße señor café",
    "windows-1252": "“quoted” – Grüße € café",
    "iso-8859-15": "Grüße € café",
    "koi8-r": "Привет, как дела",
    "shift_jis": "こんにちは 元気ですか",
    "gb2312": "你好 世界",
    "utf-16": "Grüße ☕ Привет",
}


@pytest.mark.parametrize("cte", ["quoted-printable", "base64", "8bit"])
@pytest.mark.parametrize("charset", sorted(CHARSET_TEXT))
def test_scrub_across_charsets_and_transfer_encodings(charset, cte):
    if charset == "utf-16" and cte != "base64":
        pytest.skip("utf-16 text only travels base64 encoded")
    marker = CHARSET_TEXT[charset]
    text = quoted_text(extra=marker + "\n").replace("¡Olé!", "")
    html = quoted_html(extra=f"<p>{marker}</p>\n").replace("¡Olé!", "")
    raw = owner_reply(text=text, html=html, text_charset=charset, text_cte=cte, html_charset=charset, html_cte=cte)
    # the private address really is hidden inside the encoded parts of the input
    if cte == "base64" or charset == "utf-16":
        assert OWNER.encode() not in relay.split_raw(raw)[1].lower()
    out = build(raw)
    assert_clean(out)
    parts = dict(text_parts(out))
    assert marker in parts["text/plain"] and marker in parts["text/html"]
    assert f"From: Bob Smith <{BOB}>" in parts["text/plain"]
    assert f"To: {ALIAS} <{ALIAS}>" in parts["text/plain"]
    assert f"Bob Smith &lt;{BOB}&gt;" in parts["text/html"]
    assert f'href="mailto:{ALIAS}"' in parts["text/html"]
    msg = relay.parse(out)
    for part in msg.walk():
        if part.get_content_maintype() == "text":
            assert part.get_content_charset() == "utf-8"
            assert part["Content-Transfer-Encoding"] == ("base64" if cte == "base64" else "quoted-printable")
            # the re-encoded part is 7bit clean on the wire
            assert part.get_payload().isascii()


def test_text_that_cannot_be_decoded_properly_fails_closed():
    # utf-16 mangled in transit: the scrubber cannot read it, so the leak check must refuse it
    mangled = b64(f"mail {OWNER} now".encode("utf-16-le") + b"\x00").encode()
    raw = owner_reply(text="x", html="<p>x</p>", extra_parts=(
        b"--_004_outer_\r\n"
        b'Content-Type: text/plain; charset="utf-16"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + mangled))
    p = relay_params()
    out = relay.build_relay_reply(raw, p)
    with pytest.raises(relay.LeakError):
        relay.assert_no_leak(out, p.private_addresses, p.relay_address)


def test_scrub_is_case_insensitive_and_handles_obfuscated_at_signs():
    text = (
        f"plain {OWNER.upper()} / {OWNER_MIXED} / {RELAY_ADDR.upper()}\n"
        f"url mailto:owner.private%40mailbox.example and reply-{TOKEN}%40{DOMAIN}\n"
    )
    html = (
        "<p>owner.private&#64;mailbox.example owner.private&#x40;MAILBOX.example owner.private&commat;mailbox.example "
        f'<a href="mailto:Owner.Private%40mailbox.example">me</a> reply-{TOKEN}&#64;{DOMAIN}</p>'
    )
    out = build(owner_reply(text=text, html=html))
    assert_clean(out)
    parts = dict(text_parts(out))
    assert parts["text/plain"].count(ALIAS) == 3 and parts["text/plain"].count(BOB) == 2
    assert parts["text/html"].count(ALIAS) == 4 and parts["text/html"].count(BOB) == 1
    assert "%40" not in parts["text/plain"] + parts["text/html"]


def test_scrub_address_split_by_quoted_printable_soft_line_break():
    # 76-column QP wrapping lands in the middle of the address
    text = "x" * 60 + f" {OWNER} and {RELAY_ADDR}\n"
    raw = owner_reply(text=text, text_cte="quoted-printable")
    assert b"=\r\n" in raw
    out = build(raw)
    assert_clean(out)
    assert f"{ALIAS} and {BOB}" in dict(text_parts(out))["text/plain"]


def test_scrub_forward_display_string_only_where_it_is_the_display_string():
    text = (
        f"On Tue, Sep 1, 2026 at 10:00 AM Bob Smith via {ALIAS} <{RELAY_ADDR}> wrote:\n"
        f"> hi\n\nFrom: Bob  Smith via\n {ALIAS}\nSent: Tuesday\n"
        f"You can always reach me via {ALIAS} if needed.\n"
    )
    html = (
        f"<b>From:</b> Bob&nbsp;Smith via {ALIAS} &lt;<a href=\"mailto:{RELAY_ADDR}\">{RELAY_ADDR}</a>&gt;<br>"
        f"<p>reach me via {ALIAS}</p>"
    )
    out = build(owner_reply(text=text, html=html))
    parts = {ctype: text.replace("\r\n", "\n") for ctype, text in text_parts(out)}
    assert f"Bob Smith <{BOB}> wrote:" in parts["text/plain"]
    assert "From: Bob  Smith\nSent: Tuesday" in parts["text/plain"]
    assert f"reach me via {ALIAS} if needed." in parts["text/plain"]            # the owner's own words stay
    assert f'<b>From:</b> Bob&nbsp;Smith &lt;<a href="mailto:{BOB}">{BOB}</a>&gt;' in parts["text/html"]
    assert f"<p>reach me via {ALIAS}</p>" in parts["text/html"]


def test_scrub_display_string_with_unknown_name_in_front_of_relay_address():
    # Reply-To differed from From, so the stored name is not the one shown in the forward
    text = f"From: Alice Other via {ALIAS} <{RELAY_ADDR}>\nFrom: \"Alice Other via {ALIAS}\" [mailto:{RELAY_ADDR}]\n"
    out = build(owner_reply(text=text, html="<p>x</p>"), correspondent_name=None)
    plain = dict(text_parts(out))["text/plain"]
    assert f"From: Alice Other <{BOB}>" in plain
    assert f'From: "Alice Other" [mailto:{BOB}]' in plain


def test_scrub_display_string_when_sender_had_no_name():
    text = f"From: {BOB} via {ALIAS} <{RELAY_ADDR}>\n"
    out = build(owner_reply(text=text, html="<p>x</p>"), correspondent_name=None)
    assert f"From: {BOB} <{BOB}>" in dict(text_parts(out))["text/plain"]


def test_scrub_relay_addresses_of_earlier_forwards_in_the_thread():
    older = f"reply-{'ab' * 16}@{DOMAIN}"
    text = f"> On Monday Bob Smith via {ALIAS} <{older}> wrote:\n>> first mail\n"
    out = build(owner_reply(text=text, html=f"<p>{older.upper()}</p>"))
    assert_clean(out)
    parts = dict(text_parts(out))
    assert f"Bob Smith <{BOB}> wrote:" in parts["text/plain"]
    assert f"<p>{BOB}</p>" in parts["text/html"]


def test_scrub_multiple_private_addresses():
    work = "owner@work.example"
    text = f"cc {work.upper()} and {OWNER}\n"
    out = build(owner_reply(text=text, html="<p>x</p>"), private_addresses=(OWNER, work))
    assert f"cc {ALIAS} and {ALIAS}" in dict(text_parts(out))["text/plain"]


def test_html_meta_charset_follows_the_re_encoding():
    html = ('<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">'
            f"</head><body>caf\u00e9 {OWNER}</body></html>")
    out = build(owner_reply(html=html, html_charset="iso-8859-1", html_cte="quoted-printable"))
    markup = dict(text_parts(out))["text/html"]
    assert 'content="text/html; charset=utf-8"' in markup and f"caf\u00e9 {ALIAS}" in markup


def test_untouched_text_part_is_left_byte_identical():
    text = "Nothing private here. Grüße\n"
    raw = owner_reply(text=text, text_charset="iso-8859-1", text_cte="8bit", html="<p>plain</p>", html_cte="7bit")
    out = build(raw)
    assert b'Content-Type: text/plain; charset="iso-8859-1"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' \
           b"Nothing private here. Gr\xfc\xdfe\r\n" in out


def test_preamble_and_epilogue_are_dropped():
    raw = owner_reply().replace(
        b'boundary="_004_outer_"\r\n\r\n',
        b'boundary="_004_outer_"\r\n\r\nPreamble written by ' + OWNER.encode() + b"\r\n",
    ) + b"epilogue from 203.0.113.77\r\n"
    out = build(raw)
    assert_clean(out)
    assert b"Preamble" not in out and b"epilogue" not in out


# ------------------------------------------------------------------------------------------
# attachments
# ------------------------------------------------------------------------------------------
def test_attachment_passes_through_intact():
    raw = owner_reply()
    out = build(raw)
    msg = relay.parse(out)
    (attachment,) = [p for p in msg.walk() if p.get_content_type() == "application/pdf"]
    assert attachment.get_payload(decode=True) == ATTACHMENT
    assert attachment.get_filename() == "quote.pdf"
    assert attachment["Content-Disposition"].content_disposition == "attachment"
    # identical on the wire too: same base64 text, same content headers
    wire = (b'Content-Type: application/pdf; name="quote.pdf"\r\n'
            b'Content-Disposition: attachment; filename="quote.pdf"\r\n'
            b"Content-Transfer-Encoding: base64\r\n")
    assert wire in raw and wire in out
    encoded = b64(ATTACHMENT).encode()
    assert encoded in raw and encoded in out


def test_inline_image_and_related_structure_survive():
    image = b"\x89PNG\r\n\x1a\n" + bytes(range(200))
    html = quoted_html().replace("</body>", '<img src="cid:image001.png@01DB0000.11112222"></body>')
    related = (
        b"--_004_outer_\r\n"
        b'Content-Type: multipart/related; boundary="_rel_"\r\n\r\n'
        b"--_rel_\r\n"
        b'Content-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n'
        + b64(crlf(html).encode()).encode() +
        b"--_rel_\r\n"
        b'Content-Type: image/png; name="image001.png"\r\n'
        b"Content-ID: <image001.png@01DB0000.11112222>\r\n"
        b"Content-Transfer-Encoding: base64\r\n\r\n"
        + b64(image).encode() +
        b"--_rel_--\r\n"
    )
    out = build(owner_reply(attachment=None, extra_parts=related))
    assert_clean(out)
    msg = relay.parse(out)
    (png,) = [p for p in msg.walk() if p.get_content_type() == "image/png"]
    assert png.get_payload(decode=True) == image
    assert png["Content-ID"] == "<image001.png@01DB0000.11112222>"
    htmls = [t for c, t in text_parts(out) if c == "text/html"]
    assert len(htmls) == 2 and "cid:image001.png@01DB0000.11112222" in htmls[1]
    assert f"Bob Smith &lt;{BOB}&gt;" in htmls[1]


def test_text_attachment_is_scrubbed_too():
    vcard = f"BEGIN:VCARD\r\nEMAIL:{OWNER_MIXED}\r\nEND:VCARD\r\n"
    part = (
        b"--_004_outer_\r\n"
        b'Content-Type: text/vcard; charset="utf-8"; name="me.vcf"\r\n'
        b'Content-Disposition: attachment; filename="me.vcf"\r\n'
        b"Content-Transfer-Encoding: base64\r\n\r\n" + b64(vcard.encode()).encode()
    )
    out = build(owner_reply(extra_parts=part))
    assert_clean(out)
    msg = relay.parse(out)
    (card,) = [p for p in msg.walk() if p.get_content_type() == "text/vcard"]
    assert card.get_payload(decode=True) == f"BEGIN:VCARD\r\nEMAIL:{ALIAS}\r\nEND:VCARD\r\n".encode()
    assert card.get_filename() == "me.vcf"


def nested_forward_part() -> bytes:
    """The forward itself, attached to the reply as message/rfc822 (Outlook 'attach original')."""
    inner = crlf(
        "Received: from a.eu-west-1.amazonses.com by BN8PR01MB1234.namprd01.prod.outlook.com; Tue\n"
        "Authentication-Results: spf=pass smtp.mailfrom=eisenberg.dev\n"
        f'From: "Bob Smith via {ALIAS}" <{RELAY_ADDR}>\n'
        f"To: {OWNER_MIXED}\n"
        "Subject: Hello about the bike\n"
        "Date: Tue, 01 Sep 2026 10:00:00 -0400\n"
        "Message-ID: <forward-id@eisenberg.dev>\n"
        "X-Eisenmail-Original-From: Bob Smith <bob@sender.example>\n"
        f"X-Eisenmail-Recipients: {ALIAS}\n"
        "MIME-Version: 1.0\n"
        'Content-Type: text/plain; charset="utf-8"\n'
        "\n"
        f"Is the bike still available? Mail {OWNER} if so.\n"
    ).encode()
    return (b"--_004_outer_\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment\r\n\r\n" + inner + b"\r\n")


def test_nested_rfc822_is_scrubbed_and_its_headers_reduced():
    out = build(owner_reply(extra_parts=nested_forward_part()))
    assert_clean(out)
    msg = relay.parse(out)
    (wrapper,) = [p for p in msg.walk() if p.get_content_type() == "message/rfc822"]
    inner = wrapper.get_payload(0)
    assert sorted(k.lower() for k in inner.keys()) == [
        "content-transfer-encoding", "content-type", "date", "from", "mime-version", "subject", "to"]
    assert inner["From"].addresses[0].addr_spec == BOB
    assert inner["From"].addresses[0].display_name == "Bob Smith"
    assert inner["To"].addresses[0].addr_spec == ALIAS
    assert f"Mail {ALIAS} if so." in inner.get_content()
    assert b"X-Eisenmail" not in out and b"Authentication-Results" not in out and b"amazonses" not in out


@pytest.mark.parametrize("content_type", [
    'multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="_004_outer_"',
    'multipart/encrypted; protocol="application/pgp-encrypted"; boundary="_004_outer_"',
])
def test_signed_or_encrypted_replies_are_refused(content_type):
    raw = owner_reply().replace(b'multipart/mixed; boundary="_004_outer_"', content_type.encode())
    with pytest.raises(relay.UnsafeReplyError):
        relay.build_relay_reply(raw, relay_params())


def test_smime_signature_part_is_refused():
    part = (b"--_004_outer_\r\nContent-Type: application/pkcs7-signature; name=smime.p7s\r\n"
            b"Content-Transfer-Encoding: base64\r\n\r\n" + b64(b"cert for " + OWNER.encode()).encode())
    with pytest.raises(relay.UnsafeReplyError):
        relay.build_relay_reply(owner_reply(extra_parts=part), relay_params())


# ------------------------------------------------------------------------------------------
# assert_no_leak
# ------------------------------------------------------------------------------------------
def clean_message(extra_headers: str = "", body: bytes = b"hello\r\n",
                  ctype: str = 'text/plain; charset="utf-8"', cte: str = "7bit") -> bytes:
    return crlf(
        f"From: {ALIAS}\nTo: {BOB}\nSubject: Re: x\n{extra_headers}"
        f"MIME-Version: 1.0\nContent-Type: {ctype}\nContent-Transfer-Encoding: {cte}\n\n"
    ).encode() + body


def leak(raw: bytes, match: str):
    with pytest.raises(relay.LeakError, match=match):
        relay.assert_no_leak(raw, [OWNER], RELAY_ADDR)


def test_no_leak_passes_clean_message():
    relay.assert_no_leak(clean_message(), [OWNER], RELAY_ADDR)
    relay.assert_no_leak(build(), [OWNER], RELAY_ADDR)


def test_no_leak_detects_raw_occurrences_in_any_case():
    leak(clean_message(body=f"mail {OWNER_MIXED.upper()}\r\n".encode()), "private address found in raw message")
    leak(clean_message(body=RELAY_ADDR.encode()), "relay address found in raw message")
    leak(clean_message(extra_headers=f"Cc: {OWNER}\n"), "private address")


def test_no_leak_detects_other_relay_tokens():
    other = f"reply-{'9' * 32}@{DOMAIN}"
    leak(clean_message(body=other.encode()), "relay address found")
    # ... unless explicitly allowed (alias that happens to have that shape)
    relay.assert_no_leak(clean_message(body=other.encode()), [OWNER], RELAY_ADDR, allow=(other,))


def test_no_leak_detects_encoded_headers():
    encoded = base64.b64encode(f"Owner <{OWNER}>".encode()).decode()
    leak(clean_message(extra_headers=f"X-Note: =?utf-8?b?{encoded}?=\n"), "header X-Note")
    leak(clean_message(extra_headers="X-Note: =?utf-8?q?owner=2Eprivate=40mailbox=2Eexample?=\n"), "header X-Note")


def test_no_leak_detects_encoded_bodies():
    body = f"<p>{OWNER_MIXED}</p>".encode()
    leak(clean_message(body=b64(body).encode(), cte="base64"), r"part 0 \(text/plain\) body")
    leak(clean_message(body=b"owner.private=40mailbox.example=\r\n", cte="quoted-printable"), "body")
    leak(clean_message(body=b"owner.priv=\r\nate@mailbox.example\r\n", cte="quoted-printable"), "body")
    leak(clean_message(body=b64(f"x {OWNER} y".encode("utf-16")).encode(), cte="base64",
                       ctype='text/plain; charset="utf-16"'), "body")
    leak(clean_message(body=b64(f"Привет {RELAY_ADDR}".encode("koi8-r")).encode(),
                       cte="base64", ctype='text/plain; charset="koi8-r"'), "relay address")


def test_no_leak_detects_html_and_url_obfuscation():
    leak(clean_message(body=b"<p>owner.private&#64;mailbox.example</p>", ctype="text/html"), "private address")
    leak(clean_message(body=b"<p>owner.private&#x40;mailbox&#46;example</p>", ctype="text/html"), "private address")
    leak(clean_message(body=b'<a href="mailto:owner.private%40mailbox%2Eexample">x</a>', ctype="text/html"), "private")
    leak(clean_message(body=f"reply-{TOKEN}%40{DOMAIN}".encode()), "relay address")


def test_no_leak_detects_binary_attachments_and_parameters():
    leak(clean_message(body=b64(b"%PDF-1.7 /Author (" + OWNER.encode() + b")").encode(), cte="base64",
                       ctype="application/pdf"), r"part 0 \(application/pdf\) bytes")
    leak(clean_message(body=b64(b"\xd0\xcf\x11\xe0" + OWNER_MIXED.encode("utf-16-le")).encode(), cte="base64",
                       ctype="application/msword"), "utf-16-le")
    leak(clean_message(body=b64(b"\x00" + OWNER.encode("utf-16-be")).encode(), cte="base64",
                       ctype="application/octet-stream"), "utf-16-be")
    # RFC 2231 continuation: the address only exists once the parameter is reassembled
    leak(clean_message(ctype='application/pdf; name*0="owner.priv"; name*1="ate@mailbox.example.pdf"'),
         "header Content-Type|parameter")


def test_no_leak_detects_nested_message_headers():
    nested = (clean_message(ctype='multipart/mixed; boundary="b"', body=b"")
              + b"--b\r\nContent-Type: message/rfc822\r\n\r\n"
              + f"To: =?utf-8?q?owner=2Eprivate=40mailbox=2Eexample?=\r\nSubject: x\r\n\r\nhi\r\n".encode()
              + b"--b--\r\n")
    leak(nested, "header To")


def test_no_leak_ignores_empty_configuration_values():
    relay.assert_no_leak(clean_message(), ["", "  "], None)


# ------------------------------------------------------------------------------------------
# authorisation
# ------------------------------------------------------------------------------------------
def reason(raw=None, receipt=PASS, owners=(OWNER,), ses_from=None):
    return relay.relay_refusal_reason(relay.parse(owner_reply() if raw is None else raw), receipt, owners, ses_from)


def test_relay_authorised_for_owner_with_dmarc_pass():
    assert reason() is None
    assert reason(ses_from=[f"Owner Private <{OWNER_MIXED}>"]) is None
    assert reason(owner_reply(from_header=OWNER.upper())) is None
    assert reason(owner_reply(extra_headers="Auto-Submitted: no\n")) is None


@pytest.mark.parametrize("from_header,expected", [
    ("Mallory <mallory@evil.example>", "sender is not an owner address"),
    (f"{OWNER}, mallory@evil.example", "From header does not contain exactly one address"),
    (f"mallory@evil.example, {OWNER}", "From header does not contain exactly one address"),
    (f'"{OWNER}" <mallory@evil.example>', "sender is not an owner address"),
    (f"{OWNER} <mallory@evil.example>", "malformed From header"),
    (f"friends: {OWNER}, mallory@evil.example;", "From header does not contain exactly one address"),
    (f"{OWNER}.evil.example", "sender is not an owner address"),
    (f"x{OWNER}", "sender is not an owner address"),
    ("", "From header does not contain exactly one address"),
])
def test_relay_refused_for_wrong_or_ambiguous_sender(from_header, expected):
    assert reason(owner_reply(from_header=from_header)) == expected


def test_unquoted_period_in_display_name_is_tolerated_but_routes_are_not():
    assert reason(owner_reply(from_header=f"Owner E. Private <{OWNER}>")) is None
    assert reason(owner_reply(from_header=f"Owner <@evil.example:{OWNER}>")) == "malformed From header"
    assert reason(owner_reply(from_header=f"Owner <{OWNER}>;")) == "malformed From header"
    assert reason(owner_reply(from_header=f"Owner <{OWNER}> mallory@evil.example")) == "malformed From header"


def test_relay_refused_for_two_from_headers():
    raw = owner_reply(extra_headers="From: mallory@evil.example\n")
    assert reason(raw) == "expected exactly one From header"


def test_ses_from_comparison_tolerates_formatting_but_no_foreign_address():
    assert reason(ses_from=[f"Private, Owner <{OWNER}>"]) is None            # unquoted comma in the name
    assert reason(ses_from=[f"<{OWNER_MIXED}>"]) is None
    assert reason(ses_from=[OWNER, OWNER.upper()]) is None
    assert reason(ses_from=[f'"{OWNER}" <mallory@evil.example>']) == "From header disagrees with the SES notification"
    assert reason(ses_from=["Owner Private"]) == "From header disagrees with the SES notification"


def test_relay_refused_when_ses_parsed_a_different_from():
    assert reason(ses_from=["mallory@evil.example"]) == "From header disagrees with the SES notification"
    assert reason(ses_from=[OWNER, "mallory@evil.example"]) == "From header disagrees with the SES notification"
    assert reason(ses_from=[]) == "From header disagrees with the SES notification"


@pytest.mark.parametrize("dmarc", ["FAIL", "GRAY", "PROCESSING_FAILED", "", None])
def test_relay_refused_unless_dmarc_pass(dmarc):
    receipt = dict(PASS)
    if dmarc is None:
        del receipt["dmarcVerdict"]
    else:
        receipt["dmarcVerdict"] = {"status": dmarc}
    assert reason(receipt=receipt) == "DMARC verdict is not PASS"


@pytest.mark.parametrize("name", ["spfVerdict", "dkimVerdict", "spamVerdict", "virusVerdict"])
def test_relay_refused_on_any_failed_verdict(name):
    assert reason(receipt={**PASS, name: {"status": "FAIL"}}) == f"{name} is FAIL"


@pytest.mark.parametrize("header,expected", [
    ("Auto-Submitted: auto-replied\n", "Auto-Submitted header"),
    ("Auto-Submitted: auto-generated; owner-email=x\n", "Auto-Submitted header"),
    ("X-Autoreply: yes\n", "X-Autoreply header"),
    ("X-Autorespond: \n", "X-Autorespond header"),
    ("Precedence: bulk\n", "Precedence header"),
    ("Precedence: Auto_Reply\n", "Precedence header"),
    ("Precedence: junk\n", "Precedence header"),
    ("Precedence: list\n", "Precedence header"),
])
def test_relay_refused_for_auto_responses(header, expected):
    assert reason(owner_reply(extra_headers=header)) == expected


def test_precedence_first_class_is_not_an_auto_response():
    assert reason(owner_reply(extra_headers="Precedence: first-class\n")) is None


@pytest.mark.parametrize("raw,envelope,expected", [
    (simple_message(), "bob@sender.example", None),
    (simple_message(), None, None),
    (simple_message(), "", "null envelope sender"),
    (simple_message(), "<>", "null envelope sender"),
    (simple_message(extra="Content-Type: multipart/report; report-type=delivery-status; boundary=x\r\n"),
     "bounce@sender.example", "multipart/report"),
    (simple_message(from_header="Mail Delivery Subsystem <MAILER-DAEMON@mx.sender.example>"), "x@sender.example",
     "mailer-daemon sender"),
    (simple_message(from_header="postmaster@sender.example"), None, "mailer-daemon sender"),
    (simple_message(), "MAILER-DAEMON@bounces.example", "mailer-daemon sender"),
    (simple_message(extra="Return-Path: <>\r\n"), None, "null Return-Path"),
])
def test_bounce_reason(raw, envelope, expected):
    assert relay.bounce_reason(relay.parse(raw), envelope) == expected


# ------------------------------------------------------------------------------------------
# notice
# ------------------------------------------------------------------------------------------
def test_undelivered_notice():
    out = relay.build_undelivered_notice(forward_to=[OWNER], domain=DOMAIN, correspondent=BOB,
                                         subject="Hello\r\nBcc: x@y.example", reason="private address found in part 3")
    msg = relay.parse(out)
    assert msg["From"].addresses[0].addr_spec == f"mailer-daemon@{DOMAIN}"
    assert [a.addr_spec for a in msg["To"].addresses] == [OWNER]
    assert "Bcc" not in msg
    assert msg["Subject"].startswith("Not delivered: Hello")
    assert msg["Auto-Submitted"] == "auto-generated"
    body = msg.get_content()
    assert "NOT delivered" in body and BOB in body and "private address found in part 3" in body
