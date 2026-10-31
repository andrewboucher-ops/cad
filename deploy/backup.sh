#!/usr/bin/env bash
# Nightly backup of CCCS: the database AND every uploaded file (CVs, SIA
# licence scans, ID photos, personnel files, site documents, signed
# agreements, report photos) in one archive, encrypted, checked, and copied
# off this server when a remote is set.
#
#   cccs-backup                 (installed by deploy/install-backup.sh)
#
# Settings come from the environment or /etc/cccs/cccs.env:
#   BACKUP_DIR            where archives go            (/var/backups/cccs)
#   BACKUP_KEEP           how many archives to keep    (14)
#   BACKUP_KEY_FILE       passphrase file, root only   (/etc/cccs/backup.key)
#   BACKUP_RCLONE_REMOTE  e.g. onedrive:cccs-backups   (unset = stays on this box)
#
# Restore:
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/etc/cccs/backup.key \
#     -in cccs-YYYYmmdd-HHMMSS.tar.gz.enc | tar -xzf -
# gives cccs.db and uploads/ — put them back under /var/lib/cccs with the
# service stopped. Keep a copy of backup.key somewhere other than this
# server (a password manager): without it the archives cannot be opened.
set -euo pipefail
export NODE_NO_WARNINGS=1

ENV_FILE="${ENV_FILE:-/etc/cccs/cccs.env}"
cfg() { # cfg NAME DEFAULT — the environment wins, then the env file, then DEFAULT
  local v="${!1:-}"
  [ -n "$v" ] || v=$( (grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true) | tail -1 | cut -d= -f2-)
  printf '%s' "${v:-$2}"
}
DATA_FILE=$(cfg DATA_FILE /var/lib/cccs/cccs.db)
DEST=$(cfg BACKUP_DIR /var/backups/cccs)
KEEP=$(cfg BACKUP_KEEP 14)
KEY_FILE=$(cfg BACKUP_KEY_FILE /etc/cccs/backup.key)
REMOTE=$(cfg BACKUP_RCLONE_REMOTE "")
DATA_DIR="$(dirname "$DATA_FILE")"
STAMP=$(date +%Y%m%d-%H%M%S)
ENC_ARGS=(-aes-256-cbc -pbkdf2 -iter 200000 -salt)

mkdir -p "$DEST"; chmod 700 "$DEST"
WORK=$(mktemp -d "$DEST/.work-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# Make room first: keep the newest KEEP-1 so this one makes KEEP.
{ ls -1t "$DEST"/cccs-*.tar.gz* 2>/dev/null || true; } | tail -n "+$KEEP" | xargs -r rm -f
find "$DEST" -maxdepth 1 -name 'cccs-*.db.gz' -mtime +30 -delete   # the old database-only backups

# A consistent copy of the live database. SQLite's own .backup respects WAL,
# so this is safe while the service runs — never just cp the file.
if command -v sqlite3 >/dev/null; then
  sqlite3 "$DATA_FILE" ".backup '$WORK/cccs.db'"
else
  node -e "
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]);
    db.exec(\`VACUUM INTO '\${process.argv[2].replace(/'/g, \"''\")}'\`);
    db.close();
  " "$DATA_FILE" "$WORK/cccs.db"
fi

# Uploads, without the PC installer releases and voice-prompt cache that sit
# beside them: both are re-creatable and the installer is hundreds of MB.
PARTS=(-C "$WORK" cccs.db)
[ -d "$DATA_DIR/uploads" ] && PARTS+=(-C "$DATA_DIR" uploads)

need_kb=$(( $(du -sk "$WORK/cccs.db" | cut -f1) + $( [ -d "$DATA_DIR/uploads" ] && du -sk "$DATA_DIR/uploads" | cut -f1 || echo 0) ))
free_kb=$(df -Pk "$DEST" | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt $(( need_kb * 12 / 10 )) ]; then
  echo "STOPPED: not enough disk for the backup (need about $((need_kb / 1024)) MB, $((free_kb / 1024)) MB free in $DEST). Lower BACKUP_KEEP or free space." >&2
  exit 1
fi

if [ -f "$KEY_FILE" ]; then
  OUT="$DEST/cccs-$STAMP.tar.gz.enc"
  tar -czf - "${PARTS[@]}" | openssl enc "${ENC_ARGS[@]}" -pass "file:$KEY_FILE" -out "$OUT"
  # Prove it opens, before trusting it.
  listing=$(openssl enc -d "${ENC_ARGS[@]}" -pass "file:$KEY_FILE" -in "$OUT" | tar -tzf -)
else
  OUT="$DEST/cccs-$STAMP.tar.gz"
  echo "WARNING: $KEY_FILE not found — this backup is NOT encrypted. Run deploy/install-backup.sh to create a key." >&2
  tar -czf "$OUT" "${PARTS[@]}"
  listing=$(tar -tzf "$OUT")
fi
grep -qx 'cccs.db' <<<"$listing" || { echo "STOPPED: $OUT does not open cleanly — check the disk" >&2; exit 1; }
chmod 600 "$OUT"
echo "Backed up to $OUT ($(du -h "$OUT" | cut -f1))"

# A backup on the same disk as the database is a second copy of the same
# failure, not a backup.
if [ -n "$REMOTE" ]; then
  if command -v rclone >/dev/null; then
    rclone copy "$OUT" "$REMOTE" && echo "Copied off this server to $REMOTE"
  else
    echo "WARNING: BACKUP_RCLONE_REMOTE is set but rclone is not installed — NOT copied off this server." >&2
    exit 2
  fi
else
  echo "WARNING: BACKUP_RCLONE_REMOTE not set — this backup is only on this server." >&2
fi
