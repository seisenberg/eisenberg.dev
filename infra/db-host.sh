#!/usr/bin/env bash
# Prepares a fresh Ubuntu 26.04 LTS host (PostgreSQL 18) as the eisenmail database server:
#   - PostgreSQL listening on localhost only, one database, one application role,
#     settings sized for a machine with 0.5 to 1 GB of memory
#   - a "tunnel" account that can do exactly one thing: forward a port to that PostgreSQL
#   - password logins over ssh switched off, security updates installed automatically
#   - a nightly dump of the database (/usr/local/bin/eisenmail-backup), and one right away
#
# The tables are not created here. The web function applies db/schema.sql when it starts.
#
# It runs in one of two modes and picks the right one by itself:
#
#   MODE=aws      on an EC2 instance (infra/database.yml starts it at first boot). The host makes
#                 its own tunnel key pair and database password and stores them in SSM Parameter
#                 Store, uploads the nightly dump to S3, and prints nothing secret.
#                 Needs: PROJECT_NAME, AWS_REGION, BACKUP_BUCKET (the stack passes all three).
#
#   MODE=manual   on any other machine, for example your own hardware. Run as root:
#                   sudo TUNNEL_PUBLIC_KEY="ssh-ed25519 AAAA... eisenmail-tunnel" bash db-host.sh
#                 It prints, once, the database password and the host key line. Put both where
#                 docs/BACKUP-AND-MIGRATION.md says, then clear your terminal. The nightly dump
#                 stays on the machine, in /var/backups/eisenmail.
#
# Optional in both modes: DB_NAME (default emails), DB_USER (default eisenmail).
#
# Running it again is safe. It keeps the existing password and tunnel key unless you ask:
#   ROTATE_DB_PASSWORD=1   set a new database password
#   ROTATE_TUNNEL_KEY=1    aws mode: make a new tunnel key pair
#                          (manual mode: pass the new TUNNEL_PUBLIC_KEY instead)
set -euo pipefail

CONF=/etc/eisenmail/host.env                       # non-secret settings, kept for the next run
AUTHORIZED_KEYS=/home/tunnel/.ssh/authorized_keys
AWS_HELPER=/usr/local/lib/eisenmail/aws.py
BACKUP_DIR=/var/backups/eisenmail

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
fail() { echo "db-host.sh: $*" >&2; exit 1; }

# ---- settings: the environment wins, then what an earlier run saved, then the defaults ----------
for name in MODE PROJECT_NAME AWS_REGION BACKUP_BUCKET DB_NAME DB_USER; do
  if [[ -z ${!name:-} && -r $CONF ]]; then
    printf -v "$name" '%s' "$(sed -n "s/^${name}=//p" "$CONF")"
  fi
done

# The EC2 instance metadata service (IMDSv2). Answers only on an EC2 instance.
imds() {
  local token
  command -v curl >/dev/null || return 1
  token=$(curl -fs -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token) || return 1
  curl -fs -m 2 -H "X-aws-ec2-metadata-token: ${token}" "http://169.254.169.254/latest/meta-data/$1"
}
if [[ -z ${MODE:-} ]]; then
  if imds instance-id >/dev/null 2>&1; then MODE=aws; else MODE=manual; fi
fi

PROJECT_NAME=${PROJECT_NAME:-eisenmail}
DB_NAME=${DB_NAME:-emails}
DB_USER=${DB_USER:-eisenmail}
BACKUP_BUCKET=${BACKUP_BUCKET:-}
AWS_REGION=${AWS_REGION:-}
TUNNEL_PUBLIC_KEY=${TUNNEL_PUBLIC_KEY:-}

[[ $DB_NAME =~ ^[a-z_][a-z0-9_]*$ && $DB_USER =~ ^[a-z_][a-z0-9_]*$ ]] || fail "DB_NAME / DB_USER must be plain identifiers"
[[ $PROJECT_NAME =~ ^[a-z][a-z0-9-]{2,20}$ ]] || fail "PROJECT_NAME must be lower case letters, digits and dashes"
case $MODE in
  aws)
    [[ -n $AWS_REGION ]] || AWS_REGION=$(imds placement/region || true)
    [[ $AWS_REGION =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || fail "aws mode needs AWS_REGION"
    [[ $BACKUP_BUCKET =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || fail "aws mode needs BACKUP_BUCKET (the bucket for the nightly dumps)"
    export AWS_DEFAULT_REGION=$AWS_REGION
    ;;
  manual)
    if [[ -n $TUNNEL_PUBLIC_KEY ]]; then
      [[ $TUNNEL_PUBLIC_KEY =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+ ]] || fail "TUNNEL_PUBLIC_KEY must be an ssh-ed25519 public key"
    elif [[ ! -s $AUTHORIZED_KEYS ]]; then
      fail "set TUNNEL_PUBLIC_KEY to the tunnel public key (ssh-ed25519 AAAA...)"
    fi
    ;;
  *) fail "MODE must be aws or manual" ;;
esac

# Is systemd running this machine? (Not in a container, where this script is tested.)
have_systemd() { [[ -d /run/systemd/system ]]; }

# Remember the settings, so a later run (for example to rotate a key) needs no arguments.
install -d -m 0755 /etc/eisenmail
cat > "$CONF" <<CONF
MODE=${MODE}
PROJECT_NAME=${PROJECT_NAME}
AWS_REGION=${AWS_REGION}
BACKUP_BUCKET=${BACKUP_BUCKET}
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
CONF

# ---- packages -------------------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
PACKAGES=(postgresql openssh-server unattended-upgrades)
# The few AWS calls are made with python3 and boto3 (small, and packaged by Ubuntu).
[[ $MODE == aws ]] && PACKAGES+=(python3-boto3)
# At first boot Ubuntu's own daily update job can hold the package locks for a while: wait for it.
apt_get() { apt-get -o DPkg::Lock::Timeout=300 -o Acquire::Retries=5 "$@"; }
for _ in 1 2 3 4 5 6; do
  apt_get update -qq && break
  sleep 10
done
apt_get install -y -qq "${PACKAGES[@]}" >/dev/null

# ---- aws mode: the few AWS calls this host makes ------------------------------------------------
# Values travel on stdin, never on a command line, and errors are reported without them.
if [[ $MODE == aws ]]; then
  install -d -m 0755 "$(dirname "$AWS_HELPER")"
  cat > "$AWS_HELPER" <<'PY'
"""The AWS calls of the eisenmail database host. Usage: aws.py <command> <arguments>"""
import sys

import boto3
from botocore.exceptions import ClientError


def main(command, *args):
    if command == "ssm-has":  # <name>; exit status 0 when the parameter exists, 3 when it does not
        try:
            boto3.client("ssm").get_parameter(Name=args[0])
        except ClientError as error:
            if error.response["Error"]["Code"] != "ParameterNotFound":
                raise
            return 3
    elif command == "ssm-put":  # <name> <String|SecureString>, the value on stdin
        boto3.client("ssm").put_parameter(Name=args[0], Type=args[1], Value=sys.stdin.read(), Overwrite=True)
    elif command == "s3-upload":  # <file> <bucket> <key>
        boto3.client("s3").upload_file(args[0], args[1], args[2])
    elif command == "s3-put":  # <bucket> <key>, the body on stdin
        boto3.client("s3").put_object(Bucket=args[0], Key=args[1], Body=sys.stdin.buffer.read())
    elif command == "metric":  # <namespace> <metric name> <bytes>
        boto3.client("cloudwatch").put_metric_data(
            Namespace=args[0], MetricData=[{"MetricName": args[1], "Value": float(args[2]), "Unit": "Bytes"}]
        )
    else:
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(*sys.argv[1:]))
    except ClientError as error:
        sys.exit(f"aws.py {sys.argv[1]}: {error.response['Error']['Code']}")
    except Exception as error:  # the message could contain a value, so only the kind of error is shown
        sys.exit(f"aws.py {' '.join(sys.argv[1:2])}: {type(error).__name__}")
PY
fi
ssm_put() { python3 "$AWS_HELPER" ssm-put "$@"; }       # <name> <type>, the value on stdin
ssm_has() {                                             # <name>
  local status=0
  python3 "$AWS_HELPER" ssm-has "$1" || status=$?
  case $status in
    0) return 0 ;;
    3) return 1 ;;
    *) fail "could not ask SSM Parameter Store about $1" ;;
  esac
}

# ---- swap: a small machine needs room for the occasional large query or package upgrade --------
if have_systemd && [[ -z $(swapon --noheadings --show 2>/dev/null) ]] && ! grep -q '^/swapfile ' /etc/fstab; then
  free_kb=$(df --output=avail -k / | tail -n 1)
  if (( free_kb > 3 * 1024 * 1024 )); then
    if fallocate -l 1G /swapfile && chmod 0600 /swapfile && mkswap -q /swapfile >/dev/null && swapon /swapfile; then
      echo '/swapfile none swap sw 0 0' >> /etc/fstab
    else
      rm -f /swapfile        # this filesystem cannot hold a swap file; carry on without one
    fi
  fi
fi

# ---- PostgreSQL: local connections only (the package default), password auth with scram --------
if have_systemd; then
  systemctl enable --now postgresql >/dev/null 2>&1
else
  service postgresql start >/dev/null
fi
# SQL goes in on stdin, so a password never shows up in the process list.
sql() { su -s /bin/sh postgres -c "psql -v ON_ERROR_STOP=1 -qtA -d postgres" <<<"$1"; }

# Settings for a small machine, from the memory it has.
memory_mb=${MEMORY_MB:-$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)}
shared_buffers_mb=$(( memory_mb / 8 ))
(( shared_buffers_mb >= 32 )) || shared_buffers_mb=32
tuning_file="$(dirname "$(sql 'show config_file')")/conf.d/eisenmail.conf"
tuning_new=$(mktemp)
cat > "$tuning_new" <<CONF
# Written by eisenmail db-host.sh for a machine with ${memory_mb} MB of memory. Rerun it after a resize.
shared_buffers = ${shared_buffers_mb}MB
effective_cache_size = $(( memory_mb / 2 ))MB
work_mem = 4MB
maintenance_work_mem = 32MB
max_connections = 40
CONF
if ! cmp -s "$tuning_new" "$tuning_file"; then
  install -m 0644 "$tuning_new" "$tuning_file"
  if have_systemd; then systemctl restart postgresql; else service postgresql restart >/dev/null; fi
fi
rm -f "$tuning_new"

# ---- the database and its role ---------------------------------------------------------------
role_exists=$(sql "select 1 from pg_roles where rolname = '${DB_USER}'")
new_password=no
[[ -z $role_exists || ${ROTATE_DB_PASSWORD:-0} == 1 ]] && new_password=yes
# aws mode: the role exists but its password never reached SSM (an interrupted first run)
[[ $new_password == no && $MODE == aws ]] && ! ssm_has "/${PROJECT_NAME}/db_password" && new_password=yes

DB_PASSWORD=""
if [[ $new_password == yes ]]; then
  DB_PASSWORD=$(openssl rand -base64 60 | tr -dc 'A-Za-z0-9' | cut -c1-40)
  [[ ${#DB_PASSWORD} -eq 40 ]] || fail "could not generate a password"
  if [[ -z $role_exists ]]; then
    sql "create role ${DB_USER} login password '${DB_PASSWORD}'"
  else
    sql "alter role ${DB_USER} password '${DB_PASSWORD}'"
  fi
  if [[ $MODE == aws ]]; then
    printf '%s' "$DB_PASSWORD" | ssm_put "/${PROJECT_NAME}/db_password" SecureString
    DB_PASSWORD=""
  fi
fi
if [[ -z $(sql "select 1 from pg_database where datname = '${DB_NAME}'") ]]; then
  sql "create database ${DB_NAME} owner ${DB_USER}"
fi
# nobody but the application role (and the superuser) may connect to this database
sql "revoke all on database ${DB_NAME} from public"

# ---- the tunnel account: port forwarding to PostgreSQL and nothing else -------------------------
id tunnel >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin tunnel
install -d -m 0700 -o tunnel -g tunnel /home/tunnel/.ssh
allow_tunnel_key() { # <public key line>
  printf 'restrict,port-forwarding,permitopen="127.0.0.1:5432",command="/bin/false" %s\n' "$1" > "$AUTHORIZED_KEYS"
  chown tunnel:tunnel "$AUTHORIZED_KEYS"
  chmod 0600 "$AUTHORIZED_KEYS"
}

if [[ $MODE == manual ]]; then
  [[ -z $TUNNEL_PUBLIC_KEY ]] || allow_tunnel_key "$TUNNEL_PUBLIC_KEY"
elif [[ ${ROTATE_TUNNEL_KEY:-0} == 1 || ! -s $AUTHORIZED_KEYS ]] || ! ssm_has "/${PROJECT_NAME}/tunnel_key"; then
  # The key pair is made here. The private half goes to SSM (where the two functions read it) and
  # is then destroyed on this machine, which only ever needs the public half. It is made in /run,
  # which is memory, so it never reaches the disk.
  key_dir=$(mktemp -d -p /run eisenmail-key.XXXXXX)
  trap 'find "$key_dir" -type f -exec shred -u {} + 2>/dev/null; rm -rf "$key_dir"' EXIT
  ssh-keygen -q -t ed25519 -N "" -C "${PROJECT_NAME}-tunnel" -f "$key_dir/tunnel_key"
  ssm_put "/${PROJECT_NAME}/tunnel_key" SecureString < "$key_dir/tunnel_key"
  allow_tunnel_key "$(cat "$key_dir/tunnel_key.pub")"
  shred -u "$key_dir/tunnel_key"
fi

cat > /etc/ssh/sshd_config.d/60-eisenmail.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
Match User tunnel
    AllowTcpForwarding local
    PermitOpen 127.0.0.1:5432
    X11Forwarding no
    AllowAgentForwarding no
    PermitTTY no
    ForceCommand /bin/false
CONF
mkdir -p /run/sshd
sshd -t
if have_systemd; then
  systemctl reload ssh 2>/dev/null || systemctl restart ssh
fi

# The line the functions pin, so they only ever talk to this machine.
HOST_KEY=$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)
if [[ $MODE == aws ]]; then
  printf '%s' "$HOST_KEY" | ssm_put "/${PROJECT_NAME}/tunnel_host_key" String
fi

# ---- security updates: installed daily, with a reboot at 09:00 when one is needed ---------------
# (09:00 on the machine's clock. EC2 images run on UTC.)
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
cat > /etc/apt/apt.conf.d/52eisenmail-unattended-upgrades <<'CONF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "09:00";
CONF

# ---- nightly logical backup ---------------------------------------------------------------------
# A dump in PostgreSQL's own format restores into any PostgreSQL of the same or a newer version,
# on any machine. See docs/BACKUP-AND-MIGRATION.md.
install -d -m 0700 "$BACKUP_DIR"
cat > /usr/local/bin/eisenmail-backup <<'BACKUP'
#!/usr/bin/env bash
# Dumps the eisenmail database, checks the dump, and (on AWS) uploads it to S3.
# Installed by db-host.sh. Any failure ends with a non-zero status, so systemd shows it as failed.
set -euo pipefail
umask 077
. /etc/eisenmail/host.env

dir=/var/backups/eisenmail
name="${DB_NAME}-$(date -u +%Y%m%dT%H%M%SZ).dump"
trap 'rm -f "$dir/$name.partial"' EXIT

su -s /bin/sh postgres -c "pg_dump -Fc --no-owner --no-privileges ${DB_NAME}" > "$dir/$name.partial"
pg_restore --list "$dir/$name.partial" >/dev/null       # a dump that cannot be read is not a backup
mv "$dir/$name.partial" "$dir/$name"
size=$(stat -c %s "$dir/$name")

keep=14
if [[ $MODE == aws ]]; then
  export AWS_DEFAULT_REGION=$AWS_REGION
  python3 /usr/local/lib/eisenmail/aws.py s3-upload "$dir/$name" "$BACKUP_BUCKET" "db/$name"
  printf '%s %s\n' "$name" "$size" | python3 /usr/local/lib/eisenmail/aws.py s3-put "$BACKUP_BUCKET" db/LATEST
  # the heartbeat behind the "no database backup" alarm in infra/app.yml
  python3 /usr/local/lib/eisenmail/aws.py metric "${PROJECT_NAME}/Database" BackupBytes "$size"
  keep=3      # the copies in S3 are the history; these are for a quick local restore
fi
find "$dir" -maxdepth 1 -name "${DB_NAME}-*.dump" | sort -r | tail -n +$(( keep + 1 )) | xargs -r rm -f --
echo "backup ${name} (${size} bytes) done"
BACKUP
chmod 0755 /usr/local/bin/eisenmail-backup

install -d -m 0755 /etc/systemd/system      # present on every real machine; a container may lack it
cat > /etc/systemd/system/eisenmail-backup.service <<'UNIT'
[Unit]
Description=eisenmail nightly database dump
After=postgresql.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/eisenmail-backup
UNIT
cat > /etc/systemd/system/eisenmail-backup.timer <<'UNIT'
[Unit]
Description=eisenmail nightly database dump

[Timer]
OnCalendar=*-*-* 03:17:00 UTC
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
UNIT
if have_systemd; then
  systemctl daemon-reload
  systemctl enable --now eisenmail-backup.timer >/dev/null 2>&1
fi

# Take one backup now. It proves the whole path (dump, check, upload) while you are watching, and
# on AWS it starts the heartbeat that the "no database backup" alarm listens for.
first_backup=ok
/usr/local/bin/eisenmail-backup || first_backup=failed

# ---- done -----------------------------------------------------------------------------------------
echo
echo "================ eisenmail database host ready (${MODE} mode) ================"
if [[ $MODE == aws ]]; then
  echo "In SSM Parameter Store (${AWS_REGION}):"
  echo "  /${PROJECT_NAME}/db_password      SecureString"
  echo "  /${PROJECT_NAME}/tunnel_key       SecureString"
  echo "  /${PROJECT_NAME}/tunnel_host_key  String"
  echo "Nightly dumps go to s3://${BACKUP_BUCKET}/db/"
else
  echo "Database password (POSTGRES_DB_PASSWORD, or the SSM parameter /${PROJECT_NAME}/db_password):"
  echo "  ${DB_PASSWORD:-(unchanged: the role already existed)}"
  echo "Host key (SSH_TUNNEL_HOST_KEY, or the CloudFormation parameter TunnelHostKey):"
  echo "  ${HOST_KEY}"
  echo "Nightly dumps stay on this machine, in ${BACKUP_DIR}. Copy them somewhere else too."
  have_systemd || echo "No systemd here: run /usr/local/bin/eisenmail-backup from cron yourself."
fi
echo "================================================================================"
[[ $first_backup == ok ]] || fail "the backup did not work (see the messages above). Everything else is set up."
