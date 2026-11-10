/**
 * Job follow-up: fixing times after the event, closing (with the required
 * closing note), not attended, notes and their portal visibility, resending
 * the report, editing a job, the PRF lookup, the on-scene checklist, photos
 * and stand-down.
 *
 * EMAIL_RE is defined later in server.js, so it comes in through `late`,
 * whose getter is only read when a request arrives.
 *
 * Moved out of server.js unchanged. Registrar pattern: server.js passes in
 * what this needs, at the same point in route order as before.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function registerJobs({ route, httpError, ALL, CONTROL, CLIENT, db, MIME, findPersonnel, findMdt, publicMdt, logEvent, broadcast, isControlRole, publicJob, stampJobStatus, instantiateChecklist, applyJobTimes, proposedJobTimes, retroReason, jobReportHtml, sendResolutionReportEmail, complaintLabel, secretMatches, PRF_INTEGRATION_SECRET, CHIEF_COMPLAINT_CODES, JOB_STATES, JOB_TS_FIELDS, PRIORITIES, UPLOADS_DIR, mediaDir, MEDIA_MIME_EXT, late }) {
  /* Control fixing a job's times after the fact — an officer lost signal and
   * none of their taps reached the server, or the job was only ever handled
   * by radio. Works on closed jobs too. A reason is required, and every
   * change is kept on the job (time_edits) as well as in the audit log. */
  route('PATCH', '/api/jobs/:id/times', CONTROL, ({ params, body, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    const reason = retroReason(body);
    if (reason.length < 3) throw httpError(400, 'a reason is required');
    const changes = proposedJobTimes(j, body);
    if (!changes.length) throw httpError(400, 'no times changed');
    applyJobTimes(j, changes, user, reason);
    // A completed job's stored report is rebuilt so it shows the corrected
    // times; it is not emailed out a second time.
    if (j.status === 'COMPLETED') j.resolution_report_html = jobReportHtml(j);
    j.updated_at = new Date().toISOString();
    broadcast('job.status_changed', publicJob(j));
    return publicJob(j);
  });

  /* Closing a job is control's call, with a note, even when the officer has
   * already pressed Completed: a completed job stays awaiting_close (and in
   * control's dispatch list) until a controller writes what happened. The
   * closing note goes into the job's notes log like any other note. Jobs
   * completed before this existed have no awaiting_close and count as closed. */
  const CLOSING_NOTE_MIN = 3;
  function closingNote(body) {
    const note = String(body.closing_note || body.note || '').trim().slice(0, 2000);
    if (note.length < CLOSING_NOTE_MIN) throw httpError(400, 'a closing note is required to close the job');
    return note;
  }
  function closeJob(j, user, note) {
    const at = new Date().toISOString();
    j.note_entries = j.note_entries || [];
    j.note_entries.push({ id: crypto.randomUUID(), at, by: user.id, by_name: user.display_name, text: note, closing: true });
    j.awaiting_close = false;
    j.closed_at = at; j.closed_by = user.id; j.closed_by_name = user.display_name;
    j.resolution_report_html = jobReportHtml(j);
    j.updated_at = at;
    logEvent('job.closed', `JOB ${j.reference} CLOSED BY ${user.display_name}`, { job_id: j.id, closed_by: user.id });
    sendResolutionReportEmail({
      reference: j.reference, siteId: j.site_id, media: j.media, mediaDir: mediaDir(j.id),
      logType: 'job.report_emailed', logIdKey: 'job_id', logId: j.id,
    }, j.resolution_report_html);
  }
  route('POST', '/api/jobs/:id/close', CONTROL, ({ params, body, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    if (j.status !== 'COMPLETED') throw httpError(409, 'only a completed job can be closed — mark it completed first');
    if (j.closed_at) throw httpError(409, 'job is already closed');
    closeJob(j, user, closingNote(body));
    broadcast('job.status_changed', publicJob(j));
    return publicJob(j);
  });

  /* Not attended: control raised the job and dealt with it without sending
   * anyone — a remote CCTV check, the keyholder confirmed a false alarm, the
   * client cancelled. The job closes as CANCELLED (so it's off every live
   * list and never billed, see routes-invoices.js attendancesFor) but keeps
   * a reason the client sees in their portal, with any notes control marks
   * as client-visible, so they can see action was taken. A job someone
   * actually arrived at is attended: close that one as completed instead. */
  route('POST', '/api/jobs/:id/not-attended', CONTROL, ({ params, body, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    if (j.not_attended) throw httpError(409, 'job is already marked not attended');
    if (j.status === 'COMPLETED') throw httpError(409, 'this job was completed — it was attended');
    if (j.on_scene_at) throw httpError(409, 'an officer arrived at this job — close it as completed instead');
    const reason = String(body.reason || '').trim().slice(0, 2000);
    if (reason.length < 3) throw httpError(400, 'give a reason it was not attended');
    const clientNote = String(body.client_note || '').trim().slice(0, 2000);
    const at = new Date().toISOString();
    j.status = 'CANCELLED';
    stampJobStatus(j, 'CANCELLED');
    for (const a of db.job_assignments.filter((x) => x.job_id === j.id)) {
      if (a.mdt_id) { const m = db.mdts.find((x) => x.id === a.mdt_id); if (m) m.job_id = null; }
    }
    j.not_attended = true;
    j.not_attended_reason = reason;
    j.not_attended_at = at; j.not_attended_by = user.id; j.not_attended_by_name = user.display_name;
    j.note_entries = j.note_entries || [];
    j.note_entries.push({ id: crypto.randomUUID(), at, by: user.id, by_name: user.display_name, text: `Not attended: ${reason}`, closing: true, client_visible: true });
    if (clientNote) j.note_entries.push({ id: crypto.randomUUID(), at, by: user.id, by_name: user.display_name, text: clientNote, client_visible: true });
    j.awaiting_close = false;
    j.closed_at = at; j.closed_by = user.id; j.closed_by_name = user.display_name;
    j.updated_at = at;
    broadcast('job.status_changed', publicJob(j));
    logEvent('job.not_attended', `JOB ${j.reference} MARKED NOT ATTENDED BY ${user.display_name}: ${reason}`, { job_id: j.id, by: user.id });
    return publicJob(j);
  });

  /* Show or hide one note in the client portal. Only control decides what a
   * client reads; notes are hidden from them unless marked. */
  route('PATCH', '/api/jobs/:id/notes/:noteId', CONTROL, ({ params, body, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    const n = (j.note_entries || []).find((x) => x.id === params.noteId); if (!n) throw httpError(404, 'note not found');
    if (body.client_visible === undefined) throw httpError(400, 'client_visible required');
    n.client_visible = Boolean(body.client_visible);
    j.updated_at = new Date().toISOString();
    broadcast('job.status_changed', publicJob(j));
    logEvent('job.note_visibility', `NOTE ON JOB ${j.reference} ${n.client_visible ? 'SHOWN TO' : 'HIDDEN FROM'} THE CLIENT BY ${user.display_name}`, { job_id: j.id, note_id: n.id });
    return publicJob(j);
  });

  /* Resend a closed job's report to wherever control chooses — a client who
   * lost it, or a non-client site's report forwarded from info@. Rebuilt from
   * the job as it stands, so later notes and photos are in it. */
  route('POST', '/api/jobs/:id/report/send', CONTROL, async ({ params, body, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    if (j.status !== 'COMPLETED') throw httpError(409, 'only a completed job has a report');
    const to = [...new Set(String(body.to || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    if (!to.length) throw httpError(400, 'enter at least one email address');
    const bad = to.find((x) => !late.EMAIL_RE.test(x));
    if (bad) throw httpError(400, `not an email address: ${bad}`);
    if (to.length > 10) throw httpError(400, 'at most 10 addresses');
    j.resolution_report_html = jobReportHtml(j);
    const r = await sendResolutionReportEmail({
      reference: j.reference, siteId: j.site_id, media: j.media, mediaDir: mediaDir(j.id),
      logType: 'job.report_emailed', logIdKey: 'job_id', logId: j.id, to,
    }, j.resolution_report_html);
    if (!r.ok) throw httpError(502, `report not sent: ${r.error}`);
    logEvent('job.report_resent', `REPORT FOR ${j.reference} RESENT BY ${user.display_name} TO ${to.join(', ')}`, { job_id: j.id, to, by: user.id });
    return { ok: true, to };
  });

  /* Notes added to a job at any time, closed ones included — something
   * remembered or found out after the officer cleared. Append-only, each one
   * stamped with who and when, unlike the single editable notes field that
   * control uses to brief call signs while the job is live. */
  route('POST', '/api/jobs/:id/notes', ALL, ({ params, body, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    assertJobAccess(j, user);
    const text = String(body.text || '').trim().slice(0, 2000);
    if (!text) throw httpError(400, 'note text required');
    const note = { id: crypto.randomUUID(), at: new Date().toISOString(), by: user.id, by_name: user.display_name, text };
    // Only control can put a note in front of the client (see the client portal's clientJob).
    if (body.client_visible && isControlRole(user.role)) note.client_visible = true;
    j.note_entries = j.note_entries || [];
    j.note_entries.push(note);
    if (j.status === 'COMPLETED') j.resolution_report_html = jobReportHtml(j);
    j.updated_at = note.at;
    broadcast('job.status_changed', publicJob(j));
    logEvent('job.note_added', `NOTE ADDED TO JOB ${j.reference} BY ${user.display_name}${['COMPLETED', 'CANCELLED'].includes(j.status) ? ' (after it closed)' : ''}`, { job_id: j.id, note_id: note.id });
    return { __status: 201, __body: publicJob(j) };
  });

  route('PATCH', '/api/jobs/:id', ALL, ({ params, body, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    // Control can set the actual stepper times directly — for a job an
    // officer confirmed by radio or in person rather than through the phone
    // app or MDT, there is otherwise no way to record when it really
    // happened instead of defaulting every unset stage to "now" the moment
    // status flips to COMPLETED. Applied before the status block below so
    // stampJobStatus's "only if not already set" guard respects whatever
    // was explicitly given here.
    const settingTimes = isControlRole(user.role) && JOB_TS_FIELDS.some((f) => f in body);
    if (settingTimes) {
      const times = Object.fromEntries(JOB_TS_FIELDS.filter((f) => f in body).map((f) => [f, body[f]]));
      applyJobTimes(j, proposedJobTimes(j, times), user, retroReason(body));
    }
    // Control completing a job can close it in the same step by giving the
    // closing note; checked before anything changes so a short one fails clean.
    const closingNow = body.closing_note !== undefined && isControlRole(user.role) && String(body.status || '').toUpperCase() === 'COMPLETED' && !j.closed_at;
    const closeNote = closingNow ? closingNote(body) : null;
    if (body.status) {
      const s = String(body.status).toUpperCase();
      if (!JOB_STATES.includes(s)) throw httpError(400, 'invalid job status');
      assertJobAccess(j, user);
      j.status = s;
      stampJobStatus(j, s);
      if (['COMPLETED', 'CANCELLED'].includes(s)) {
        for (const a of db.job_assignments.filter((x) => x.job_id === j.id)) {
          if (a.mdt_id) { const m = db.mdts.find((x) => x.id === a.mdt_id); if (m) m.job_id = null; }
        }
      }
      if (s === 'COMPLETED') {
        if (!j.closed_at) j.awaiting_close = true;
        // Built now so it's on the job straight away, but only emailed once a
        // controller closes the job — the closing note belongs in it.
        j.resolution_report_html = jobReportHtml(j);
        logEvent('job.report_generated', `RESOLUTION REPORT GENERATED FOR ${j.reference}`, { job_id: j.id });
      }
    }
    if (body.notes !== undefined) j.notes = body.notes;
    // Incident details — mainly for a job auto-created from an emergency,
    // which starts with placeholders (raw coordinates, no description) and
    // gets filled in as the officer actually reports what's going on.
    const DETAIL_FIELDS = { incident_type: 120, location: 200, description: 2000, caller: 200 };
    if (Object.keys(DETAIL_FIELDS).some((f) => body[f] !== undefined)) {
      if (!isControlRole(user.role)) throw httpError(403, 'only control can edit incident details');
      for (const [f, max] of Object.entries(DETAIL_FIELDS)) if (body[f] !== undefined) j[f] = String(body[f]).slice(0, max);
      if (body.what3words !== undefined) j.what3words = String(body.what3words).replace(/^\/+/, '').trim();
    }
    // Medical incident flag, the patient questions it unlocks, and priority
    // — all control-gated like the incident details above. Priority has no
    // other edit route (only set once at creation until now), which this
    // feature needs: a dispatcher adjusts it as the chief complaint is
    // entered or corrected, same as they would for any other triage change.
    if (body.is_medical !== undefined) {
      if (!isControlRole(user.role)) throw httpError(403, 'only control can edit incident details');
      j.is_medical = Boolean(body.is_medical);
    }
    const MEDICAL_FIELDS = { patient_name: 200, patient_dob: 20 };
    if (Object.keys(MEDICAL_FIELDS).some((f) => body[f] !== undefined) || body.chief_complaint !== undefined) {
      if (!isControlRole(user.role)) throw httpError(403, 'only control can edit incident details');
      for (const [f, max] of Object.entries(MEDICAL_FIELDS)) if (body[f] !== undefined) j[f] = String(body[f]).slice(0, max);
      if (body.chief_complaint !== undefined) {
        const cc = String(body.chief_complaint || '');
        if (cc && !CHIEF_COMPLAINT_CODES.includes(cc)) throw httpError(400, 'invalid chief_complaint');
        j.chief_complaint = cc;
      }
    }
    if (body.priority !== undefined) {
      if (!isControlRole(user.role)) throw httpError(403, 'only control can edit incident details');
      const pr = String(body.priority).toUpperCase();
      if (!PRIORITIES.includes(pr)) throw httpError(400, 'invalid priority');
      j.priority = pr;
    }
    if (closeNote && j.status === 'COMPLETED') closeJob(j, user, closeNote);
    j.updated_at = new Date().toISOString();
    broadcast('job.status_changed', publicJob(j));
    logEvent('job.status_changed', `JOB ${j.reference} → ${j.status}`, { job_id: j.id });
    return publicJob(j);
  });

  /** Read-only job lookup for the PRF system's own CAD search/sync — a
   * first aider enters a CCCS job reference (or raw numeric id) and the
   * PRF system pulls across whatever control already captured (patient
   * name/DoB/chief complaint if it's a medical job, description, caller,
   * site). Shared-secret gated, same pattern as the stock/medication/
   * catalogue integration routes in routes-inventory.js/routes-medication.js
   * — this system never holds a CCCS session. GET, not POST: it changes
   * nothing on the CCCS side. */
  route('GET', '/api/integrations/prf/jobs/:reference', null, ({ params, req }) => {
    if (!secretMatches(req.headers['x-prf-integration-secret'], PRF_INTEGRATION_SECRET)) throw httpError(401, 'bad integration secret');
    const ref = String(params.reference || '').trim().toUpperCase();
    const j = db.jobs.find((x) => x.reference.toUpperCase() === ref || String(x.id) === ref);
    if (!j) throw httpError(404, 'job not found');
    const site = j.site_id ? db.sites.find((s) => s.id === j.site_id) : null;
    return {
      id: j.id, reference: j.reference, is_medical: Boolean(j.is_medical),
      incident_type: j.incident_type, location: j.location, site: site ? site.name : null,
      description: j.description || '', notes: j.notes || '', caller: j.caller || '',
      patient_name: j.patient_name || '', patient_dob: j.patient_dob || '',
      chief_complaint: j.chief_complaint || '', chief_complaint_label: complaintLabel(j.chief_complaint),
      priority: j.priority, status: j.status, created_at: j.created_at,
    };
  });
  /** Only the assigned personnel/MDT (or control) may touch a job's checklist —
   * same "is this mine" check used by the general job PATCH above, pulled out
   * since both the checklist and media routes need it. */
  function assertJobAccess(j, user) {
    if (isControlRole(user.role)) return;
    const mine = db.job_assignments.some((a) => a.job_id === j.id && (
      (user.role === 'FIELD_USER' && user.personnel_id && a.personnel_id === user.personnel_id) ||
      (user.role === 'MDT_USER' && user.mdt_id && a.mdt_id === user.mdt_id)));
    if (!mine) throw httpError(403, 'job not assigned to you');
  }
  route('PATCH', '/api/jobs/:id/checklist/:itemId', ALL, ({ params, body, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    assertJobAccess(j, user);
    const item = (j.checklist || []).find((x) => x.id === params.itemId); if (!item) throw httpError(404, 'checklist item not found');
    if (body.status) {
      const s = String(body.status).toUpperCase();
      if (!['PENDING', 'COMPLETE'].includes(s)) throw httpError(400, 'invalid checklist status');
      item.status = s;
      if (s === 'COMPLETE') { item.completed_at = new Date().toISOString(); item.completed_by = user.display_name; }
      else { item.completed_at = null; item.completed_by = null; }
    }
    if (body.notes !== undefined) item.notes = String(body.notes).slice(0, 2000);
    const closed = ['COMPLETED', 'CANCELLED'].includes(j.status);
    // Filled in after the visit — e.g. by control from the officer's account
    // once they're back in signal — so the stored report stays current.
    if (closed) { item.updated_after_close = true; if (j.status === 'COMPLETED') j.resolution_report_html = jobReportHtml(j); }
    j.updated_at = new Date().toISOString();
    broadcast('job.status_changed', publicJob(j));
    logEvent('job.checklist_updated', `${item.status === 'COMPLETE' ? 'COMPLETED' : 'UPDATED'} "${item.title}" on JOB ${j.reference}${closed ? ` AFTER IT CLOSED, BY ${user.display_name}` : ''}`, { job_id: j.id, by: user.id });
    return publicJob(j);
  });
  /* Swap a job's checklist for the site's current one — the site's checklist
   * was changed after the visit and control wants the job recorded against
   * the new one. Items with the same title keep what was already filled in
   * (and their photos); the old checklist is kept on the job for the record. */
  route('POST', '/api/jobs/:id/checklist/refresh', CONTROL, ({ params, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    const site = j.site_id ? db.sites.find((x) => x.id === j.site_id) : null;
    const fresh = instantiateChecklist(site);
    const key = (t) => String(t || '').trim().toLowerCase();
    const old = j.checklist || [];
    const remap = {};
    for (const item of fresh) {
      const prev = old.find((o) => key(o.title) === key(item.title));
      if (!prev) continue;
      Object.assign(item, { status: prev.status, notes: prev.notes, completed_by: prev.completed_by, completed_at: prev.completed_at });
      remap[prev.id] = item.id;
    }
    for (const m of j.media || []) if (m.checklist_item_id) m.checklist_item_id = remap[m.checklist_item_id] || null;
    j.previous_checklists = [...(j.previous_checklists || []), { replaced_at: new Date().toISOString(), replaced_by: user.display_name, items: old }];
    j.checklist = fresh;
    if (j.status === 'COMPLETED') j.resolution_report_html = jobReportHtml(j);
    j.updated_at = new Date().toISOString();
    broadcast('job.status_changed', publicJob(j));
    logEvent('job.checklist_refreshed', `CHECKLIST ON JOB ${j.reference} REPLACED WITH ${site ? `${site.name}'S` : 'THE DEFAULT'} CURRENT CHECKLIST BY ${user.display_name}`, { job_id: j.id, kept: Object.keys(remap).length });
    return publicJob(j);
  });

  route('POST', '/api/jobs/:id/media', ALL, ({ params, body, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    assertJobAccess(j, user);
    const ext = MEDIA_MIME_EXT[body.mimetype];
    if (!ext) throw httpError(400, 'mimetype must be image/jpeg, image/png or image/webp');
    if (!body.data) throw httpError(400, 'data (base64) required');
    if (body.checklist_item_id && !(j.checklist || []).some((x) => x.id === body.checklist_item_id)) throw httpError(404, 'checklist item not found');
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.length > 8e6) throw httpError(413, 'photo too large');
    const dir = mediaDir(j.id);
    fs.mkdirSync(dir, { recursive: true });
    const mediaId = crypto.randomUUID();
    const filename = `${mediaId}${ext}`;
    fs.writeFileSync(path.join(dir, filename), bytes);
    const media = {
      id: mediaId, url: `/api/jobs/${j.id}/media/${mediaId}`, filename, caption: String(body.caption || '').slice(0, 200),
      checklist_item_id: body.checklist_item_id || null, taken_by: user.display_name, taken_at: new Date().toISOString(),
    };
    j.media = j.media || [];
    j.media.push(media);
    // A photo added after the job closed (from the gallery, or by control)
    // still belongs on its stored report.
    if (j.status === 'COMPLETED') j.resolution_report_html = jobReportHtml(j);
    j.updated_at = new Date().toISOString();
    broadcast('job.status_changed', publicJob(j));
    logEvent('job.media_added', `PHOTO ADDED TO JOB ${j.reference} BY ${user.display_name}`, { job_id: j.id });
    return { __status: 201, __body: media };
  });
  route('GET', '/api/jobs/:id/media/:mediaId', ALL, ({ params, user }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    assertJobAccess(j, user);
    const m = (j.media || []).find((x) => x.id === params.mediaId); if (!m) throw httpError(404, 'photo not found');
    const file = path.join(mediaDir(j.id), m.filename);
    if (!fs.existsSync(file)) throw httpError(404, 'photo file missing');
    return { __body: fs.readFileSync(file), __headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'private, max-age=86400' } };
  });

  route('POST', '/api/jobs/:id/stand-down', CONTROL, ({ params, body }) => {
    const j = db.jobs.find((x) => x.id === Number(params.id)); if (!j) throw httpError(404, 'job not found');
    const p = body.personnel ? findPersonnel(body.personnel) : null;
    const m = body.mdt ? findMdt(body.mdt) : null;
    if (!p && !m) throw httpError(400, 'personnel or mdt required');
    const a = db.job_assignments.find((x) => x.job_id === j.id && ((p && x.personnel_id === p.id) || (m && x.mdt_id === m.id)));
    if (!a) throw httpError(404, 'that resource is not assigned to this job');
    db.job_assignments = db.job_assignments.filter((x) => x.id !== a.id);
    const who = p ? p.name : m.mdt_code;
    if (m) { m.job_id = null; broadcast('mdt.status_changed', publicMdt(m)); }
    j.updated_at = new Date().toISOString();
    const payload = publicJob(j);
    broadcast('job.status_changed', payload);
    broadcast('job.stood_down', payload, { personnelIds: p ? [p.id] : [], mdtIds: m ? [m.id] : [] });
    logEvent('job.stood_down', `${who} STOOD DOWN FROM JOB ${j.reference}`, { job_id: j.id });
    return payload;
  });

  return { assertJobAccess, closeJob, closingNote };
};
