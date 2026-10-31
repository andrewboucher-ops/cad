#!/usr/bin/env bash
# Installs (or refreshes) the nightly CCCS backup: the cccs-backup command,
# its systemd timer, and an encryption key if there isn't one yet. Safe to
# run again — install.sh and update.sh both call it.
#
#   bash deploy/install-backup.sh
set -euo pipefail
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
KEY_FILE="${BACKUP_KEY_FILE:-/etc/cccs/backup.key}"

install -m 755 "$SRC_DIR/deploy/backup.sh" /usr/local/bin/cccs-backup

if [ ! -f "$KEY_FILE" ]; then
  mkdir -p "$(dirname "$KEY_FILE")"
  (umask 077; openssl rand -base64 48 > "$KEY_FILE")
  chown root:root "$KEY_FILE"
  echo "==> Created backup encryption key $KEY_FILE"
  echo "    Copy it into your password manager now: without it no backup can be restored."
  echo "    To see it:  cat $KEY_FILE"
fi

cat > /etc/systemd/system/cccs-backup.service <<UNIT
[Unit]
Description=CCCS backup (database and uploads)
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
systemctl daemon-reload
systemctl enable --now cccs-backup.timer >/dev/null
echo "==> Nightly backup installed (02:30). Run one now with: systemctl start cccs-backup && journalctl -u cccs-backup -n 20"
