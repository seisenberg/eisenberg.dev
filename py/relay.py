"""Pure message builders for eisenmail (no I/O, no AWS, no database).

Two directions:

* forward  -- mail received on one of our aliases is re-sent to the owner's private mailbox with
              ``From: "<sender> via <alias>" <reply-<token>@domain>`` (build_forward).
* relay    -- the owner replies to that forward from the private mailbox; the reply is rewritten
              so the correspondent receives an ordinary reply from the alias and learns nothing
              about the private mailbox or the relay (build_relay_reply + assert_no_leak).

Everything security-sensitive lives here so it can be unit-tested without mocks.

Known limitations of the relay scrubbing (see also assert_no_leak, which fails closed):
* Only e-mail ADDRESSES are rewritten. The owner's real name, signature, phone number, the
  "On <date> ... wrote:" timestamp (client time zone) etc. are the owner's own content and are
  left alone.
* message/rfc822 attachments: text parts inside are scrubbed and the embedded message keeps only
  From/To/Cc/Subject/Date (scrubbed) plus Content-* headers. Anything private that survives in a
  form the scrubber does not understand makes assert_no_leak refuse the message.
* Binary attachments pass through untouched; document metadata inside compressed formats
  (docx, most PDFs) is not inspected.
* Signed / encrypted replies (S/MIME, PGP/MIME) are refused: the signature identifies the owner
  and would be broken by scrubbing anyway.
* Cc/Bcc on the owner's reply are dropped; the reply only goes to the stored correspondent.
"""
from __future__ import annotations

import base64
import html
import quopri
import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from email import message_from_bytes, policy
from email.header import decode_header, make_header
from email.headerregistry import Address
from email.message import EmailMessage, Message
from email.utils import collapse_rfc2231_value, format_datetime, getaddresses, parsedate_to_datetime
from typing import Callable, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import unquote

# Headers of the original top-level header block that describe the body. Everything else in a
# header block we rewrite is dropped.
CONTENT_HEADERS = (
    "content-type",
    "content-transfer-encoding",
    "content-disposition",
    "mime-version",
    "content-language",
    "content-id",
)

# Exactly the headers a relayed reply may carry.
RELAY_ALLOWED_HEADERS = frozenset(
    CONTENT_HEADERS + ("from", "to", "subject", "date", "message-id", "in-reply-to", "references")
)

RELAY_LOCAL_RE = re.compile(r"^reply-([0-9a-f]{32})$")

# Ways an "@" shows up in text/html bodies and mailto: links.
_AT = r"(?:@|%40|&#0*64;|&#x0*40;|&commat;)"
_ANY_RELAY_RE = re.compile(r"reply-[0-9a-f]{32}" + _AT + r"[a-z0-9-]+(?:\.[a-z0-9-]+)*", re.I)
_ANY_RELAY_PLAIN_RE = re.compile(r"reply-[0-9a-f]{32}@[a-z0-9-]+(?:\.[a-z0-9-]+)*")

# Conservative addr-spec: plain dot-atom local part, ASCII host name. Anything else (quoted local
# parts, SMTPUTF8, address literals) simply does not get a relay token.
_ADDR_SPEC_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$"
)
_MSGID_RE = re.compile(r"<[^<>\s]+>")
_ADDR_TOKEN_RE = re.compile(r"[^\s<>,;:\"()\[\]]+@[^\s<>,;:\"()\[\]]+")

_UNSAFE_REPLY_TYPES = frozenset({
    "multipart/signed",
    "multipart/encrypted",
    "application/pkcs7-mime",
    "application/x-pkcs7-mime",
    "application/pkcs7-signature",
    "application/x-pkcs7-signature",
    "application/pgp-signature",
    "application/pgp-encrypted",
})

_EMBEDDED_KEEP = ("from", "to", "cc", "subject", "date")
_AUTO_PRECEDENCE = frozenset({"bulk", "junk", "auto_reply", "list"})

_SMTP = policy.SMTP
# Emit headers that came from the parsed source verbatim (no refolding).
_SMTP_VERBATIM = policy.SMTP.clone(refold_source="none")


class LeakError(Exception):
    """A relayed reply still contains (or cannot be proven free of) private data. Never send."""


class UnsafeReplyError(LeakError):
    """The owner's reply has a structure that cannot be anonymised (signed/encrypted)."""


# --------------------------------------------------------------------------------------------
# small pure helpers
# --------------------------------------------------------------------------------------------
def parse(raw: bytes) -> EmailMessage:
    return message_from_bytes(raw, policy=policy.default)


def clean_header_text(value, limit: int = 900, strip_format: bool = False) -> str:
    """Make a decoded header value safe to put in a new header.

    CR, LF and every other control character can never survive (they are what header injection
    needs; RFC 2047 encoded-words can smuggle them past the parser). Lone surrogates from
    undecodable bytes are dropped. Whitespace is collapsed.
    """
    out = []
    for ch in str(value if value is not None else ""):
        cat = unicodedata.category(ch)
        if ch in "\r\n\t\v\f" or cat in ("Zl", "Zp"):
            out.append(" ")
        elif cat in ("Cc", "Cs") or (strip_format and cat == "Cf"):
            continue
        else:
            out.append(ch)
    return " ".join("".join(out).split())[:limit].strip()


def clean_display_name(value, limit: int = 80) -> str:
    """Display-name fragment: no controls/format chars, no quotes, backslashes or angle brackets."""
    text = clean_header_text(value, limit=4000, strip_format=True)
    text = re.sub(r'["\\<>]', "", text)
    return " ".join(text.split())[:limit].strip()


def is_addr_spec(value: str) -> bool:
    return bool(value) and bool(_ADDR_SPEC_RE.match(value))


def domain_of(address: str) -> str:
    return address.rpartition("@")[2].lower()


_PLAIN_ADDRESS_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?\.[A-Za-z]{2,}")


def is_plain_address(address: str) -> bool:
    """A bare addr-spec with nothing that could bend a header or an envelope (used for forward
    targets read from the database)."""
    return len(address) <= 254 and ".." not in address and _PLAIN_ADDRESS_RE.fullmatch(address) is not None


def _raw_header_values(msg: Message, name: str) -> List[str]:
    name = name.lower()
    return [str(v) for k, v in msg.raw_items() if k.lower() == name]


def _decode_words(value: str) -> str:
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def header_values(msg: Message, name: str) -> List[str]:
    """Decoded values of every `name` header. Never raises.

    Plain msg[...] / msg.get_all() run the policy's structured header parser, which RAISES on
    hostile input (e.g. an encoded-word that decodes to CR/LF inside an address header). One
    such header must not make a message unprocessable, so all header access goes through here."""
    out = []
    for raw in _raw_header_values(msg, name):
        try:
            out.append(str(msg.policy.header_fetch_parse(name, raw)))
        except Exception:
            out.append(_decode_words("".join(raw.splitlines())))
    return out


def header_value(msg: Message, name: str, default: Optional[str] = None) -> Optional[str]:
    values = header_values(msg, name)
    return values[0] if values else default


def header_addresses(msg: Message, name: str) -> List[Tuple[str, str]]:
    """(display_name, addr_spec) for every address in every `name` header (groups flattened).
    Never raises; display names may still contain control characters, clean before use."""
    found: List[Tuple[str, str]] = []
    for raw in _raw_header_values(msg, name):
        try:
            parsed = msg.policy.header_fetch_parse(name, raw)
            found.extend((a.display_name or "", a.addr_spec or "") for a in parsed.addresses)
        except Exception:  # hostile or unparseable header: legacy parser on the unfolded source
            pairs = getaddresses(["".join(raw.splitlines())])
            found.extend((_decode_words(n), a) for n, a in pairs)
    return [(n, a) for n, a in found if a and a != "<>"]


def find_relay_recipient(recipients: Iterable[str], mail_domains: Sequence[str] = ()) -> Optional[Tuple[str, str]]:
    """First envelope recipient of the form reply-<32 hex>@domain -> (token, address)."""
    for rcpt in recipients:
        rcpt = rcpt.strip().lower()
        local, _, domain = rcpt.rpartition("@")
        m = RELAY_LOCAL_RE.match(local)
        if m and domain and (not mail_domains or domain in mail_domains):
            return m.group(1), rcpt
    return None


def pick_alias(recipients: Iterable[str], mail_domains: Sequence[str] = ()) -> Optional[str]:
    """Primary alias: first envelope recipient, restricted to MAIL_DOMAINS when configured."""
    for rcpt in recipients:
        rcpt = rcpt.strip().lower()
        if "@" not in rcpt:
            continue
        if not mail_domains or domain_of(rcpt) in mail_domains:
            return rcpt
    return None


def relay_address(token: str, domain: str) -> str:
    return f"reply-{token}@{domain}"


@dataclass(frozen=True)
class Correspondent:
    address: str
    name: Optional[str] = None


def extract_correspondent(msg: Message) -> Optional[Correspondent]:
    """Who a reply should go to: addr-spec of Reply-To if present, else of From.

    Returns None when there is no usable address (then no relay token is issued)."""
    from_addrs = header_addresses(msg, "From")
    from_name = clean_display_name(from_addrs[0][0]) if from_addrs else ""
    for header, addrs in (("Reply-To", header_addresses(msg, "Reply-To")), ("From", from_addrs)):
        for name, addr in addrs:
            if is_addr_spec(addr):
                return Correspondent(address=addr, name=clean_display_name(name) or from_name or None)
    return None


def sender_label(msg: Message) -> str:
    """Original display name, else original address, for the "<x> via <alias>" display name."""
    for name, addr in header_addresses(msg, "From"):
        label = clean_display_name(name) or clean_display_name(addr)
        if label:
            return label
    return "unknown sender"


def forward_display_name(label: str, alias: str) -> str:
    return f"{clean_display_name(label) or 'unknown sender'} via {clean_display_name(alias, 254)}"


def message_ids(value) -> List[str]:
    """Well-formed <id> tokens of a Message-ID / In-Reply-To / References value."""
    return _MSGID_RE.findall(clean_header_text(value, limit=20000))


def new_message_id(domain: str) -> str:
    return f"<{uuid.uuid4()}@{domain}>"


def split_raw(raw: bytes) -> Tuple[bytes, bytes]:
    """Split a raw message into (header block, body) at the first empty line. Body is untouched."""
    candidates = [(i, n) for i, n in ((raw.find(b"\r\n\r\n"), 4), (raw.find(b"\n\n"), 2)) if i != -1]
    if raw.startswith(b"\r\n"):
        return b"", raw[2:]
    if raw.startswith(b"\n"):
        return b"", raw[1:]
    if not candidates:
        return raw, b""
    i, n = min(candidates)
    return raw[:i], raw[i + n:]


def content_header_block(header_block: bytes) -> Tuple[bytes, bool]:
    """The CONTENT_HEADERS of a raw header block, verbatim (folding kept, CRLF line ends).

    Only the first occurrence of each header is kept. Returns (bytes, has_mime_version)."""
    lines = header_block.replace(b"\r\n", b"\n").replace(b"\r", b"").split(b"\n")
    out: List[bytes] = []
    seen = set()
    keeping = False
    for line in lines:
        if not line:
            continue
        if line[:1] in (b" ", b"\t"):
            if keeping:
                out.append(line)
            continue
        name = line.split(b":", 1)[0].strip().lower().decode("ascii", "replace")
        keeping = b":" in line and name in CONTENT_HEADERS and name not in seen
        if keeping:
            seen.add(name)
            out.append(line)
    block = b"".join(line + b"\r\n" for line in out)
    return block, "mime-version" in seen


def _header_bytes(headers: EmailMessage) -> bytes:
    """Serialise a header-only EmailMessage (CRLF, RFC 2047, folded) without the blank line."""
    return headers.as_bytes(policy=_SMTP).rstrip(b"\r\n") + b"\r\n"


def _date_header(value, now: Optional[datetime]) -> str:
    if value:
        try:
            return format_datetime(parsedate_to_datetime(clean_header_text(value)))
        except (TypeError, ValueError, IndexError):
            pass
    return format_datetime(now or datetime.now(timezone.utc))


def _joined(msg: Message, name: str) -> str:
    return clean_header_text(", ".join(header_values(msg, name)))


# --------------------------------------------------------------------------------------------
# forward (inbound -> owner)
# --------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class ForwardParams:
    forward_to: Sequence[str]        # owner's private mailbox(es)
    alias: str                       # our address the mail was sent to
    sender: str                      # From addr-spec of the forward: relay address or noreply@domain
    recipients: Sequence[str]        # SES envelope recipients
    ses_message_id: str
    message_id: Optional[str] = None  # new Message-ID (generated when None)
    now: Optional[datetime] = None


def _forward_headers(msg: Message, p: ForwardParams, subject: Optional[str]) -> EmailMessage:
    out = EmailMessage(policy=_SMTP)
    out["From"] = Address(display_name=forward_display_name(sender_label(msg), p.alias), addr_spec=p.sender)
    out["To"] = ", ".join(p.forward_to)
    if subject is not None:
        out["Subject"] = clean_header_text(subject)
    out["Date"] = _date_header(header_value(msg, "Date"), p.now)
    out["Message-ID"] = p.message_id or new_message_id(domain_of(p.sender))
    in_reply_to = message_ids(header_value(msg, "In-Reply-To", ""))
    references = message_ids(" ".join(header_values(msg, "References")))
    if in_reply_to:
        out["In-Reply-To"] = " ".join(in_reply_to)
    if references:
        out["References"] = " ".join(references)
    out["X-Eisenmail-Original-From"] = _joined(msg, "From") or "(none)"
    out["X-Eisenmail-Original-To"] = _joined(msg, "To") or "(none)"
    out["X-Eisenmail-Recipients"] = clean_header_text(", ".join(p.recipients)) or "(none)"
    out["X-Eisenmail-Message-Id"] = clean_header_text(p.ses_message_id)
    out["X-Auto-Response-Suppress"] = "OOF, AutoReply"
    return out


def build_forward_inline(raw: bytes, p: ForwardParams) -> bytes:
    """The original MIME body, byte for byte, under a rewritten header block."""
    msg = parse(raw)
    head, body = split_raw(raw)
    kept, has_mime_version = content_header_block(head)
    headers = _header_bytes(_forward_headers(msg, p, header_value(msg, "Subject")))
    if not has_mime_version:
        headers += b"MIME-Version: 1.0\r\n"
    return headers + kept + b"\r\n" + body


def _summary(msg: Message) -> Tuple[str, str]:
    fields = [
        ("From", _joined(msg, "From")),
        ("To", _joined(msg, "To")),
        ("Subject", clean_header_text(header_value(msg, "Subject", "no subject"))),
        ("CC", _joined(msg, "Cc")),
    ]
    fields = [(k, v) for k, v in fields if v]
    text = "".join(f"{k}: {v}\n" for k, v in fields)
    markup = "".join(f"{k}: {html.escape(v)}<br/>\n" for k, v in fields)
    return text, markup


def build_forward_attach(raw: bytes, p: ForwardParams) -> bytes:
    """Legacy layout: short summary (text + html) with the original attached as message/rfc822.

    The attachment is the original raw message, verbatim."""
    msg = parse(raw)
    subject = f"FW {p.alias}: {clean_header_text(header_value(msg, 'Subject', 'no subject'))}"
    headers = _header_bytes(_forward_headers(msg, p, subject))

    text, markup = _summary(msg)
    summary = EmailMessage(policy=_SMTP)
    summary.set_content(text, charset="utf-8", cte="quoted-printable")
    summary.add_alternative(markup, subtype="html", charset="utf-8", cte="quoted-printable")
    for part in summary.walk():
        del part["MIME-Version"]
    summary_bytes = summary.as_bytes(policy=_SMTP)

    boundary = "=_eisenmail_" + uuid.uuid4().hex
    while boundary.encode("ascii") in raw or boundary.encode("ascii") in summary_bytes:
        boundary = "=_eisenmail_" + uuid.uuid4().hex
    b = boundary.encode("ascii")
    eight_bit = any(byte > 127 for byte in raw)
    return b"".join([
        headers,
        b"MIME-Version: 1.0\r\n",
        b'Content-Type: multipart/mixed; boundary="' + b + b'"\r\n',
        b"\r\n",
        b"--" + b + b"\r\n",
        summary_bytes,
        b"\r\n--" + b + b"\r\n",
        b"Content-Type: message/rfc822\r\n",
        b"Content-Disposition: attachment; filename=\"original.eml\"\r\n",
        b"Content-Transfer-Encoding: " + (b"8bit" if eight_bit else b"7bit") + b"\r\n",
        b"\r\n",
        raw,
        b"\r\n--" + b + b"--\r\n",
    ])


FORWARD_STYLES = ("inline", "attach")


def normalize_forward_style(value) -> str:
    """'attach' or 'inline'; anything unknown (or missing) is 'inline'."""
    style = str(value or "").strip().lower()
    return style if style in FORWARD_STYLES else "inline"


def build_forward(raw: bytes, p: ForwardParams, style: str = "inline") -> bytes:
    if style == "attach":
        return build_forward_attach(raw, p)
    if style == "inline":
        return build_forward_inline(raw, p)
    raise ValueError(f"unknown forward style {style!r}")


def build_too_large_notice(raw: bytes, p: ForwardParams) -> bytes:
    """Short stand-in forward for a message SES refuses to send because of its size."""
    msg = parse(raw)
    out = _forward_headers(msg, p, header_value(msg, "Subject"))
    text, _ = _summary(msg)
    out.set_content(
        "This message is too large to forward "
        f"({len(raw)} bytes). View it in webmail.\n\n{text}",
        charset="utf-8",
        cte="quoted-printable",
    )
    return out.as_bytes(policy=_SMTP)


# --------------------------------------------------------------------------------------------
# relay authorisation (owner -> correspondent)
# --------------------------------------------------------------------------------------------
def verdict(receipt: Mapping, name: str) -> str:
    """Upper-cased status of an SES verdict; '' when missing.

    Verdicts are objects ({"status": "PASS"}); dmarcPolicy is a bare string ("reject") in real
    SES events, so both shapes are accepted."""
    value = (receipt or {}).get(name)
    status = value.get("status") if isinstance(value, Mapping) else value
    return str(status or "").strip().upper()


def auto_response_reason(msg: Message) -> Optional[str]:
    """Why the message is an automatic response (never relayed), or None."""
    for value in header_values(msg, "Auto-Submitted"):
        if value.split(";")[0].strip().lower() != "no":
            return "Auto-Submitted header"
    for name in ("X-Autoreply", "X-Autorespond"):
        if _raw_header_values(msg, name):
            return f"{name} header"
    for value in header_values(msg, "Precedence"):
        if value.strip().lower() in _AUTO_PRECEDENCE:
            return "Precedence header"
    return None


def bounce_reason(msg: Message, envelope_from: Optional[str] = None) -> Optional[str]:
    """Why the message is a delivery status notification / mailer-daemon mail, or None.

    `envelope_from` is the SMTP MAIL FROM (SES mail.source); bounces use the null sender."""
    if envelope_from is not None and envelope_from.strip() in ("", "<>"):
        return "null envelope sender"
    try:
        if msg.get_content_type() == "multipart/report":
            return "multipart/report"
    except Exception:
        pass
    locals_ = {a.rpartition("@")[0].lower() for _, a in header_addresses(msg, "From")}
    if envelope_from:
        locals_.add(envelope_from.strip().strip("<>").rpartition("@")[0].lower())
    if locals_ & {"mailer-daemon", "postmaster"}:
        return "mailer-daemon sender"
    if any(v.strip() == "<>" for v in header_values(msg, "Return-Path")):
        return "null Return-Path"
    return None


def relay_refusal_reason(
    msg: Message,
    receipt: Mapping,
    owner_addresses: Iterable[str],
    ses_from: Optional[Sequence[str]] = None,
) -> Optional[str]:
    """None when the message may use the reply relay, otherwise the reason it may not.

    The token lookup is the caller's job. `ses_from` is SES's own parse of the From header
    (mail.commonHeaders.from); when given it must agree with ours, so a header that two parsers
    read differently cannot be used to get past the DMARC check."""
    owners = {a.lower() for a in owner_addresses}

    raw_from = _raw_header_values(msg, "From")
    if len(raw_from) != 1:
        return "expected exactly one From header"
    try:
        parsed = msg.policy.header_fetch_parse("From", raw_from[0])
        # An unquoted "John Q. Public <a@b>" is the one tolerated defect; anything else
        # (routes, groups, stray tokens, non-printables) is refused.
        defects = [d for d in parsed.defects if str(d) != "period in 'phrase'"]
        addrs = [a.addr_spec.lower() for a in parsed.addresses]
    except Exception:
        return "malformed From header"
    if defects:
        return "malformed From header"
    if len(addrs) != 1:
        return "From header does not contain exactly one address"
    sender = addrs[0]
    if sender not in owners:
        return "sender is not an owner address"
    # second opinion from the legacy parser, on the unfolded source text
    second = [a.lower() for _, a in getaddresses(["".join(raw_from[0].splitlines())]) if a]
    if second != [sender]:
        return "From header is ambiguous"
    if ses_from is not None:
        # every address-looking token SES saw in From must be the owner's, and there must be one
        ses_addrs = {m.lower() for v in ses_from for m in _ADDR_TOKEN_RE.findall(str(v))}
        if ses_addrs != {sender}:
            return "From header disagrees with the SES notification"

    if verdict(receipt, "dmarcVerdict") != "PASS":
        return "DMARC verdict is not PASS"
    for name in ("spfVerdict", "dkimVerdict", "spamVerdict", "virusVerdict"):
        if verdict(receipt, name) == "FAIL":
            return f"{name} is FAIL"

    return auto_response_reason(msg)


# --------------------------------------------------------------------------------------------
# relay reply (owner -> correspondent)
# --------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class RelayParams:
    alias_address: str                    # our address the reply goes out From
    correspondent: str                    # addr-spec the reply is sent to
    relay_address: str                    # reply-<token>@domain the owner replied to
    private_addresses: Sequence[str]      # OWNER_ADDRESSES + FORWARD_TO
    correspondent_name: Optional[str] = None
    orig_message_id: Optional[str] = None
    orig_references: Optional[str] = None
    subject: Optional[str] = None         # subject stored with the token
    message_id: Optional[str] = None      # new Message-ID (generated when None)
    now: Optional[datetime] = None


def _addr_pattern(address: str) -> str:
    local, _, domain = address.rpartition("@")
    return re.escape(local) + _AT + re.escape(domain)


_GAP = r"(?:\s|&nbsp;)+"   # \s already covers U+00A0
_META_CHARSET_RE = re.compile(r"(<meta\b[^>]{0,200}?charset\s*=\s*[\"']?)[A-Za-z0-9_:.-]+", re.I)


class Scrubber:
    """Rewrites body text so it reads as if the alias, not the private mailbox, wrote/received it.

    In order (all case-insensitive):
      1. forward display string  "<name> via <alias>"            -> "<name>"
      2. relay addresses         reply-<token>@domain            -> correspondent address
      3. private addresses       OWNER_ADDRESSES / FORWARD_TO    -> alias address
    """

    def __init__(self, p: RelayParams):
        alias = _addr_pattern(p.alias_address)
        relay = _addr_pattern(p.relay_address)
        self._alias_address = p.alias_address
        self._correspondent = p.correspondent
        self._private = [
            re.compile(_addr_pattern(a), re.I) for a in sorted(set(p.private_addresses), key=len, reverse=True) if a
        ]
        self._relay = re.compile(relay, re.I)
        self._alias_is_relay = bool(_ANY_RELAY_PLAIN_RE.fullmatch(p.alias_address.lower()))

        # 1a. "<known name> via <alias>" wherever it appears.
        names = []
        for candidate in (p.correspondent_name, p.correspondent):
            label = clean_display_name(candidate)
            if not label:
                continue
            for variant in (label, html.escape(label)):
                if variant not in names:
                    names.append(variant)
        self._named = [
            re.compile("(" + _GAP.join(re.escape(w) for w in name.split()) + ")" + _GAP + "via" + _GAP + alias, re.I)
            for name in names
        ]
        # 1b. " via <alias>" directly in front of a relay address, whatever the name was.
        any_relay = r"reply-[0-9a-f]{32}" + _AT
        self._via_before_relay = re.compile(
            _GAP + "via" + _GAP + alias
            + r"(?=(?:<[^<>]{0,300}>|&lt;|&quot;|&#34;|&#60;|[\s\"'\[(<])*(?:mailto:)?" + any_relay + ")",
            re.I,
        )

    def __call__(self, text: str) -> str:
        for pattern in self._named:
            text = pattern.sub(lambda m: m.group(1), text)
        text = self._via_before_relay.sub("", text)
        text = self._relay.sub(lambda m: self._correspondent, text)
        text = _ANY_RELAY_RE.sub(self._other_relay, text)
        for pattern in self._private:
            text = pattern.sub(lambda m: self._alias_address, text)
        return text

    def _other_relay(self, m: "re.Match") -> str:
        # Relay addresses of earlier forwards quoted further down the thread. If the alias itself
        # looks like a relay address (mail that was sent to an unknown reply-... address), keep it.
        if self._alias_is_relay and m.group(0).lower() == self._alias_address.lower():
            return m.group(0)
        return self._correspondent


def decode_text_part(part: Message) -> str:
    """Body of a text/* leaf part as str (declared charset, then lenient fallbacks)."""
    data = part.get_payload(decode=True) or b""
    try:
        declared = part.get_content_charset()
    except Exception:
        declared = None
    for charset in (declared or "us-ascii", "utf-8", "cp1252"):
        try:
            return data.decode(charset)
        except (LookupError, UnicodeDecodeError, ValueError):
            continue
    return data.decode("latin-1")


def _set_text(part: Message, text: str) -> None:
    """Replace the body of a text/* part: utf-8, base64 if it was base64, else quoted-printable."""
    cte = (header_value(part, "Content-Transfer-Encoding") or "").strip().lower()
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if part.get_content_subtype() == "html":
        # keep an in-document <meta ... charset=...> consistent with the new encoding
        text = _META_CHARSET_RE.sub(lambda m: m.group(1) + "utf-8", text)
    if cte == "base64":
        payload = base64.encodebytes(text.replace("\n", "\r\n").encode("utf-8")).decode("ascii")
        new_cte = "base64"
    else:
        payload = quopri.encodestring(text.encode("utf-8")).decode("ascii")
        new_cte = "quoted-printable"
    del part["Content-Transfer-Encoding"]
    part["Content-Transfer-Encoding"] = new_cte
    part.set_param("charset", "utf-8")
    part.set_payload(payload)


def _keep_headers(part: Message, keep: Callable[[str], bool]) -> None:
    """Drop every header `keep` rejects; of duplicated headers only the first survives."""
    for name in {k.lower() for k in part.keys()}:
        if not keep(name):
            del part[name]
        elif len(_raw_header_values(part, name)) > 1:
            first = header_values(part, name)[0]
            del part[name]
            part[name] = clean_header_text(first)


def _scrub_embedded_headers(part: Message, scrub: Scrubber) -> None:
    for name in _EMBEDDED_KEEP:
        value = header_value(part, name)
        if value is None:
            continue
        cleaned = clean_header_text(scrub(value))
        del part[name]
        try:
            part[name] = cleaned
        except Exception:
            pass  # unparseable after scrubbing: better gone than wrong


def _sanitize_tree(part: Message, scrub: Scrubber, *, top: bool = False, embedded: bool = False) -> None:
    if top:
        _keep_headers(part, lambda n: n in CONTENT_HEADERS)
    elif embedded:
        _keep_headers(part, lambda n: n.startswith("content-") or n == "mime-version" or n in _EMBEDDED_KEEP)
        _scrub_embedded_headers(part, scrub)
    else:
        _keep_headers(part, lambda n: n.startswith("content-"))

    ctype = part.get_content_type()
    if ctype in _UNSAFE_REPLY_TYPES:
        raise UnsafeReplyError(f"signed or encrypted reply ({ctype}) cannot be relayed")

    if part.is_multipart():
        if part.get_content_maintype() == "multipart":
            part.preamble = None
            part.epilogue = None
            for sub in part.get_payload():
                _sanitize_tree(sub, scrub)
        elif ctype in ("message/rfc822", "message/global"):
            for sub in part.get_payload():
                _sanitize_tree(sub, scrub, embedded=True)
        # other message/* (delivery-status ...) are left alone; assert_no_leak still inspects them
        return

    if part.get_content_maintype() == "text":
        text = decode_text_part(part)
        scrubbed = scrub(text)
        if scrubbed != text:
            _set_text(part, scrubbed)


def relay_subject(owner_subject, p: RelayParams, scrub: Optional[Scrubber] = None) -> str:
    """Subject of the relayed reply: the owner's subject without the `FW <alias>: ` segment an
    attach-style forward put in front of it; `Re: <stored subject>` when nothing is left.

    The decision does not depend on any setting (the address's forward style may have changed
    since the forward was sent). It is made from the reply itself and the original subject stored
    with the token: the segment is removed once, and only when the reply's subject contains it
    more often than the original subject did, i.e. only when it is the one we added. An original
    subject that itself contained `FW <alias>: ` therefore survives an inline forward untouched."""
    subject = clean_header_text(owner_subject)
    segment = re.compile(r"\bFW\s+" + re.escape(p.alias_address) + r"\s*:\s*", re.I)
    if len(segment.findall(subject)) > len(segment.findall(clean_header_text(p.subject))):
        subject = segment.sub("", subject, count=1).strip()
    if scrub is not None:
        subject = clean_header_text(scrub(subject))
    if not subject:
        stored = clean_header_text(p.subject)
        if re.match(r"(?i)re\s*:", stored):
            subject = stored
        else:
            subject = f"Re: {stored}".strip()
    return subject


def build_relay_reply(raw: bytes, p: RelayParams) -> bytes:
    """Rewrite the owner's reply into the message the correspondent receives.

    Only CONTENT_HEADERS and the (scrubbed) body of the owner's message survive; every other
    header is new. Raises UnsafeReplyError for signed/encrypted replies. The caller MUST run
    assert_no_leak on the result before sending."""
    if not is_addr_spec(p.correspondent) or not is_addr_spec(p.alias_address):
        raise UnsafeReplyError("stored relay addresses are not valid")

    msg = parse(raw)
    scrub = Scrubber(p)
    subject = relay_subject(header_value(msg, "Subject", ""), p, scrub)
    had_mime_version = bool(_raw_header_values(msg, "MIME-Version"))
    _sanitize_tree(msg, scrub, top=True)

    out = EmailMessage(policy=_SMTP)
    out["From"] = Address(addr_spec=p.alias_address)
    out["To"] = Address(display_name=clean_display_name(p.correspondent_name), addr_spec=p.correspondent)
    out["Subject"] = subject
    out["Date"] = format_datetime(p.now or datetime.now(timezone.utc))
    out["Message-ID"] = p.message_id or new_message_id(domain_of(p.alias_address))
    orig_ids = message_ids(p.orig_message_id)[:1]
    references = list(dict.fromkeys(message_ids(p.orig_references) + orig_ids))
    if orig_ids:
        out["In-Reply-To"] = orig_ids[0]
    if references:
        out["References"] = " ".join(references)

    headers = _header_bytes(out)
    if not had_mime_version:
        headers += b"MIME-Version: 1.0\r\n"
    return headers + msg.as_bytes(policy=_SMTP_VERBATIM)


def _views(text: str, deep: bool) -> List[str]:
    low = text.lower()
    if not deep:
        return [low]
    unescaped = html.unescape(low)
    return list(dict.fromkeys([low, unescaped, unquote(low), unquote(unescaped)]))


def assert_no_leak(
    raw_bytes: bytes,
    private_addresses: Iterable[str],
    relay_address: Optional[str],
    *,
    allow: Iterable[str] = (),
) -> None:
    """Final gate before a relayed reply is sent. Raises LeakError if any private address, the
    relay address, or any other reply-<token>@ address appears anywhere in the message:

    * the raw bytes,
    * every header of every part, RFC 2047 / RFC 2231 decoded,
    * every leaf part after transfer-decoding: text parts in their charset (also HTML-unescaped
      and URL-unquoted), all parts as raw bytes and as UTF-16.

    `allow` lists relay-shaped addresses that may appear (the alias itself, in the odd case the
    alias has that shape). The error message names the location, never the content."""
    needles = [a.strip().lower() for a in private_addresses if a and a.strip()]
    if relay_address:
        needles.append(relay_address.strip().lower())
    allowed = {a.lower() for a in allow}
    needles = [n for n in needles if n not in allowed]

    def check(text: str, where: str, deep: bool = True) -> None:
        for view in _views(text, deep):
            for needle in needles:
                if needle in view:
                    kind = "relay address" if needle == (relay_address or "").lower() else "private address"
                    raise LeakError(f"{kind} found in {where}")
            for m in _ANY_RELAY_PLAIN_RE.finditer(view):
                if m.group(0) not in allowed:
                    raise LeakError(f"relay address found in {where}")

    check(raw_bytes.decode("latin-1"), "raw message")

    try:
        msg = parse(raw_bytes)
        parts = list(msg.walk())
    except Exception as exc:  # fail closed
        raise LeakError(f"message cannot be parsed for the leak check ({type(exc).__name__})") from None

    for index, part in enumerate(parts):
        try:
            ctype = part.get_content_type()
            where = f"part {index} ({ctype})"
            for name, value in part.items():
                check(f"{name}: {value}", f"{where} header {name}")
            for header in ("Content-Type", "Content-Disposition"):
                for _, value in part.get_params([], header=header) or []:
                    check(str(collapse_rfc2231_value(value)), f"{where} {header} parameter")
            if part.is_multipart():
                for extra in (part.preamble, part.epilogue):
                    if extra:
                        check(str(extra), f"{where} preamble/epilogue")
                continue
            data = part.get_payload(decode=True) or b""
            is_text = part.get_content_maintype() == "text"
            if is_text:
                check(decode_text_part(part), f"{where} body")
            check(data.decode("latin-1"), f"{where} bytes", deep=is_text)
            for codec in ("utf-16-le", "utf-16-be"):
                check(data.decode(codec, "ignore"), f"{where} bytes ({codec})", deep=False)
                check(data[1:].decode(codec, "ignore"), f"{where} bytes ({codec})", deep=False)
        except LeakError:
            raise
        except Exception as exc:  # fail closed
            raise LeakError(f"part {index} cannot be inspected ({type(exc).__name__})") from None


def build_undelivered_notice(
    *,
    forward_to: Sequence[str],
    domain: str,
    correspondent: str,
    subject: Optional[str],
    reason: str,
    message_id: Optional[str] = None,
    now: Optional[datetime] = None,
) -> bytes:
    """Notice to the owner that a reply was NOT relayed. Sent from mailer-daemon@domain, never
    from the relay address, so answering the notice cannot reach the correspondent."""
    out = EmailMessage(policy=_SMTP)
    out["From"] = Address(display_name="eisenmail relay", addr_spec=f"mailer-daemon@{domain}")
    out["To"] = ", ".join(forward_to)
    out["Subject"] = clean_header_text(f"Not delivered: {clean_header_text(subject) or '(no subject)'}")
    out["Date"] = format_datetime(now or datetime.now(timezone.utc))
    out["Message-ID"] = message_id or new_message_id(domain)
    out["Auto-Submitted"] = "auto-generated"
    out["X-Auto-Response-Suppress"] = "All"
    out.set_content(
        "Your reply was NOT delivered.\n\n"
        f"To: {clean_header_text(correspondent)}\n"
        f"Subject: {clean_header_text(subject) or '(no subject)'}\n"
        f"Reason: {clean_header_text(reason)}\n\n"
        "The relay refuses to send a reply when it cannot prove that the message is free of\n"
        "your private address and of the relay address. Nothing was sent to the correspondent.\n"
        "Remove the offending content (for example an attached copy of the forwarded message,\n"
        "a signature block containing your private address, or S/MIME / PGP signing) and reply\n"
        "again, or answer from webmail.\n",
        charset="utf-8",
        cte="quoted-printable",
    )
    return out.as_bytes(policy=_SMTP)
