#!/usr/bin/env bash
# Apache Guacamole installer for a fresh Debian 12 / Ubuntu 24.04 VM.
# Run as root from this folder:  bash install.sh remote.yourdomain.com
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="/opt/guacamole"
GUAC_IMAGE="guacamole/guacamole:1.6.0"

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: bash install.sh <domain>"
  echo "The domain must already point at this server — Caddy fetches a certificate on first start."
  exit 1
fi
if [[ $EUID -ne 0 ]]; then echo "Run this as root."; exit 1; fi
cd "$(dirname "$0")"

echo "==> Installing Docker"
if ! command -v docker &>/dev/null; then
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates openssl
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null

echo "==> Copying files to $APP_DIR"
mkdir -p "$APP_DIR"/{initdb,data/postgres,data/caddy,data/recordings}
cp docker-compose.yml Caddyfile backup.sh openid.env.example "$APP_DIR/"

echo "==> Generating secrets"
if [[ ! -f "$APP_DIR/.env" ]]; then
  sed -e "s|^GUAC_DOMAIN=.*|GUAC_DOMAIN=$DOMAIN|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
      .env.example > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
else
  echo "    $APP_DIR/.env exists, leaving it alone"
fi

echo "==> Generating the database schema"
if [[ ! -f "$APP_DIR/initdb/001-schema.sql" ]]; then
  docker run --rm "$GUAC_IMAGE" /opt/guacamole/bin/initdb.sh --postgresql > "$APP_DIR/initdb/001-schema.sql"
fi

# guacd (uid 1000) writes recordings; the web app (gid 1001) plays them back.
# setgid keeps new files in the web app's group.
chown 1000:1001 "$APP_DIR/data/recordings"
chmod 2750 "$APP_DIR/data/recordings"

echo "==> Starting"
cd "$APP_DIR"
docker compose pull -q
docker compose up -d

echo "==> Nightly database backup at 02:30"
cat > /etc/cron.d/guacamole-backup <<CRON
30 2 * * * root $APP_DIR/backup.sh >> /var/log/guacamole-backup.log 2>&1
CRON

cat <<DONE

Guacamole is starting at https://$DOMAIN/  (first certificate can take a minute)

  Sign in as guacadmin / guacadmin and IMMEDIATELY:
    1. Create your own admin user with all permissions, and enrol TOTP on it.
    2. Sign in as that user, then delete guacadmin (or give it a long random password).

  Next: Entra ID sign-in and adding connections — see README.md.
  Logs: cd $APP_DIR && docker compose logs -f guacamole
DONE
