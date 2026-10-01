#!/usr/bin/env bash
# Deploys the checked-out code in the source repo to the live service, with a
# backup first and an automatic rollback if the service does not come back.
#
#   cd /opt/cccs-src && git fetch origin && git checkout <branch> && git pull
#   bash deploy/update.sh            # or DRY_RUN=1 bash deploy/update.sh
#
# Why a script rather than steps to paste: pasting long multi-line commands
# into an SSH session has already garbled server.js once on this estate.
# The copy only adds and overwrites (like install.sh): the live folder may hold
# files git doesn't (APK downloads), and a deploy shouldn't remove what
# nobody looked at.
# One short command is harder to get wrong at 2am.
#
# Pre-pivot database (RADIO_USER accounts)? The account check below stops
# and prints what deploy/migrate-radio-users.js would change. Review it, then
#   MIGRATE=1 bash deploy/update.sh
# stops the service, backs the database up, migrates it and deploys; if the
# new code then fails its health check, BOTH the code and the pre-migration
# database are restored (the old code cannot read migrated accounts).
#
# What it does NOT do: merge anything, change /etc/cccs/cccs.env, or turn on
# SMS_LIVE / AMI_*. New features that need those stay inert (dial falls back
# to a logged tel: attempt, SMS stays in dry-run) until you set them.
set -euo pipefail

SRC_DIR="${SRC_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
APP_DIR="${APP_DIR:-/opt/cccs}"
ENV_FILE="${ENV_FILE:-/etc/cccs/cccs.env}"
SERVICE="${SERVICE:-cccs}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/cccs}"
DRY_RUN="${DRY_RUN:-}"
# MIGRATE=1: convert radio-era accounts (RADIO_USER) as part of this deploy.
# Never implied — review the dry run it prints first.
MIGRATE="${MIGRATE:-}"
STAMP=$(date +%Y%m%d-%H%M%S)
export NODE_NO_WARNINGS=1   # node:sqlite's "experimental" notice is noise here

say() { printf '\n==> %s\n' "$*"; }
run() { if [ -n "$DRY_RUN" ]; then echo "   (dry run) $*"; else "$@"; fi; }
die() { printf '\nSTOPPED: %s\nNothing on the live service was changed.\n' "$*" >&2; exit 1; }

[ -n "$DRY_RUN" ] || [ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -f "$SRC_DIR/server.js" ] || die "no server.js in $SRC_DIR"
[ -d "$APP_DIR" ] || die "$APP_DIR does not exist — this is for updating an installed system; use deploy/install.sh for a new one"

# Settings the live service actually runs with.
DATA_FILE=$( (grep -E '^DATA_FILE=' "$ENV_FILE" 2>/dev/null || true) | tail -1 | cut -d= -f2-)
DATA_FILE="${DATA_FILE:-/var/lib/cccs/cccs.db}"
PORT=$( (grep -E '^PORT=' "$ENV_FILE" 2>/dev/null || true) | tail -1 | cut -d= -f2-)
PORT="${PORT:-4000}"
APP_USER=$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)
APP_USER="${APP_USER:-cccs}"

say "Deploying $(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD) @ $(git -C "$SRC_DIR" rev-parse --short HEAD) → $APP_DIR (service $SERVICE, port $PORT)"
[ -z "$(git -C "$SRC_DIR" status --porcelain)" ] || die "$SRC_DIR has uncommitted changes — commit or stash them so what is deployed is a known commit"

say "1/6  Tests"
if [ -n "$DRY_RUN" ]; then echo "   (dry run) skipping"; else
  (cd "$SRC_DIR" && node --test test/*.test.js >/tmp/cccs-deploy-tests.log 2>&1) \
    || { tail -30 /tmp/cccs-deploy-tests.log; die "tests failed (full log: /tmp/cccs-deploy-tests.log)"; }
  grep -E '^# (pass|fail)' /tmp/cccs-deploy-tests.log | sed 's/^/   /'
fi

say "2/6  Accounts on the live database"
# The code only recognises these roles. An account left on an older role
# (RADIO_USER, from before the pivot) would simply fail to sign in, with no
# clear error. Refuse to deploy over that rather than find out at shift change.
if [ -f "$DATA_FILE" ]; then
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const row = db.prepare("SELECT payload FROM collections WHERE name = ?").get("users");
    const users = row ? JSON.parse(row.payload) : [];
    const known = ["SYSTEM_ADMIN", "DISPATCHER", "SUPERVISOR", "FIELD_USER", "MDT_USER"];
    const bad = users.filter((u) => !known.includes(u.role));
    const counts = {}; for (const u of users) counts[u.role] = (counts[u.role] || 0) + 1;
    console.log("   " + users.length + " accounts: " + JSON.stringify(counts));
    if (bad.length) { console.log("   UNKNOWN ROLES: " + bad.map((u) => u.username + "=" + u.role).join(", ")); process.exit(3); }
    // Officer logins converted before the rename existed still carry a
    // device name (radio101); the same migration renames them.
    const stale = users.filter((u) => u.role === "FIELD_USER" && /^radio\d+$/i.test(u.username) && !u.previous_username);
    if (stale.length) { console.log("   OLD RADIO LOGIN NAMES: " + stale.map((u) => u.username).join(", ")); process.exit(3); }
  ' "$DATA_FILE" 2>/dev/null || NEEDS_MIGRATION=1
  if [ -n "${NEEDS_MIGRATION:-}" ]; then
    echo; echo "   These accounts are from before the radio removal (or still named after a radio). What the migration would change:"
    node "$SRC_DIR/deploy/migrate-radio-users.js" --db "$DATA_FILE" --dry-run | sed 's/^/   /' \
      || die "the migration cannot run on this database (reason above) — resolve it by hand first"
    if [ -z "$MIGRATE" ] && [ -z "$DRY_RUN" ]; then
      die "review the changes above; if they are right, run again as:  MIGRATE=1 bash deploy/update.sh"
    fi
  fi
else
  echo "   no database at $DATA_FILE yet — nothing to check"
fi

say "3/6  Backups"
run mkdir -p "$BACKUP_DIR"
DB_BACKUP="$BACKUP_DIR/cccs-predeploy-$STAMP.db"
MIGRATED=""
if [ -n "${NEEDS_MIGRATION:-}" ]; then
  # Stop FIRST: the running service keeps the whole state in memory and
  # writes it back every second, so a backup or migration under it would be
  # stale or overwritten. From here until the health check, the console is down.
  echo "   stopping $SERVICE for the migration (the console is down until step 6)"
  run systemctl stop "$SERVICE"
  # Until the full rollback is armed below, a failure must at least bring
  # the old service straight back — never leave the console down.
  [ -n "$DRY_RUN" ] || trap 'trap - ERR; systemctl start "$SERVICE"; die "a backup step failed — the previous service was restarted unchanged"' ERR
fi
if [ -f "$DATA_FILE" ]; then
  # SQLite's own online backup respects WAL; a plain cp of a live db does not.
  run node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec(`VACUUM INTO '"'"'${process.argv[2]}'"'"'`);d.close();' "$DATA_FILE" "$DB_BACKUP"
  echo "   database → $DB_BACKUP"
fi
APP_BACKUP="$BACKUP_DIR/app-predeploy-$STAMP.tar.gz"
run tar -czf "$APP_BACKUP" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
echo "   code     → $APP_BACKUP"

rollback() {
  trap - ERR
  printf '\n!!! %s — rolling back to the previous code\n' "$1" >&2
  systemctl stop "$SERVICE" || true
  rm -rf "$APP_DIR.failed-$STAMP"; mv "$APP_DIR" "$APP_DIR.failed-$STAMP"
  tar -xzf "$APP_BACKUP" -C "$(dirname "$APP_DIR")"
  if [ -n "$MIGRATED" ]; then
    # The old code cannot read migrated accounts: the database goes back too.
    # Nothing is lost by this — the service was stopped from backup to here.
    echo "!!! restoring the pre-migration database" >&2
    cp "$DATA_FILE" "$DATA_FILE.failed-$STAMP" 2>/dev/null || true
    rm -f "$DATA_FILE-wal" "$DATA_FILE-shm"
    cp "$DB_BACKUP" "$DATA_FILE"; chown "$APP_USER:$APP_USER" "$DATA_FILE" 2>/dev/null || true
  fi
  systemctl restart "$SERVICE"
  sleep 3
  if systemctl is-active --quiet "$SERVICE"; then
    echo "!!! Rolled back; the previous version is running. The failed copy is kept at $APP_DIR.failed-$STAMP" >&2
    echo "!!! Last log lines from the failed start:" >&2
    journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
  else
    echo "!!! ROLLBACK ALSO FAILED TO START. Check: journalctl -u $SERVICE -n 100" >&2
  fi
  exit 1
}

# From here on the live folder is being changed: any failure at all rolls
# back to the backup rather than leaving a half-copied service.
[ -n "$DRY_RUN" ] || trap 'rollback "a deploy step failed (line $LINENO)"' ERR

if [ -n "${NEEDS_MIGRATION:-}" ]; then
  say "3b   Migrating radio-era accounts"
  if [ -n "$DRY_RUN" ]; then echo "   (dry run) would run deploy/migrate-radio-users.js — changes listed in step 2"; else
    MIGRATED=1
    node "$SRC_DIR/deploy/migrate-radio-users.js" --db "$DATA_FILE" --service "$SERVICE" | sed 's/^/   /'
  fi
fi

say "4/6  Copying code"
# tar rather than rsync: always present, so this needs no extra package.
if [ -n "$DRY_RUN" ]; then echo "   (dry run) copy $SRC_DIR → $APP_DIR"; else
  tar -C "$SRC_DIR" --exclude=./data --exclude=./.git --exclude=./node_modules --exclude=./seed.json -cf - . | tar -C "$APP_DIR" -xf -
fi
run chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "5/6  Restarting $SERVICE"
run systemctl restart "$SERVICE"

say "6/6  Health check"
if [ -n "$DRY_RUN" ]; then echo "   (dry run) would poll http://127.0.0.1:$PORT/"; else
  ok=""
  for _ in $(seq 1 20); do
    sleep 1
    if systemctl is-active --quiet "$SERVICE" \
      && curl -fsS -o /dev/null "http://127.0.0.1:$PORT/control.html" \
      && curl -fsS "http://127.0.0.1:$PORT/api/auth/microsoft/status" | grep -q enabled; then ok=1; break; fi
  done
  [ -n "$ok" ] || rollback "service did not come back healthy within 20s"
  echo "   service active, pages and API answering"
fi
trap - ERR

cat <<DONE

Deployed $(git -C "$SRC_DIR" rev-parse --short HEAD). Now, by hand:
  - sign in as a dispatcher, an officer and an admin
  - raise and reset a test emergency; start a short welfare timer and check it
  - press Dial and SMS on an officer (SMS stays dry-run unless SMS_LIVE=on)

To roll back to exactly what was running before:
  systemctl stop $SERVICE && mv $APP_DIR $APP_DIR.rolledback-$STAMP \\
    && tar -xzf $APP_BACKUP -C $(dirname "$APP_DIR") && systemctl start $SERVICE
The pre-deploy database is at $DB_BACKUP.
DONE
if [ -n "$MIGRATED" ]; then cat <<MIG
THIS DEPLOY MIGRATED THE DATABASE: the old code cannot run on it. A rollback
must restore the database too — after the tar step above and BEFORE starting:
  rm -f $DATA_FILE-wal $DATA_FILE-shm && cp $DB_BACKUP $DATA_FILE && chown $APP_USER:$APP_USER $DATA_FILE
(that discards anything recorded since the deploy — note it down first).
MIG
fi
