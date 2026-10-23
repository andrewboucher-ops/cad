#!/usr/bin/env bash
# Fills (or repairs) the "Echelon Rota" Outlook calendar from the live rota,
# today → +14 days, in one command:
#
#   cd /opt/cccs-src && sudo bash deploy/rota-calendar-sync.sh
#   cd /opt/cccs-src && sudo bash deploy/rota-calendar-sync.sh --days 28
#
# Safe to run any time, as often as you like — the service keeps running and
# nothing is duplicated. The server already does the same thing itself after
# every restart and each night at 02:00. See deploy/rota-calendar-sync.js.
set -euo pipefail
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-/etc/cccs/cccs.env}"
set -a
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
set +a
export NODE_NO_WARNINGS=1
exec node "$SRC_DIR/deploy/rota-calendar-sync.js" --db "${DATA_FILE:-/var/lib/cccs/cccs.db}" "$@"
