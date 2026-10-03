# Backups, restoring, and leaving AWS

What is saved where, how to get it back, and what it would take to run this system somewhere
else. The commands assume the AWS CLI is signed in as an administrator, as in
[SETUP.md](SETUP.md), and use these three values:

```bash
INSTANCE_ID=$(aws cloudformation describe-stacks --stack-name eisenmail-database --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
```

```bash
BACKUP_BUCKET=$(aws cloudformation describe-stacks --stack-name eisenmail-database --query "Stacks[0].Outputs[?OutputKey=='BackupBucketName'].OutputValue" --output text)
```

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
```

How far these instructions have been tested: the dump and restore commands were run on
Ubuntu 24.04 with PostgreSQL 16, exactly as written here. The commands that talk to AWS
(snapshots, replacing a disk, Session Manager) follow the AWS documentation but were written
without an AWS account to try them in. The restore drill at the end is how you find out that
they work for you, before the day you need them.

## What is backed up, and where

| What | Where | How often, how long | Good for |
| --- | --- | --- | --- |
| The database (all mail, rules, settings, your sign-in) | Dumps in `s3://eisenmail-backups-<account>/db/` | every night at 03:17 UTC, kept 90 days | restoring anywhere, on AWS or not. This is the copy that lets you leave |
| The same dumps | `/var/backups/eisenmail/` on the database host | the 3 newest | a quick restore without downloading anything |
| The whole disk of the database host | EBS snapshots | every day at about 05:00 UTC, kept 7 days | getting the machine back as it was, fast. Only usable inside AWS |
| File drop | `eisenmail-files-<account>` and `eisenmail-public-files-<account>` | the private bucket keeps deleted and replaced files for 30 more days | undoing an accidental delete |
| Raw incoming mail, as SES received it | `eisenmail-mail-<account>` | 30 days | replaying mail the database missed (the reconcile run does this by itself) |

Details worth knowing:

- A dump is made with `pg_dump` in PostgreSQL's custom format. Before it is uploaded the host
  checks that `pg_restore` can read it. A dump that fails the check is not uploaded and the
  backup counts as failed.
- `db/LATEST` in the backup bucket is one line: the name and the size of the newest dump.
- The database host can add files to the backup bucket. It cannot read them, change them or
  delete them. If the host were broken into, the backups made before that stay intact. The bucket
  also keeps the earlier version of any file that is written again, for 30 days.
- A snapshot is taken while PostgreSQL is running. PostgreSQL recovers from such a copy the same
  way it recovers from a power cut. That is reliable, but it is one more reason the dump exists.
- Secrets (the database password, the tunnel key, the push key) are in SSM Parameter Store and
  are not backed up. They do not need to be: the database password and the tunnel key can be made
  new at any time (SETUP.md, "Day to day"). If the push key is lost, create a new one and switch
  notifications on again on each device.
- The settings of the system are the parameters of the three CloudFormation stacks.

## Checking that backups happen

If you set `AlertEmail`, the alarm `eisenmail-no-database-backup` sends you a message when no
dump has reached the bucket for 36 hours. To look yourself:

```bash
aws s3 cp s3://$BACKUP_BUCKET/db/LATEST -
```

```bash
aws s3 ls s3://$BACKUP_BUCKET/db/ | tail -n 5
```

```bash
aws ec2 describe-snapshots --owner-ids self --filters Name=tag:eisenmail-snapshot,Values=daily --query "sort_by(Snapshots,&StartTime)[].[StartTime,SnapshotId,State]" --output table
```

On the host itself (`aws ssm start-session --target $INSTANCE_ID`):

```bash
systemctl list-timers eisenmail-backup.timer
```

```bash
journalctl -u eisenmail-backup -n 20
```

To take a backup right now, for example before a risky change:

```bash
sudo systemctl start eisenmail-backup
```

## Restoring

Pick the smallest tool that fixes the problem.

| What happened | Use |
| --- | --- |
| Data was deleted or damaged, the machine is fine | A. Restore a dump into the running database |
| The machine does not boot or its disk is damaged | B. Put yesterday's snapshot back |
| You want a fresh machine, or the snapshots are gone too | C. New disk from a clean image, then restore a dump |

After any restore the database is as old as the backup you used. Mail that arrived since then is
not lost: its raw copy is in the mail bucket, and the reconcile run (every 15 minutes) processes
whatever the database does not know about, 25 messages at a time, looking back 72 hours. Forwards
for those messages may reach your private mailbox a second time. If the gap is longer than 72
hours, raise `RECONCILE_MAX_AGE_HOURS` in `infra/app.yml`, deploy the application stack, wait
for it to catch up, and put the number back. The raw copies are kept 30 days.

### A. Restore a dump into the running database

The restore runs in one transaction. Either everything is put back, or, if anything fails,
nothing changes. Tables that exist in the dump are replaced by their saved state.

**From a copy on the host** (the last three nights). Open a shell on the host:

```bash
aws ssm start-session --target $INSTANCE_ID
```

```bash
sudo ls -l /var/backups/eisenmail/
```

```bash
sudo cat /var/backups/eisenmail/<file> | sudo -u postgres pg_restore --clean --if-exists --single-transaction --no-owner --role=eisenmail -d emails
```

**From any dump in S3.** The host cannot read the backup bucket, so the restore runs from your
machine through a forwarded port. You need the PostgreSQL client tools, version 16 or later, and
the Session Manager plugin (SETUP.md step 8).

```bash
aws s3 cp s3://$BACKUP_BUCKET/db/<file> .
```

In a second terminal, and leave it running:

```bash
aws ssm start-session --target $INSTANCE_ID --document-name AWS-StartPortForwardingSession --parameters portNumber=5432,localPortNumber=15432
```

Back in the first:

```bash
PGPASSWORD="$(aws ssm get-parameter --name /eisenmail/db_password --with-decryption --query Parameter.Value --output text)" \
pg_restore -h 127.0.0.1 -p 15432 -U eisenmail --clean --if-exists --single-transaction --no-owner -d emails <file>
```

Then delete the downloaded file. It contains all your mail.

### B. Put yesterday's snapshot back

This replaces the disk of the existing machine with a copy of a snapshot. The machine keeps its
address and reboots once.

```bash
aws ec2 describe-snapshots --owner-ids self --filters Name=tag:eisenmail-snapshot,Values=daily --query "sort_by(Snapshots,&StartTime)[].[StartTime,SnapshotId,State]" --output table
```

```bash
aws ec2 create-replace-root-volume-task --instance-id $INSTANCE_ID --snapshot-id <snapshot id>
```

```bash
aws ec2 describe-replace-root-volume-tasks --filters Name=instance-id,Values=$INSTANCE_ID --query "ReplaceRootVolumeTasks[].[StartTime,TaskState]" --output table
```

When the task shows `succeeded`:

1. Open `<site>/api/health`. It must show `{"ok":true}`.
2. Make sure the new disk is still picked up by the daily snapshots. The second column must say
   `daily`:

   ```bash
   aws ec2 describe-volumes --filters Name=attachment.instance-id,Values=$INSTANCE_ID --query "Volumes[].[VolumeId,Tags[?Key=='eisenmail-snapshot']|[0].Value]" --output text
   ```

   If it does not:

   ```bash
   aws ec2 create-tags --resources <volume id> --tags Key=eisenmail-snapshot,Value=daily
   ```

3. If you rotated the database password or the tunnel key after that snapshot was taken, the
   machine now has the old ones again. Rotate them once more (SETUP.md, "Day to day").
4. The old disk is kept, detached. Delete it in the EC2 console under Volumes when you are sure
   you do not need anything from it. Until then it costs the same as the new one.

### C. A fresh machine, then restore a dump

This gives the existing instance a new, empty disk made from the current Ubuntu image. Because
the disk is new, the machine sets itself up again exactly as on its first boot: PostgreSQL, a new
database password, a new tunnel key, a new host key. It keeps its address.

First download the dump you are going to restore, as in A, "From any dump in S3". Do it now,
because at the end of its setup the fresh machine uploads a dump of its own, still empty,
database, and from then on that one is the newest file in the bucket.

```bash
IMAGE_ID=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
```

```bash
aws ec2 create-replace-root-volume-task --instance-id $INSTANCE_ID --image-id $IMAGE_ID
```

1. Wait until the setup has finished. The parameter `/eisenmail/tunnel_host_key` gets a new
   version number when it has:

   ```bash
   aws ssm get-parameter --name /eisenmail/tunnel_host_key --query "Parameter.[Version,LastModifiedDate]" --output text
   ```

2. Give the functions the new host key. Use the version number you just saw. This also restarts
   both functions, so they read the new password and tunnel key.

   ```bash
   aws cloudformation deploy --stack-name eisenmail --template-file infra/app.yml --parameter-overrides TunnelHostKeyParameter=/eisenmail/tunnel_host_key:<version>
   ```

3. Restore the dump you downloaded, as in A, "From any dump in S3". Not the newest file in the
   bucket: that is the small dump of the empty database.
4. Check the snapshot tag and delete the old disk, as in B.

## Changing the database host

**The stack `eisenmail-database` is deployed once.** Every time it is updated, CloudFormation
looks up the newest Ubuntu image, and if there is a newer one it wants to build a new machine.
The stack policy from SETUP.md step 5 refuses that, so such an update fails without touching
anything. The changes people actually need do not go through the stack:

**Another size** (for example from `t4g.micro` to `t4g.nano`, or up to `t4g.small`). About two
minutes of downtime. Mail that arrives meanwhile is processed afterwards.

```bash
aws ec2 stop-instances --instance-ids $INSTANCE_ID
```

```bash
aws ec2 wait instance-stopped --instance-ids $INSTANCE_ID
```

```bash
aws ec2 modify-instance-attribute --instance-id $INSTANCE_ID --instance-type Value=t4g.nano
```

```bash
aws ec2 start-instances --instance-ids $INSTANCE_ID
```

Then, in a shell on the host, let PostgreSQL's memory settings follow the new size:

```bash
sudo /usr/local/sbin/eisenmail-db-host
```

**A bigger disk.** Disks can grow but not shrink. Ubuntu enlarges the file system by itself at
the next boot.

```bash
VOLUME_ID=$(aws ec2 describe-instances --instance-ids $INSTANCE_ID --query "Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId" --output text)
```

```bash
aws ec2 modify-volume --volume-id $VOLUME_ID --size 40
```

```bash
aws ec2 reboot-instances --instance-ids $INSTANCE_ID
```

**A newer version of the setup script.** In a shell on the host, download the version you
reviewed and run it. It keeps the password, the key and the data.

```bash
sudo curl -fsSL -o /usr/local/sbin/eisenmail-db-host https://raw.githubusercontent.com/seisenberg/eisenberg.dev/<commit>/infra/db-host.sh
```

```bash
sudo /usr/local/sbin/eisenmail-db-host
```

**Backup retention or anything else in the stack.** Pin the image CloudFormation built the
machine from, so that it sees nothing to rebuild. The first command reads that image from the
stack. The second prints the names of Canonical's parameters for exactly that image. Use the one
with a date in it, not the one that says `current`.

```bash
BUILT_FROM=$(aws cloudformation describe-stacks --stack-name eisenmail-database --query "Stacks[0].Parameters[?ParameterKey=='ImageId'].ResolvedValue" --output text)
```

```bash
aws ssm get-parameters-by-path --recursive --path /aws/service/canonical/ubuntu/server/24.04/stable --query "Parameters[?Value=='$BUILT_FROM'].Name" --output text
```

```bash
aws cloudformation deploy --stack-name eisenmail-database --template-file infra/database.yml \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides ImageId=<that name> DumpRetentionDays=180
```

If the second command prints nothing, Canonical has withdrawn that image. Change the retention
directly instead: in the EC2 console under Lifecycle Manager for the snapshots, in the S3 console
under the backup bucket's lifecycle rules for the dumps.

Never change `VolumeSizeGb` this way. It only applies when the machine is created.

## Taking everything with you

Everything that is yours can be copied out with four commands. Take a fresh dump first if you
want the last few hours as well (`sudo systemctl start eisenmail-backup` on the host).

```bash
aws s3 sync s3://eisenmail-backups-$ACCOUNT/db ./eisenmail-export/db
```

```bash
aws s3 sync s3://eisenmail-files-$ACCOUNT ./eisenmail-export/files
```

```bash
aws s3 sync s3://eisenmail-public-files-$ACCOUNT ./eisenmail-export/public-files
```

```bash
aws s3 sync s3://eisenmail-mail-$ACCOUNT ./eisenmail-export/mail
```

- `db/` holds the dumps. The newest one is the whole database.
- `files/drop/` and `public-files/public/` are the file drop, under the names you gave the files.
- `mail/email-inbox/` holds the last 30 days of incoming mail as plain `.eml` text (the files have
  no extension). You do not need them if you have the dump. They are the untouched originals.

A dump restores into any PostgreSQL of version 16 or later, on any machine, under any role name:

```bash
createdb emails
```

```bash
pg_restore --no-owner -d emails ./eisenmail-export/db/<newest file>
```

From there it is ordinary SQL. The table `messages` holds the mail.

### Running the database on your own hardware

`infra/db-host.sh` is the same script the AWS machine runs. On a machine that is not in AWS it
works in "manual" mode: it asks you for the tunnel's public key and prints the database password
and the host key instead of storing them anywhere. It needs a fresh Ubuntu 24.04.

On your own computer, create the tunnel key pair:

```bash
ssh-keygen -t ed25519 -N "" -C eisenmail-tunnel -f ./eisenmail_tunnel
```

Copy `infra/db-host.sh` to the new machine and run it there:

```bash
sudo TUNNEL_PUBLIC_KEY="<the one line in eisenmail_tunnel.pub>" bash db-host.sh
```

It prints the database password and the host key line once. Then restore your data, on that
machine:

```bash
sudo cat <dump file> | sudo -u postgres pg_restore --clean --if-exists --single-transaction --no-owner --role=eisenmail -d emails
```

The machine now dumps its database every night into `/var/backups/eisenmail` and keeps 14 days.
Those files are on the same disk as the database, so copy them somewhere else on a schedule.
The script changes ssh for the whole machine: password logins are switched off. Make sure you
have another way in (a key for your own account, or a console) before you run it.

If the functions stay in AWS for now, the machine must be reachable from the internet on TCP
port 22. Tell the application stack to use it:

```bash
read -rs DB_PASSWORD
```

```bash
aws ssm put-parameter --name /eisenmail/db_password --type SecureString --overwrite --value "$DB_PASSWORD"
```

```bash
aws ssm put-parameter --name /eisenmail/tunnel_key --type SecureString --overwrite --value file://eisenmail_tunnel
```

```bash
aws cloudformation deploy --stack-name eisenmail --template-file infra/app.yml \
  --parameter-overrides UseDatabaseStack=false TunnelHost=<name or address of your machine> TunnelHostKey='<host key line>'
```

Then delete `eisenmail_tunnel` and `eisenmail_tunnel.pub` from your computer. With
`UseDatabaseStack=false` there is no backup alarm, because your machine does not report to AWS.

## What else leaving AWS would take

Your data leaves easily: the section above is all of it. Running the *system* without AWS is a
different matter, and it is better to say so plainly. Four of its parts are AWS services, and
only some of the code is indifferent to that.

| Part | Today | Outside AWS |
| --- | --- | --- |
| Database | PostgreSQL on a small machine | Nothing to change. Any PostgreSQL 16 or later. See above |
| Web site and webmail | The web container on Lambda, behind API Gateway | Runs as it is. The container is a plain HTTP server on port 8080 and runs anywhere docker runs. Put any reverse proxy with TLS in front of it and set `TRUSTED_PROXY_HOPS` to the number of proxies. It can take its secrets from environment variables instead of SSM (`POSTGRES_DB_PASSWORD`, `VAPID_PRIVATE_KEY`, and `SSH_TUNNEL_KEY_PATH` for a key file) |
| Sending mail | SES, called through the AWS SDK by both containers | Needs code. There is no SMTP sender. One would have to be added to `src/server/send.ts` and to the Python forwarder, along with new DKIM and SPF records for whoever sends the mail |
| Receiving mail | SES receives, stores the raw message in S3 and calls the inbox function with its verdicts (spam, virus, SPF, DKIM, DMARC) | Needs an adapter. The inbox handler expects an SES-shaped event and reads the message from S3. A different way in (your own mail server, or another provider's inbound hook) needs a small program that stores the message, builds that event and calls the handler. It must supply a trustworthy DMARC verdict, because the reply relay only acts on mail SES marked as DMARC `PASS` |
| The inbox container itself | A Lambda image | The code is ordinary Python, but the image starts Lambda's runtime client. Outside Lambda it needs the Lambda runtime emulator, or a few lines that call `inbox.lambda_handler` directly |
| File drop | Two S3 buckets, presigned links | The code speaks the S3 API, so any S3-compatible store would do. But there is no setting for a custom endpoint yet. That would need adding to `src/server/files.ts` (and to the inbox code for the mail bucket). A local directory driver exists (`FILES_DRIVER=local`). It was written for development and has not been reviewed for real use |
| Scheduled reconcile | EventBridge, every 15 minutes | A cron job that calls the handler with `{"eisenmail": "reconcile"}` |
| Alarms | CloudWatch and SNS | Whatever monitoring you use. The things to watch are in `infra/app.yml` under "alarms" |
| Deploying | GitHub Actions pushes images to ECR and updates the functions | A different last step in `.github/workflows/deploy.yml` |
| Push notifications | Web Push, sent by both containers | Nothing to change. It never depended on AWS |

In short: the database, your data, the web container and push notifications move as they are.
Mail in and mail out are the real work, because that is the part AWS does for this system. A
sensible middle path, if the reason to move is cost or control of the data, is to move only the
database to your own hardware (the section above) and leave the rest where it is.

## The restore drill

Do this once, a day or two after setup, and again after any change to the database host. It
takes ten minutes and changes nothing in the live database.

1. A backup exists and is recent. The first command shows a name and a size, the second shows
   the same file in the list.

   ```bash
   aws s3 cp s3://$BACKUP_BUCKET/db/LATEST -
   ```

   ```bash
   aws s3 ls s3://$BACKUP_BUCKET/db/ | tail -n 3
   ```

2. The snapshots are being taken. After the first night there is at least one, in state
   `completed`.

   ```bash
   aws ec2 describe-snapshots --owner-ids self --filters Name=tag:eisenmail-snapshot,Values=daily --query "sort_by(Snapshots,&StartTime)[].[StartTime,SnapshotId,State]" --output table
   ```

3. A dump really restores. Open a shell on the host and restore the newest local dump into a
   scratch database next to the real one:

   ```bash
   aws ssm start-session --target $INSTANCE_ID
   ```

   ```bash
   sudo ls -l /var/backups/eisenmail/
   ```

   ```bash
   sudo -u postgres createdb -O eisenmail restore_drill
   ```

   ```bash
   sudo cat /var/backups/eisenmail/<newest file> | sudo -u postgres pg_restore --no-owner --role=eisenmail -d restore_drill
   ```

   The two numbers must match, or differ only by mail that arrived since the dump:

   ```bash
   sudo -u postgres psql -d restore_drill -c "select count(*) from messages"
   ```

   ```bash
   sudo -u postgres psql -d emails -c "select count(*) from messages"
   ```

   ```bash
   sudo -u postgres dropdb restore_drill
   ```

4. The copy in S3 is the same file. Download the newest dump to your own machine and compare its
   size with the line in `db/LATEST`. If you have the PostgreSQL client tools, `pg_restore --list
   <file>` must print a table of contents. Delete the file afterwards.

5. The alarm works. In the CloudWatch console the alarm `eisenmail-no-database-backup` is in
   state OK. (You can only see this if `AlertEmail` is set.)

Once a year, or before you rely on it, also walk through B on a quiet evening. It is the only
way to know that the snapshot path works in your account.
