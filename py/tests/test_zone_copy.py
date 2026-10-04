"""infra/zone_copy.py: which records of an old hosted zone are copied into the new one."""
import importlib.util
import io
import json
import pathlib

import pytest

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / "infra" / "zone_copy.py"
spec = importlib.util.spec_from_file_location("zone_copy", SCRIPT)
zone_copy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(zone_copy)

OLD, NEW = "ZOLD111", "ZNEW222"


def rr(name, kind, *vals, ttl=300, **extra):
    return {"Name": name, "Type": kind, "TTL": ttl, "ResourceRecords": [{"Value": v} for v in vals], **extra}


def alias(name, kind, target, zone):
    return {"Name": name, "Type": kind, "AliasTarget": {"DNSName": target, "HostedZoneId": zone, "EvaluateTargetHealth": False}}


ZONE = [
    rr("example.com.", "NS", "ns-1.awsdns-01.org.", "ns-2.awsdns-02.com.", ttl=172800),
    rr("example.com.", "SOA", "ns-1.awsdns-01.org. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400", ttl=900),
    rr("example.com.", "MX", "10 inbound-smtp.us-east-1.amazonaws.com"),
    rr("example.com.", "TXT", '"v=spf1 include:amazonses.com ~all"', '"site-verification=abc"'),
    rr("example.com.", "A", "203.0.113.10"),
    rr("_dmarc.example.com.", "TXT", '"v=DMARC1;p=reject;rua=mailto:reports@example.com"'),
    rr("mail.example.com.", "MX", "10 feedback-smtp.us-east-1.amazonses.com"),
    rr("mail.example.com.", "TXT", '"v=spf1 include:amazonses.com ~all"'),
    rr("oldtoken1._domainkey.example.com.", "CNAME", "oldtoken1.dkim.amazonses.com"),
    rr("www.example.com.", "CNAME", "example.com"),
    rr("\\052.dev.example.com.", "A", "203.0.113.11"),
    rr("mailbox.example.com.", "MX", "10 mx.elsewhere.example"),
]


def names(changes):
    return [(c["ResourceRecordSet"]["Name"], c["ResourceRecordSet"]["Type"]) for c in changes]


def test_everything_the_stacks_do_not_own_is_copied_unchanged():
    changes, skipped, warnings = zone_copy.plan(ZONE, "Example.COM")
    assert names(changes) == [
        ("example.com.", "TXT"),                                  # the top-level TXT record is the owner's
        ("oldtoken1._domainkey.example.com.", "CNAME"),           # keeps the old account's SES identity verified
        ("www.example.com.", "CNAME"),
        ("\\052.dev.example.com.", "A"),
        ("mailbox.example.com.", "MX"),                          # an MX below the domain is not ours
    ]
    assert all(c["Action"] == "CREATE" for c in changes)
    assert changes[0]["ResourceRecordSet"] == ZONE[3]
    assert sorted((r["Name"], r["Type"]) for r, _ in skipped) == sorted([
        ("example.com.", "NS"), ("example.com.", "SOA"), ("example.com.", "MX"), ("example.com.", "A"),
        ("_dmarc.example.com.", "TXT"), ("mail.example.com.", "MX"), ("mail.example.com.", "TXT"),
    ])
    assert warnings == []


def test_the_site_address_and_another_mail_from_name_on_request():
    changes, skipped, _ = zone_copy.plan(ZONE, "example.com", mail_from="bounce", with_site_address=True)
    copied = names(changes)
    assert ("example.com.", "A") in copied
    assert ("mail.example.com.", "MX") in copied and ("mail.example.com.", "TXT") in copied
    assert ("example.com.", "MX") not in copied and ("example.com.", "NS") not in copied


def test_aliases():
    zone = [
        alias("cdn.example.com.", "A", "d111.cloudfront.net.", "Z2FDTNDATAQYW2"),         # a resource: copied as is
        alias("shop.example.com.", "A", "www.example.com.", OLD),                          # a record of the old zone
        rr("www.example.com.", "A", "203.0.113.10"),
    ]
    changes, _, warnings = zone_copy.plan(zone, "example.com", old_zone=OLD, new_zone=NEW)
    by_name = {c["ResourceRecordSet"]["Name"]: c["ResourceRecordSet"] for c in changes}
    assert by_name["cdn.example.com."]["AliasTarget"]["HostedZoneId"] == "Z2FDTNDATAQYW2"
    assert by_name["shop.example.com."]["AliasTarget"]["HostedZoneId"] == NEW
    assert names(changes)[-1] == ("shop.example.com.", "A"), "an alias to a record of the zone comes after that record"
    assert zone[1]["AliasTarget"]["HostedZoneId"] == OLD, "the input is not modified"
    assert len(warnings) == 1 and "cdn.example.com." in warnings[0]

    # without the zone ids, an alias inside the zone cannot be rewritten: left out, and said so
    changes, _, warnings = zone_copy.plan(zone, "example.com")
    assert ("shop.example.com.", "A") not in names(changes)
    assert any("shop.example.com." in w and "--old-zone" in w for w in warnings)


def test_records_tied_to_the_old_account_are_left_out():
    zone = [
        rr("api.example.com.", "A", "203.0.113.1", SetIdentifier="primary", Failover="PRIMARY", HealthCheckId="abc"),
        {"Name": "tp.example.com.", "Type": "A", "TrafficPolicyInstanceId": "xyz"},
        rr("other.example.org.", "A", "203.0.113.2"),
    ]
    changes, skipped, warnings = zone_copy.plan(zone, "example.com")
    assert changes == [] and len(skipped) == 2
    assert any("other.example.org." in w for w in warnings)


def test_command_line(monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"ResourceRecordSets": ZONE})))
    assert zone_copy.main(["example.com"]) == 0
    out, err = capsys.readouterr()
    batch = json.loads(out)
    assert len(batch["Changes"]) == 5 and "left out" in err and "_dmarc.example.com." in err

    monkeypatch.setattr("sys.stdin", io.StringIO("not json"))
    assert zone_copy.main(["example.com"]) == 2
    assert capsys.readouterr().out == ""


def test_too_many_records_for_one_batch():
    zone = [rr(f"h{i}.example.com.", "A", "203.0.113.1") for i in range(zone_copy.MAX_CHANGES + 1)]
    with pytest.raises(SystemExit):
        zone_copy.plan(zone, "example.com")
