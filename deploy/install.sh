#!/usr/bin/env bash
# CCCS installer for a fresh Debian/Ubuntu server.
# Run as root:  bash deploy/install.sh cccs.yourdomain.com
set -euo pipefail

DOMAIN="${1:-}"
APP_USER="cccs"
APP_DIR="/opt/cccs"
DATA_DIR="/var/lib/cccs"

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: bash deploy/install.sh <domain>"
  echo "The domain must already point at this server — Caddy fetches a certificate on first start."
  exit 1
fi
if [[ $EUID -ne 0 ]]; then echo "Run this as root."; exit 1; fi

echo "==> Installing Node.js 22 and Caddy"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq && apt-get install -y -qq caddy

echo "==> Creating service account and directories"
id -u "$APP_USER" &>/dev/null || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR" /etc/cccs
rsync -a --exclude data --exclude .git --exclude node_modules ./ "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

echo "==> Generating secrets"
if [[ ! -f /etc/cccs/cccs.env ]]; then
  cat > /etc/cccs/cccs.env <<ENV
AUTH_SECRET=$(openssl rand -hex 32)
PBX_SECRET=$(openssl rand -hex 24)
PORT=4000
DATA_FILE=$DATA_DIR/cccs.db
SIMULATION=off
# Add TURN before you rely on audio over mobile networks:
# ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.$DOMAIN:3478","username":"cccs","credential":"CHANGE_ME"}]
# Microsoft 365 / Entra ID single sign-on — optional, sits alongside local login.
# See SSO.md for how to register the app and get these three values. Uncomment
# all four once you have them; leaving any unset keeps SSO disabled.
# MS_TENANT_ID=
# MS_CLIENT_ID=
# MS_CLIENT_SECRET=
# MS_REDIRECT_URI=https://$DOMAIN/api/auth/microsoft/callback
ENV
  chmod 600 /etc/cccs/cccs.env
  chown root:root /etc/cccs/cccs.env
  echo "    Wrote /etc/cccs/cccs.env — secrets generated, not printed."
else
  echo "    /etc/cccs/cccs.env already exists, leaving it alone."
fi

echo "==> Installing systemd unit"
sed "s|__APP_DIR__|$APP_DIR|g; s|__APP_USER__|$APP_USER|g; s|__DATA_DIR__|$DATA_DIR|g" \
  deploy/cccs.service > /etc/systemd/system/cccs.service
systemctl daemon-reload
systemctl enable --now cccs

echo "==> Configuring Caddy for $DOMAIN"
sed "s|__DOMAIN__|$DOMAIN|g" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "==> Installing nightly backup"
install -m 755 deploy/backup.sh /usr/local/bin/cccs-backup
cat > /etc/systemd/system/cccs-backup.service <<UNIT
[Unit]
Description=CCCS database backup
[Service]
Type=oneshot
ExecStart=/usr/local/bin/cccs-backup
UNIT
cat > /etc/systemd/system/cccs-backup.timer <<UNIT
[Unit]
Description=Nightly CCCS backup
[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload && systemctl enable --now cccs-backup.timer

cat <<DONE

Done.

  https://$DOMAIN

  systemctl status cccs        service state
  journalctl -u cccs -f        live logs
  /etc/cccs/cccs.env           secrets (root only)
  $DATA_DIR/cccs.db            the database — this one file is your system

Do these two things now, before anyone else has the address:
  1. Sign in as admin/admin123 and change every demo password.
  2. Restore a backup into a scratch directory and confirm it opens. An untested
     backup is not a backup.
DONE
