"""eisenmail inbound Lambda: SES receipt rule -> S3 -> this handler.

Per SES record:
  virus FAIL                     -> dropped (log only)
  DMARC FAIL + policy REJECT     -> bounced
  spf/dkim/spam FAIL             -> stored as kind='junk', not forwarded, never relayed
  authorised reply to reply-<token>@domain from the owner
                                 -> rewritten and sent to the correspondent from the alias,
                                    stored as kind='relay_out'
  recipient with a blocked rule  -> removed from the message; nothing left -> 'blocked', not stored
  everything else                -> stored as kind='inbound'; then, depending on the delivery
                                    rules of the receiving address(es) (address_rules, created
                                    from mail_settings on first mail):
                                      forward on -> relay token created, forwarded to the address's mailboxes (default FORWARD_TO)
                                                    in that address's style (inline | attach)
                                      notify on  -> Web Push to every push_subscriptions row
                                    Mail is always stored, whatever the rules say.

This module only orchestrates; message building lives in relay.py (pure), storage in db.py,
settings in config.py. Nothing touches AWS or the database at import time: clients are created
on first use, and tests either build a Processor with fakes or monkeypatch the get_* functions.
"""
from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timezone
from typing import Any, Callable, List, Mapping, Optional, Tuple

import config as config_module
import push
import relay

log = logging.getLogger("eisenmail")
log.setLevel(logging.INFO)

BOUNCE_EXPLANATION = "Unauthenticated email is not accepted due to the sending domain's DMARC policy."
# SES refuses raw messages over its size limit (10 MB by default) with InvalidParameterValue
# "Message length is more than N bytes long". Quota/throttling errors also say "exceeded", so the
# match is deliberately narrow and only considered for messages that are actually big.
_SIZE_ERROR_RE = re.compile(r"message (?:length|size)|length is more than|too (?:large|long|big)|entity too large", re.I)
_NOT_SIZE_CODES = frozenset({"throttling", "throttlingexception", "limitexceededexception", "toomanyrequestsexception"})
SIZE_FALLBACK_MIN_BYTES = 1_000_000
MAX_FORWARD_TARGETS = 50  # SES takes at most 50 recipients in one message

_singletons: dict = {}


def get_config() -> config_module.Config:
    if "config" not in _singletons:
        _singletons["config"] = config_module.load()
    return _singletons["config"]


def get_s3():
    if "s3" not in _singletons:
        import boto3

        _singletons["s3"] = boto3.client("s3")
    return _singletons["s3"]


def get_ses():
    if "ses" not in _singletons:
        import boto3

        _singletons["ses"] = boto3.client("ses")
    return _singletons["ses"]


def get_db():
    if "db" not in _singletons:
        from db import Database

        cfg = get_config()
        _singletons["db"] = Database(cfg.db, cfg.tunnel)
    return _singletons["db"]


def get_notifier():
    """The Web Push notifier, or None (logged once) when no VAPID key is configured."""
    if "notifier" not in _singletons:
        cfg = get_config()
        if cfg.push is None:
            log.info("web push is disabled: no VAPID_PRIVATE_KEY / VAPID_PRIVATE_KEY_SSM configured")
            _singletons["notifier"] = None
        else:
            _singletons["notifier"] = push.PushNotifier(cfg.push)
    return _singletons["notifier"]


class RecordsFailed(RuntimeError):
    """Raised after all records were attempted when at least one failed (so Lambda retries)."""


def _is_size_error(exc: Exception, size: int) -> bool:
    """True when sending failed because the message is too large for SES."""
    if size < SIZE_FALLBACK_MIN_BYTES:
        return False
    response = getattr(exc, "response", None)
    if isinstance(response, Mapping):
        status = (response.get("ResponseMetadata") or {}).get("HTTPStatusCode")
        if status == 413:
            return True
        error = response.get("Error") or {}
        if str(error.get("Code", "")).lower() in _NOT_SIZE_CODES:
            return False
        text = f"{error.get('Code', '')} {error.get('Message', '')}"
    else:
        text = str(exc)
    return bool(_SIZE_ERROR_RE.search(text))


class Processor:
    def __init__(
        self,
        cfg: config_module.Config,
        s3: Any,
        ses: Any,
        db: Any,
        *,
        now: Optional[Callable[[], datetime]] = None,
        new_token: Optional[Callable[[], str]] = None,
        notifier: Any = None,
    ):
        self.cfg = cfg
        self.s3 = s3
        self.ses = ses
        self.db = db
        self.notifier = notifier            # push.PushNotifier, or None when push is disabled
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._new_token = new_token or (lambda: secrets.token_hex(16))

    # ------------------------------------------------------------------------------------
    def process_event(self, event: Mapping) -> List[str]:
        """Process every record; one bad record never stops the others. Raises RecordsFailed
        at the end if any record failed."""
        outcomes: List[str] = []
        failed: List[str] = []
        for index, record in enumerate((event or {}).get("Records") or []):
            ident = f"#{index}"
            try:
                ident = str(record["ses"]["mail"]["messageId"])
                outcome = self.process_record(record)
                log.info("record %s: %s", ident, outcome)
                outcomes.append(outcome)
            except Exception:
                log.exception("record %s: FAILED", ident)
                outcomes.append("failed")
                failed.append(ident)
        if failed:
            raise RecordsFailed(f"{len(failed)} of {len(outcomes)} record(s) failed: {', '.join(failed)}")
        return outcomes

    # ------------------------------------------------------------------------------------
    def process_record(self, record: Mapping, *, replay: bool = False) -> str:
        """Handle one SES record and write its outcome to the delivery log (inbox_log). A record
        that raises logs nothing, so the scheduled reconcile run can replay it.

        `replay=True` is the reconcile path: the notification was rebuilt from the stored message,
        not sent by SES. Such a message is never relayed as an owner reply and never bounced, and
        it is junk when its virus verdict is unknown."""
        outcome = self._process(record, replay)
        self._log_outcome(str(record["ses"]["mail"]["messageId"]), outcome)
        return outcome

    def _log_outcome(self, message_id: str, outcome: str) -> None:
        try:
            self.db.log_outcome(message_id, outcome)
        except Exception as exc:  # the log must never fail a record that was handled
            log.error("record %s: could not write the delivery log (%s)", message_id, type(exc).__name__)

    def _process(self, record: Mapping, replay: bool) -> str:
        notification = record["ses"]
        mail = notification.get("mail") or {}
        receipt = notification.get("receipt") or {}
        message_id = str(mail["messageId"])
        recipients = [str(r).strip().lower() for r in (receipt.get("recipients") or []) if str(r).strip()]

        def failed(name: str) -> bool:
            return relay.verdict(receipt, name) == "FAIL"

        if failed("virusVerdict"):
            return "dropped_virus"

        alias = relay.pick_alias(recipients, self.cfg.mail_domains)
        domain = relay.domain_of(alias) if alias else self.cfg.fallback_domain
        if not domain:
            raise ValueError("record has no recipients and MAIL_DOMAINS is not set")

        if not replay and failed("dmarcVerdict") and relay.verdict(receipt, "dmarcPolicy") == "REJECT":
            self._bounce(message_id, domain, receipt)
            return "bounced"

        # Blocked addresses: as if the mail had never been addressed to them.
        blocked = self._blocked(recipients)
        if blocked:
            recipients = [r for r in recipients if r not in blocked]
            log.info("record %s: %d blocked recipient(s) removed", message_id, len(blocked))
            if not recipients:
                return "blocked"
            kept = [r for r in (receipt.get("recipients") or []) if str(r).strip().lower() not in blocked]
            receipt = {**receipt, "recipients": kept}
            notification = {**notification, "receipt": receipt}
            alias = relay.pick_alias(recipients, self.cfg.mail_domains)
            domain = relay.domain_of(alias) if alias else self.cfg.fallback_domain or domain
        base_meta = {"blocked_recipients": sorted(blocked)} if blocked else None

        key = self.cfg.mail_prefix + message_id
        raw = self.s3.get_object(Bucket=self.cfg.mail_bucket, Key=key)["Body"].read()
        msg = relay.parse(raw)

        virus_unknown = replay and "virusVerdict" not in receipt
        if failed("spfVerdict") or failed("dkimVerdict") or failed("spamVerdict") or virus_unknown:
            self.db.insert_inbox(message_id, key, notification, raw, "junk", base_meta)
            return "junk"

        loop = None
        relay_rcpt = relay.find_relay_recipient(recipients, self.cfg.mail_domains)
        if relay_rcpt is not None:
            token, relay_addr = relay_rcpt
            token_row = None
            if replay:
                # The DMARC evidence was reconstructed from the stored message, it is not SES's
                # own event: a replayed message is never trusted as an owner reply.
                reason: Optional[str] = "replayed message"
            else:
                token_row = self.db.get_token(token)
                if token_row is None:
                    reason = "unknown token"
                else:
                    # Who may answer: the owner, and the mailboxes this very forward was sent to
                    # (an address that forwards to a group).
                    allowed = tuple(self.cfg.owner_addresses) + tuple(token_row.get("forwarded_to") or ())
                    common_from = (mail.get("commonHeaders") or {}).get("from")
                    reason = relay.relay_refusal_reason(msg, receipt, allowed, ses_from=common_from)
            if reason is None:
                return self._relay(message_id, notification, raw, relay_addr, token_row)
            log.warning("record %s: relay refused (%s); handling as normal inbound", message_id, reason)
            loop = relay.auto_response_reason(msg) or relay.bounce_reason(msg, mail.get("source"))
            if loop is not None:
                # Relay addresses are the From/Source of our forwards, so the only automatic mail
                # they receive is the owner's mailbox answering a forward (out-of-office) or a
                # bounce of a forward. Forwarding that to the same mailbox would be answered or
                # bounced again, and every forward has a new From address, so "once per sender"
                # limits never kick in. Store it, do not forward it.
                log.warning("record %s: automatic mail to a relay address (%s); not forwarded", message_id, loop)

        return self._inbound(message_id, key, notification, raw, msg, recipients, alias, domain, loop, base_meta)

    def _ours(self, recipients) -> List[str]:
        """The recipients on our receiving domains (all of them when MAIL_DOMAINS is unset)."""
        domains = self.cfg.mail_domains
        return [r for r in dict.fromkeys(recipients) if "@" in r and (not domains or relay.domain_of(r) in domains)]

    def _blocked(self, recipients) -> set:
        """Blocked recipients (each hit is counted). Only an existing rule can block: relay-shaped
        addresses have no rule, and an address seen for the first time is not blocked."""
        ordinary = [r for r in self._ours(recipients) if not relay.RELAY_LOCAL_RE.match(r.rpartition("@")[0])]
        if not ordinary:
            return set()
        return {str(address).lower() for address in self.db.record_blocked(ordinary)}

    # ------------------------------------------------------------------------------------
    def _bounce(self, message_id: str, domain: str, receipt: Mapping) -> None:
        self.ses.send_bounce(
            OriginalMessageId=message_id,
            BounceSender=f"mailer-daemon@{domain}",
            MessageDsn={
                "ReportingMta": f"dns; {domain}",
                "ArrivalDate": self._now(),
                "ExtensionFields": [],
            },
            Explanation=BOUNCE_EXPLANATION,
            BouncedRecipientInfoList=[
                {"Recipient": recipient, "BounceType": "ContentRejected"}
                for recipient in (receipt.get("recipients") or [])
            ],
        )

    # ------------------------------------------------------------------------------------
    def _inbound(self, message_id, key, notification, raw, msg, recipients, alias, domain, loop, base_meta=None) -> str:
        """Store, then forward (when the address rules say so), then notify (when they say so).

        Each finished step leaves a key in the row's meta, so a Lambda retry only redoes what is
        missing:  forwarded: true | false (+ forward_skipped: "rule" | "loop"),  notified: true | false.
        `base_meta` (blocked_recipients) is written with the row itself.
        """
        inserted = self.db.insert_inbox(message_id, key, notification, raw, "inbound", base_meta)
        meta: Mapping[str, Any] = {}
        if not inserted:
            state = self.db.get_inbox_meta(message_id)
            if state is None or state.get("kind") != "inbound":
                return "duplicate"
            meta = state.get("meta") or {}
            if "forwarded" in meta and "notified" in meta:
                return "duplicate"

        want_forward, want_notify, style, targets = self._delivery(recipients)

        forward_error: Optional[BaseException] = None
        if "forwarded" in meta:
            outcome = "forwarded" if meta["forwarded"] else "stored"
        elif loop or not want_forward:
            self.db.merge_inbox_meta(message_id, {"forwarded": False, "forward_skipped": "loop" if loop else "rule"})
            outcome = "stored"
        else:
            try:
                outcome = self._forward(message_id, raw, msg, recipients, alias, domain, style,
                                        reuse_token=not inserted, targets=targets)
                self.db.merge_inbox_meta(message_id, {"forwarded": True})
            except Exception as exc:  # still notify (the mail is stored), then fail the record
                forward_error = exc
                outcome = "failed"

        if "notified" not in meta:
            # Automatic mail to a relay address (an out-of-office or bounce answering a forward) is
            # stored but is not worth a notification.
            self._notify_step(message_id, msg, alias or (recipients[0] if recipients else ""), domain,
                              want_notify and not loop, recipients)

        if forward_error is not None:
            raise forward_error
        return outcome

    def _delivery(self, recipients) -> Tuple[bool, bool, str, Tuple[str, ...]]:
        """(forward, notify, forward style, mailboxes to forward to) for a normal inbound message.

        The mailboxes are those of every recipient whose rule forwards: the rule's own list, or
        FORWARD_TO when it has none. One forward goes to all of them together.


        forward / notify are true when ANY of our recipients' rules says so. Each ordinary address
        gets its rule row from the current defaults the first time it receives mail; relay-shaped
        addresses never get a row and use the mail_settings defaults, as does a message with no
        recipient on our domains.

        The style is that of the address the forward is made for: the primary alias (our first
        recipient) when its rule forwards, otherwise the first recipient in envelope order whose
        rule forwards. Unknown values are 'inline'."""
        ours = self._ours(recipients)
        defaults = None
        rules = []
        for address in ours:
            if relay.RELAY_LOCAL_RE.match(address.rpartition("@")[0]):
                defaults = defaults or self.db.get_mail_defaults()
                rules.append(defaults)
            else:
                rules.append(self.db.resolve_address_rule(address))
        if not rules:
            rules.append(self.db.get_mail_defaults())
        forwarding = [rule for rule in rules if rule["forward"]]
        style = relay.normalize_forward_style(forwarding[0].get("forward_style")) if forwarding else "inline"
        return bool(forwarding), any(rule["notify"] for rule in rules), style, self._targets(forwarding)

    def _targets(self, forwarding) -> Tuple[str, ...]:
        """The mailboxes a forward goes to. Never one of our own receiving addresses (that would
        loop), never more than SES takes in one message; FORWARD_TO when nothing usable is left."""
        wanted: List[str] = []
        for rule in forwarding:
            wanted.extend(rule.get("forward_to") or self.cfg.forward_to)
        domains = self.cfg.mail_domains
        usable = []
        for address in dict.fromkeys(str(a).strip().lower() for a in wanted):
            if relay.is_plain_address(address) and not (domains and relay.domain_of(address) in domains):
                usable.append(address)
        return tuple(usable[:MAX_FORWARD_TARGETS]) or tuple(self.cfg.forward_to)

    def _notify_step(self, message_id, msg, alias, domain, want_notify, recipients=()) -> None:
        """Web Push. Nothing in here may fail the record or hold up the forward."""
        try:
            notified = False
            if want_notify and self.notifier is not None:
                ours = self._ours(recipients)

                def alias_for(scope):
                    # An owner sees the primary alias. A member is shown the first recipient on one
                    # of their own domains: the message may also have gone to an address on a domain
                    # the member must not learn about.
                    if scope is None:
                        return alias
                    return next((r for r in ours if relay.domain_of(r) in scope), "")

                counts = self.notifier.notify(
                    self.db,
                    lambda badge, scope=None: push.build_payload(msg, alias_for(scope), message_id, badge),
                    self.cfg.fallback_domain or domain,
                    recipient_domains={relay.domain_of(r) for r in ours},
                )
                log.info("record %s: push %s", message_id, counts)
                notified = True
            self.db.merge_inbox_meta(message_id, {"notified": notified})
        except Exception as exc:
            log.error("record %s: push step failed (%s); continuing", message_id, type(exc).__name__)

    def _forward(self, message_id, raw, msg, recipients, alias, domain, style, reuse_token, targets=None) -> str:
        targets = tuple(targets or self.cfg.forward_to)
        sender = f"noreply@{domain}"
        correspondent = relay.extract_correspondent(msg) if alias else None
        if correspondent is not None:
            existing = self.db.find_token_for_message(message_id) if reuse_token else None
            if existing is not None:
                token = existing["token"]
                if list(existing.get("forwarded_to") or ()) != list(targets):
                    self.db.set_token_targets(token, targets)
            else:
                token = self._new_token()
                references = relay.message_ids(" ".join(relay.header_values(msg, "References"))) or relay.message_ids(
                    relay.header_value(msg, "In-Reply-To", "")
                )
                self.db.create_token(
                    token=token,
                    inbox_message_id=message_id,
                    alias_address=alias,
                    correspondent=correspondent.address,
                    correspondent_name=correspondent.name,
                    orig_message_id=(relay.message_ids(relay.header_value(msg, "Message-ID", "")) or [None])[0],
                    orig_references=" ".join(references) or None,
                    subject=relay.clean_header_text(relay.header_value(msg, "Subject", "")) or None,
                    forwarded_to=targets,
                )
            sender = relay.relay_address(token, domain)
        else:
            log.warning("record %s: no usable alias/sender address; forwarding without a relay token", message_id)

        params = relay.ForwardParams(
            forward_to=targets,
            alias=alias or (recipients[0] if recipients else f"unknown@{domain}"),
            sender=sender,
            recipients=recipients,
            ses_message_id=message_id,
            now=self._now(),
        )
        data = relay.build_forward(raw, params, style)
        try:
            self._send(sender, targets, data)
        except Exception as exc:
            if not _is_size_error(exc, len(data)):
                raise
            log.warning("record %s: forward rejected for size (%d bytes); sending notice", message_id, len(data))
            self._send(sender, targets, relay.build_too_large_notice(raw, params))
            return "forwarded_notice"
        return "forwarded"

    # ------------------------------------------------------------------------------------
    def _relay(self, message_id, notification, raw, relay_addr, token_row) -> str:
        if self.db.relay_already_sent(message_id):
            return "relay_duplicate"

        alias = token_row["alias_address"]
        correspondent = token_row["correspondent"]
        # Nothing on the private side may show in what goes out: the owner's addresses, the
        # mailboxes this forward went to, and every other mailbox an address forwards to (a quoted
        # older message may name them).
        group = tuple(token_row.get("forwarded_to") or ())
        private = tuple(dict.fromkeys(
            str(a).strip().lower()
            for a in tuple(self.cfg.private_addresses) + group + tuple(self.db.all_forward_targets())
            if a and str(a).strip()
        ))
        notice_to = group or tuple(self.cfg.forward_to)
        params = relay.RelayParams(
            alias_address=alias,
            correspondent=correspondent,
            relay_address=relay_addr,
            private_addresses=private,
            correspondent_name=token_row.get("correspondent_name"),
            orig_message_id=token_row.get("orig_message_id"),
            orig_references=token_row.get("orig_references"),
            subject=token_row.get("subject"),
            now=self._now(),
        )
        try:
            data = relay.build_relay_reply(raw, params)
            relay.assert_no_leak(data, private, relay_addr, allow=(alias,))
        except Exception as exc:
            if isinstance(exc, relay.LeakError):
                reason = str(exc)
            else:
                reason = f"the reply could not be rewritten ({type(exc).__name__})"
            log.error("record %s: relay reply NOT sent: %s", message_id, reason)
            notice = relay.build_undelivered_notice(
                forward_to=notice_to,
                domain=relay.domain_of(relay_addr),
                correspondent=correspondent,
                subject=token_row.get("subject"),
                reason=reason,
                now=self._now(),
            )
            self._send(f"mailer-daemon@{relay.domain_of(relay_addr)}", notice_to, notice)
            return "relay_blocked"

        response = self._send(alias, [correspondent], data)
        sent_id = str((response or {}).get("MessageId") or f"unknown-{message_id}")
        self.db.insert_inbox(
            f"relay-{sent_id}",
            None,
            notification,
            data,
            "relay_out",
            {
                "from": alias,
                "to": [correspondent],
                "cc": [],
                "bcc": [],
                "in_reply_to_raw_id": token_row.get("inbox_message_id"),
                "relay_source_id": message_id,
            },
        )
        self.db.touch_token(token_row["token"])
        return "relayed"

    # ------------------------------------------------------------------------------------
    def _send(self, source: str, destinations, data: bytes):
        return self.ses.send_raw_email(Source=source, Destinations=list(destinations), RawMessage={"Data": data})


def lambda_handler(event, context):
    """SES events ({"Records": [...]}) are processed; the scheduled {"eisenmail": "reconcile"}
    event replays stored mail that was never processed (see reconcile.py)."""
    processor = Processor(get_config(), get_s3(), get_ses(), get_db(), notifier=get_notifier())
    if isinstance(event, Mapping) and "Records" not in event and event.get("eisenmail") == "reconcile":
        import reconcile

        return reconcile.run(processor, context)
    processor.process_event(event)
    return None
