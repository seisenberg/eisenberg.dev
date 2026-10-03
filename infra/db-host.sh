#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 host as the eisenmail database server:
#   - PostgreSQL listening on localhost only, one database, one application role
#   - a "tunnel" account that can do exactly one thing: forward a port to that PostgreSQL
#   - password logins over ssh switched off
#
# Run as root on the host:
#   sudo TUNNEL_PUBLIC_KEY="ssh-ed25519 AAAA... eisenmail-tunnel" bash db-host.sh
#
# Optional: DB_NAME (default emails), DB_USER (default eisenmail), SCHEMA_FILE (path to
# db/schema.sql, applied as the application role when given).
#
# It prints, once, the database password and the host key line. Put both where docs/SETUP.md
# says, then clear your terminal. Running it again is safe: it keeps the existing password.
set -euo pipefail

DB_NAME=${DB_NAME:-emails}
DB_USER=${DB_USER:-eisenmail}
: "${TUNNEL_PUBLIC_KEY:?set TUNNEL_PUBLIC_KEY to the tunnel public key (ssh-ed25519 AAAA...)}"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ $TUNNEL_PUBLIC_KEY =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+ ]] || { echo "TUNNEL_PUBLIC_KEY must be an ssh-ed25519 public key" >&2; exit 1; }
[[ $DB_NAME =~ ^[a-z_][a-z0-9_]*$ && $DB_USER =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "DB_NAME / DB_USER must be plain identifiers" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql openssh-server unattended-upgrades >/dev/null

# ---- PostgreSQL: local connections only (the package default), password auth with scram --------
if command -v systemctl >/dev/null && systemctl is-system-running >/dev/null 2>&1; then
  systemctl enable --now postgresql >/dev/null
else
  service postgresql start >/dev/null
fi
as_postgres() { su -s /bin/sh postgres -c "psql -v ON_ERROR_STOP=1 -qtA $*"; }

PASSWORD_NOTE="(unchanged: the role already existed)"
if [[ -z $(as_postgres "-c \"select 1 from pg_roles where rolname = '${DB_USER}'\"") ]]; then
  DB_PASSWORD=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40)
  as_postgres "-c \"create role ${DB_USER} login password '${DB_PASSWORD}'\""
  PASSWORD_NOTE=$DB_PASSWORD
fi
if [[ -z $(as_postgres "-c \"select 1 from pg_database where datname = '${DB_NAME}'\"") ]]; then
  as_postgres "-c \"create database ${DB_NAME} owner ${DB_USER}\""
fi
# nobody but the application role (and the superuser) may connect to this database
as_postgres "-c \"revoke all on database ${DB_NAME} from public\""

if [[ -n ${SCHEMA_FILE:-} ]]; then
  install -m 0644 "$SCHEMA_FILE" /tmp/eisenmail-schema.sql
  # run as the application role so it owns the tables (peer auth through a matching local user is
  # not set up, so authenticate as postgres and switch role)
  as_postgres "-d ${DB_NAME} -c \"set role ${DB_USER}\" -f /tmp/eisenmail-schema.sql"
  rm -f /tmp/eisenmail-schema.sql
fi

# ---- the tunnel account: port forwarding to PostgreSQL and nothing else -------------------------
id tunnel >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin tunnel
install -d -m 0700 -o tunnel -g tunnel /home/tunnel/.ssh
printf 'restrict,port-forwarding,permitopen="127.0.0.1:5432",command="/bin/false" %s\n' "$TUNNEL_PUBLIC_KEY" > /home/tunnel/.ssh/authorized_keys
chown tunnel:tunnel /home/tunnel/.ssh/authorized_keys
chmod 0600 /home/tunnel/.ssh/authorized_keys

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
if command -v systemctl >/dev/null && systemctl is-system-running >/dev/null 2>&1; then
  systemctl reload ssh 2>/dev/null || systemctl restart ssh
fi

echo
echo "================ eisenmail database host ready ================"
echo "Database password (SSM parameter /eisenmail/db_password):"
echo "  ${PASSWORD_NOTE}"
echo "Host key (CloudFormation parameter TunnelHostKey):"
echo "  $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
echo "================================================================"
