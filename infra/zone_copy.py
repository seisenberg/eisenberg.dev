#!/usr/bin/env python3
"""Copies the records of a Route 53 hosted zone into the zone made by infra/domain.yml.

For a domain whose DNS is moving from another AWS account (docs/MOVING-FROM-ANOTHER-ACCOUNT.md).
It only transforms JSON: it reads what `aws route53 list-resource-record-sets` printed for the
OLD zone and prints a change batch for `aws route53 change-resource-record-sets` on the NEW one.
It never talks to AWS itself, so you can read the result before applying it.

    aws route53 list-resource-record-sets --hosted-zone-id <old zone> --profile <old account> > old-zone.json
    python3 infra/zone_copy.py example.com < old-zone.json > changes.json
    aws route53 change-resource-record-sets --hosted-zone-id <new zone> --change-batch file://changes.json

Left out, because the new zone has its own or the stacks create them:
  - the zone's NS and SOA records
  - the MX record of the domain itself            (infra/domain.yml, ReceiveMail)
  - the _dmarc record                             (infra/domain.yml, DmarcPolicy)
  - the MX and TXT records of the MAIL FROM name  (infra/domain.yml, MailFromSubdomain)
  - the address of the domain itself and of www   (infra/app.yml; --with-site-address copies them)
  - records tied to the old account (health checks, traffic policies)
Everything else is copied as it is, including the TXT record at the top of the domain and the
old account's DKIM records, which keep the old system working until you switch it off.
"""
import argparse
import json
import sys

MAX_CHANGES = 1000  # Route 53's limit for one change batch


def canonical(name: str) -> str:
    """Lower case, with the trailing dot Route 53 uses."""
    name = name.strip().lower()
    return name if name.endswith(".") else name + "."


def values(record: dict) -> str:
    if "AliasTarget" in record:
        return "alias to " + record["AliasTarget"].get("DNSName", "?")
    return ", ".join(r.get("Value", "") for r in record.get("ResourceRecords", []))


def plan(record_sets, domain, mail_from="mail", with_site_address=False, old_zone=None, new_zone=None):
    """Returns (changes, skipped, warnings). `skipped` is a list of (record, reason)."""
    apex = canonical(domain)
    mail_from_name = canonical(f"{mail_from}.{domain}")
    dmarc_name = canonical(f"_dmarc.{domain}")
    changes, skipped, warnings = [], [], []

    for original in record_sets:
        record = json.loads(json.dumps(original))  # a copy we may change
        name, kind = canonical(record.get("Name", "")), record.get("Type", "")
        if not (name == apex or name.endswith("." + apex)):
            warnings.append(f"{name} {kind}: not inside {apex}, left out")
            continue

        reason = None
        if name == apex and kind in ("NS", "SOA"):
            reason = "the new zone has its own"
        elif name == apex and kind == "MX":
            reason = "infra/domain.yml creates the MX record (ReceiveMail)"
        elif name == dmarc_name and kind == "TXT":
            reason = "infra/domain.yml creates it (DmarcPolicy, DmarcReportAddress): keep the same policy"
        elif name == mail_from_name and kind in ("MX", "TXT"):
            reason = "infra/domain.yml creates the MAIL FROM records"
        elif name in (apex, "www." + apex) and kind in ("A", "AAAA", "CNAME") and not with_site_address:
            reason = "infra/app.yml points the domain and www at the new site (--with-site-address copies it)"
        elif record.get("TrafficPolicyInstanceId"):
            reason = "made by a traffic policy of the old account: recreate it by hand if still needed"
        elif record.get("HealthCheckId"):
            reason = "uses a health check of the old account: recreate it by hand if still needed"
        if reason:
            skipped.append((original, reason))
            continue

        if kind == "CAA":
            allowed = " ".join(r.get("Value", "") for r in record.get("ResourceRecords", []))
            if "amazon.com" not in allowed and "amazontrust.com" not in allowed:
                warnings.append(f"{name} CAA: {allowed}. Amazon is not allowed to issue certificates for this name. "
                                "Add the value 0 issue \"amazon.com\" to it (next to the others) before turning the "
                                "certificate on in infra/domain.yml, or the certificate never issues")
        alias = record.get("AliasTarget")
        if alias:
            target = canonical(alias.get("DNSName", ""))
            in_zone = target == apex or target.endswith("." + apex)
            if old_zone and alias.get("HostedZoneId") == old_zone:
                if not new_zone:
                    warnings.append(f"{name} {kind}: alias to a record of the old zone; give --new-zone so it can point at the new one. Left out")
                    continue
                alias["HostedZoneId"] = new_zone
            elif in_zone and not old_zone:
                warnings.append(f"{name} {kind}: alias to {target}, a name in this zone; give --old-zone and --new-zone so it can be rewritten. Left out")
                continue
            elif not in_zone:
                warnings.append(f"{name} {kind}: alias to {target}. It is copied, and keeps pointing at that resource wherever it lives")
        changes.append({"Action": "CREATE", "ResourceRecordSet": record})

    # An alias to a record of the zone must come after the record it points at.
    changes.sort(key=lambda change: "AliasTarget" in change["ResourceRecordSet"]
                 and change["ResourceRecordSet"]["AliasTarget"].get("HostedZoneId") == new_zone)
    if len(changes) > MAX_CHANGES:
        raise SystemExit(f"{len(changes)} records: more than one change batch can hold ({MAX_CHANGES}). Split the input.")
    return changes, skipped, warnings


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("domain", help="the domain of the zone, for example example.com")
    parser.add_argument("--mail-from", default="mail", help="MailFromSubdomain of the domain stack (default: mail)")
    parser.add_argument("--with-site-address", action="store_true",
                        help="also copy the address records of the domain itself and of www (the old site stays "
                             "reachable; delete them before infra/app.yml is given the HostedZoneId)")
    parser.add_argument("--old-zone", help="id of the old zone, to rewrite aliases that point at its own records")
    parser.add_argument("--new-zone", help="id of the new zone (with --old-zone)")
    args = parser.parse_args(argv)

    try:
        listing = json.load(sys.stdin)
        record_sets = listing["ResourceRecordSets"]
    except (ValueError, KeyError, TypeError):
        print("The input is not the JSON output of `aws route53 list-resource-record-sets`.", file=sys.stderr)
        return 2

    changes, skipped, warnings = plan(record_sets, args.domain, args.mail_from, args.with_site_address,
                                      args.old_zone, args.new_zone)
    say = lambda line="": print(line, file=sys.stderr)  # noqa: E731
    say(f"{len(changes)} record(s) to copy:")
    for change in changes:
        record = change["ResourceRecordSet"]
        say(f"  {record['Name']} {record['Type']}  {values(record)[:90]}")
    say(f"\n{len(skipped)} left out:")
    for record, reason in skipped:
        say(f"  {record['Name']} {record['Type']}  {values(record)[:70]}\n      {reason}")
    if warnings:
        say("\nLook at these:")
        for warning in warnings:
            say(f"  {warning}")
    if not changes:
        say("\nNothing to copy.")
        return 0
    json.dump({"Comment": f"copied from the old zone of {args.domain}", "Changes": changes}, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
