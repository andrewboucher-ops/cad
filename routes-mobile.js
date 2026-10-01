/**
 * Mobile-only views that have no desktop route to reuse.
 *
 * Active users — who is working right now, with a phone number to call
 * from the handset itself. Deliberately NOT the PBX click-to-dial: on a
 * phone the call goes out over the phone's own line (a tel: link), so it
 * needs no extension, no AMI and leaves nothing in dial_log.
 *
 * "Working right now" matches the control room's On shift panel: clocked
 * in, or rostered on a shift that has started and not ended (so a no-show
 * is visible), plus anyone on an open job or visit, with a welfare timer
 * running, or with an active emergency even when the rota says otherwise —
 * a person mid-task never drops off this list because the rota is wrong.
 *
 * Who may see it is decided by the admin's section settings (ui-sections.js,
 * `active_users`), checked here on the server: the list carries phone
 * numbers, so hiding the menu entry alone would not be enough.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const CLOSED_JOB = ['COMPLETED', 'CANCELLED'];
const CLOSED_VISIT = ['COMPLETED', 'CANCELLED', 'MISSED'];

module.exports = function registerMobileRoutes({ route, httpError, db, sections, visibleToUser }) {
  route('GET', '/api/mobile/active-users', [], ({ user }) => {
    if (!sections.canSee('active_users', user.role)) throw httpError(403, 'active users is not available to your role');
    const now = Date.now();
    const byPerson = new Map();
    for (const a of db.shift_assignments || []) {
      if (['REMOVED', 'DECLINED'].includes(a.status)) continue;
      const s = (db.shifts || []).find((x) => x.id === a.shift_id); if (!s) continue;
      const clockedIn = Boolean(a.clocked_in_at && !a.clocked_out_at);
      const rosteredNow = ['PUBLISHED', 'IN_PROGRESS'].includes(s.status) && Date.parse(s.starts_at) <= now && Date.parse(s.ends_at) > now;
      if (!clockedIn && !rosteredNow) continue;
      const prev = byPerson.get(a.personnel_id);
      if (prev && prev.clocked_in) continue;
      const site = s.site_id ? (db.sites || []).find((x) => x.id === s.site_id) : null;
      byPerson.set(a.personnel_id, { clocked_in: clockedIn, clocked_in_at: a.clocked_in_at || null, shift_ends_at: s.ends_at, site_name: site ? site.name : null });
    }
    const openJob = (p) => (db.job_assignments || []).map((a) => a.personnel_id === p.id && db.jobs.find((j) => j.id === a.job_id && !CLOSED_JOB.includes(j.status))).find(Boolean) || null;
    const openVisit = (p) => (db.site_visits || []).find((v) => !CLOSED_VISIT.includes(v.status) && (v.personnel_id === p.id || (v.additional_personnel || []).includes(p.id))) || null;
    const emergency = (p) => (db.emergency_events || []).find((e) => e.personnel_id === p.id && e.state !== 'RESOLVED') || null;

    const out = [];
    for (const p of db.personnel.filter((x) => visibleToUser(x, user))) {
      if ((p.employment_status || 'ACTIVE') !== 'ACTIVE') continue;
      const shift = byPerson.get(p.id) || null;
      const job = openJob(p), visit = openVisit(p), emg = emergency(p);
      if (!shift && !job && !visit && !p.welfare_due_at && !emg) continue;
      const cs = db.callsigns.find((c) => c.id === p.callsign_id);
      out.push({
        id: p.id, name: p.name, callsign: cs ? cs.name : null, phone: p.contact_phone || null,
        is_me: p.id === user.personnel_id,
        clocked_in: Boolean(shift && shift.clocked_in), on_rota: Boolean(shift),
        site_name: (shift && shift.site_name) || null, shift_ends_at: shift ? shift.shift_ends_at : null,
        task: job ? { kind: 'JOB', reference: job.reference, location: job.location } : visit ? { kind: 'VISIT', reference: visit.reference } : null,
        welfare_due_at: p.welfare_due_at || null, emergency: Boolean(emg),
      });
    }
    const rank = (r) => (r.emergency ? 0 : r.task ? 1 : r.clocked_in ? 2 : 3);
    return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  });
};
