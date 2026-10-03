"""Scheduled replay of stored mail that was never processed.

SES invokes the Lambda asynchronously; when an invocation keeps failing (database down, bug,
throttling) the built-in retries run out and the message is lost, although its raw copy is in S3.
EventBridge invokes the Lambda with {"eisenmail": "reconcile"}; `run` then

1. lists the objects under MAIL_BUCKET/MAIL_PREFIX that are between MIN_AGE and
   RECONCILE_MAX_AGE_HOURS old and whose name is an SES message id,
2. asks the database which of them it has never finished with (not in inbox_log, not in
   lambda_inbox, not the source of a relayed reply),
3. replays up to RECONCILE_BATCH of those, oldest first, through the normal Processor path.

There is no SES event for a replay, so one is rebuilt from the headers SES itself prepended to the
stored message (`rebuild_notification`). Because those verdicts are reconstructed, a replayed
message is never relayed as an owner reply and never bounced, whatever its headers say, and it is
stored as junk when SES's virus verdict is not there to read. The reconstructed spf/dkim/dmarc
values are best effort (parts of that header echo values chosen by the sending server) and only
decide inbox versus junk.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

import relay

log = logging.getLogger("eisenmail.reconcile")

MIN_AGE = timedelta(minutes=20)          # younger mail may still be in SES's own retries
MIN_REMAINING_MS = 20_000                # stop replaying when the invocation is about to time out
MESSAGE_ID_RE = re.compile(r"^[a-z0-9]{20,60}$")

# Headers SES prepends to a received message, in this order. X-SES-RECEIPT / X-SES-DKIM-SIGNATURE
# close the block: whatever follows belongs to the message as the sender wrote it.
_SES_HEADERS = ("return-path", "received", "x-ses-spam-verdict", "x-ses-virus-verdict", "received-spf",
                "authentication-results")
_SES_TRAILERS = ("x-ses-receipt", "x-ses-dkim-signature")
_VERDICTS = ("PASS", "FAIL", "GRAY", "PROCESSING_FAILED")
_RECEIVED_RE = re.compile(r"\bby\s+inbound-smtp\.[a-z0-9-]+\.amazonaws\.com\s+with\s+SMTP\s+id\s+([a-z0-9]+)\b", re.I)
_FOR_RE = re.compile(r"\bfor\s+<?([^\s<>;]+@[^\s<>;]+?)>?\s*;", re.I)
_COMMENT_RE = re.compile(r"\([^()]*\)")


# --------------------------------------------------------------------------------------------
# rebuilding the SES notification from the stored message (pure)
# --------------------------------------------------------------------------------------------
def unfolded_headers(raw: bytes) -> List[Tuple[str, str]]:
    """(name, value) of every header of the top-level header block, in order, unfolded."""
    head, _ = relay.split_raw(raw)
    headers: List[Tuple[str, str]] = []
    for line in head.decode("latin-1").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if not line:
            continue
        if line[0] in " \t":
            if headers:
                name, value = headers[-1]
                headers[-1] = (name, f"{value} {line.strip()}")
            continue
        name, sep, value = line.partition(":")
        if not sep:
            break                       # not a header line: the block is malformed from here on
        headers.append((name.strip(), value.strip()))
    return headers


def ses_headers(raw: bytes, message_id: str) -> Dict[str, str]:
    """The headers SES itself wrote: the first occurrence of each SES header at the very top of
    the message, up to the first header SES does not add (or a repeated one). Nothing lower in the
    message is trusted, so a forged Authentication-Results / X-SES-* header further down is ignored.

    The block is only accepted when its Received header names this very message id."""
    found: Dict[str, str] = {}
    trailer_seen = False
    for name, value in unfolded_headers(raw):
        key = name.lower()
        if key in _SES_TRAILERS:
            if key in found:
                break
            trailer_seen = True
        elif key not in _SES_HEADERS or key in found or trailer_seen:
            break
        found[key] = value
    match = _RECEIVED_RE.search(found.get("received", ""))
    if not match or match.group(1).lower() != message_id.lower():
        return {}
    return found


def _status(value: Optional[str]) -> Optional[str]:
    status = (value or "").strip().upper()
    return status if status in _VERDICTS else None


def _method_results(authentication_results: str) -> Dict[str, List[str]]:
    """{"spf": [...], "dkim": [...], "dmarc": [...]} from SES's Authentication-Results value."""
    results: Dict[str, List[str]] = {"spf": [], "dkim": [], "dmarc": []}
    text = authentication_results
    while _COMMENT_RE.search(text):
        text = _COMMENT_RE.sub(" ", text)
    parts = [part.strip() for part in text.split(";")]
    if not parts or parts[0].lower() != "amazonses.com":
        return results
    for part in parts[1:]:
        m = re.match(r"^(spf|dkim|dmarc)\s*=\s*([a-z]+)", part, re.I)
        if m:
            results[m.group(1).lower()].append(m.group(2).lower())
    return results


def _mapped(result: Optional[str]) -> Optional[str]:
    if result is None:
        return None
    return {"pass": "PASS", "fail": "FAIL"}.get(result, "GRAY")


def rebuild_notification(
    raw: bytes,
    message_id: str,
    last_modified: datetime,
    mail_domains: Sequence[str] = (),
) -> Dict[str, Any]:
    """An SES-shaped notification ({"mail": ..., "receipt": ...}) for a stored message.

    A verdict that cannot be read is left out, which the handler treats as neither PASS nor FAIL
    (a missing virus verdict makes the handler store the message as junk). dmarcPolicy is never
    set. `receipt.recipients` may be empty: the caller must not process such a message."""
    trusted = ses_headers(raw, message_id)
    msg = relay.parse(raw)

    recipients: List[str] = []
    match = _FOR_RE.search(trusted.get("received", ""))
    if match and relay.is_addr_spec(match.group(1)):
        recipients.append(match.group(1).lower())
    if mail_domains:
        for header in ("To", "Cc"):
            for _, address in relay.header_addresses(msg, header):
                address = address.lower()
                if relay.is_addr_spec(address) and relay.domain_of(address) in mail_domains:
                    recipients.append(address)
    recipients = list(dict.fromkeys(recipients))

    receipt: Dict[str, Any] = {"recipients": recipients, "timestamp": _iso(last_modified)}
    for name, header in (("spamVerdict", "x-ses-spam-verdict"), ("virusVerdict", "x-ses-virus-verdict")):
        status = _status(trusted.get(header))
        if status is not None:
            receipt[name] = {"status": status}

    results = _method_results(trusted.get("authentication-results", ""))
    spf = results["spf"][0] if results["spf"] else None
    if spf is None and trusted.get("received-spf"):
        spf = trusted["received-spf"].split()[0].lower()
    dkim = "pass" if "pass" in results["dkim"] else (results["dkim"][0] if results["dkim"] else None)
    dmarc = results["dmarc"][-1] if results["dmarc"] else None
    for name, result in (("spfVerdict", spf), ("dkimVerdict", dkim), ("dmarcVerdict", dmarc)):
        status = _mapped(result)
        if status is not None:
            receipt[name] = {"status": status}

    source = trusted.get("return-path", "").strip().strip("<>").strip()
    mail: Dict[str, Any] = {
        "messageId": message_id,
        "timestamp": _iso(last_modified),
        "source": source,
        "destination": list(recipients),
        "commonHeaders": {
            "from": relay.header_values(msg, "From"),
            "to": relay.header_values(msg, "To"),
            "subject": relay.header_value(msg, "Subject", ""),
        },
    }
    return {"mail": mail, "receipt": receipt, "reconciled": True}


def _iso(moment: datetime) -> str:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


# --------------------------------------------------------------------------------------------
# the run
# --------------------------------------------------------------------------------------------
def list_candidates(s3: Any, bucket: str, prefix: str, now: datetime, max_age: timedelta) -> List[Tuple[datetime, str]]:
    """(LastModified, message id) of every stored message inside the age window, oldest first."""
    found: List[Tuple[datetime, str]] = []
    kwargs: Dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
    while True:
        page = s3.list_objects_v2(**kwargs)
        for item in page.get("Contents") or []:
            key = str(item.get("Key", ""))
            message_id = key[len(prefix):] if key.startswith(prefix) else ""
            modified = item.get("LastModified")
            if not MESSAGE_ID_RE.match(message_id) or not isinstance(modified, datetime):
                continue
            if modified.tzinfo is None:
                modified = modified.replace(tzinfo=timezone.utc)
            if MIN_AGE <= now - modified <= max_age:
                found.append((modified, message_id))
        token = page.get("NextContinuationToken")
        if not page.get("IsTruncated") or not token:
            break
        kwargs["ContinuationToken"] = token
    found.sort()
    return found


def _remaining_ms(context: Any) -> Optional[int]:
    probe = getattr(context, "get_remaining_time_in_millis", None)
    if not callable(probe):
        return None
    try:
        return int(probe())
    except Exception:
        return None


def run(processor: Any, context: Any = None) -> Dict[str, int]:
    """One reconcile pass. Never raises for a single message; what fails is retried next run."""
    cfg = processor.cfg
    now = processor._now()
    summary = {"listed": 0, "missing": 0, "replayed": 0, "unroutable": 0, "failed": 0}

    candidates = list_candidates(processor.s3, cfg.mail_bucket, cfg.mail_prefix, now,
                                 timedelta(hours=cfg.reconcile_max_age_hours))
    summary["listed"] = len(candidates)
    handled = processor.db.handled_message_ids([message_id for _, message_id in candidates]) if candidates else set()
    missing = [(modified, message_id) for modified, message_id in candidates if message_id not in handled]
    summary["missing"] = len(missing)

    for modified, message_id in missing[: cfg.reconcile_batch]:
        remaining = _remaining_ms(context)
        if remaining is not None and remaining < MIN_REMAINING_MS:
            log.warning("reconcile: out of time, the rest waits for the next run")
            break
        try:
            raw = processor.s3.get_object(Bucket=cfg.mail_bucket, Key=cfg.mail_prefix + message_id)["Body"].read()
            notification = rebuild_notification(raw, message_id, modified, cfg.mail_domains)
            if not notification["receipt"]["recipients"]:
                processor._log_outcome(message_id, "reconcile_unroutable")
                summary["unroutable"] += 1
                log.warning("reconcile %s: no recipient can be determined; skipped", message_id)
                continue
            outcome = processor.process_record({"ses": notification}, replay=True)
            summary["replayed"] += 1
            log.info("reconcile %s: %s", message_id, outcome)
        except Exception:
            summary["failed"] += 1
            log.exception("reconcile %s: FAILED", message_id)

    log.info("reconcile: %s", summary)
    return summary
