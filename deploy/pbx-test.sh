#!/usr/bin/env bash
# The real click-to-dial test against FreePBX, as one command:
#
#   cd /opt/cccs-src && bash deploy/pbx-test.sh
#
# It asks for the AMI secret (not echoed, never written to disk or history),
# your desk extension and a mobile to ring, then runs a THROWAWAY copy of
# this checkout on port 4010 with an in-memory database — the live service,
# its data and /etc/cccs/cccs.env are never touched — and walks you through
# three calls, printing what CCCS recorded for each. Everything it started
# is stopped on exit, however it exits.
#
# Expected:  1 answered → ANSWERED + seconds
#            2 rejected → BUSY (or NO_ANSWER, depending on the network)
#            3 your desk phone left ringing → NO_ANSWER, cause OPERATOR_NO_ANSWER
# If the phones ring but every result stays ATTEMPTED, the AMI user is
# missing read=call: it may place calls but is not sent their outcome.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PBX_TEST_PORT:-4010}"
AMI_HOST="${AMI_HOST:-192.168.7.45}"
AMI_USERNAME="${AMI_USERNAME:-control-dial}"
B="http://127.0.0.1:$PORT"
export NODE_NO_WARNINGS=1

ss -ltn 2>/dev/null | grep -q ":$PORT " && { echo "Port $PORT is already in use — stop whatever is on it (an old test?) and retry."; exit 1; }

read -r -s -p "AMI secret for $AMI_USERNAME: " AMI_SECRET; echo
read -r -p "Your desk extension (rings first): " EXT
read -r -p "Mobile number to ring (07…): " MOBILE
[[ "$EXT" =~ ^[0-9]{2,6}$ ]] || { echo "extension must be 2-6 digits"; exit 1; }

LOG=$(mktemp /tmp/cccs-pbx-test.XXXXXX.log)
cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true; unset AMI_SECRET; echo; echo "Test server stopped. Its log: $LOG"; }
trap cleanup EXIT

( cd "$SRC_DIR" && env AMI_SECRET="$AMI_SECRET" AMI_HOST="$AMI_HOST" AMI_USERNAME="$AMI_USERNAME" PORT="$PORT" HOST=127.0.0.1 \
    PERSISTENCE=off SIMULATION=off RETENTION=off TLS_CERT_DIR=/nonexistent AUTH_SECRET="pbx-test-$RANDOM$RANDOM" \
    node server.js >"$LOG" 2>&1 ) & SRV=$!
for _ in $(seq 1 20); do sleep 0.5; curl -fsS -o /dev/null "$B/index.html" 2>/dev/null && break; done

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s||"null");const v=new Function("j","return "+process.argv[1])(j);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
T=$(curl -fsS "$B/api/auth/login" -H 'content-type: application/json' -d '{"username":"admin","password":"admin123"}' | json 'j.token')
H=(-H "authorization: Bearer $T" -H 'content-type: application/json')

echo; echo "== Can CCCS reach the PBX and Originate?"
PROBE=$(curl -sS "$B/api/contact/pbx-probe" "${H[@]}")
echo "   $PROBE"
[ "$(echo "$PROBE" | json 'j.logged_in && j.can_originate')" = "true" ] || { echo "   Not ready — fix that first (secret, permit=, or write=originate)."; exit 1; }

curl -fsS -X PATCH "$B/api/personnel/1" "${H[@]}" -d "{\"contact_phone\":\"$MOBILE\"}" >/dev/null

call() {
  local n="$1" what="$2"
  echo; read -r -p "== Call $n: $what  — press Enter to dial… " _
  local R; R=$(curl -sS -X POST "$B/api/contact/dial" "${H[@]}" -d "{\"personnel\":1,\"extension\":\"$EXT\"}")
  local ID; ID=$(echo "$R" | json 'j.id || ""')
  [ -n "$ID" ] || { echo "   Not placed: $R"; return; }
  echo "   Placed (dial_log #$ID). Your desk phone ($EXT) should ring now…"
  for _ in $(seq 1 70); do
    sleep 3
    local ROW; ROW=$(curl -sS "$B/api/personnel/1/contact-log" "${H[@]}" | json "j.find(r => r.id === $ID)")
    if [ "$(echo "$ROW" | json 'j && j.settled_at ? 1 : 0')" = "1" ]; then
      echo "   RESULT: $(echo "$ROW" | json '`${j.outcome}${j.duration_s != null ? " " + j.duration_s + "s" : ""}${j.error_code ? " (" + j.error_code + ")" : ""}`')"
      return
    fi
  done
  echo "   No outcome after 3.5 minutes — still ATTEMPTED. If the phones did ring, the AMI user probably lacks read=call."
}

call 1 "answer your desk phone, then ANSWER the mobile and talk ~10 seconds, then hang up"
call 2 "answer your desk phone, then REJECT the call on the mobile"
call 3 "do NOT answer your desk phone — let it ring out (~30s)"

echo; echo "== Everything CCCS recorded:"
curl -sS "$B/api/personnel/1/contact-log" "${H[@]}" | json 'j.map(r => `   #${r.id} ${r.outcome}${r.duration_s != null ? " " + r.duration_s + "s" : ""}${r.error_code ? " (" + r.error_code + ")" : ""}`).join("\n")'
