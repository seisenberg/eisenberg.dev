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
| The two Lambda functions, HTTPS endpoint, SES receiving rule | `infra/app.yml`, deployed by you |
| New code on every push to `main` | `.github/workflows/deploy.yml` |
| Secrets (database password, tunnel key, push key) | SSM Parameter Store, typed in by you, never in git |

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
   `Python (inbox lambda)`, `Container images build`, `CloudFormation templates lint`.
   (The check names appear in the list after the first workflow run.)
6. Deploy keys: the key that pushes from the development machine should be the only one with
   write access. Remove it when it is no longer needed.

## 2. Prepare the AWS account

1. Sign in as root once: set a strong password, add **MFA**, and do not create root access keys.
2. Create an administrator for daily use through **IAM Identity Center** (or an IAM user with MFA)
   and use that from here on.
3. **Billing, Budgets**: create a monthly cost budget of a few dollars with an email alert. This
   system should cost little; an alert is how you find out if something is wrong.
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
forward to PostgreSQL.

1. Create the tunnel key pair **on your own machine** (not on the server):

   ```bash
   ssh-keygen -t ed25519 -N "" -C eisenmail-tunnel -f ./eisenmail_tunnel
   ```

2. Launch an instance: Ubuntu Server 24.04, `t4g.micro` (or `t4g.nano`), 20 GB gp3, in a public
   subnet with a public IPv4 address. Give it an Elastic IP so the address survives a stop/start.
   Security group: inbound TCP 22 from anywhere (Lambda has no fixed addresses; the tunnel account
   is the only way in and it has no shell), nothing else. Use an EC2 key pair or Session Manager
   for your own administrative access.
3. Copy two files to the instance and run the script:

   ```bash
   scp infra/db-host.sh db/schema.sql ubuntu@<instance-address>:
   ssh ubuntu@<instance-address> \
     "sudo TUNNEL_PUBLIC_KEY='$(cat eisenmail_tunnel.pub)' SCHEMA_FILE=schema.sql bash db-host.sh"
   ```

   It installs PostgreSQL (listening on localhost only), creates the database and its role,
   applies the schema, creates the restricted `tunnel` account, switches off password logins, and
   prints two things: the **database password** and the **host key line**. Copy both.

Alternative: any PostgreSQL 14 or later that the functions can reach over TLS (for example RDS).
Leave `TunnelHost` empty in step 7, set `DbHost` to its endpoint and keep `DbSslMode=verify-full`.

## 6. Store the secrets

```bash
aws ssm put-parameter --name /eisenmail/db_password --type SecureString --value '<database password from step 5>'
aws ssm put-parameter --name /eisenmail/tunnel_key  --type SecureString --value "$(cat eisenmail_tunnel)"
```

Push notifications (optional, can be added later):

```bash
npm ci && npm run push:keys
aws ssm put-parameter --name /eisenmail/vapid_private_key --type SecureString --value '<VAPID_PRIVATE_KEY>'
```

Keep the `VAPID_PUBLIC_KEY` line for step 7. Then delete the local key files and clear your
shell history: `rm eisenmail_tunnel eisenmail_tunnel.pub`.

## 7. Deploy the application stack

```bash
aws cloudformation deploy \
  --stack-name eisenmail \
  --template-file infra/app.yml \
  --parameter-overrides \
    MailDomains=eisenberg.dev \
    ForwardTo=<your private mailbox> \
    DefaultFrom=<an address you want as the default sender> \
    TunnelHost=<instance address> \
    TunnelHostKey='<host key line from step 5>' \
    VapidPublicKey=<VAPID_PUBLIC_KEY, or leave this line out>
```

```bash
aws cloudformation describe-stacks --stack-name eisenmail --query "Stacks[0].Outputs" --output table
```

Several domains are a quoted comma list: `MailDomains="eisenberg.dev,example-llc.com"`.

`SiteUrl` is where the site answers right now (a generated `execute-api` address until the domain
moves in step 10). To change any setting later, run the same command with the parameter you want
to change; the others keep their values.

To use the file drop while the site is still on the temporary address, allow that origin to upload:

```bash
aws cloudformation deploy --stack-name eisenmail-bootstrap --template-file infra/bootstrap.yml \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides SiteOrigins="https://eisenberg.dev,<SiteUrl>"
```

## 8. Create your sign-in

The web user is created from your machine through the same tunnel the functions use. In one
terminal:

```bash
ssh -i <your admin key> -N -L 15432:127.0.0.1:5432 ubuntu@<instance address>
```

In another:

```bash
POSTGRES_DB_HOST=127.0.0.1 POSTGRES_DB_PORT=15432 POSTGRES_DB_USER=eisenmail \
POSTGRES_DB_NAME=emails POSTGRES_DB_PASSWORD='<database password>' \
npm run user:set -- <username>
```

It asks for the password twice (12 characters or more). Open `SiteUrl`, go to `/mail`, sign in,
then open the account menu, **Security settings**, and switch on two-factor authentication.

## 9. Mail: SES identities, DNS, receiving, sending

For **each** domain in `MailDomains`:

1. Create the identity and read its DKIM tokens:

   ```bash
   aws sesv2 create-email-identity --email-identity eisenberg.dev
   aws sesv2 get-email-identity --email-identity eisenberg.dev --query "DkimAttributes.Tokens"
   aws sesv2 put-email-identity-mail-from-attributes --email-identity eisenberg.dev --mail-from-domain mail.eisenberg.dev
   ```

2. Add these DNS records at the domain's DNS provider:

   | Type | Name | Value | Purpose |
   | --- | --- | --- | --- |
   | CNAME | `<token>._domainkey` (three of them) | `<token>.dkim.amazonses.com` | DKIM signing |
   | MX | `@` | `10 inbound-smtp.us-east-1.amazonaws.com` | receive mail (this moves the domain's mail here) |
   | MX | `mail` | `10 feedback-smtp.us-east-1.amazonses.com` | custom MAIL FROM |
   | TXT | `mail` | `v=spf1 include:amazonses.com ~all` | SPF for the MAIL FROM domain |
   | TXT | `@` | `v=spf1 include:amazonses.com ~all` | SPF |
   | TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@eisenberg.dev` | DMARC |

   Use your region in the two host names. The `@` MX record is the switch that actually moves a
   domain's mail to this system, so add it last, when you are ready.

Then, once for the account:

3. Activate the receiving rule set (CloudFormation cannot do this):

   ```bash
   aws ses set-active-receipt-rule-set --rule-set-name eisenmail
   ```

4. Request production access: **SES console, Account dashboard, Request production access**
   (mail type: transactional; describe it as personal mail for your own domains with replies to
   people who wrote to you). Until it is granted, SES only sends to verified addresses. To use the
   system meanwhile, verify your private mailbox as an identity:
   `aws sesv2 create-email-identity --email-identity <your private mailbox>`.

Adding a domain later: add it to `MailDomains` (step 7 command), then repeat 1 and 2 for it.

## 10. Move the site to its domain

1. Request a certificate **in the same region as the stack**:

   ```bash
   aws acm request-certificate --domain-name eisenberg.dev --validation-method DNS
   ```

   Add the CNAME that `aws acm describe-certificate --certificate-arn <arn>` shows, and wait for
   the status `ISSUED`.
2. Update the stack:

   ```bash
   aws cloudformation deploy --stack-name eisenmail --template-file infra/app.yml \
     --parameter-overrides DomainName=eisenberg.dev CertificateArn=<certificate arn>
   ```

3. Point the domain at the `DnsTarget` output: an ALIAS/ANAME record for the apex (in Route 53,
   an alias A record using `DnsTargetHostedZoneId`), or a CNAME for a subdomain.
4. If the site was used on its temporary address with the file drop, nothing else changes. If you
   serve it on more than one origin, list them all in the bootstrap stack's `SiteOrigins`.

## 11. Phone

Open `https://eisenberg.dev/mail` on the phone, sign in, add it to the home screen, open it from
there, then account menu, **Forwarding & notifications**, **Turn on notifications**, **Send a test
notification**. Details are in the README under "On your phone".

## 12. Check that it works

- [ ] `https://<site>/` shows the portfolio and `/mail` asks for a sign-in.
- [ ] Mail sent from another account to `anything@<domain>` appears in the webmail within a minute
      and, if that address forwards, in your private mailbox.
- [ ] Replying to the forward from your private mailbox reaches the sender from the alias address.
      Look at the received message's headers: your private address must not appear.
- [ ] A message sent from the webmail arrives and passes SPF, DKIM and DMARC (check the headers).
- [ ] A file uploaded to the file drop downloads again, and its public link works only while the
      switch is on.
- [ ] Security settings shows your real IP address under "Signed-in devices". If it shows an AWS
      address, `TrustedProxyHops` is wrong.
- [ ] `aws logs tail /aws/lambda/eisenmail-inbox --since 1h` shows no errors.

## Day to day

| Task | How |
| --- | --- |
| Ship a change | merge to `main`; the Deploy workflow does the rest |
| Change a setting | rerun the step 7 command with the changed parameter |
| Rotate the database password | change it in PostgreSQL, then `aws ssm put-parameter --overwrite ...`; the functions pick it up within minutes |
| Rotate the tunnel key | new key pair, rerun `db-host.sh` with the new public key, overwrite `/eisenmail/tunnel_key` |
| Reset your sign-in | step 8 again (also signs out every device and switches two-factor off) |
| Database backup | snapshot the instance's volume on a schedule (Data Lifecycle Manager), or `pg_dump` to S3 |
| Roll back | **Actions, Deploy**, rerun the workflow on the earlier commit |

## What it costs

Roughly: the EC2 instance and its disk (a few dollars a month), a public IPv4 address, and cents
for Lambda, API Gateway, S3 and SES at personal volume. There is no NAT gateway, load balancer or
managed database in this design.

## Removing everything

```bash
aws ses set-active-receipt-rule-set          # deactivates receiving
aws cloudformation delete-stack --stack-name eisenmail
aws cloudformation delete-stack --stack-name eisenmail-bootstrap   # buckets are kept; empty and delete them by hand
```
