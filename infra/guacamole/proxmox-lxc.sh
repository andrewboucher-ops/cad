#!/usr/bin/env bash
# Creates a dedicated Proxmox LXC container for Guacamole and installs it.
# Run as root ON THE PROXMOX HOST, from this folder:
#
#   bash proxmox-lxc.sh <ctid> <ip/cidr> <gateway> <domain> [bridge] [storage]
#   bash proxmox-lxc.sh 150 192.168.1.150/24 192.168.1.1 remote.yourdomain.com
#
# Docker runs inside an unprivileged container, which needs nesting and keyctl.
set -euo pipefail

CTID="${1:-}"; IP="${2:-}"; GW="${3:-}"; DOMAIN="${4:-}"
BRIDGE="${5:-vmbr0}"; STORAGE="${6:-local-lvm}"

if [[ -z "$CTID" || -z "$IP" || -z "$GW" || -z "$DOMAIN" ]]; then
  sed -n '2,7p' "$0"; exit 1
fi
if ! command -v pct &>/dev/null; then echo "Run this on the Proxmox host."; exit 1; fi
if pct status "$CTID" &>/dev/null; then echo "Container $CTID already exists."; exit 1; fi
cd "$(dirname "$0")"

echo "==> Finding a Debian 12 template"
pveam update >/dev/null
TEMPLATE=$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)
[[ -n "$TEMPLATE" ]] || { echo "No Debian 12 template found."; exit 1; }
pveam list local | grep -q "$TEMPLATE" || pveam download local "$TEMPLATE"

echo "==> Creating container $CTID ($IP)"
pct create "$CTID" "local:vztmpl/$TEMPLATE" \
  --hostname guacamole \
  --cores 2 --memory 4096 --swap 1024 \
  --rootfs "$STORAGE:20" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=$IP,gw=$GW" \
  --unprivileged 1 \
  --features nesting=1,keyctl=1 \
  --onboot 1 \
  --start 1

# Prefer IPv4: on networks where DNS returns IPv6 addresses but IPv6 doesn't
# route, apt and curl otherwise hang trying them.
pct exec "$CTID" -- bash -c 'echo "Acquire::ForceIPv4 \"true\";" > /etc/apt/apt.conf.d/99force-ipv4
  grep -q "^precedence ::ffff:0:0/96" /etc/gai.conf 2>/dev/null || echo "precedence ::ffff:0:0/96  100" >> /etc/gai.conf'

echo "==> Waiting for network"
ONLINE=no
for _ in $(seq 1 30); do
  if pct exec "$CTID" -- timeout 5 bash -c "</dev/tcp/deb.debian.org/80" &>/dev/null; then ONLINE=yes; break; fi
  sleep 2
done
if [[ $ONLINE != yes ]]; then
  echo "Container $CTID can't reach the internet (deb.debian.org:80). Check its IP, gateway and DNS:"
  echo "  pct exec $CTID -- bash -c 'ip -4 addr; ip route; cat /etc/resolv.conf'"
  exit 1
fi

echo "==> Copying the kit into the container"
tar czf /tmp/guacamole-kit.tgz --exclude=proxmox-lxc.sh .
pct exec "$CTID" -- mkdir -p /root/guacamole-kit
pct push "$CTID" /tmp/guacamole-kit.tgz /root/guacamole-kit.tgz
pct exec "$CTID" -- tar xzf /root/guacamole-kit.tgz -C /root/guacamole-kit
rm -f /tmp/guacamole-kit.tgz

echo "==> Installing Guacamole inside the container"
pct exec "$CTID" -- bash -c "apt-get update && apt-get install -y curl ca-certificates openssl"
pct exec "$CTID" -- bash /root/guacamole-kit/install.sh "$DOMAIN"

echo
echo "Container $CTID is running Guacamole at ${IP%/*}. Shell into it with: pct enter $CTID"
