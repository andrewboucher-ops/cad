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
#   BACKUP_ONEDRIVE_USER  copy each archive to this person's OneDrive, through
#                         the Microsoft app CCCS already uses (deploy/offsite-copy.js;
#                         BACKUP_ONEDRIVE_FOLDER, BACKUP_REMOTE_KEEP)
#   BACKUP_RCLONE_REMOTE  or: an rclone remote, e.g. nas:cccs-backups
#   BACKUP_PING_URL       optional: a Healthchecks.io-style URL told about every
#                         run (…/fail on failure), so a backup that stops
#                         happening at all is noticed off this server too
# Neither remote set = the backup stays on this box, and says so.
#
# The outcome of each run is written to last-backup.json in BACKUP_DIR, which
# cccs-watchdog (deploy/watchdog.js) reads to text/email when backups stop
# or stop leaving the server.
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
ONEDRIVE_USER=$(cfg BACKUP_ONEDRIVE_USER "")
PING_URL=$(cfg BACKUP_PING_URL "")
CCCS_LIB="${CCCS_LIB:-/usr/local/lib/cccs}"
DATA_DIR="$(dirname "$DATA_FILE")"
STAMP=$(date +%Y%m%d-%H%M%S)
ENC_ARGS=(-aes-256-cbc -pbkdf2 -iter 200000 -salt)

mkdir -p "$DEST"; chmod 700 "$DEST"
WORK=$(mktemp -d "$DEST/.work-XXXXXX")
OUT="" OFFSITE="none" OFFSITE_ERROR=""
# Every exit, good or bad, records what happened for the watchdog (and the
# optional ping URL) — a failure nobody hears about is how a backup quietly
# stops working for months.
finish() {
  local code=$?
  rm -rf "$WORK"
  STATUS_CODE=$code OUT_FILE="$OUT" OFFSITE="$OFFSITE" OFFSITE_ERROR="$OFFSITE_ERROR" node -e '
    const e = process.env;
    require("fs").writeFileSync(process.argv[1], JSON.stringify({
      at: new Date().toISOString(), ok: e.STATUS_CODE === "0", exit_code: Number(e.STATUS_CODE),
      file: e.OUT_FILE || null, offsite: e.OFFSITE, offsite_error: e.OFFSITE_ERROR || null,
    }, null, 1));' "$DEST/last-backup.json" 2>/dev/null || true
  if [ -n "$PING_URL" ]; then
    if [ "$code" = 0 ]; then curl -fsS -m 15 --retry 3 -o /dev/null "$PING_URL" || true
    else curl -fsS -m 15 --retry 3 -o /dev/null "${PING_URL%/}/fail" || true; fi
  fi
}
trap finish EXIT

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
if [ -n "$ONEDRIVE_USER" ]; then
  if log=$(ENV_FILE="$ENV_FILE" node "$CCCS_LIB/offsite-copy.js" "$OUT" 2>&1); then
    OFFSITE="onedrive"; echo "$log"
  else
    OFFSITE="failed"; OFFSITE_ERROR=$(tail -1 <<<"$log"); echo "$log" >&2
    echo "WARNING: the backup is only on this server tonight." >&2
    exit 2
  fi
elif [ -n "$REMOTE" ]; then
  if ! command -v rclone >/dev/null; then
    OFFSITE="failed"; OFFSITE_ERROR="BACKUP_RCLONE_REMOTE is set but rclone is not installed"
    echo "WARNING: $OFFSITE_ERROR — NOT copied off this server." >&2
    exit 2
  elif rclone copy "$OUT" "$REMOTE"; then
    OFFSITE="rclone"; echo "Copied off this server to $REMOTE"
  else
    OFFSITE="failed"; OFFSITE_ERROR="rclone copy to $REMOTE failed"
    echo "WARNING: $OFFSITE_ERROR — NOT copied off this server." >&2
    exit 2
  fi
else
  echo "WARNING: no off-server copy is set up (BACKUP_ONEDRIVE_USER or BACKUP_RCLONE_REMOTE) — this backup is only on this server." >&2
fi
