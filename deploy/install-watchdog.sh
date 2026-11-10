#!/usr/bin/env bash
# Installs (or refreshes) cccs-watchdog: a check every 2 minutes that texts
# and emails ALERT_SMS / ALERT_EMAIL (from /etc/cccs/cccs.env) when CCCS goes
# down, backups stop or don't leave the server, or the disk fills. Safe to
# run again — install.sh and update.sh both call it. Until ALERT_EMAIL or
# ALERT_SMS is set it only writes to its log (journalctl -u cccs-watchdog).
#
#   bash deploy/install-watchdog.sh
set -euo pipefail
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

install -d -m 755 /usr/local/lib/cccs
install -m 644 "$SRC_DIR/deploy/watchdog.js" /usr/local/lib/cccs/watchdog.js
cat > /usr/local/bin/cccs-watchdog <<SH
#!/bin/sh
exec "$NODE_BIN" /usr/local/lib/cccs/watchdog.js "\$@"
SH
chmod 755 /usr/local/bin/cccs-watchdog

cat > /etc/systemd/system/cccs-watchdog.service <<UNIT
[Unit]
Description=CCCS watchdog (down, backup and disk alerts)
After=network-online.target
[Service]
Type=oneshot
Environment=NODE_NO_WARNINGS=1
ExecStart=/usr/local/bin/cccs-watchdog
TimeoutStartSec=120
UNIT
cat > /etc/systemd/system/cccs-watchdog.timer <<UNIT
[Unit]
Description=Check CCCS every 2 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=2min
AccuracySec=15s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now cccs-watchdog.timer >/dev/null
echo "==> Watchdog installed (every 2 minutes). Send a test alert with: cccs-watchdog --test"
