#!/usr/bin/env bash
# Consistent backup of the CCCS database. SQLite's own .backup respects WAL,
# so this is safe to run while the service is live — do not just cp the file.
set -euo pipefail

DATA_FILE="${DATA_FILE:-/var/lib/cccs/cccs.db}"
DEST="${BACKUP_DIR:-/var/backups/cccs}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$DEST"
OUT="$DEST/cccs-$STAMP.db"

if command -v sqlite3 >/dev/null; then
  sqlite3 "$DATA_FILE" ".backup '$OUT'"
else
  node -e "
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]);
    db.exec(\`VACUUM INTO '\${process.argv[2]}'\`);
    db.close();
  " "$DATA_FILE" "$OUT"
fi

gzip -f "$OUT"
find "$DEST" -name 'cccs-*.db.gz' -mtime "+$KEEP_DAYS" -delete

echo "Backed up to $OUT.gz"

# Copy it somewhere else. A backup on the same disk as the database is not a
# backup — it is a second copy of the same failure. Uncomment and configure:
# rclone copy "$OUT.gz" remote:cccs-backups/
