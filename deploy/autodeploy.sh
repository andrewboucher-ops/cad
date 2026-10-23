#!/usr/bin/env bash
# Auto-deploy: run every few minutes by cccs-autodeploy.timer (installed by
# deploy/install-autodeploy.sh). If the branch this checkout follows has new
# commits on GitHub, it brings them in and runs deploy/update.sh — the same
# deploy you would run by hand, with its tests, backups and automatic
# rollback if the new version doesn't come up healthy.
#
# The server PULLS from GitHub; nothing reaches in. So deploying needs no
# VPN or SSH session — pushing to the branch is enough.
#
# Safety:
#  - one run at a time (flock);
#  - a version that failed to deploy (tests failed, rolled back, or a
#    database migration that needs a person — see update.sh) is NOT retried
#    every few minutes: it waits until a newer commit is pushed;
#  - only fast-forwards — if this checkout has drifted from GitHub it stops
#    and says so rather than guessing;
#  - pause it with:  touch /etc/cccs/autodeploy.off   (rm to resume).
#
# The outcome of the last attempt is written to deploy-status.json next to
# the database, which Admin → Updates shows — so you can see what happened
# without getting onto the server. Full output: /var/log/cccs-autodeploy.log
set -uo pipefail

SRC_DIR="${SRC_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ENV_FILE="${ENV_FILE:-/etc/cccs/cccs.env}"
PAUSE_FILE="${PAUSE_FILE:-/etc/cccs/autodeploy.off}"
LOG="${LOG:-/var/log/cccs-autodeploy.log}"
STATE_DIR="${STATE_DIR:-/var/lib/cccs-autodeploy}"
SERVICE="${SERVICE:-cccs}"

[ -f "$PAUSE_FILE" ] && exit 0
exec 9>"${LOCK_FILE:-/run/cccs-autodeploy.lock}"
flock -n 9 || exit 0
mkdir -p "$STATE_DIR"

DATA_FILE=$( (grep -E '^DATA_FILE=' "$ENV_FILE" 2>/dev/null || true) | tail -1 | cut -d= -f2-)
DATA_FILE="${DATA_FILE:-/var/lib/cccs/cccs.db}"
STATUS_FILE="$(dirname "$DATA_FILE")/deploy-status.json"
APP_USER=$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true); APP_USER="${APP_USER:-cccs}"
BRANCH="${AUTODEPLOY_BRANCH:-$(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD)}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
# result: ok | failed | blocked; message: one line for a person
status() {
  local result="$1" message="$2" commit subject tail
  commit=$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')
  subject=$(git -C "$SRC_DIR" log -1 --format=%s 2>/dev/null || echo '')
  tail=$(tail -40 "$LOG" 2>/dev/null || true)
  RESULT="$result" MESSAGE="$message" COMMIT="$commit" SUBJECT="$subject" BRANCH="$BRANCH" TAIL="$tail" \
    node -e 'const e=process.env;require("fs").writeFileSync(process.argv[1],JSON.stringify({at:new Date().toISOString(),result:e.RESULT,message:e.MESSAGE,commit:e.COMMIT,subject:e.SUBJECT,branch:e.BRANCH,log_tail:e.TAIL},null,1))' "$STATUS_FILE" \
    && chown "$APP_USER:$APP_USER" "$STATUS_FILE" 2>/dev/null || true
}

if ! git -C "$SRC_DIR" fetch -q origin "$BRANCH" 2>>"$LOG"; then
  log "could not reach GitHub to check for updates"
  exit 0   # a network blip — try again next time, nothing to report
fi
LOCAL=$(git -C "$SRC_DIR" rev-parse HEAD)
REMOTE=$(git -C "$SRC_DIR" rev-parse "origin/$BRANCH")
# Commits made on the server and not pushed yet: leave them alone — only
# what is on GitHub is ever deployed automatically.
if [ "$LOCAL" != "$REMOTE" ] && git -C "$SRC_DIR" merge-base --is-ancestor "$REMOTE" "$LOCAL"; then exit 0; fi
# What is actually live (written by update.sh into the app folder), so a
# checkout that was pulled but never deployed is still caught.
APP_DIR="${APP_DIR:-/opt/cccs}"
LIVE=$(node -e 'try{process.stdout.write(require(process.argv[1]).commit||"")}catch{}' "$APP_DIR/VERSION.json" 2>/dev/null || true)
[ "$LOCAL" = "$REMOTE" ] && [ "$LIVE" = "$REMOTE" ] && exit 0
if [ "$(cat "$STATE_DIR/failed" 2>/dev/null)" = "$REMOTE" ]; then exit 0; fi

log "new version on $BRANCH: $(git -C "$SRC_DIR" log -1 --format='%h %s' "$REMOTE") (live: ${LIVE:-unknown})"
if [ "$LOCAL" != "$REMOTE" ] && ! git -C "$SRC_DIR" merge --ff-only -q "origin/$BRANCH" >>"$LOG" 2>&1; then
  echo "$REMOTE" >"$STATE_DIR/failed"
  log "STOPPED: $SRC_DIR has changes that are not on GitHub, so it can't simply move forward"
  status blocked "The server's copy of the code has changes that aren't on GitHub, so auto-deploy stopped. Someone needs to look on the server: cd $SRC_DIR && git status"
  exit 1
fi

if bash "$SRC_DIR/deploy/update.sh" >>"$LOG" 2>&1; then
  rm -f "$STATE_DIR/failed"
  log "deployed $(git -C "$SRC_DIR" rev-parse --short HEAD)"
  status ok "Deployed automatically."
else
  echo "$REMOTE" >"$STATE_DIR/failed"
  log "deploy FAILED — the live service was left on (or rolled back to) the previous version"
  if tail -60 "$LOG" | grep -q 'MIGRATE=1'; then
    status blocked "This version needs a database migration, which is never done automatically. Run on the server: cd $SRC_DIR && MIGRATE=1 bash deploy/update.sh"
  else
    status failed "The new version did not deploy (see the log below); the previous version is still running. Pushing a fix deploys again automatically."
  fi
  exit 1
fi
