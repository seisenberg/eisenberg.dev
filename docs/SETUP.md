# Setting up eisenmail in a new AWS account

Every action you need to take, in order. Budget about an hour, plus waiting time for DNS and for
AWS to approve sending. Commands assume the AWS CLI is signed in as an administrator of the new
account (AWS CloudShell in the console works well) and that you are in a clone of this repository.

```bash
export AWS_REGION=us-east-1   # SES can receive mail in us-east-1, us-west-2 and eu-west-1 (and a few others)
```

What you end up with:

| Piece | Where it comes from |
| --- | --- |
| Container registry, buckets, IAM roles, GitHub deploy role | `infra/bootstrap.yml`, deployed once by you |
| The database host, its daily snapshots, the backup bucket | `infra/database.yml`, deployed once by you. The host sets itself up with `infra/db-host.sh` |
| The two Lambda functions, HTTPS endpoint, SES receiving rule, reconcile schedule, alarms | `infra/app.yml`, deployed by you |
| Per domain: the DNS zone, the SES identity, the mail records, the site's certificate | `infra/domain.yml`, one stack per domain, deployed by you |
| New code on every push to `main` | `.github/workflows/deploy.yml` |
| Secrets | SSM Parameter Store, never in git. The database host creates the database password and the tunnel key itself. The only one you type in is the optional push key |

---

## 1. Lock down the GitHub repository

Do this before anything else. The repository is public, so its settings are part of the security.

1. **Settings, General.** Under "Pull Requests" allow squash merging only, if you like a linear history.
2. **Settings, Code security.** Switch on: Private vulnerability reporting, Dependency graph,
   Dependabot alerts, Dependabot security updates, Secret scanning, and Push protection.
3. **Settings, Actions, General.**
   - "Fork pull request workflows from outside collaborators": **Require approval for all outside collaborators**.
   - "Workflow permissions": **Read repository contents and packages permissions**, and leave
     "Allow GitHub Actions to create and approve pull requests" off.
4. **Settings, Environments.** Create an environment named `production`.
   - Deployment branches and tags: **Selected branches**, add `main`.
   - Optional but recommended: add yourself as a required reviewer, so every deploy waits for one click.
5. **Settings, Rules, Rulesets.** New branch ruleset for `main`: restrict deletions, block force
   pushes, require a pull request, and require these status checks: `Node (typecheck, API tests, build, browser tests)`,
   `Python (inbox lambda)`, `Container images build`, `Infrastructure templates and scripts lint`.
   (The check names appear in the list after the first workflow run.)
6. Deploy keys: the key that pushes from the development machine should be the only one with
   write access. Remove it when it is no longer needed.

## 2. Prepare the AWS account

1. Sign in as root once: set a strong password, add **MFA**, and do not create root access keys.
2. Create an administrator for daily use through **IAM Identity Center** (or an IAM user with MFA)
   and use that from here on.
3. **Billing, Budgets**: create a monthly cost budget of a few dollars above what "What it costs"
   below predicts, with an email alert. An alert is how you find out if something is wrong.
4. Optional: switch on CloudTrail (the default 90 day event history is already there).

## 3. Deploy the bootstrap stack

```bash
aws cloudformation deploy \
  --stack-name eisenmail-bootstrap \
  --template-file infra/bootstrap.yml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides GitHubRepository=seisenberg/eisenberg.dev SiteOrigins=https://eisenberg.dev
```

```bash
aws cloudformation describe-stacks --stack-name eisenmail-bootstrap --query "Stacks[0].Outputs" --output table
```

Keep the output on screen: you need `DeployRoleArn` next.

## 4. Connect GitHub Actions and build the first images

1. **Settings, Secrets and variables, Actions, Variables tab**, add repository variables
   (these are not secrets):

   | Variable | Value |
   | --- | --- |
   | `AWS_DEPLOY_ROLE_ARN` | the `DeployRoleArn` output |
   | `AWS_REGION` | `us-east-1` (or your region) |

2. **Actions, Deploy, Run workflow** on `main`. If you added a required reviewer, approve it.
   It runs the tests, builds both images and pushes them. The last step prints a notice that the
   functions do not exist yet. That is expected on this first run.

## 5. Database

The system needs one small PostgreSQL. The cheapest arrangement, and the one this project was
designed around, is a tiny EC2 instance reached through an ssh tunnel that can do nothing but
forward to PostgreSQL. `infra/database.yml` creates it, and the machine sets itself up at first
boot. You do not log in to it, copy files to it or create any key.

Size: the default is `t4g.micro` (1 GB of memory). `t4g.nano` (0.5 GB) works for one person's
mail and costs about half. To choose it, add `InstanceType=t4g.nano` to the deploy command below.

1. Find the account's default VPC and one of its subnets. Every subnet of a default VPC is public,
   which is what the instance needs.

   ```bash
   VPC_ID=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query "Vpcs[0].VpcId" --output text)
   ```

   ```bash
   SUBNET_ID=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID Name=default-for-az,Values=true --query "Subnets[0].SubnetId" --output text)
   ```

   ```bash
   echo "$VPC_ID $SUBNET_ID"
   ```

   You should see one `vpc-...` and one `subnet-...`. If the first is `None`, the account has no
   default VPC. Create one with `aws ec2 create-default-vpc` and run the three commands again.

2. Deploy the stack. `GitRef` pins the exact version of `infra/db-host.sh` the machine downloads
   from this public repository and runs at first boot, so the commit must already be pushed to
   GitHub.

   ```bash
   aws cloudformation deploy \
     --stack-name eisenmail-database \
     --template-file infra/database.yml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides VpcId=$VPC_ID SubnetId=$SUBNET_ID GitRef=$(git rev-parse HEAD)
   ```

   If it fails because the instance type is not offered in that subnet's zone, delete the failed
   stack, pick another subnet (`Subnets[1]` in the second command) and deploy again.

3. Tell CloudFormation that it may never replace or delete the machine that holds your mail.
   This matters because the stack looks up the newest Ubuntu image every time it is updated, and
   a newer image would otherwise mean a new, empty machine.

   ```bash
   aws cloudformation set-stack-policy --stack-name eisenmail-database --stack-policy-body '{"Statement":[{"Effect":"Allow","Action":"Update:*","Principal":"*","Resource":"*"},{"Effect":"Deny","Action":["Update:Replace","Update:Delete"],"Principal":"*","Resource":"LogicalResourceId/DatabaseInstance"}]}'
   ```

4. Wait for the machine to finish setting itself up. It takes three to five minutes after the
   stack is done. It is finished when three parameters exist:

   ```bash
   aws ssm get-parameters-by-path --path /eisenmail --query "Parameters[].[Name,Type]" --output table
   ```

   | Name | Type | What it is |
   | --- | --- | --- |
   | `/eisenmail/db_password` | SecureString | the database password, generated on the machine |
   | `/eisenmail/tunnel_key` | SecureString | the private key of the tunnel account, generated on the machine and then erased there |
   | `/eisenmail/tunnel_host_key` | String | the machine's public host key, so the functions only ever talk to this machine |

   The machine also takes its first backup at the end of the setup. This shows its name and size:

   ```bash
   BACKUP_BUCKET=$(aws cloudformation describe-stacks --stack-name eisenmail-database --query "Stacks[0].Outputs[?OutputKey=='BackupBucketName'].OutputValue" --output text)
   ```

   ```bash
   aws s3 cp s3://$BACKUP_BUCKET/db/LATEST -
   ```

   If the parameters have not appeared after ten minutes, read what the machine printed while
   booting. Nothing secret is in that log.

   ```bash
   INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name eisenmail-database --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
   ```

   ```bash
   aws ec2 get-console-output --instance-id $INSTANCE_ID --latest --output text | tail -n 60
   ```

What you have now: PostgreSQL listening on localhost only, an empty database (the web function
creates the tables when it first starts), a `tunnel` account that can only forward a port to
PostgreSQL, automatic security updates, a snapshot of the disk every day, and a database dump in
the backup bucket every night. [BACKUP-AND-MIGRATION.md](BACKUP-AND-MIGRATION.md) explains the
backups and how to restore them.

Alternative: a PostgreSQL that you run yourself (the tests run on version 18; use 18 or later). In step 7 set
`UseDatabaseStack=false`. For a server the functions reach over TLS (for example RDS), set `DbHost`
to its endpoint and keep `DbSslMode=verify-full`. For your own machine behind an ssh tunnel, see
"Running the database on your own hardware" in [BACKUP-AND-MIGRATION.md](BACKUP-AND-MIGRATION.md).
In both cases you store `/eisenmail/db_password` yourself.

## 6. Store the two secrets you create yourself

The database password and the tunnel key are already in SSM Parameter Store. Two secrets are left.

**The vault key.** It encrypts the accounts you keep on the Codes page (the built-in authenticator).
Without it that page is switched off; everything else works.

```bash
aws ssm put-parameter --name /eisenmail/vault_key --type SecureString --value "$(openssl rand -base64 32)"
```

The key exists only in that parameter. A database backup does not contain it, and the codes cannot
be read without it. Save a copy in your password manager now:

```bash
aws ssm get-parameter --name /eisenmail/vault_key --with-decryption --query Parameter.Value --output text
```

**The push key (optional).** Skip this if you do not want notifications on your phone. You can come
back to it later.

```bash
npm ci
```

```bash
npm run push:keys
```

```bash
aws ssm put-parameter --name /eisenmail/vapid_private_key --type SecureString --value '<VAPID_PRIVATE_KEY>'
```

Keep the `VAPID_PUBLIC_KEY` line for step 7. It is not a secret. Then clear your shell history.

## 7. Deploy the application stack

```bash
aws cloudformation deploy \
  --stack-name eisenmail \
  --template-file infra/app.yml \
  --parameter-overrides \
    MailDomains=eisenberg.dev \
    ForwardTo=<your private mailbox> \
    DefaultFrom=<an address you want as the default sender> \
    AlertEmail=<where alarms should be sent> \
    VapidPublicKey=<VAPID_PUBLIC_KEY, or leave this line out>
```

```bash
aws cloudformation describe-stacks --stack-name eisenmail --query "Stacks[0].Outputs" --output table
```

Several domains are a quoted comma list: `MailDomains="eisenberg.dev,example-llc.com"`.

The database address and host key are taken from the database stack. There is nothing to type.

`AlertEmail` switches the alarms on: the inbox function failing or being throttled, the web
function or the site returning errors, the SES bounce or complaint rate getting close to the level
where AWS steps in, and no database backup for 36 hours. AWS sends a message with the subject
"AWS Notification - Subscription Confirmation" to that address. **Click the link in it.** Until
you do, no alarm reaches you. Leave `AlertEmail` out and no alarms are created.

`SiteUrl` is where the site answers right now (a generated `execute-api` address until the domain
moves in step 10). To change any setting later, run the same command with the parameter you want
to change; the others keep their values.

Open `<SiteUrl>/api/health` in a browser. It must show `{"ok":true}`. This first request also
creates the database tables, which step 8 needs.

To use the file drop while the site is still on the temporary address, allow that origin to upload:

```bash
aws cloudformation deploy --stack-name eisenmail-bootstrap --template-file infra/bootstrap.yml \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides SiteOrigins="https://eisenberg.dev,<SiteUrl>"
```

## 8. Create your sign-in

The web user is created from your machine, straight into the database. There is no ssh key for
you on the database host. You reach it through AWS Session Manager, which needs the
[Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
for the AWS CLI on your machine (AWS CloudShell already has it). In one terminal:

```bash
INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name eisenmail-database --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
```

```bash
aws ssm start-session --target $INSTANCE_ID --document-name AWS-StartPortForwardingSession --parameters portNumber=5432,localPortNumber=15432
```

Leave it running. In another terminal, in the repository (after `npm ci`):

```bash
POSTGRES_DB_PASSWORD="$(aws ssm get-parameter --name /eisenmail/db_password --with-decryption --query Parameter.Value --output text)" \
POSTGRES_DB_HOST=127.0.0.1 POSTGRES_DB_PORT=15432 POSTGRES_DB_USER=eisenmail POSTGRES_DB_NAME=emails \
npm run user:set -- <username> --email <your private mailbox>
```

The database password goes from SSM straight into the environment of that one command. It is not
shown and not stored. The command asks for your new sign-in password twice (12 characters or
more). Then stop the first terminal with Ctrl-C.

`--email` switches on the sign-in check from the first sign-in: after the password, a six digit
code is sent to that mailbox and has to be typed in. Use a mailbox outside this system (your
Outlook address), so that the code does not land in the webmail you are trying to open. Two things
to know:

- The code is sent through SES. Until step 9 is done (domain verified, and either production
  access granted or that mailbox verified as a recipient), the mail cannot be delivered and you
  could not sign in. If you want to look around before step 9, leave `--email` out now and switch
  the check on later under **Security and people**, which confirms the mailbox with a test code.
- The address is stored in the database only. Do not put it in the repository.

Open `SiteUrl`, go to `/mail` and sign in. Then do three things right away:

1. Accept the offer to **add a passkey** that appears after the first sign-in (or later: account
   menu, **Security and people**). From then on that device signs in with Touch ID, Face ID or
   its PIN, without password or code. Do this again after step 10: a passkey belongs to the
   site's address, so one made on the temporary address stops working when the domain moves.
   Repeat on each device you use.
2. Account menu, **Security and people**: save the recovery route you prefer. Either keep the
   email check, or switch on an authenticator app with recovery codes, which then replaces the
   emailed code. Do not keep that authenticator entry only on this site's own Codes page: you
   would need to be signed in to read it.
3. Account menu, **Mail settings**: create a delivery rule for the address
   `dmarc@<your domain>` with **Forward** off and **Notify** off (one rule per domain).
   Step 9 publishes that address as the place where other mail providers send their daily DMARC
   reports. The rule keeps those machine-made reports in the webmail, where you can look at them
   when you want, and out of your private mailbox and your phone's notifications.

## 9. DNS and mail for each domain

One stack per domain does it all: `infra/domain.yml` creates the Route 53 hosted zone, the SES
identity that lets this account receive and send for the domain, and the DNS records mail needs
(DKIM, the MX record, the custom MAIL FROM records, DMARC).

**Is the domain in use somewhere already** (mail or DNS in another AWS account, or at another
provider)? Then follow [MOVING-FROM-ANOTHER-ACCOUNT.md](MOVING-FROM-ANOTHER-ACCOUNT.md) instead of
items 1 and 2 below. It uses the same stack, in an order that does not lose mail.

For **each** domain in `MailDomains`:

1. Deploy its stack. The stack name is the domain with dashes:

   ```bash
   aws cloudformation deploy --stack-name eisenmail-domain-eisenberg-dev --template-file infra/domain.yml \
     --parameter-overrides DomainName=eisenberg.dev
   ```

   ```bash
   aws cloudformation describe-stacks --stack-name eisenmail-domain-eisenberg-dev --query "Stacks[0].Outputs" --output table
   ```

2. At the registrar where the domain was bought, replace the domain's name servers with the four
   in the `NameServers` output. For GoDaddy the clicks are in
   [MOVING-FROM-ANOTHER-ACCOUNT.md](MOVING-FROM-ANOTHER-ACCOUNT.md#5-switch-the-name-servers-at-godaddy).
   This is the moment the domain starts using this zone; it can take an hour or two to be seen
   everywhere. SES then finds its records and verifies the domain by itself:

   ```bash
   aws sesv2 get-email-identity --email-identity eisenberg.dev --query "[VerifiedForSendingStatus, DkimAttributes.Status]"
   ```

   It is ready when that prints `true` and `SUCCESS`.

Then, once for the account:

3. Activate the receiving rule set (CloudFormation cannot do this):

   ```bash
   aws ses set-active-receipt-rule-set --rule-set-name eisenmail
   ```

4. Request production access. Until it is granted, SES only sends to verified addresses and at
   most 200 messages a day. In the **SES console, Account dashboard, Request production access**,
   or from the command line:

   ```bash
   aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL \
     --website-url https://eisenberg.dev --contact-language EN \
     --use-case-description "Personal mail for my own domains. Incoming mail is forwarded to my own mailbox, and I reply to people who wrote to me first. No marketing or bulk mail. Bounces and complaints are monitored with CloudWatch alarms."
   ```

   AWS answers by email, usually within a day. To use the system meanwhile, verify your private
   mailbox as an identity (AWS sends it a link to click):

   ```bash
   aws sesv2 create-email-identity --email-identity <your private mailbox>
   ```

Adding a domain later: deploy a stack for it (item 1), switch its name servers (item 2), add it
to `MailDomains` (step 7 command), and create its `dmarc@` delivery rule (step 8).

What the stack leaves alone: the TXT record at the top of the domain, and every record you add
to the zone yourself. Options: `ReceiveMail=false` (no MX record: the domain only sends),
`DmarcPolicy=none|quarantine|reject` (default `quarantine`), `MailFromSubdomain` (default `mail`).

<details>
<summary>The domain's DNS stays somewhere else (no Route 53)</summary>

Skip the stack and do by hand what it does. Create the identity and read its DKIM tokens:

```bash
aws sesv2 create-email-identity --email-identity eisenberg.dev
```

```bash
aws sesv2 get-email-identity --email-identity eisenberg.dev --query "DkimAttributes.Tokens"
```

```bash
aws sesv2 put-email-identity-mail-from-attributes --email-identity eisenberg.dev --mail-from-domain mail.eisenberg.dev
```

Add these records at the DNS provider (use your region in the two host names):

| Type | Name | Value | Purpose |
| --- | --- | --- | --- |
| CNAME | `<token>._domainkey` (three of them) | `<token>.dkim.amazonses.com` | DKIM signing, and proof of ownership |
| MX | `@` | `10 inbound-smtp.us-east-1.amazonaws.com` | receive mail (this moves the domain's mail here: add it last) |
| MX | `mail` | `10 feedback-smtp.us-east-1.amazonses.com` | custom MAIL FROM |
| TXT | `mail` | `v=spf1 include:amazonses.com ~all` | SPF for the MAIL FROM domain |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@eisenberg.dev` | DMARC |

For the site (step 10), request the certificate yourself with
`aws acm request-certificate --domain-name eisenberg.dev --subject-alternative-names www.eisenberg.dev --validation-method DNS`,
add the CNAMEs that `aws acm describe-certificate` shows, and point the domain at the `DnsTarget`
output of the application stack (ALIAS/ANAME at the top of a domain, CNAME for a subdomain) and
`www` at its `WwwDnsTarget` output (a CNAME).

</details>

## 10. Move the site to its domain

Do this once the registrar points at the zone (step 9, item 2): the certificate is validated
through DNS, and `.dev` domains are only ever reached over HTTPS.

1. Add the certificate to the domain's stack (it covers the domain and its `www` name). The
   command returns when it has been issued, usually within a few minutes:

   ```bash
   aws cloudformation deploy --stack-name eisenmail-domain-eisenberg-dev --template-file infra/domain.yml \
     --parameter-overrides Certificate=true
   ```

2. Give the application stack the domain, the certificate and the zone. It creates the record
   that points the domain at the site:

   ```bash
   DOMAIN_STACK=eisenmail-domain-eisenberg-dev
   ```

   ```bash
   aws cloudformation deploy --stack-name eisenmail --template-file infra/app.yml \
     --parameter-overrides DomainName=eisenberg.dev \
       CertificateArn=$(aws cloudformation describe-stacks --stack-name $DOMAIN_STACK --query "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue" --output text) \
       HostedZoneId=$(aws cloudformation describe-stacks --stack-name $DOMAIN_STACK --query "Stacks[0].Outputs[?OutputKey=='HostedZoneId'].OutputValue" --output text)
   ```

3. Allow the new address to upload to the file drop:

   ```bash
   aws cloudformation deploy --stack-name eisenmail-bootstrap --template-file infra/bootstrap.yml \
     --capabilities CAPABILITY_NAMED_IAM --parameter-overrides SiteOrigins="https://eisenberg.dev"
   ```

4. Open `https://eisenberg.dev/api/health`, and `https://www.eisenberg.dev/`, which must land
   on the bare domain. Then add your passkeys again: a passkey belongs to
   the site's address, so one made on the temporary address does not work here.

`www.eisenberg.dev` works too: the certificate covers it, the application stack creates its
record, and the site answers there with a permanent redirect to `https://eisenberg.dev`, keeping
the path. The site itself lives on one name, because sign-ins and passkeys belong to one address.
If `DomainName` is a subdomain (`mail.example.com`), add `WwwRedirect=false` to the command in
item 2.

## 11. Phone

Open `https://eisenberg.dev/mail` on the phone, sign in, add it to the home screen, open it from
there, then account menu, **Mail settings**, **Turn on notifications**, **Send a test
notification**. Details are in the README under "On your phone".

On the phone the bar at the bottom switches between **Mail**, **Files**, **Codes** and
**Account**. Files has a **Photo** button that opens the camera and stores the picture at once.
Codes has **Add account**, which opens the camera to photograph the QR code another site shows
when you set up two-factor there.

## 12. Check that it works

- [ ] `https://<site>/` shows the portfolio and `/mail` asks for a sign-in.
- [ ] Mail sent from another account to `anything@<domain>` appears in the webmail within a minute
      and, if that address forwards, in your private mailbox.
- [ ] Replying to the forward from your private mailbox reaches the sender from the alias address.
      Look at the received message's headers: your private address must not appear.
- [ ] A message sent from the webmail arrives and passes SPF, DKIM and DMARC (check the headers).
- [ ] A file uploaded to the file drop downloads again, and its public link works only while the
      switch is on.
- [ ] Signing in with the password asks for the code from your private mailbox, and signing in
      with the passkey asks for neither.
- [ ] The Codes page lets you add an account. If it says the vault key is missing, step 6 was
      skipped (the page picks the key up within a minute, no redeploy needed).
- [ ] **Security and people** shows your real IP address under "Signed-in devices". If it shows an AWS
      address, `TrustedProxyHops` is wrong.
- [ ] `aws logs tail /aws/lambda/eisenmail-inbox --since 1h` shows no errors. The function
      running every 15 minutes without any mail arriving is normal: that is the reconcile run.
- [ ] You clicked the link in the alarm confirmation mail (step 7). The subscription shows as
      confirmed in the SNS console under the topic `eisenmail-alerts`.
- [ ] The rule for `dmarc@<domain>` exists with Forward and Notify off (step 8).
- [ ] `aws s3 cp s3://$BACKUP_BUCKET/db/LATEST -` names a database dump from the last day.
- [ ] You ran the restore drill in [BACKUP-AND-MIGRATION.md](BACKUP-AND-MIGRATION.md) once.

## Day to day

| Task | How |
| --- | --- |
| Ship a change | merge to `main`. The Deploy workflow updates the web function, checks that it answers (which also applies any database schema change), then updates the inbox function |
| Change a setting | rerun the step 7 command with the changed parameter |
| Get a shell on the database host | `aws ssm start-session --target $INSTANCE_ID` (find `INSTANCE_ID` as in step 8). You are `ssm-user` and can use `sudo` |
| Rotate the database password | in that shell: `sudo ROTATE_DB_PASSWORD=1 /usr/local/sbin/eisenmail-db-host`. It stores the new password in SSM. The functions notice the old one is refused and read the new one |
| Rotate the tunnel key | in that shell: `sudo ROTATE_TUNNEL_KEY=1 /usr/local/sbin/eisenmail-db-host`. Then rerun the Deploy workflow, so both functions start fresh and read the new key |
| Forward an address to other people | account menu, **Mail settings**, the menu on the address, **Forward to other mailboxes**. Until SES production access is granted (step 9), each such mailbox must be verified as an identity like your own, or the forward fails |
| Reset your sign-in | step 8 again, with `--email` as before. It also signs out every device, removes passkeys and switches two-factor off |
| Locked out because the sign-in code does not arrive | step 8 again without `--email`: that switches the email check off. Sign in, then switch it on again under **Security and people** |
| Database backups | automatic: a disk snapshot every day (kept 7 days) and a dump in S3 every night (kept 90 days). `aws s3 cp s3://$BACKUP_BUCKET/db/LATEST -` shows the newest. The alarm tells you if one is missed |
| Restore, or test a restore | [BACKUP-AND-MIGRATION.md](BACKUP-AND-MIGRATION.md). Run the drill there once after setup |
| Resize the database host, grow its disk | [BACKUP-AND-MIGRATION.md](BACKUP-AND-MIGRATION.md), "Changing the database host" |
| Operating system updates on the database host | automatic (security updates daily, with a reboot at 09:00 UTC when one is needed). Mail that arrives during a reboot is picked up afterwards by Lambda's retries and the reconcile run |
| Roll back | **Actions, Deploy**, rerun the workflow on the earlier commit |

## What it costs

At list prices in us-east-1, for one person's mail, roughly 12 US dollars a month with the default
`t4g.micro`, or 9 with `t4g.nano`:

| Item | About, per month |
| --- | --- |
| EC2 instance | `t4g.micro` 6.10, `t4g.nano` 3.10 |
| Its 20 GB disk | 1.60 |
| Its public IPv4 address | 3.65 |
| Disk snapshots (7 days, only changed blocks are stored) and database dumps in S3 (90 days) | well under 1.00 |
| Alarms and the one custom metric | 0 to 1.00 |
| Route 53 hosted zone | 0.50 per domain |
| Lambda, API Gateway, S3, SES, the 15 minute schedule | cents at personal volume |

A new account may also get free tier credits that cover part of this. There is no NAT gateway,
load balancer or managed database in this design. The instance runs with standard CPU credits, so
a busy hour slows it down instead of adding to the bill.

## Removing everything

Deactivate receiving and delete the application stack:

```bash
aws ses set-active-receipt-rule-set
```

```bash
aws cloudformation delete-stack --stack-name eisenmail
```

Copy off anything you want to keep first ([BACKUP-AND-MIGRATION.md](BACKUP-AND-MIGRATION.md)).
The database host is protected against termination. Lift that (find `INSTANCE_ID` as in step 8),
then delete its stack. Its disk is deleted with it.

```bash
aws ec2 modify-instance-attribute --instance-id $INSTANCE_ID --no-disable-api-termination
```

```bash
aws cloudformation delete-stack --stack-name eisenmail-database
```

```bash
aws cloudformation delete-stack --stack-name eisenmail-bootstrap
```

Each domain stack (`eisenmail-domain-...`) can be deleted the same way. Its hosted zone and its
SES identity are kept on purpose: deleting the zone takes the domain off the internet until the
registrar points somewhere else. Delete them by hand once the domain has moved away.

What is left on purpose, for you to delete by hand when you are sure: the four buckets (mail,
files, public files, backups), the disk snapshots, and the parameters under `/eisenmail/` in SSM
Parameter Store.
