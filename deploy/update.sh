#!/usr/bin/env bash
# Deploys the checked-out code in the source repo to the live service, with a
# backup first and an automatic rollback if the service does not come back.
#
#   cd /opt/cccs-src && git fetch origin && git checkout <branch> && git pull
#   bash deploy/update.sh            # or DRY_RUN=1 bash deploy/update.sh
#
# Why a script rather than steps to paste: pasting long multi-line commands
# into an SSH session has already garbled server.js once on this estate.
# No --delete on the copy (same as install.sh): the live folder may hold
# files git doesn't (APK downloads), and a deploy shouldn't remove what
# nobody looked at.
# One short command is harder to get wrong at 2am.
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
STAMP=$(date +%Y%m%d-%H%M%S)

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
  ' "$DATA_FILE" 2>/dev/null || die "accounts with a role this code does not recognise (listed above) — migrate them first (see docs/ROADMAP.md, Phase A)"
else
  echo "   no database at $DATA_FILE yet — nothing to check"
fi

say "3/6  Backups"
run mkdir -p "$BACKUP_DIR"
if [ -f "$DATA_FILE" ]; then
  # SQLite's own online backup respects WAL; a plain cp of a live db does not.
  run node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1]);d.exec(`VACUUM INTO '"'"'${process.argv[2]}'"'"'`);d.close();' "$DATA_FILE" "$BACKUP_DIR/cccs-predeploy-$STAMP.db"
  echo "   database → $BACKUP_DIR/cccs-predeploy-$STAMP.db"
fi
APP_BACKUP="$BACKUP_DIR/app-predeploy-$STAMP.tar.gz"
run tar -czf "$APP_BACKUP" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
echo "   code     → $APP_BACKUP"

rollback() {
  printf '\n!!! %s — rolling back to the previous code\n' "$1" >&2
  rm -rf "$APP_DIR.failed-$STAMP"; mv "$APP_DIR" "$APP_DIR.failed-$STAMP"
  tar -xzf "$APP_BACKUP" -C "$(dirname "$APP_DIR")"
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

say "4/6  Copying code"
run rsync -a --exclude data --exclude .git --exclude node_modules --exclude 'seed.json' "$SRC_DIR/" "$APP_DIR/"
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

cat <<DONE

Deployed $(git -C "$SRC_DIR" rev-parse --short HEAD). Now, by hand:
  - sign in as a dispatcher, an officer and an admin
  - raise and reset a test emergency; start a short welfare timer and check it
  - press Dial and SMS on an officer (SMS stays dry-run unless SMS_LIVE=on)

To roll back to exactly what was running before:
  systemctl stop $SERVICE && mv $APP_DIR $APP_DIR.rolledback-$STAMP \\
    && tar -xzf $APP_BACKUP -C $(dirname "$APP_DIR") && systemctl start $SERVICE
The pre-deploy database is at $BACKUP_DIR/cccs-predeploy-$STAMP.db (only
needed if data itself went wrong — restoring it discards anything since).
DONE
