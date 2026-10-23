#!/usr/bin/env bash
# One-time setup for auto-deploy (see deploy/autodeploy.sh). Run as root on
# the CCCS server, in the source checkout:
#
#   cd /opt/cccs-src && git pull && bash deploy/install-autodeploy.sh
#
# Installs a systemd timer that checks GitHub every 3 minutes (change with
# INTERVAL=5min) and deploys new commits on the branch this checkout is on.
#   Pause:   touch /etc/cccs/autodeploy.off       Resume: rm /etc/cccs/autodeploy.off
#   Remove:  systemctl disable --now cccs-autodeploy.timer
#   Watch:   tail -f /var/log/cccs-autodeploy.log
set -euo pipefail
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INTERVAL="${INTERVAL:-3min}"
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ -f "$SRC_DIR/deploy/update.sh" ] || { echo "run from the CCCS source checkout"; exit 1; }
git -C "$SRC_DIR" fetch -q origin || { echo "this server can't fetch from GitHub — fix that first (git fetch origin)"; exit 1; }

cat >/etc/systemd/system/cccs-autodeploy.service <<UNIT
[Unit]
Description=CCCS auto-deploy (deploys new commits from GitHub)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $SRC_DIR/deploy/autodeploy.sh
UNIT

cat >/etc/systemd/system/cccs-autodeploy.timer <<UNIT
[Unit]
Description=Check GitHub for CCCS updates every $INTERVAL

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
Persistent=true

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now cccs-autodeploy.timer
echo
echo "Auto-deploy is on: branch $(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD), checked every $INTERVAL."
echo "Results: CCCS Admin → Updates, or  tail -f /var/log/cccs-autodeploy.log"
echo "Pause:   touch /etc/cccs/autodeploy.off"
systemctl list-timers cccs-autodeploy.timer --no-pager | head -3
