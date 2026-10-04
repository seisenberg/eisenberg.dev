# Moving a domain that is already in use

For a domain whose mail and DNS work today in another AWS account, and should move to the account
this project runs in. The domain is registered at GoDaddy; its DNS is a Route 53 hosted zone in
the old account. The same order works for DNS hosted elsewhere, with the differences noted.

The one moment that matters is **changing the name servers at GoDaddy** (step 5). Before it,
nothing you do in the new account is visible to anyone. After it, the world uses the new zone.
So everything before step 5 is preparation you can take your time over and check.

What to expect:

- No mail is lost if you follow the order. Mail servers retry for days, and both accounts can
  receive during the change.
- The site at the domain (and at `www`) is unreachable from step 5 until step 6 is done (a few minutes of work,
  after the name servers have been picked up). Step 3 has an option that keeps the old site up
  in between.
- Mail the OLD system stored is not moved by these steps. It stays in the old account until you
  export it.

You need the AWS CLI signed in to both accounts. The commands below use two named profiles,
`old` and `new`. With AWS CloudShell instead, run each command in the CloudShell of the account
it names and leave `--profile` out; step 3 then moves one file from one to the other
(Actions, Download file / Upload file).

```bash
export AWS_REGION=us-east-1
DOMAIN=eisenberg.dev
STACK=eisenmail-domain-eisenberg-dev
```

## 0. Before you start

1. [SETUP.md](SETUP.md) steps 1 to 8 are done in the new account: the site answers on its
   temporary address and you can sign in.
2. Ask for SES production access in the new account now (SETUP.md step 9, item 4). It takes
   about a day, and until it is granted the new account cannot send to people.
3. Look at what the domain publishes today. Keep this output: it is what must still be true at
   the end.

   ```bash
   for type in NS MX TXT A DS; do echo "== $type"; dig +short $type $DOMAIN; done; echo "== DMARC"; dig +short TXT _dmarc.$DOMAIN
   ```

   - `NS` ending in `awsdns-...`: the DNS is in Route 53, as this guide assumes. Ending in
     `domaincontrol.com`: it is GoDaddy's own DNS; see the note in step 3.
   - `MX` names the SES region the old system receives in. If it is the same region as the new
     account, the record does not even change.
   - `DS` must be empty. If it prints anything, DNSSEC is on: switch it off at GoDaddy and wait
     a day before step 5, or the domain stops resolving when the name servers change.
   - `DMARC` shows the policy (`p=`) the domain has now. Keep it in step 1.

## 1. Create the zone and the mail setup in the new account

Use the DMARC policy the domain already has (`reject` in this example). Starting with a weaker
one is safe; a stricter one than today is not something to try during a move.

```bash
aws cloudformation deploy --profile new --stack-name $STACK --template-file infra/domain.yml \
  --parameter-overrides DomainName=$DOMAIN DmarcPolicy=reject
```

```bash
NEW_ZONE=$(aws cloudformation describe-stacks --profile new --stack-name $STACK --query "Stacks[0].Outputs[?OutputKey=='HostedZoneId'].OutputValue" --output text)
```

The zone now holds the records mail needs. Nobody uses it yet.

Add the domain to the application stack and activate receiving, if you have not yet
(SETUP.md step 7 with `MailDomains=...`, and step 9 item 3).

## 2. Let the new account prove it owns the domain, ahead of time

SES accepts and sends mail for a domain only after it has found the domain's DKIM records in
public DNS. Public DNS is still the old zone, so put the new account's three DKIM records there
too. They sit next to the old account's records and do not disturb them.

```bash
OLD_ZONE=$(aws route53 list-hosted-zones-by-name --profile old --dns-name $DOMAIN --query "HostedZones[0].Id" --output text)
```

```bash
for token in $(aws sesv2 get-email-identity --profile new --email-identity $DOMAIN --query "DkimAttributes.Tokens" --output text); do
  aws route53 change-resource-record-sets --profile old --hosted-zone-id $OLD_ZONE --change-batch \
    "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$token._domainkey.$DOMAIN\",\"Type\":\"CNAME\",\"TTL\":1800,\"ResourceRecords\":[{\"Value\":\"$token.dkim.amazonses.com\"}]}}]}"
done
```

Wait until this prints `true` and `SUCCESS` (minutes, sometimes an hour):

```bash
aws sesv2 get-email-identity --profile new --email-identity $DOMAIN --query "[VerifiedForSendingStatus, DkimAttributes.Status]"
```

Skipping this step is possible. The new account then verifies only some time after step 5, and
mail that arrives in that gap is turned away and retried later by its sender.

## 3. Copy the other records of the old zone

Everything else the old zone holds (site verifications, other host names, the old account's own
DKIM records) has to exist in the new zone before the switch. `infra/zone_copy.py` turns a
listing of the old zone into a change for the new one. It only reads and writes files, and it
prints what it copies and what it leaves out, and why.

```bash
aws route53 list-resource-record-sets --profile old --hosted-zone-id $OLD_ZONE > old-zone.json
```

```bash
python3 infra/zone_copy.py $DOMAIN --old-zone ${OLD_ZONE##*/} --new-zone $NEW_ZONE < old-zone.json > changes.json
```

Read the list it printed. Then apply it:

```bash
aws route53 change-resource-record-sets --profile new --hosted-zone-id $NEW_ZONE --change-batch file://changes.json
```

Left out on purpose: the records the new stacks create themselves (the domain's MX record,
`_dmarc`, the `mail.` records) and the address of the old site, for the domain and for `www`.

- **Keeping the old site reachable until the new one is live:** add `--with-site-address` to the
  `zone_copy.py` command. Then, just before step 6 item 1, delete the address records of the
  domain and of `www` from the new zone in the Route 53 console, because the application stack
  creates its own.
- **`www`:** nothing to do. The new site answers on `www.` as well, with a redirect to the bare
  domain, and the application stack creates that record in step 6.
- **DNS at GoDaddy instead of Route 53:** export the zone file there (DNS, Actions, Export zone
  file), remove the lines for the domain's own `MX`, `_dmarc`, `mail` and (unless you want the
  old site kept) the `A` and `www` records, and import the rest in the Route 53 console (the new zone, Import
  zone file).

## 4. Check the new zone before anyone uses it

Ask one of the new zone's name servers directly and compare with what you noted in step 0:

```bash
NS1=$(aws route53 get-hosted-zone --profile new --id $NEW_ZONE --query "DelegationSet.NameServers[0]" --output text)
```

```bash
for type in MX TXT; do echo "== $type"; dig +short $type $DOMAIN @$NS1; done; echo "== DMARC"; dig +short TXT _dmarc.$DOMAIN @$NS1; echo "== MAIL FROM"; dig +short MX mail.$DOMAIN @$NS1
```

`MX` must name `inbound-smtp.<region of the new account>.amazonaws.com`, `TXT` must show the same
SPF line as before, and DMARC the same policy.

## 5. Switch the name servers at GoDaddy

Print the four names:

```bash
aws cloudformation describe-stacks --profile new --stack-name $STACK --query "Stacks[0].Outputs[?OutputKey=='NameServers'].OutputValue" --output text
```

At GoDaddy:

1. Sign in, open **My Products**, and next to the domain choose **DNS** (or the domain, then
   **Manage DNS**).
2. Open the **Nameservers** tab and choose **Change Nameservers**.
3. Choose **I'll use my own nameservers**.
4. Replace the names that are there with the four from above, one per field, without a dot at
   the end. Add fields until there are four.
5. **Save**, and confirm the warning. If the domain has ownership protection, GoDaddy asks for a
   code first.

GoDaddy's pages change now and then; the wording may differ slightly. Do not touch anything
else there: the domain stays registered at GoDaddy, only its DNS moves.

Then wait. Most of the world sees the change within an hour or two, the rest within two days.
Until then some senders still use the old zone, which is why it must stay as it is for now.

```bash
dig +short NS $DOMAIN
```

When that prints the four new names, your own network has picked it up.

## 6. Finish in the new account

1. The site's certificate and address: SETUP.md step 10.
2. Send a message to an address at the domain from an outside mailbox, and send one out from
   the webmail. Then go through the checklist in SETUP.md step 12.

## 7. Switch the old system off

While both accounts have the domain verified and a receiving rule active in the same region,
each of them may handle an incoming message (AWS does not document which one does). The sign is
a forward arriving twice, once from each system. So, as soon as the new system has received and
forwarded its first message, stop the old one receiving:

```bash
aws ses set-active-receipt-rule-set --profile old
```

(Without a name, that command deactivates the active rule set. Nothing is deleted.)

If the old system received in a **different region**, the `MX` record changed at step 5, and
mail simply stops arriving there as the change spreads. Deactivate its rule set all the same,
after two days.

## 8. Clean up, after a week

Not before: a week leaves time to notice anything that was only in the old account.

1. Export anything you still want from the old account (its stored mail, its database).
2. Old account: delete the SES identity of the domain, then the old hosted zone (it costs half a
   dollar a month and nobody asks it anything once step 5 has spread).
3. New zone: delete the old account's three `..._domainkey` records that step 3 copied. They are
   the ones whose names are not in the output of:

   ```bash
   aws sesv2 get-email-identity --profile new --email-identity $DOMAIN --query "DkimAttributes.Tokens"
   ```

## If something goes wrong

- **The site or mail misbehaves right after step 5:** put the old four name servers back at
  GoDaddy. The old zone and the old system are untouched until steps 7 and 8, so this undoes the
  move. The old names are in the `NS` output you kept in step 0.
- **Mail arrives in the old system but not the new one:** the new identity is not verified
  (step 2), the domain is missing from `MailDomains`, or the rule set is not active
  (SETUP.md step 9, item 3).
- **The certificate stays "pending":** the name servers have not been picked up yet (`dig +short NS`),
  or a `CAA` record copied from the old zone does not allow Amazon to issue. In that case add
  `0 issue "amazon.com"` to it.
