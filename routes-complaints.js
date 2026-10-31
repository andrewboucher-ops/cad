/**
 * Complaints log, for SIA ACS (and BS 7499 / BS 7858's own complaints
 * clauses): every complaint recorded when received, acknowledged,
 * investigated, with a root cause, corrective and preventive action, and the
 * outcome told to the complainant, before it can be closed.
 *
 * Control roles record and work complaints; nothing is ever deleted by hand
 * (a complaints log with gaps is worth nothing at audit). Closed complaints
 * age out after RETAIN_COMPLAINTS_DAYS (default 6 years) via retention.
 *
 * Registrar pattern, like routes-forms.js and routes-client.js.
 */
'use strict';

const SOURCES = ['PHONE', 'EMAIL', 'CLIENT_PORTAL', 'IN_PERSON', 'LETTER', 'SOCIAL_MEDIA', 'OTHER'];
const CATEGORIES = ['OFFICER_CONDUCT', 'SERVICE_FAILURE', 'LATE_OR_MISSED', 'CONTROL_ROOM', 'BILLING', 'DATA_PROTECTION', 'DISCRIMINATION', 'OTHER'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'];
const STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED'];
// Targets the log reports against; change them here if your procedure differs.
const ACK_DAYS = Number(process.env.COMPLAINT_ACK_DAYS || 2);
const RESOLVE_DAYS = Number(process.env.COMPLAINT_RESOLVE_DAYS || 28);
const RETAIN_DAYS = process.env.RETAIN_COMPLAINTS_DAYS === undefined || process.env.RETAIN_COMPLAINTS_DAYS === '' ? 2190 : Number(process.env.RETAIN_COMPLAINTS_DAYS);

module.exports = function registerComplaints({ route, httpError, CONTROL, db, nextId, logEvent, siteVisibleTo = () => true, flushNow = () => {} }) {
  if (!Array.isArray(db.complaints)) db.complaints = [];
  const str = (v, n = 4000) => (v === undefined || v === null ? '' : String(v).trim().slice(0, n));
  const isoOrNull = (v, what) => {
    if (v === undefined || v === null || v === '') return null;
    if (isNaN(Date.parse(v))) throw httpError(400, `${what} is not a valid date`);
    return new Date(v).toISOString();
  };
  const find = (id) => { const c = db.complaints.find((x) => x.id === Number(id)); if (!c) throw httpError(404, 'complaint not found'); return c; };
  const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;

  function publicComplaint(c) {
    const now = new Date().toISOString();
    const client = c.client_id ? db.clients.find((x) => x.id === c.client_id) : null;
    const site = c.site_id ? db.sites.find((x) => x.id === c.site_id) : null;
    return {
      ...c,
      client_name: client ? client.name : null, site_name: site ? site.name : null,
      personnel: (c.personnel_ids || []).map((id) => { const p = db.personnel.find((x) => x.id === id); return { id, name: p ? p.name : `#${id}` }; }),
      ack_overdue: !c.acknowledged_at && days(c.received_at, now) > ACK_DAYS,
      resolve_overdue: !['RESOLVED', 'CLOSED'].includes(c.status) && days(c.received_at, now) > RESOLVE_DAYS,
    };
  }
  const visible = (c, user) => !c.site_id || siteVisibleTo(c.site_id, user);

  function apply(c, b, user) {
    if ('received_at' in b) c.received_at = isoOrNull(b.received_at, 'received') || c.received_at;
    if ('source' in b) { if (!SOURCES.includes(b.source)) throw httpError(400, 'invalid source'); c.source = b.source; }
    if ('category' in b) { if (!CATEGORIES.includes(b.category)) throw httpError(400, 'invalid category'); c.category = b.category; }
    if ('severity' in b) { if (!SEVERITIES.includes(b.severity)) throw httpError(400, 'invalid severity'); c.severity = b.severity; }
    for (const k of ['complainant_name', 'complainant_contact']) if (k in b) c[k] = str(b[k], 200);
    for (const k of ['summary', 'root_cause', 'corrective_action', 'preventive_action', 'outcome']) if (k in b) c[k] = str(b[k]);
    if ('client_id' in b) { const id = b.client_id ? Number(b.client_id) : null; if (id && !db.clients.some((x) => x.id === id)) throw httpError(400, 'unknown client'); c.client_id = id; }
    if ('site_id' in b) { const id = b.site_id ? Number(b.site_id) : null; if (id && !db.sites.some((x) => x.id === id)) throw httpError(400, 'unknown site'); c.site_id = id; }
    if ('personnel_ids' in b) c.personnel_ids = (Array.isArray(b.personnel_ids) ? b.personnel_ids : []).map(Number).filter((id) => db.personnel.some((p) => p.id === id));
    if ('assigned_to' in b) c.assigned_to = str(b.assigned_to, 120) || null;
    if ('acknowledged_at' in b) c.acknowledged_at = isoOrNull(b.acknowledged_at, 'acknowledged');
    if ('outcome_communicated_at' in b) c.outcome_communicated_at = isoOrNull(b.outcome_communicated_at, 'outcome told');
    if ('status' in b) {
      if (!STATUSES.includes(b.status)) throw httpError(400, 'invalid status');
      if (b.status === 'CLOSED') {
        const missing = [['root_cause', 'root cause'], ['corrective_action', 'corrective action'], ['outcome', 'outcome'], ['outcome_communicated_at', 'date the outcome was told to the complainant']]
          .filter(([k]) => !c[k]).map(([, l]) => l);
        if (missing.length) throw httpError(400, `before closing, record the ${missing.join(', ')}`);
        if (c.status !== 'CLOSED') { c.closed_at = new Date().toISOString(); c.closed_by = user.display_name; }
      } else { c.closed_at = null; c.closed_by = null; }
      if (b.status === 'RESOLVED' && !c.resolved_at) c.resolved_at = new Date().toISOString();
      c.status = b.status;
    }
  }

  route('GET', '/api/complaints', CONTROL, ({ query, user }) => {
    let rows = db.complaints.filter((c) => visible(c, user));
    if (query.get('status')) rows = rows.filter((c) => c.status === query.get('status'));
    return {
      complaints: rows.slice().sort((a, b) => (a.received_at < b.received_at ? 1 : -1)).map(publicComplaint),
      sources: SOURCES, categories: CATEGORIES, severities: SEVERITIES, statuses: STATUSES, ack_days: ACK_DAYS, resolve_days: RESOLVE_DAYS,
    };
  });
  route('GET', '/api/complaints/:id', CONTROL, ({ params, user }) => {
    const c = find(params.id); if (!visible(c, user)) throw httpError(404, 'complaint not found');
    return publicComplaint(c);
  });
  route('POST', '/api/complaints', CONTROL, ({ body, user }) => {
    const b = body || {};
    if (!str(b.summary)) throw httpError(400, 'say what the complaint is about');
    const id = nextId('complaints');
    const c = {
      id, reference: `CMP-${String(id).padStart(4, '0')}`, received_at: new Date().toISOString(), source: 'PHONE', category: 'OTHER', severity: 'MEDIUM',
      complainant_name: '', complainant_contact: '', client_id: null, site_id: null, personnel_ids: [], summary: '',
      assigned_to: null, acknowledged_at: null, status: 'OPEN', notes: [], root_cause: '', corrective_action: '', preventive_action: '',
      outcome: '', outcome_communicated_at: null, resolved_at: null, closed_at: null, closed_by: null,
      recorded_by: user.display_name, recorded_at: new Date().toISOString(),
    };
    const { status: _ignored, ...fields } = b; // a new complaint always starts OPEN
    apply(c, fields, user);
    db.complaints.push(c);
    logEvent('complaint.created', `COMPLAINT ${c.reference} RECORDED (${c.category}) BY ${user.username}`, { complaint_id: c.id, site_id: c.site_id });
    flushNow();
    return { __status: 201, __body: publicComplaint(c) };
  });
  route('PATCH', '/api/complaints/:id', CONTROL, ({ params, body, user }) => {
    const c = find(params.id); if (!visible(c, user)) throw httpError(404, 'complaint not found');
    const before = c.status;
    apply(c, body || {}, user);
    c.updated_at = new Date().toISOString(); c.updated_by = user.display_name;
    logEvent('complaint.updated', `COMPLAINT ${c.reference} UPDATED BY ${user.username}${c.status !== before ? ` (${before} → ${c.status})` : ''}`, { complaint_id: c.id });
    flushNow();
    return publicComplaint(c);
  });
  // Investigation notes are added, never edited or removed.
  route('POST', '/api/complaints/:id/notes', CONTROL, ({ params, body, user }) => {
    const c = find(params.id); if (!visible(c, user)) throw httpError(404, 'complaint not found');
    const text = str(body && body.body);
    if (!text) throw httpError(400, 'note is empty');
    c.notes.push({ at: new Date().toISOString(), by: user.display_name, body: text });
    flushNow();
    return publicComplaint(c);
  });

  function sweep() {
    if (!(RETAIN_DAYS > 0)) return { complaints: 0 };
    const cutoff = Date.now() - RETAIN_DAYS * 86400000;
    const before = db.complaints.length;
    db.complaints = db.complaints.filter((c) => !(c.status === 'CLOSED' && Date.parse(c.closed_at) < cutoff));
    return { complaints: before - db.complaints.length };
  }
  return { sweep };
};
