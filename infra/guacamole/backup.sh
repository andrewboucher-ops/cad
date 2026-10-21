#!/usr/bin/env bash
# Dumps the Guacamole database (users, connections, permissions, history).
# Keeps 14 days. Copy /var/backups/guacamole off this machine too.
set -euo pipefail

BACKUP_DIR="/var/backups/guacamole"
mkdir -p "$BACKUP_DIR"
cd "$(dirname "$0")"

docker compose exec -T postgres pg_dump -U guacamole_user -d guacamole_db \
  | gzip > "$BACKUP_DIR/guacamole-$(date +%F).sql.gz"
find "$BACKUP_DIR" -name 'guacamole-*.sql.gz' -mtime +14 -delete
