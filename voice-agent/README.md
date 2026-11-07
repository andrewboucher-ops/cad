# Echelon AI phone assistant

Picks up calls to the control room ring group that nobody has answered after
2 minutes. It tells the caller it is an automated assistant, then:

- **Something needs a response at one of our sites** (alarm, intruder, damage,
  keyholder or lock-up): it confirms the site, takes the details and a callback
  number, and raises a job in CCCS. The job is flagged *via AI phone assistant*,
  carries the call transcript in its notes, and alerts control by push.
- **Anyone in danger, a crime happening now, or fire**: it tells the caller to
  dial 999, raises a RED job, and puts them through to the on-call phone.
- **Wants a person, or anything it can't handle**: puts them through to on-call.
- **Everything else** (quotes, new business, billing, messages): leaves a
  message in the CCCS control inbox with their name and callback number.

If the AI, the speech service or CCCS fails mid-call, the caller is put through
to on-call rather than dropped. If the caller hangs up before details are
complete, whatever they said is still left as a message.

It never gives out site security information (alarm codes, keyholders, rotas,
whether a site is empty), never quotes prices or response times, and the
transfer number is fixed in the dialplan, not chosen by the AI.

## What it needs

| | |
|---|---|
| Phone system | FreePBX 16/17 (Asterisk 18+) with `app_audiosocket` and `func_curl` |
| Server | Node 22 on Echelon-Server (same VM/container as CCCS is fine; no GPU needed) |
| Claude API key | console.anthropic.com — Haiku is used for calls (fast, cheap) |
| Deepgram API key | deepgram.com — speech-to-text and the voice, on its EU endpoint |

Running cost is roughly 2–4p per minute of call (speech + AI), only for calls
it actually answers.

## Set-up

1. **CCCS**: add to `/etc/cccs/cccs.env`, then `systemctl restart cccs`:
   ```
   VOICE_SECRET=<long random string, e.g. from: openssl rand -hex 32>
   ANTHROPIC_API_KEY=<key>      # also switches on the staff AI buttons
   ```
2. **Agent**: copy `.env.example` to `/etc/cccs/voice-agent.env`, fill it in
   (same `VOICE_SECRET`), then:
   ```
   cp voice-agent/echelon-voice-agent.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now echelon-voice-agent
   curl http://127.0.0.1:8091/health        # → ok
   ```
3. **FreePBX dialplan**: append `asterisk/extensions_custom.conf` to
   `/etc/asterisk/extensions_custom.conf`, and add `AI_HOST` and `AI_ONCALL`
   to `/etc/asterisk/globals_custom.conf`. Then `fwconsole reload`.
4. **FreePBX GUI**:
   - *Admin → Custom Destinations → Add*: Target `echelon-ai-agent,s,1`,
     Description `Echelon AI assistant`.
   - *Applications → Ring Groups →* the control room group: **Ring Time 120**,
     *Destination if no answer* → Custom Destinations → `Echelon AI assistant`.
   - Submit, Apply Config.
5. **Test**: ring the control number from a mobile and let it ring out. Try an
   alarm at a real site, a quote request, and "can I speak to someone". Check
   the job and message appear in CCCS.

Ports 8091 and 9092 must only be reachable from the PBX. Don't forward them
through the router; if the agent runs on a different host from FreePBX, allow
them from the PBX's IP only.

## Changing what it says

The greeting, rules and wording are in `prompt.js`. Restart the service after
editing: `systemctl restart echelon-voice-agent`.

## Data protection

Call audio is streamed to Deepgram (EU) for transcription and the transcript
to Anthropic for the reply. Neither is recorded by the agent; the transcript is
kept on the CCCS job or message under CCCS's normal retention. Add both to the
processor list in `docs/PRIVACY.md` and your ROPA, and mention automated call
handling in your privacy notice.
