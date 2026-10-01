#!/usr/bin/env bash
# Removes the built-in demo data (sample sites, officers, vehicles, call
# signs, MDTs and logins) from the live database, in one command:
#
#   cd /opt/cccs-src && bash deploy/remove-demo-data.sh
#
# Shows exactly what would go, asks you to confirm, then stops the service,
# makes a backup, removes it and starts the service again. If anything
# fails the service is started again on the untouched database.
# See deploy/remove-demo-data.js for what counts as demo and what is kept.
set -euo pipefail
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="${SERVICE:-cccs}"
DATA_FILE="${DATA_FILE:-/var/lib/cccs/cccs.db}"
APP_USER=$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)
export NODE_NO_WARNINGS=1

echo "== What would be removed"
node "$SRC_DIR/deploy/remove-demo-data.js" --db "$DATA_FILE" --dry-run
echo
read -r -p "Remove all of that? Type YES to continue: " ok
[ "$ok" = "YES" ] || { echo "Nothing changed."; exit 0; }

systemctl stop "$SERVICE"
trap 'systemctl start "$SERVICE"; echo "FAILED — the service was restarted; the database was not changed unless it says Done above."' ERR
node "$SRC_DIR/deploy/remove-demo-data.js" --db "$DATA_FILE" --service "$SERVICE" --apply
# Keep the database owned by the service user (the script ran as root).
[ -n "$APP_USER" ] && [ "$APP_USER" != "root" ] && chown "$APP_USER": "$DATA_FILE"* 2>/dev/null || true
trap - ERR
systemctl start "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" && echo "Service is running again." || { echo "Service did not start — check: journalctl -u $SERVICE -n 50"; exit 1; }
