/**
 * AI assistance for CCCS.
 *
 * Two jobs:
 *  1. Help control room staff and officers: turn rough call notes into a job,
 *     turn an officer's rough notes into a proper incident report, and rank
 *     the nearest free units for a job.
 *  2. Give the phone agent (voice-agent/) a narrow, secret-protected way in:
 *     look up a site, raise a job, leave a message for control.
 *
 * Ground rule: the staff-facing routes only *suggest*. Nothing here writes to
 * a job or the record on a person's behalf — the console shows the suggestion,
 * and the person accepts or edits it through the normal routes, so the audit
 * trail always shows a human making the change. The phone routes are the one
 * exception, because there is no human on the call; anything they create is
 * flagged `external_source: 'ai-call'` and alerts control straight away.
 *
 * The model is reached over plain HTTPS (no SDK — CCCS has zero
 * dependencies). With no ANTHROPIC_API_KEY set the assist routes answer 503
 * and the console hides the buttons; the unit ranking is plain arithmetic and
 * works regardless.
 */
'use strict';

const API_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 30000);

/* Swappable so tests run offline: setTransport(async (request) => response). */
let transport = async (request) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST', signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(request),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`AI service error ${res.status}: ${(body.error && body.error.message) || 'unknown'}`);
    return body;
  } finally { clearTimeout(timer); }
};
const setTransport = (fn) => { transport = fn; };
const enabled = () => Boolean(process.env.ANTHROPIC_API_KEY) || transport.__fake === true;

/** Ask the model for one structured answer by forcing a single tool call. */
async function structured({ system, prompt, schema, name, maxTokens = 1500 }) {
  const out = await transport({
    model: MODEL, max_tokens: maxTokens, system,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ name, description: `Return the ${name} result.`, input_schema: schema }],
    tool_choice: { type: 'tool', name },
  });
  const block = (out.content || []).find((b) => b.type === 'tool_use' && b.name === name);
  if (!block) throw new Error('AI returned no usable answer');
  return block.input || {};
}

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const haversineM = (aLat, aLon, bLat, bLon) => {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const STYLE = 'You work for Echelon Command Information Centre Ltd, a UK commercial security company ' +
  '(alarm response, keyholding, patrols, static guarding, CCTV and fire alarm monitoring). Use UK English. ' +
  'Never invent facts: if something is not in the material you are given, leave it out or list it as missing. ' +
  'This is not a 999 service.';

function register(ctx) {
  const {
    route, db, ALL, CONTROL, PRIORITIES, httpError, logEvent, broadcast, pushToRoles,
    publicJob, nextId, instantiateChecklist, assertJobAccess, store,
  } = ctx;

  const requireAi = () => { if (!enabled()) throw httpError(503, 'AI assistant not configured (set ANTHROPIC_API_KEY)'); };
  const aiFailed = (e) => { const err = httpError(502, e.message || 'AI request failed'); return err; };

  route('GET', '/api/ai/status', ALL, () => ({ enabled: enabled(), model: enabled() ? MODEL : null }));

  /* ---- Call notes → suggested job --------------------------------------- */
  route('POST', '/api/ai/triage', CONTROL, async ({ body, user }) => {
    requireAi();
    const text = clip(body.text, 6000).trim();
    if (!text) throw httpError(400, 'text required');
    const sites = db.sites.slice(0, 400).map((s) => `${s.id} | ${s.name} | ${s.address || ''}`).join('\n');
    let r;
    try {
      r = await structured({
        name: 'job_suggestion',
        system: `${STYLE} You help a control room operator turn rough notes from a phone call or alarm into a job record.`,
        prompt: `Contracted sites (id | name | address):\n${sites || '(none)'}\n\nOperator's notes:\n"""${text}"""\n\n` +
          'Fill in the job. Priority: RED = life at risk or crime in progress; AMBER = confirmed alarm or intruder ' +
          'suspected, attend promptly; GREEN = routine response (keyholding, unconfirmed alarm); ROUTINE = can be scheduled. ' +
          'Only give site_id if the notes clearly match one of the listed sites. List anything important that is missing.',
        schema: {
          type: 'object', required: ['incident_type', 'priority', 'description'],
          properties: {
            incident_type: { type: 'string', description: 'Short label, e.g. "Alarm activation", "Intruder on site", "Keyholding response"' },
            priority: { type: 'string', enum: PRIORITIES },
            site_id: { type: ['integer', 'null'] },
            location: { type: 'string', description: 'Address or description if no site matches' },
            what3words: { type: 'string' },
            description: { type: 'string', description: 'Clear factual summary for the responding officer' },
            caller: { type: 'string', description: 'Who reported it and how to call them back' },
            missing: { type: 'array', items: { type: 'string' }, description: 'Questions the operator should still ask' },
            emergency_services: { type: 'boolean', description: 'True if police/fire/ambulance should be called now' },
          },
        },
      });
    } catch (e) { throw aiFailed(e); }
    const site = r.site_id != null ? db.sites.find((s) => s.id === Number(r.site_id)) : null;
    logEvent('ai.triage', `AI JOB SUGGESTION FOR ${user.display_name}`, { user_id: user.id });
    return {
      incident_type: clip(r.incident_type, 120) || 'Unspecified',
      priority: PRIORITIES.includes(r.priority) ? r.priority : 'GREEN',
      site_id: site ? site.id : null, site_name: site ? site.name : null,
      location: site ? '' : clip(r.location, 200),
      what3words: clip(r.what3words, 60).replace(/^\/+/, ''),
      description: clip(r.description, 2000), caller: clip(r.caller, 200),
      missing: Array.isArray(r.missing) ? r.missing.slice(0, 8).map((m) => clip(m, 200)) : [],
      emergency_services: Boolean(r.emergency_services),
    };
  });

  /* ---- Rough notes → incident report draft ------------------------------ */
  route('POST', '/api/ai/jobs/:id/report', ALL, async ({ params, body, user }) => {
    requireAi();
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    assertJobAccess(j, user);
    const notes = clip(body.notes, 6000).trim();
    const timeline = [['Created', j.created_at], ['Dispatched', j.dispatched_at], ['Acknowledged', j.acknowledged_at],
      ['En route', j.en_route_at], ['On scene', j.on_scene_at], ['Completed', j.completed_at]]
      .filter(([, t]) => t).map(([k, t]) => `${k}: ${new Date(t).toLocaleString('en-GB', { timeZone: 'Europe/London' })}`).join('\n');
    const checklist = (j.checklist || []).map((c) => `- ${c.title}: ${c.status}${c.notes ? ` — ${c.notes}` : ''}`).join('\n');
    if (!notes && !checklist.includes('—')) throw httpError(400, 'add some notes first');
    let r;
    try {
      r = await structured({
        name: 'incident_report', maxTokens: 2500,
        system: `${STYLE} You write incident reports for security officers. The report may be sent to the client and ` +
          'could be used as evidence, so keep it factual, in the first person past tense, chronological, and free of opinion or speculation. ' +
          'Use only the facts provided; do not add times, names, damage or actions that are not stated.',
        prompt: `Job ${j.reference}\nType: ${j.incident_type}\nPriority: ${j.priority}\nLocation: ${j.location}\n` +
          `Description from control: ${j.description || '—'}\nTimeline:\n${timeline || '—'}\n\nChecklist:\n${checklist || '—'}\n\n` +
          `Officer's rough notes:\n"""${notes || '(none — use the checklist notes)'}"""\n\nWrite the report and list anything a reviewer would expect that is missing.`,
        schema: {
          type: 'object', required: ['report'],
          properties: {
            report: { type: 'string', description: 'The finished report, plain text, short paragraphs' },
            missing: { type: 'array', items: { type: 'string' } },
          },
        },
      });
    } catch (e) { throw aiFailed(e); }
    logEvent('ai.report_drafted', `AI REPORT DRAFTED FOR ${j.reference}`, { job_id: j.id, user_id: user.id });
    return { report: clip(r.report, 8000), missing: Array.isArray(r.missing) ? r.missing.slice(0, 8).map((m) => clip(m, 200)) : [] };
  });

  /* ---- Nearest free units (plain distance, no model) -------------------- */
  route('GET', '/api/ai/jobs/:id/units', CONTROL, ({ params }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    if (j.lat == null || j.lon == null) return { job_located: false, units: [] };
    const speedKmh = Number(process.env.AI_ETA_SPEED_KMH || 45);
    const units = db.mdts
      .filter((m) => m.connected && m.lat != null && m.lon != null && !m.emergency)
      .map((m) => {
        const cs = db.callsigns.find((c) => c.id === m.callsign_id);
        const busy = Boolean(m.job_id) || (m.duty_status && m.duty_status !== 'AVAILABLE');
        const metres = haversineM(m.lat, m.lon, j.lat, j.lon);
        // Road distance runs ~1.3× the straight line on average; good enough to rank, not to promise.
        return { mdt: m.mdt_code, callsign: cs ? cs.name : null, available: !busy, duty_status: m.duty_status || 'AVAILABLE',
          distance_km: Math.round(metres / 100) / 10, eta_min: Math.max(1, Math.round((metres * 1.3) / 1000 / speedKmh * 60)) };
      })
      .sort((a, b) => (b.available - a.available) || (a.distance_km - b.distance_km))
      .slice(0, 5);
    return { job_located: true, units };
  });

  /* ---- Phone agent integration ------------------------------------------ */
  const assertVoice = (req) => {
    const secret = process.env.VOICE_SECRET;
    if (!secret || req.headers['x-voice-secret'] !== secret) throw httpError(401, 'bad voice secret');
  };

  // Site lookup so the agent can confirm "is that the Meridian Point site?".
  // Returns names and addresses only — never keyholder or alarm details.
  route('GET', '/api/integrations/voice/sites', null, ({ query, req }) => {
    assertVoice(req);
    const q = clip(query.get('q'), 100).toLowerCase().trim();
    if (q.length < 2) return [];
    const words = q.split(/\s+/).filter((w) => w.length > 1);
    return db.sites
      .map((s) => {
        const hay = `${s.name} ${s.address || ''}`.toLowerCase();
        return { s, score: words.filter((w) => hay.includes(w)).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ s }) => ({ id: s.id, name: s.name, address: s.address || '' }));
  });

  route('POST', '/api/integrations/voice/jobs', null, ({ body, req }) => {
    assertVoice(req);
    const callId = clip(body.call_id, 80) || null;
    if (callId) {
      const existing = db.jobs.find((x) => x.external_source === 'ai-call' && x.external_ref === callId);
      if (existing) return { __status: 200, __body: publicJob(existing) };
    }
    const priority = PRIORITIES.includes(String(body.priority || '').toUpperCase()) ? String(body.priority).toUpperCase() : 'AMBER';
    const site = body.site_id != null ? db.sites.find((s) => s.id === Number(body.site_id)) : null;
    const location = clip(body.location, 200);
    if (!site && !location) throw httpError(400, 'site_id or location required');
    const caller = [clip(body.caller_name, 80), clip(body.caller_number, 30)].filter(Boolean).join(', ');
    const now = new Date().toISOString();
    const j = {
      id: nextId('jobs'), reference: `INC-${new Date().getFullYear()}-${String(nextId('jobref') + 124).padStart(5, '0')}`,
      incident_type: clip(body.incident_type, 120) || 'Phone report', priority,
      location: site ? `${site.name}, ${site.address}` : location,
      site_id: site ? site.id : null, keyholder: site ? site.keyholder : '',
      lat: site && site.lat != null ? site.lat : null, lon: site && site.lon != null ? site.lon : null,
      description: `${clip(body.description, 1800)}\n\n[Taken by the AI phone assistant — confirm details with the caller before dispatch.]`,
      caller: caller || 'Unknown caller', required_resources: 1, what3words: '',
      notes: body.transcript ? `Call transcript:\n${clip(body.transcript, 8000)}` : '',
      status: 'CREATED', created_by: null, created_at: now, updated_at: now,
      external_source: 'ai-call', external_ref: callId,
      checklist: instantiateChecklist(site), media: [],
    };
    db.jobs.push(j);
    broadcast('job.created', publicJob(j));
    pushToRoles(CONTROL, { title: `New job from phone — ${priority}`, body: `${j.reference} · ${j.incident_type} · ${j.location}`, url: '/control.html', tag: 'cccs-job' });
    logEvent('job.created', `JOB ${j.reference} CREATED (${priority}) — via AI phone assistant`, { job_id: j.id, call_id: callId });
    store.flushNow();
    return { __status: 201, __body: { id: j.id, reference: j.reference, priority: j.priority } };
  });

  route('POST', '/api/integrations/voice/messages', null, ({ body, req }) => {
    assertVoice(req);
    const callId = clip(body.call_id, 80) || null;
    if (callId) {
      const existing = db.messages.find((m) => m.ai_call_id === callId);
      if (existing) return { __status: 200, __body: existing };
    }
    const text = clip(body.message, 900).trim();
    if (!text) throw httpError(400, 'message required');
    const who = [clip(body.caller_name, 80), clip(body.caller_number, 30)].filter(Boolean).join(', ') || 'unknown caller';
    const msg = {
      id: nextId('messages'), body: `Phone message from ${who}: ${text}`.slice(0, 1000),
      from_label: 'AI PHONE', from_personnel_id: null, from_mdt_id: null,
      to_personnel_id: null, to_mdt_id: null, to_label: 'CONTROL',
      state: 'DELIVERED', sent_at: new Date().toISOString(), read_at: null, ai_call_id: callId,
    };
    db.messages.push(msg);
    broadcast('message.received', msg);
    pushToRoles(CONTROL, { title: 'Phone message', body: msg.body.slice(0, 120), url: '/control.html', tag: 'cccs-msg' });
    logEvent('message.sent', `AI PHONE ✉ CONTROL: ${msg.body.slice(0, 60)}`, { message_id: msg.id, call_id: callId });
    return { __status: 201, __body: msg };
  });
}

module.exports = { register, setTransport, structured, enabled, haversineM };
