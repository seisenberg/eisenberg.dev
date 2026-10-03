"""Shared fixtures-as-functions: sample messages, SES events and in-memory fakes."""
from __future__ import annotations

import base64
import copy
import io
import quopri
from datetime import datetime, timezone

import relay
from config import Config

DOMAIN = "eisenberg.dev"
ALIAS = "cool_stuff@eisenberg.dev"
OWNER = "owner.private@mailbox.example"            # as configured (lower case)
OWNER_MIXED = "Owner.Private@Mailbox.Example"      # as the owner's client writes it
BOB = "bob@sender.example"
TOKEN = "0123456789abcdef0123456789abcdef"
RELAY_ADDR = f"reply-{TOKEN}@{DOMAIN}"
FIXED_NOW = datetime(2026, 10, 3, 12, 0, 0, tzinfo=timezone.utc)

ATTACHMENT = bytes(range(256)) * 5 + b"\x00\xff tail"


def crlf(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\n", "\r\n")


def b64(data: bytes) -> str:
    return base64.encodebytes(data).decode("ascii").replace("\n", "\r\n")


def encode_body(text: str, charset: str, cte: str) -> bytes:
    data = crlf(text).encode(charset)
    if cte == "base64":
        return b64(data).encode("ascii")
    if cte == "quoted-printable":
        return quopri.encodestring(data.replace(b"\r\n", b"\n")).replace(b"\n", b"\r\n")
    return data  # 7bit / 8bit


def make_config(**overrides) -> Config:
    values = dict(
        forward_to=(OWNER,),
        owner_addresses=(OWNER,),
        mail_bucket="mail-bucket",
        mail_prefix="email-inbox/",
        mail_domains=(DOMAIN,),
    )
    values.update(overrides)
    return Config(**values)


# ------------------------------------------------------------------------------------------
# messages
# ------------------------------------------------------------------------------------------
INBOUND_BODY = crlf(
    "This is the preamble.\n"
    "------=_Part_42\n"
    "Content-Type: text/plain; charset=utf-8\n"
    "Content-Transfer-Encoding: 8bit\n"
    "\n"
    "Is the bike still available? café ☕\n"
    "------=_Part_42\n"
    'Content-Type: application/octet-stream; name="blob.bin"\n'
    "Content-Transfer-Encoding: base64\n"
    'Content-Disposition: attachment; filename="blob.bin"\n'
    "\n"
).encode("utf-8") + b64(ATTACHMENT).encode("ascii") + b"------=_Part_42--\r\n"


def inbound_message(
    *,
    from_header: str = "Bob Smith <bob@sender.example>",
    subject: str = "Hello about the bike",
    extra_headers: str = "",
    message_id: str = "<orig-1@sender.example>",
) -> bytes:
    head = crlf(
        "Return-Path: <bob@sender.example>\n"
        "Received: from mail.sender.example (mail.sender.example [198.51.100.7])\n"
        " by inbound-smtp.us-east-1.amazonaws.com with SMTP id abc123;\n"
        " Tue, 01 Sep 2026 14:00:01 +0000 (UTC)\n"
        "DKIM-Signature: v=1; a=rsa-sha256; d=sender.example; s=sel; bh=xyz; b=SIGDATA\n"
        f"From: {from_header}\n"
        "To: Cool Stuff <cool_stuff@eisenberg.dev>\n"
        f"Subject: {subject}\n"
        "Date: Tue, 01 Sep 2026 10:00:00 -0400\n"
        f"Message-ID: {message_id}\n"
        "In-Reply-To: <earlier-0@eisenberg.dev>\n"
        "References: <root@sender.example> <earlier-0@eisenberg.dev>\n"
        "MIME-Version: 1.0\n"
        "Content-Type: multipart/mixed;\n"
        '\tboundary="----=_Part_42"\n'
        "X-Mailer: BobMail 1.0\n"
        f"{extra_headers}"
        "\n"
    ).encode("utf-8")
    return head + INBOUND_BODY


def simple_message(from_header="Bob Smith <bob@sender.example>", subject="Plain", body="Just text.\r\n", extra="") -> bytes:
    return crlf(
        f"From: {from_header}\n"
        "To: cool_stuff@eisenberg.dev\n"
        f"Subject: {subject}\n"
        "Message-ID: <plain-1@sender.example>\n"
        f"{extra}"
        "\n"
    ).encode("utf-8") + body.encode("utf-8")


def quoted_text(relay_addr: str = RELAY_ADDR, extra: str = "") -> str:
    return (
        "Yes, it is still available. ¡Olé!\n"
        f"{extra}"
        "\n"
        "________________________________\n"
        f"From: Bob Smith via {ALIAS} <{relay_addr}>\n"
        "Sent: Tuesday, September 1, 2026 10:00 AM\n"
        f"To: {OWNER} <{OWNER_MIXED}>\n"
        "Subject: Hello about the bike\n"
        "\n"
        "Is the bike still available?\n"
    )


def quoted_html(relay_addr: str = RELAY_ADDR, extra: str = "") -> str:
    return (
        "<html><body><div>Yes, it is still available. ¡Olé!</div>\n"
        f"{extra}"
        '<hr><div id="divRplyFwdMsg"><font face="Calibri">'
        f"<b>From:</b> Bob Smith via {ALIAS} &lt;{relay_addr}&gt;<br>\n"
        "<b>Sent:</b> Tuesday, September 1, 2026 10:00 AM<br>\n"
        f'<b>To:</b> {OWNER} &lt;<a href="mailto:{OWNER_MIXED}">{OWNER_MIXED}</a>&gt;<br>\n'
        "<b>Subject:</b> Hello about the bike</font></div>\n"
        "<div>Is the bike still available?</div></body></html>\n"
    )


OWNER_SECRETS = [
    "203.0.113.77",                 # X-Originating-IP
    "BN8PR01MB1234",                # Received / Message-ID host
    "Microsoft-MacOutlook",         # User-Agent
    "AQHabcThreadIndex",            # Thread-Index
    "selector1",                    # DKIM-Signature
]


def owner_reply(
    relay_addr: str = RELAY_ADDR,
    *,
    subject: str = "Re: Hello about the bike",
    from_header: str = f"Owner Private <{OWNER_MIXED}>",
    text: str | None = None,
    html: str | None = None,
    text_charset: str = "utf-8",
    text_cte: str = "quoted-printable",
    html_charset: str = "utf-8",
    html_cte: str = "base64",
    attachment: bytes | None = ATTACHMENT,
    extra_headers: str = "",
    extra_parts: bytes = b"",
) -> bytes:
    """An Outlook-style reply from the owner's private mailbox to a relay address."""
    text = quoted_text(relay_addr) if text is None else text
    html = quoted_html(relay_addr) if html is None else html
    head = crlf(
        "Received: from BN8PR01MB1234.namprd01.prod.outlook.com (2603:10b6:408:1::7)\n"
        " by BN8PR01MB1234.namprd01.prod.outlook.com with HTTPS; Tue, 1 Sep 2026 15:00:00 +0000\n"
        "Return-Path: <owner.private@mailbox.example>\n"
        "DKIM-Signature: v=1; a=rsa-sha256; d=outlook.com; s=selector1; bh=abc; b=def\n"
        "X-Originating-IP: [203.0.113.77]\n"
        "User-Agent: Microsoft-MacOutlook/16.99.0\n"
        "Thread-Index: AQHabcThreadIndex\n"
        f"From: {from_header}\n"
        f'To: "Bob Smith via {ALIAS}" <{relay_addr}>\n'
        f"Subject: {subject}\n"
        "Date: Tue, 1 Sep 2026 11:00:00 -0400\n"
        "Message-ID: <BN8PR01MB1234ABCDEF@BN8PR01MB1234.namprd01.prod.outlook.com>\n"
        "In-Reply-To: <forward-id@eisenberg.dev>\n"
        "References: <forward-id@eisenberg.dev>\n"
        "Content-Language: en-US\n"
        "MIME-Version: 1.0\n"
        f"{extra_headers}"
        'Content-Type: multipart/mixed; boundary="_004_outer_"\n'
        "\n"
    ).encode("ascii")
    parts = [
        head,
        b"--_004_outer_\r\n",
        b'Content-Type: multipart/alternative; boundary="_000_alt_"\r\n\r\n',
        b"--_000_alt_\r\n",
        f'Content-Type: text/plain; charset="{text_charset}"\r\n'.encode(),
        f"Content-Transfer-Encoding: {text_cte}\r\n\r\n".encode(),
        encode_body(text, text_charset, text_cte),
        b"\r\n--_000_alt_\r\n",
        f'Content-Type: text/html; charset="{html_charset}"\r\n'.encode(),
        f"Content-Transfer-Encoding: {html_cte}\r\n\r\n".encode(),
        encode_body(html, html_charset, html_cte),
        b"\r\n--_000_alt_--\r\n",
    ]
    if attachment is not None:
        parts += [
            b"--_004_outer_\r\n",
            b'Content-Type: application/pdf; name="quote.pdf"\r\n',
            b'Content-Disposition: attachment; filename="quote.pdf"\r\n',
            b"Content-Transfer-Encoding: base64\r\n",
            b"X-Attachment-Id: f_secret_1\r\n\r\n",
            b64(attachment).encode("ascii"),
        ]
    parts += [extra_parts, b"--_004_outer_--\r\n"]
    return b"".join(parts)


def relay_params(**overrides) -> relay.RelayParams:
    values = dict(
        alias_address=ALIAS,
        correspondent=BOB,
        relay_address=RELAY_ADDR,
        private_addresses=(OWNER,),
        correspondent_name="Bob Smith",
        orig_message_id="<orig-1@sender.example>",
        orig_references="<root@sender.example> <earlier-0@eisenberg.dev>",
        subject="Hello about the bike",
        now=FIXED_NOW,
    )
    values.update(overrides)
    return relay.RelayParams(**values)


def text_parts(raw: bytes):
    """[(content_type, decoded text)] for every text leaf part."""
    msg = relay.parse(raw)
    return [
        (part.get_content_type(), relay.decode_text_part(part))
        for part in msg.walk()
        if not part.is_multipart() and part.get_content_maintype() == "text"
    ]


def top_header_names(raw: bytes):
    return [k.lower() for k in relay.parse(raw).keys()]


# ------------------------------------------------------------------------------------------
# SES event
# ------------------------------------------------------------------------------------------
def ses_record(
    message_id: str,
    recipients,
    *,
    from_header: str = "Bob Smith <bob@sender.example>",
    spf: str | None = "PASS",
    dkim: str | None = "PASS",
    spam: str | None = "PASS",
    virus: str | None = "PASS",
    dmarc: str | None = "PASS",
    dmarc_policy=None,
    common_headers: bool = True,
) -> dict:
    receipt = {"recipients": list(recipients), "timestamp": "2026-09-01T14:00:01.000Z", "action": {"type": "Lambda"}}
    for name, value in (("spfVerdict", spf), ("dkimVerdict", dkim), ("spamVerdict", spam),
                        ("virusVerdict", virus), ("dmarcVerdict", dmarc)):
        if value is not None:
            receipt[name] = {"status": value}
    if dmarc_policy is not None:
        receipt["dmarcPolicy"] = dmarc_policy
    mail = {"messageId": message_id, "source": "bounce@sender.example", "destination": list(recipients)}
    if common_headers:
        mail["commonHeaders"] = {"from": [from_header], "to": list(recipients), "subject": "x"}
    return {"eventSource": "aws:ses", "eventVersion": "1.0", "ses": {"mail": mail, "receipt": receipt}}


# ------------------------------------------------------------------------------------------
# fakes
# ------------------------------------------------------------------------------------------
class FakeS3:
    def __init__(self, bucket="mail-bucket", prefix="email-inbox/"):
        self.bucket, self.prefix = bucket, prefix
        self.objects: dict[str, bytes] = {}
        self.modified: dict[str, datetime] = {}
        self.gets: list[str] = []
        self.list_calls: list[dict] = []
        self.page_size = 1000

    def put(self, message_id: str, raw: bytes, last_modified: datetime | None = None):
        self.objects[self.prefix + message_id] = raw
        self.modified[self.prefix + message_id] = last_modified or FIXED_NOW

    def put_key(self, key: str, raw: bytes, last_modified: datetime | None = None):
        """An object at an arbitrary key (outside the prefix, or not a message id)."""
        self.objects[key] = raw
        self.modified[key] = last_modified or FIXED_NOW

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None):
        assert Bucket == self.bucket
        self.list_calls.append({"Prefix": Prefix, "ContinuationToken": ContinuationToken})
        keys = sorted(k for k in self.objects if k.startswith(Prefix))
        start = int(ContinuationToken) if ContinuationToken else 0
        page = keys[start:start + self.page_size]
        result = {"Contents": [{"Key": k, "LastModified": self.modified[k], "Size": len(self.objects[k])} for k in page],
                  "IsTruncated": start + self.page_size < len(keys)}
        if result["IsTruncated"]:
            result["NextContinuationToken"] = str(start + self.page_size)
        return result

    def get_object(self, Bucket, Key):
        assert Bucket == self.bucket
        self.gets.append(Key)
        if Key not in self.objects:
            raise KeyError(f"NoSuchKey: {Key}")
        return {"Body": io.BytesIO(self.objects[Key])}


class FakeSES:
    def __init__(self):
        self.sent: list[dict] = []
        self.bounces: list[dict] = []
        self.fail = None  # callable(kwargs) -> Exception | None

    def send_raw_email(self, Source, Destinations, RawMessage):
        kwargs = {"Source": Source, "Destinations": list(Destinations), "Data": RawMessage["Data"]}
        assert isinstance(RawMessage["Data"], bytes)
        if self.fail is not None:
            exc = self.fail(kwargs)
            if exc is not None:
                raise exc
        self.sent.append(kwargs)
        return {"MessageId": f"ses-out-{len(self.sent)}"}

    def send_bounce(self, **kwargs):
        self.bounces.append(kwargs)
        return {"MessageId": "bounce-1"}

    def to(self, address: str):
        return [s for s in self.sent if address in s["Destinations"]]


class FakeDB:
    """In-memory stand-in for db.Database (same public operations)."""

    def __init__(self):
        self.inbox: dict[str, dict] = {}
        self.tokens: dict[str, dict] = {}
        self.mail_settings: dict | None = {"default_forward": True, "default_notify": True,
                                           "default_forward_style": "inline"}                 # the single row
        self.address_rules: dict[str, dict] = {}
        self.blocked: dict[str, dict] = {}                # address -> {"count": n, "last": ...} for blocked rules
        self.inbox_log: dict[str, str] = {}
        self.users: dict[int, dict] = {1: {"role": "owner", "domains": None}}      # webmail_users
        self.indexed_unread: list[list[str]] = []         # domains of each unread row in "messages"
        self.push_subscriptions: dict[str, dict] = {}
        self.fail = None  # callable(method_name) -> Exception | None

    def _maybe_fail(self, name):
        if self.fail is not None:
            exc = self.fail(name)
            if exc is not None:
                raise exc

    def insert_inbox(self, message_id, s3_key, event, email_raw, kind, meta=None):
        self._maybe_fail("insert_inbox")
        assert kind in ("inbound", "junk", "relay_out", "sent")
        if message_id in self.inbox:
            return False
        self.inbox[message_id] = dict(message_id=message_id, s3_key=s3_key, event=copy.deepcopy(event),
                                      email_raw=email_raw, kind=kind, meta=copy.deepcopy(meta), processed_at=None)
        return True

    def get_inbox_meta(self, message_id):
        row = self.inbox.get(message_id)
        return None if row is None else {"kind": row["kind"], "meta": dict(row["meta"] or {})}

    def merge_inbox_meta(self, message_id, meta):
        self._maybe_fail("merge_inbox_meta")
        row = self.inbox[message_id]
        row["meta"] = {**(row["meta"] or {}), **meta}

    def relay_already_sent(self, relay_source_id):
        return any(r["kind"] == "relay_out" and (r["meta"] or {}).get("relay_source_id") == relay_source_id
                   for r in self.inbox.values())

    def create_token(self, *, token, inbox_message_id, alias_address, correspondent, correspondent_name,
                     orig_message_id, orig_references, subject):
        self._maybe_fail("create_token")
        assert inbox_message_id in self.inbox, "relay_tokens.inbox_message_id references lambda_inbox"
        self.tokens.setdefault(token, dict(
            token=token, inbox_message_id=inbox_message_id, alias_address=alias_address,
            correspondent=correspondent, correspondent_name=correspondent_name,
            orig_message_id=orig_message_id, orig_references=orig_references, subject=subject,
            last_used_at=None, use_count=0))

    def get_token(self, token):
        row = self.tokens.get(token)
        return dict(row) if row else None

    def find_token_for_message(self, inbox_message_id):
        for row in self.tokens.values():
            if row["inbox_message_id"] == inbox_message_id:
                return dict(row)
        return None

    def touch_token(self, token):
        self.tokens[token]["use_count"] += 1
        self.tokens[token]["last_used_at"] = "now"

    # -- delivery rules --
    def get_mail_defaults(self):
        self._maybe_fail("get_mail_defaults")
        if self.mail_settings is None:
            return {"forward": True, "notify": True, "forward_style": "inline"}
        return {"forward": self.mail_settings["default_forward"], "notify": self.mail_settings["default_notify"],
                "forward_style": self.mail_settings["default_forward_style"]}

    def resolve_address_rule(self, address):
        self._maybe_fail("resolve_address_rule")
        assert address == address.lower()
        if self.mail_settings is not None:      # insert ... select from mail_settings on conflict do nothing
            self.address_rules.setdefault(address, {"forward": self.mail_settings["default_forward"],
                                                    "notify": self.mail_settings["default_notify"],
                                                    "forward_style": self.mail_settings["default_forward_style"]})
        rule = self.address_rules.get(address)
        return dict(rule) if rule else {"forward": True, "notify": True, "forward_style": "inline"}

    def set_rule(self, address, forward=True, notify=True, forward_style="inline"):
        """What the webmail does when the owner edits an address."""
        self.address_rules[address] = {"forward": forward, "notify": notify, "forward_style": forward_style}

    # -- blocked addresses, delivery log, reconcile --
    def block(self, address):
        """What the webmail does when the owner blocks an address (the rule row exists by then)."""
        self.address_rules.setdefault(address, {"forward": True, "notify": True, "forward_style": "inline"})
        self.blocked[address] = {"count": 0, "last": None}

    def record_blocked(self, addresses):
        self._maybe_fail("record_blocked")
        hits = [a for a in addresses if a in self.blocked]
        for address in hits:
            self.blocked[address]["count"] += 1
            self.blocked[address]["last"] = "now"
        return hits

    def log_outcome(self, message_id, outcome):
        self._maybe_fail("log_outcome")
        self.inbox_log[message_id] = outcome

    def handled_message_ids(self, message_ids):
        self._maybe_fail("handled_message_ids")
        sources = {(r["meta"] or {}).get("relay_source_id") for r in self.inbox.values() if r["kind"] == "relay_out"}

        def stored(m):          # an inbound row whose forward never finished does not count as handled
            row = self.inbox.get(m)
            meta = (row or {}).get("meta") or {}
            return row is not None and not (row["kind"] == "inbound" and "notified" in meta and "forwarded" not in meta)

        return {m for m in message_ids if m in self.inbox_log or stored(m) or m in sources}

    # -- web push --
    def add_subscription(self, endpoint, p256dh="p256dh-key", auth="auth-secret", failure_count=0, user_id=1):
        self.push_subscriptions[endpoint] = dict(endpoint=endpoint, p256dh=p256dh, auth=auth, user_id=user_id,
                                                 last_success_at=None, failure_count=failure_count)

    def add_user(self, user_id, role="member", domains=None):
        self.users[user_id] = {"role": role, "domains": domains}

    def delete_orphan_push_subscriptions(self):
        self._maybe_fail("delete_orphan_push_subscriptions")
        orphans = [e for e, row in self.push_subscriptions.items() if row["user_id"] not in self.users]
        for endpoint in orphans:
            del self.push_subscriptions[endpoint]
        return len(orphans)

    def list_push_subscriptions(self, limit=40, per_user=5):
        """Mirrors db.Database: the healthiest `per_user` of each user, owners first, `limit` overall."""
        self._maybe_fail("list_push_subscriptions")
        rows = sorted((r for r in self.push_subscriptions.values() if r["user_id"] in self.users),
                      key=lambda r: r["failure_count"])
        taken, kept = {}, []
        for r in rows:
            taken[r["user_id"]] = taken.get(r["user_id"], 0) + 1
            if taken[r["user_id"]] <= per_user:
                kept.append(r)
        kept.sort(key=lambda r: (self.users[r["user_id"]]["role"] != "owner", r["failure_count"]))
        return [dict(endpoint=r["endpoint"], p256dh=r["p256dh"], auth=r["auth"],
                     role=self.users[r["user_id"]]["role"], domains=self.users[r["user_id"]]["domains"])
                for r in kept[:limit]]

    def count_unread(self, domains=None):
        self._maybe_fail("count_unread")
        wanted = None if domains is None else {d.lower() for d in domains}

        def visible(message_domains):
            return wanted is None or bool(wanted & {d.lower() for d in message_domains})

        indexed = sum(1 for message_domains in self.indexed_unread if visible(message_domains))
        pending = sum(
            1 for row in self.inbox.values()
            if row["kind"] == "inbound" and row["processed_at"] is None
            and visible(r.rpartition("@")[2] for r in ((row["event"].get("receipt") or {}).get("recipients") or []))
        )
        return indexed + pending

    def push_succeeded(self, endpoint):
        self.push_subscriptions[endpoint].update(last_success_at="now", failure_count=0)

    def push_failed(self, endpoint):
        self._maybe_fail("push_failed")
        self.push_subscriptions[endpoint]["failure_count"] += 1

    def delete_push_subscription(self, endpoint):
        self.push_subscriptions.pop(endpoint, None)
