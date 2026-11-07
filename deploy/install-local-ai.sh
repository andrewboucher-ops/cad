#!/usr/bin/env bash
# Builds the free local AI for "Write it up for me" (see docs/LOCAL-AI.md).
# Run this on the PROXMOX HOST shell (not inside a container):
#
#   pct exec 140 -- cat /opt/cccs-src/deploy/install-local-ai.sh > /root/install-local-ai.sh && bash /root/install-local-ai.sh
#
# What it does:
#   1. Creates Debian 12 container CT 220 "local-ai" at 192.168.7.202, using
#      the same disk storage, network bridge and gateway as CCCS (CT 140).
#   2. Installs Ollama in it and downloads the model (qwen2.5:7b, or the
#      smaller qwen2.5:3b if the host is short of memory).
#   3. Firewalls port 11434 so only CCCS (and the container itself) can use it.
#   4. Adds LOCAL_AI_URL (and LOCAL_AI_MODEL) to CT 140's /etc/cccs/cccs.env
#      and restarts CCCS.
# Safe to run again: steps already done are skipped.
#
# Override with env vars, e.g.  CTID=221 AI_IP=192.168.7.203 bash /root/install-local-ai.sh
set -euo pipefail

CTID="${CTID:-220}"
AI_IP="${AI_IP:-192.168.7.202}"
CCCS_CT="${CCCS_CT:-140}"
DISK_GB="${DISK_GB:-40}"
PORT=11434

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

command -v pct >/dev/null || die "Run this on the Proxmox host shell, not inside a container."
pct status "$CCCS_CT" >/dev/null 2>&1 || die "CCCS container $CCCS_CT not found."

# ---- What we copy from CT 140 -------------------------------------------
CCCS_CONF="$(pct config "$CCCS_CT")"
STORAGE="$(sed -n 's/^rootfs: \([^:]*\):.*/\1/p' <<<"$CCCS_CONF")"
NET0="$(sed -n 's/^net0: //p' <<<"$CCCS_CONF")"
BRIDGE="$(tr ',' '\n' <<<"$NET0" | sed -n 's/^bridge=//p')"
GW="${GW:-$(tr ',' '\n' <<<"$NET0" | sed -n 's/^gw=//p')}"
CCCS_IP="${CCCS_IP:-$(tr ',' '\n' <<<"$NET0" | sed -n 's/^ip=\([0-9.]*\)\/.*/\1/p')}"
PREFIX="${PREFIX:-$(tr ',' '\n' <<<"$NET0" | sed -n 's/^ip=[0-9.]*\/\([0-9]*\).*/\1/p')}"
# CT 140 on DHCP has no gw= or ip= in its config: use the host's own
# default route (same LAN) and ask the container for its current address.
[ -n "$GW" ] || GW="$(ip route | awk '/^default/ {print $3; exit}')"
[ -n "$CCCS_IP" ] || CCCS_IP="$(pct exec "$CCCS_CT" -- hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$PREFIX" ] || PREFIX="$(ip -o -4 addr show | awk -v gw="${GW%.*}." 'index($4, gw) == 1 {split($4, a, "/"); print a[2]; exit}')"
[ -n "$GW" ] || die "Could not find the network gateway. Run again with GW=<router address>."
[ -n "$CCCS_IP" ] || die "Could not find CT $CCCS_CT's address. Run again with CCCS_IP=<its address>."
PREFIX="${PREFIX:-24}"

# ---- Size it to the host ------------------------------------------------
AVAIL_MB="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
HOST_CORES="$(nproc)"
CORES=$(( HOST_CORES > 4 ? HOST_CORES - 2 : 2 )); [ "$CORES" -gt 8 ] && CORES=8
if [ -n "${MODEL:-}" ]; then MEM_MB="${MEM_MB:-10240}"
elif [ "$AVAIL_MB" -ge 13000 ]; then MODEL="qwen2.5:7b"; MEM_MB=10240
elif [ "$AVAIL_MB" -ge 7000 ]; then MODEL="qwen2.5:3b"; MEM_MB=6144
else die "Only ${AVAIL_MB} MB of memory free on this host; the local AI needs at least 7000 MB. CCCS will keep using the template drafter."
fi
say "Host has ${AVAIL_MB} MB free and ${HOST_CORES} cores: CT $CTID gets ${MEM_MB} MB, ${CORES} cores, model ${MODEL}"
say "Copying from CT $CCCS_CT: storage ${STORAGE}, bridge ${BRIDGE}, gateway ${GW}, CCCS at ${CCCS_IP}"

# ---- 1. Container ---------------------------------------------------------
if pct status "$CTID" >/dev/null 2>&1; then
  pct config "$CTID" | grep -q "^hostname: local-ai" || die "CT $CTID already exists and is not local-ai. Run again with CTID=<free id>."
  say "CT $CTID (local-ai) already exists, reusing it"
else
  if ping -c1 -W1 "$AI_IP" >/dev/null 2>&1; then die "$AI_IP is already in use. Run again with AI_IP=<free address>."; fi
  say "Finding the Debian 12 template"
  pveam update >/dev/null || true
  TEMPLATE="$(pveam list local 2>/dev/null | awk '/debian-12-standard/ {print $1}' | sort | tail -1)"
  if [ -z "$TEMPLATE" ]; then
    NAME="$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort | tail -1)"
    [ -n "$NAME" ] || die "No Debian 12 template available from pveam."
    say "Downloading $NAME"
    pveam download local "$NAME"
    TEMPLATE="local:vztmpl/$NAME"
  fi
  say "Creating CT $CTID"
  pct create "$CTID" "$TEMPLATE" \
    --hostname local-ai --cores "$CORES" --memory "$MEM_MB" --swap 1024 \
    --rootfs "${STORAGE}:${DISK_GB}" \
    --net0 "name=eth0,bridge=${BRIDGE},ip=${AI_IP}/${PREFIX},gw=${GW}" \
    --unprivileged 1 --features nesting=1 --onboot 1 \
    --description "Ollama local AI for CCCS report writing (deploy/install-local-ai.sh)"
fi
pct status "$CTID" | grep -q running || pct start "$CTID"
for _ in $(seq 1 30); do pct exec "$CTID" -- true 2>/dev/null && break; sleep 2; done
for _ in $(seq 1 30); do pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break; sleep 2; done

# ---- 2. Ollama --------------------------------------------------------------
say "Installing packages"
pct exec "$CTID" -- bash -c 'export DEBIAN_FRONTEND=noninteractive
  echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
  apt-get update -qq && apt-get install -y -qq curl ca-certificates zstd iptables iptables-persistent >/dev/null'

if pct exec "$CTID" -- test -x /usr/local/bin/ollama; then say "Ollama already installed"
else say "Installing Ollama"; pct exec "$CTID" -- bash -c 'curl -fsSL https://ollama.com/install.sh | sh'; fi

pct exec "$CTID" -- bash -c "mkdir -p /etc/systemd/system/ollama.service.d && printf '[Service]\nEnvironment=\"OLLAMA_HOST=0.0.0.0:${PORT}\"\nEnvironment=\"OLLAMA_KEEP_ALIVE=30m\"\nEnvironment=\"OLLAMA_NUM_PARALLEL=1\"\n' > /etc/systemd/system/ollama.service.d/override.conf && systemctl daemon-reload && systemctl enable --now ollama >/dev/null 2>&1; systemctl restart ollama"
for _ in $(seq 1 30); do pct exec "$CTID" -- curl -fs "http://127.0.0.1:${PORT}/api/version" >/dev/null 2>&1 && break; sleep 2; done

say "Downloading ${MODEL} (a few GB, takes a few minutes)"
pct exec "$CTID" -- ollama pull "$MODEL"

# ---- 3. Firewall: only CCCS may use it ------------------------------------
say "Firewalling port ${PORT} to CCCS (${CCCS_IP}) only"
pct exec "$CTID" -- bash -c "iptables -S INPUT | grep -q 'dport ${PORT}' || {
  iptables -A INPUT -p tcp --dport ${PORT} -s ${CCCS_IP} -j ACCEPT
  iptables -A INPUT -p tcp --dport ${PORT} -s 127.0.0.1 -j ACCEPT
  iptables -A INPUT -p tcp --dport ${PORT} -j DROP
  netfilter-persistent save >/dev/null; }"

# ---- 4. Point CCCS at it ---------------------------------------------------
say "Checking CCCS can reach it"
TAGS="$(pct exec "$CCCS_CT" -- curl -fs --max-time 10 "http://${AI_IP}:${PORT}/api/tags" || true)"
grep -q "${MODEL%%:*}" <<<"$TAGS" \
  || die "CT $CCCS_CT cannot reach http://${AI_IP}:${PORT}. Nothing changed in cccs.env."

say "Warming the model up (first answer is slow)"
pct exec "$CTID" -- bash -c "curl -fs --max-time 300 http://127.0.0.1:${PORT}/api/generate -d '{\"model\":\"${MODEL}\",\"prompt\":\"Say OK.\",\"stream\":false}' >/dev/null" || true

say "Updating /etc/cccs/cccs.env in CT $CCCS_CT"
pct exec "$CCCS_CT" -- bash -c "f=/etc/cccs/cccs.env; cp \$f \$f.bak-local-ai
  sed -i '/^LOCAL_AI_URL=/d;/^LOCAL_AI_MODEL=/d' \$f
  printf 'LOCAL_AI_URL=http://${AI_IP}:${PORT}\nLOCAL_AI_MODEL=${MODEL}\n' >> \$f
  systemctl restart cccs"
sleep 3
pct exec "$CCCS_CT" -- systemctl is-active cccs >/dev/null || die "CCCS did not restart. The old settings are in /etc/cccs/cccs.env.bak-local-ai in CT $CCCS_CT."

say "Done. Local AI is CT ${CTID} at http://${AI_IP}:${PORT} running ${MODEL}."
echo "    Test it: officer app > Incident report > Write it up for me. It should say 'Written by the local AI'."
