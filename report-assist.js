/**
 * Report writing help: "Write it up for me" on the officer's report forms.
 *
 * The officer jots down what happened in any order. This turns the notes
 * into suggested answers for the form's text boxes (What happened, What
 * you did straight away, People involved, …). It only suggests: nothing is
 * saved here. The answers appear in the form, the officer checks and edits
 * them, signs the statement of truth and submits as normal, so the report
 * is still the officer's own account.
 *
 * Two drafters, both free to run:
 *   1. A local AI model through Ollama on our own Proxmox (LOCAL_AI_URL,
 *      e.g. http://192.168.7.202:11434). Nothing leaves the network and
 *      there is no per-use fee. See docs/LOCAL-AI.md for the LXC set-up.
 *   2. A template drafter (plain code, no AI). It tidies the notes into
 *      sentences ("arrived 2215" → "I arrived at 22:15."), sorts them into
 *      the right boxes by keyword and opens with the job's own details.
 *      Used when LOCAL_AI_URL is not set, or when the AI is down, slow,
 *      busy or gives an unusable answer, so the officer always gets a draft.
 *
 * Guard rails:
 *   - Only text boxes, short text fields and pick lists are filled. Tick
 *     boxes (RIDDOR, data breach, force used…), times, signatures and the
 *     SIA licence are left for the officer.
 *   - Any number or time in an AI draft that is not in the notes or the job
 *     record is listed back as "check these", since a small model can
 *     invent details.
 *   - Notes and drafts are not stored or logged; the audit log records only
 *     that a draft was made, for which form and by which drafter.
 *
 * Registrar pattern: server.js passes in what this needs.
 */
'use strict';

const crypto = require('node:crypto');

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const londonTime = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'short', timeStyle: 'short' });
const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });

/* Field ids the drafter must never fill, whatever their type. */
const NEVER_FILL = /licence|signature|statement_true|reference$|_ref$/;

/** The form fields a draft may fill: text boxes, short text and pick lists. */
function fillableFields(def) {
  return (def.fields || []).filter((f) => ['textarea', 'text', 'select'].includes(f.type) && !NEVER_FILL.test(f.id));
}

/* ---- Template drafter (no AI) ------------------------------------------ */

const PAST_VERBS = new Set(('arrived attended found saw noticed spoke asked told advised informed called rang phoned contacted ' +
  'checked searched patrolled walked drove went left secured locked unlocked closed opened reset set isolated silenced ' +
  'escorted removed detained restrained moved waited met handed gave took made reported recorded logged photographed ' +
  'requested confirmed returned completed cleared heard approached challenged explained warned followed observed watched ' +
  'stayed remained entered exited tried attempted used applied administered treated helped assisted').split(' '));
const ACTION_VERBS = /\b(secured|locked|reset|set|isolated|silenced|rang|called|phoned|contacted|informed|advised|told|escorted|removed|detained|restrained|reported|handed|requested|administered|treated|closed|cleared|evacuated|first aid|999)\b/i;
const PEOPLE_WORDS = /\b(male|female|man|men|woman|women|youths?|kids?|teenagers?|boy|girl|person|people|individual|suspects?|offenders?|ip|aged|wearing|hoodie|tall|short|build)\b/i;
const WITNESS_WORDS = /\bwitness(es|ed)?\b/i;

/* Keyword → incident-report "Type" option. First match wins. */
const TYPE_RULES = [
  [/\b(assault(ed)?|punch(ed)?|kick(ed)?|hit me|attacked)\b/i, 'Assault'],
  [/\b(threat(ened|s)?|abus(e|ive)|aggressive|spat)\b/i, 'Violence or threats to staff'],
  [/\b(stole|stolen|theft|shoplift(ing|er)?|took .* without)\b/i, 'Theft'],
  [/\b(smashed|broken window|damaged?|graffiti|vandal(ism|ised)?|forced)\b/i, 'Criminal damage'],
  [/\b(fire(?!\s*(door|exit|escape|extinguisher))|smoke|alarm activation)\b/i, 'Fire or alarm'],
  [/\b(trespass(ing|ers?)?|intruders?|on the roof|climbed)\b/i, 'Trespass'],
  [/\b(youths?|asb|anti.?social|drinking|noise)\b/i, 'Anti-social behaviour'],
  [/\b(collapsed|unconscious|ambulance|medical|seizure|fitting)\b/i, 'Medical'],
  [/\b(slipped|tripped|fell|injur(ed|y)|cut (his|her|their|my))\b/i, 'Injury or accident'],
  [/\b(suspicious|loitering|acting strangely)\b/i, 'Suspicious activity'],
  [/\b(lost|found) (property|wallet|phone|bag|keys)\b/i, 'Lost or found property'],
  [/\b(alarm)\b/i, 'Fire or alarm'],
];

/** "2215" / "22.15" / "10pm" / "10:30 am" → "22:15" style, inside free text. */
function tidyTimes(s) {
  return s
    .replace(/\b(\d{1,2})[:.]?(\d{2})\s*(am|pm)\b/gi, (m, h, mm, ap) => `${String((Number(h) % 12) + (/pm/i.test(ap) ? 12 : 0)).padStart(2, '0')}:${mm}`)
    .replace(/\b(\d{1,2})\s*(am|pm)\b/gi, (m, h, ap) => `${String((Number(h) % 12) + (/pm/i.test(ap) ? 12 : 0)).padStart(2, '0')}:00`)
    .replace(/\b([01]\d|2[0-3])\.?([0-5]\d)(\s*hrs|\s*hours|h)?\b(?![.:]\d)/gi, (m, h, mm, suffix, off, str) => {
      // Leave phone numbers, years and reference numbers alone: only a bare
      // 4-digit group (or 22.15) that is not part of a longer number.
      const before = str[off - 1] || '', after = str[off + m.length] || '';
      if (/\d/.test(before) || /\d/.test(after)) return m;
      if (/^(19|20)\d\d$/.test(m) && !suffix && !/\./.test(m)) return m; // looks like a year
      // "ref 1234", "crime no. 2215", "unit 1430", "pin 0930": a number, not a time.
      if (/\b(ref|reference|no|number|log|crime|cad|incident|job|room|unit|flat|ext|extension|code|pin|zone|bay|gate|door|reg)\b\.?\s*[:#]?\s*$/i.test(str.slice(Math.max(0, off - 20), off))) return m;
      return `${h}:${mm}`;
    });
}

/** Rough notes → tidy first-person sentences, in the order written. */
function sentences(notes) {
  return tidyTimes(String(notes || ''))
    .split(/\n+|(?<=[.!?])\s+|;\s*|,\s*|\s+-\s+/)
    .map((s) => s.replace(/\s+/g, ' ').replace(/^[-*•\s]+/, '').replace(/[.,;\s]+$/, '').trim())
    .filter((s) => s.length > 1)
    .map((s) => {
      let out = s;
      const first = out.split(' ')[0].toLowerCase();
      if (PAST_VERBS.has(first)) out = `I ${out.charAt(0).toLowerCase()}${out.slice(1)}`;
      // "I arrived 22:15" → "I arrived at 22:15"
      // "I arrived 22:15" / "I rang keyholder 22:30" → "… at 22:15"
      out = out.replace(/([a-z]) (\d{2}:\d{2})\b/gi, (m, c, t, off, str) => (/\b(at|by|until|from|to|before|after|around|about)$/i.test(str.slice(0, off + 1)) ? m : `${c} at ${t}`));
      out = out.replace(/\bi\b/g, 'I');
      return `${out.charAt(0).toUpperCase()}${out.slice(1)}.`;
    });
}

/** Which box a template draft puts the narrative in for this form. */
function narrativeField(fields) {
  return fields.find((f) => f.type === 'textarea' && /^(description|what_happened|narrative)$/.test(f.id))
    || fields.find((f) => f.type === 'textarea' && f.required)
    || fields.find((f) => f.type === 'textarea');
}

function templateDraft(def, notes, ctx) {
  const fields = fillableFields(def);
  const byId = Object.fromEntries(fields.map((f) => [f.id, f]));
  const lines = sentences(notes);
  const values = {};

  const intro = [];
  if (ctx.kind === 'job') {
    const at = ctx.on_scene_at || ctx.en_route_at || ctx.dispatched_at;
    intro.push(`${at ? `At ${hhmm(at)} on ${new Date(at).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })} I` : 'I'} attended ${ctx.location} in response to job ${ctx.reference} (${ctx.incident_type}).`);
    if (ctx.description) intro.push(`Control's description: ${ctx.description.replace(/\s+/g, ' ').replace(/[.\s]+$/, '')}.`);
  } else if (ctx.kind === 'visit') {
    const at = ctx.on_scene_at || ctx.scheduled_for;
    intro.push(`${at ? `At ${hhmm(at)} on ${new Date(at).toLocaleDateString('en-GB', { timeZone: 'Europe/London' })} I` : 'I'} was at ${ctx.location} on site visit ${ctx.reference}.`);
  } else if (ctx.kind === 'site') {
    intro.push(`I was on duty at ${ctx.location}.`);
  }

  const narrative = narrativeField(fields);
  if (narrative) values[narrative.id] = [...intro, ...lines].join(' ').trim();

  const actionField = fields.find((f) => f.type === 'textarea' && /action/.test(f.id) && f !== narrative);
  if (actionField) {
    const acts = lines.filter((s) => ACTION_VERBS.test(s));
    if (acts.length) values[actionField.id] = acts.join(' ');
  }
  if (byId.persons_involved) {
    const ppl = lines.filter((s) => PEOPLE_WORDS.test(s));
    if (ppl.length) values.persons_involved = ppl.join(' ');
  }
  if (byId.witnesses) {
    const w = lines.filter((s) => WITNESS_WORDS.test(s));
    if (w.length) values.witnesses = w.join(' ');
  }
  if (byId.location && ctx.location) values.location = ctx.location;
  if (byId.incident_type && byId.incident_type.type === 'select') {
    // The officer's notes say what actually happened; the job type is only
    // what control was told, so it is a fallback.
    const pick = (hay) => TYPE_RULES.find(([re, opt]) => re.test(hay) && byId.incident_type.options.includes(opt));
    const hit = pick(notes) || pick(ctx.incident_type || '');
    if (hit) values.incident_type = hit[1];
  }
  return values;
}

/* ---- Local AI drafter (Ollama) ----------------------------------------- */

const STYLE = 'You help security officers at Echelon, a UK commercial security company, write up incident reports. ' +
  'Use UK English. Write in the first person, past tense, in time order, plain and factual, with no opinions or guesses. ' +
  'The report may be sent to the client and used as evidence. Use ONLY facts in the officer\'s notes and the job details. ' +
  'Never add times, names, descriptions, injuries, damage or actions that are not stated. If something is not stated, leave that field empty.';

function aiPrompt(def, notes, ctx, fields) {
  const job = ctx.kind === 'none' ? '(none)' : [
    ctx.reference && `Reference: ${ctx.reference}`, ctx.incident_type && `Job type: ${ctx.incident_type}`,
    ctx.location && `Location: ${ctx.location}`, ctx.description && `Description from control: ${ctx.description}`,
    ctx.timeline && ctx.timeline.length && `Timeline:\n${ctx.timeline.join('\n')}`,
    ctx.checklist && ctx.checklist.length && `Checklist:\n${ctx.checklist.join('\n')}`,
  ].filter(Boolean).join('\n');
  const list = fields.map((f) => `- ${f.id}: ${f.label}${f.type === 'select' ? ` (choose exactly one of: ${f.options.join(' | ')})` : ''}`).join('\n');
  return `Form: ${def.name}\n\nJob details:\n${job}\n\nOfficer's rough notes:\n"""${notes}"""\n\n` +
    `Fill in these fields from the notes. Leave a field as an empty string if the notes do not cover it.\n${list}\n\n` +
    'Also list in "missing" up to 6 short questions about things a manager would expect in this report that the notes do not say.';
}

function aiSchema(fields) {
  const props = {};
  for (const f of fields) props[f.id] = f.type === 'select' ? { type: 'string', enum: ['', ...f.options] } : { type: 'string' };
  return {
    type: 'object', required: ['fields', 'missing'],
    properties: {
      fields: { type: 'object', properties: props, required: fields.map((f) => f.id) },
      missing: { type: 'array', items: { type: 'string' } },
    },
  };
}

/* Swappable so tests run offline: setTransport(async ({ url, body, timeoutMs }) => ollamaResponse). */
const httpTransport = async ({ url, body, timeoutMs }) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`local AI answered ${res.status}`);
    return await res.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'local AI took too long' : `local AI unavailable (${e.message})`);
  } finally { clearTimeout(timer); }
};
let transport = httpTransport;
const setTransport = (fn) => { transport = fn || httpTransport; };
const aiUrl = () => (process.env.LOCAL_AI_URL || '').trim().replace(/\/+$/, '');
const aiModel = () => (process.env.LOCAL_AI_MODEL || 'qwen2.5:7b').trim();
const aiConfigured = () => Boolean(aiUrl());

/* CPU-only models answer one at a time; past this many waiting, use the template. */
const MAX_IN_FLIGHT = Number(process.env.LOCAL_AI_MAX_QUEUE || 2);
let inFlight = 0;

async function aiDraft(def, notes, ctx) {
  const fields = fillableFields(def);
  const out = await transport({
    url: `${aiUrl()}/api/chat`,
    timeoutMs: Number(process.env.LOCAL_AI_TIMEOUT_MS || 240000),
    body: {
      model: aiModel(), stream: false, format: aiSchema(fields), keep_alive: '30m',
      options: { temperature: 0.2, num_ctx: 4096, num_predict: 900 },
      messages: [{ role: 'system', content: STYLE }, { role: 'user', content: aiPrompt(def, notes, ctx, fields) }],
    },
  });
  let parsed;
  try { parsed = JSON.parse((out && out.message && out.message.content) || ''); } catch { throw new Error('local AI gave an unreadable answer'); }
  const given = (parsed && typeof parsed.fields === 'object' && parsed.fields) || {};
  const values = {};
  for (const f of fields) {
    const v = clip(given[f.id], f.type === 'textarea' ? 4000 : 200).trim();
    if (!v) continue;
    if (f.type === 'select' && !f.options.includes(v)) continue;
    values[f.id] = v;
  }
  if (!Object.keys(values).length) throw new Error('local AI left every field empty');
  const missing = Array.isArray(parsed.missing) ? parsed.missing.slice(0, 6).map((m) => clip(m, 200)).filter(Boolean) : [];
  return { values, missing };
}

/** Numbers and times in the draft that appear nowhere in the source. */
function unsupportedNumbers(values, source) {
  const norm = (s) => tidyTimes(String(s)).replace(/(\d{1,2}):(\d{2})/g, '$1$2');
  const have = new Set((norm(source).match(/\d+/g) || []).map((n) => n.replace(/^0+(?=\d)/, '')));
  const seen = new Set();
  for (const v of Object.values(values)) {
    for (const m of String(v).match(/\b\d{1,2}:\d{2}\b|\b\d+\b/g) || []) {
      const key = m.replace(':', '').replace(/^0+(?=\d)/, '');
      if (!have.has(key)) seen.add(m);
    }
  }
  return [...seen].slice(0, 10);
}

/** Required fields still empty after the draft → prompts for the officer. */
function stillToAdd(def, values) {
  return (def.fields || [])
    .filter((f) => f.required && ['textarea', 'text'].includes(f.type) && !NEVER_FILL.test(f.id) && !values[f.id])
    .map((f) => `Add: ${f.label}`);
}

function register({ route, db, ALL, httpError, logEvent, assertJobAccess, assertVisitAccess }) {
  function contextFor(subjectType, subjectId, user) {
    const id = Number(subjectId);
    if (subjectType === 'JOB') {
      const j = db.jobs.find((x) => x.id === id); if (!j) throw httpError(404, 'job not found');
      assertJobAccess(j, user);
      const timeline = [['Created', j.created_at], ['Dispatched', j.dispatched_at], ['Acknowledged', j.acknowledged_at],
        ['En route', j.en_route_at], ['On scene', j.on_scene_at], ['Completed', j.completed_at]]
        .filter(([, t]) => t).map(([k, t]) => `${k}: ${londonTime(t)}`);
      const checklist = (j.checklist || []).map((c) => `- ${c.title}: ${c.status || ''}${c.notes ? ` (${clip(c.notes, 300)})` : ''}`);
      return { kind: 'job', reference: j.reference, incident_type: j.incident_type || '', location: j.location || '',
        description: clip(j.description, 1200), dispatched_at: j.dispatched_at, en_route_at: j.en_route_at, on_scene_at: j.on_scene_at, timeline, checklist };
    }
    if (subjectType === 'SITE_VISIT') {
      const v = db.site_visits.find((x) => x.id === id); if (!v) throw httpError(404, 'site visit not found');
      assertVisitAccess(v, user);
      const site = db.sites.find((s) => s.id === v.site_id);
      const timeline = [['Scheduled', v.scheduled_for], ['On scene', v.on_scene_at], ['Completed', v.completed_at]]
        .filter(([, t]) => t).map(([k, t]) => `${k}: ${londonTime(t)}`);
      const checklist = (v.checklist || []).map((c) => `- ${c.title}: ${c.status || ''}${c.notes ? ` (${clip(c.notes, 300)})` : ''}`);
      return { kind: 'visit', reference: v.reference, incident_type: 'Site visit', location: site ? `${site.name}${site.address ? `, ${site.address}` : ''}` : '',
        scheduled_for: v.scheduled_for, on_scene_at: v.on_scene_at, timeline, checklist };
    }
    if (subjectType === 'SITE') {
      const s = db.sites.find((x) => x.id === id); if (!s) throw httpError(404, 'site not found');
      return { kind: 'site', location: `${s.name}${s.address ? `, ${s.address}` : ''}` };
    }
    return { kind: 'none' };
  }

  route('GET', '/api/report-assist/status', ALL, () => ({ available: true, ai: aiConfigured(), model: aiConfigured() ? aiModel() : null }));

  /* A CPU-only model can take a minute or two, longer than the web proxy in
   * front of CCCS waits for one request (it answered 504). So an AI draft
   * runs in the background: POST answers 202 with an id at once, and the
   * form asks GET /api/report-assist/drafts/:id every couple of seconds.
   * Drafts live in memory only, for their author only, for 10 minutes. */
  const drafts = new Map();
  const DRAFT_TTL_MS = 10 * 60 * 1000;
  const sweep = () => { const cutoff = Date.now() - DRAFT_TTL_MS; for (const [id, d] of drafts) if (d.at < cutoff) drafts.delete(id); };

  function finish(def, notes, ctx, user, ai, note) {
    const sourceText = [notes, ctx.reference, ctx.location, ctx.description, ...(ctx.timeline || []), ...(ctx.checklist || [])].filter(Boolean).join('\n');
    const source = ai ? 'ai' : 'template';
    const values = ai ? ai.values : templateDraft(def, notes, ctx);
    // The job or site's own address is better than nothing for "Exact location".
    if (ai && !values.location && ctx.location && fillableFields(def).some((f) => f.id === 'location')) values.location = ctx.location;
    const check = ai ? unsupportedNumbers(values, sourceText) : [];
    const missing = [...(ai ? ai.missing : []), ...stillToAdd(def, values)].slice(0, 8);
    logEvent('report.assist', `REPORT DRAFT (${ai ? 'local AI' : 'template'}) FOR ${user.display_name}: ${def.name}`,
      { user_id: user.id, definition_id: def.id, source });
    return { values, missing, check, source, model: ai ? aiModel() : null, note };
  }

  route('POST', '/api/report-assist', ALL, ({ body, user }) => {
    const def = (db.form_definitions || []).find((d) => d.id === Number(body.definition_id));
    if (!def) throw httpError(404, 'form not found');
    const notes = clip(body.notes, 6000).trim();
    if (notes.length < 3) throw httpError(400, 'write a few notes first');
    if (!fillableFields(def).length) throw httpError(400, 'this form has nothing to write up');
    const ctx = contextFor(String(body.subject_type || ''), body.subject_id, user);

    if (!aiConfigured()) return finish(def, notes, ctx, user, null, null);
    if (inFlight >= MAX_IN_FLIGHT) return finish(def, notes, ctx, user, null, 'The local AI is busy: used the simple template instead.');

    sweep();
    const id = crypto.randomBytes(12).toString('hex');
    const entry = { user_id: user.id, at: Date.now(), result: null };
    drafts.set(id, entry);
    inFlight++;
    aiDraft(def, notes, ctx)
      .then((ai) => { entry.result = finish(def, notes, ctx, user, ai, null); })
      .catch((e) => { entry.result = finish(def, notes, ctx, user, null, `${e.message}: used the simple template instead.`); })
      .finally(() => { inFlight--; });
    return { __status: 202, __body: { pending: true, id } };
  });

  route('GET', '/api/report-assist/drafts/:id', ALL, ({ params, user }) => {
    const d = drafts.get(String(params.id));
    if (!d || d.user_id !== user.id) throw httpError(404, 'draft not found (they are kept for 10 minutes)');
    if (!d.result) return { pending: true };
    drafts.delete(String(params.id));
    return d.result;
  });
}

module.exports = { register, setTransport, templateDraft, sentences, tidyTimes, unsupportedNumbers, fillableFields };
