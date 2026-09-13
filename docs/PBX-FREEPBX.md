# FreePBX integration — dial 9 for an outside line

How the CCCS radios reach the telephone network, and how phone calls reach a radio.

**Status:** the gateway code in `pbx.js` has not been run against a live PBX from
this build. The default driver is `simulated` — it drives the full call lifecycle
with no media, which is what the automated tests exercise. Switching to
`asterisk` gives you real code paths against ARI that you should expect to debug.
Everything below is the configuration you need on the FreePBX side.

---

## The shape of it

```
radio ──WebRTC──▶ CCCS ──ARI originate──▶ Asterisk ──trunk──▶ PSTN
                    │
                    └── radio-to-radio and talkgroup PTT never touch the PBX
```

Radios do not speak SIP. Each radio has a PJSIP extension on FreePBX, and CCCS
originates and bridges channels on its behalf. That keeps the dialplan, trunk
credentials, CDR and call recording on the PBX, where your existing tooling and
retention policy already live. It also means a compromised handset cannot dial
out on its own — it can only ask CCCS to, and CCCS logs every request.

The alternative — a SIP stack inside each handset — means credentials on every
device, NAT traversal per device, and no central control of what can be dialled.
For a fleet, don't.

---

## 1. Extensions

One PJSIP extension per radio. In FreePBX: **Applications → Extensions → Add New
PJSIP Extension**.

| Radio | ISSI | Extension |
|---|---|---|
| A101 | 234100001 | 9001 |
| A102 | 234100002 | 9002 |
| A103 | 234100003 | 9003 |

CCCS seeds `pbx_extension` as `9000 + n`; match these or set them explicitly when
creating radios. Under **Advanced** on each extension:

- Transport: `0.0.0.0-wss` (WebRTC transport)
- Enable AVPF: yes · Enable ICE Support: yes · Enable DTLS: yes
- DTLS Setup: `actpass` · Media Encryption: `SRTP via in-SDP`
- Media Use Received Transport: yes · RTCP Mux: yes

Those seven settings are the ones people miss; without them the WebRTC leg
negotiates and then sits silent.

## 2. ARI user

**Settings → Asterisk REST Interface Users → Add**. Username `cccs`, a strong
password, and note the port (8088 by default, 8089 for TLS — use TLS).

In `/etc/asterisk/http_custom.conf`:

```
[general]
enabled=yes
bindaddr=127.0.0.1      ; or the interface CCCS reaches it on
tlsenable=yes
tlsbindaddr=0.0.0.0:8089
tlscertfile=/etc/asterisk/keys/fullchain.pem
tlsprivatekey=/etc/asterisk/keys/privkey.pem
```

Bind ARI to localhost or a private interface. It is a full control API for your
phone system; it does not belong on the internet.

## 3. Outbound route

You almost certainly already have one. CCCS strips the leading `9` itself and
passes the bare number, so your outbound route patterns do not need a `9`
prefix — set `PBX_OUTBOUND_CONTEXT` to the context your route uses
(`from-internal` is the usual FreePBX answer).

If you would rather the PBX strip the 9, set `PSTN_PREFIX=` empty in CCCS and
pass the digits through untouched. Pick one; doing it in both places is how you
end up dialling `020` as `20`.

## 4. Inbound DDI to a radio

Add to `/etc/asterisk/extensions_custom.conf`:

```
[cccs-inbound]
exten => _X.,1,NoOp(CCCS inbound to ${EXTEN})
 same => n,Set(CURL_RESULT=${CURL(https://cccs.yourdomain.example/api/pbx/inbound,\
   {"to":"${EXTEN}","caller_id":"${CALLERID(num)}","channel_id":"${CHANNEL(name)}"})})
 same => n,NoOp(CCCS said ${CURL_RESULT})
 same => n,Dial(PJSIP/9001,30)
 same => n,Hangup()
```

`CURL()` cannot set headers, so for the shared secret either use a small AGI
script, or front CCCS with nginx and inject `X-PBX-Secret` there for that path
only. Do not drop the secret check — that endpoint rings handsets.

Point your inbound route at this context.

## 5. CCCS configuration

```bash
PBX_MODE=asterisk
ARI_URL=https://pbx.internal:8089
ARI_USER=cccs
ARI_PASSWORD=…                 # from a secret store, not the compose file
ARI_APP=cccs
PBX_OUTBOUND_CONTEXT=from-internal
PSTN_PREFIX=9
PBX_SECRET=…                   # must match what the dialplan sends
```

With `PBX_MODE` unset or `simulated`, everything runs without a PBX.

---

## Test order

Work through these in order; each one isolates a different failure.

1. `curl -u cccs:pass https://pbx:8089/ari/asterisk/info` — ARI reachable and authenticated.
2. Register a softphone (Zoiper, Linphone) as extension 9001 over WSS. If this
   fails, the extension's WebRTC settings are wrong, not CCCS.
3. Dial an outside number from that softphone. If this fails, it's the outbound route.
4. Only now try dial-9 from a radio. If 1–3 pass and this doesn't, it's `pbx.js`.
5. Inbound: call your DDI and watch `asterisk -rvvv` alongside the CCCS log.

## Things that will bite you

- **Codecs.** Browsers do Opus; many trunks do G.711 only. Asterisk transcodes,
  which costs CPU per concurrent call. Budget for it, or negotiate Opus with your
  SIP provider.
- **TURN.** Roughly a third of mobile-network sessions won't establish
  peer-to-peer. You need coturn with credentials, and radio-to-radio audio needs
  it just as much as PBX calls. Set `ICE_SERVERS` in CCCS accordingly.
- **Emergency calls.** If anyone might dial 999 or 112 from a handset, that is a
  regulated path with location and reliability obligations. Decide deliberately
  whether to allow it, and if you do, talk to your provider about it rather than
  letting it work by accident through the outbound route.
- **Fleet growth.** One extension per radio means provisioning at scale. Script it
  against the FreePBX API before you get past about thirty radios.
