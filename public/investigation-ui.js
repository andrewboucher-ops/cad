/* The investigation panel on a report (forms.html): start one, name the
 * investigator, record findings and root cause, the risk assessment,
 * actions and external notification decisions, then sign off. Also the
 * report's audit trail and the investigation report PDF.
 *
 * Every rule lives on the server (routes-forms.js); this page only offers
 * what the server said this person may do (can_investigate, can_see_trail). */
'use strict';
window.CCCSInvestigation = (() => {
  const { api, esc } = CCCS;
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const FIELDS = [
    ['findings', 'Findings', 'What the investigation found, in order.'],
    ['witnesses', 'Witnesses', 'Who was spoken to, and when.'],
    ['evidence_reviewed', 'Evidence reviewed', 'CCTV, body-worn video, radio logs, statements, photos.'],
    ['root_cause', 'Root cause', 'Why it happened — the underlying reason, not just what happened.'],
    ['contributing_factors', 'Contributing factors', 'Staffing, training, site layout, instructions, equipment.'],
    ['recommendations', 'Recommendations', ''],
    ['lessons_learned', 'Lessons learned', 'What will be shared with the team.'],
  ];
  const BODIES = [
    ['CQC', 'CQC (statutory notification)', 'Only if the work is a CQC-regulated activity (e.g. medical cover). Notify without delay.'],
    ['SIA', 'SIA', 'For example a licence holder arrested, charged or convicted, or an ACS-relevant matter.'],
    ['ICO', 'ICO (personal data breach)', 'Within 72 hours of becoming aware, if the breach is likely to put people at risk.'],
    ['HSE_RIDDOR', 'HSE (RIDDOR)', 'Deaths and specified injuries without delay; over-7-day injuries within 15 days.'],
    ['POLICE', 'Police', ''],
    ['SAFEGUARDING', 'Local authority safeguarding team', ''],
    ['CLIENT', 'Client', ''],
    ['INSURER', 'Insurer', ''],
    ['PERSON_AFFECTED', 'Person affected (duty of candour / being open)', 'Tell them what happened, apologise, and say what is being done.'],
    ['OTHER', 'Other', ''],
  ];
  const STATUS_LABEL = { UNDER_INVESTIGATION: 'Under investigation', RETURNED_FOR_CORRECTION: 'Returned to the officer for correction', ACTIONED: 'Signed off' };
  const box = 'border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-top:10px';
  const small = 'font-size:12px';

  async function openPdf(url, btn) {
    const was = btn.textContent; btn.disabled = true; btn.textContent = '…';
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${CCCS.getSession().token}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'could not build the PDF');
      window.open(URL.createObjectURL(await res.blob()), '_blank');
    } catch (e) { alert(e.message); }
    btn.disabled = false; btn.textContent = was;
  }

  /** host: an element. sub: the report as GET /api/form-submissions/:id
   * returned it. isAdmin: SYSTEM_ADMIN. reload(): re-open the report. */
  function render(host, sub, { isAdmin, reload }) {
    const inv = sub.investigation && sub.investigation.started_at ? sub.investigation : null;
    if (!inv) {
      host.innerHTML = isAdmin && sub.status === 'OPEN' ? `
        <div style="${box}">
          <label>Investigate this report</label>
          <p class="dim" style="${small};margin:4px 0 8px">For anything that needs more than a quick review: an injury, use of force, a complaint, a safeguarding concern, a data breach or a near miss. Every view and change from now on is recorded.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><select id="ivWho" style="flex:1;min-width:180px"><option value="">Investigator: me</option></select>
          <button class="btn primary" id="ivStart">Start investigation</button></div>
          <p class="err" id="ivErr"></p>
        </div>${trailButtons(sub)}` : trailButtons(sub);
      wireTrail(host, sub);
      if (isAdmin && sub.status === 'OPEN') {
        api('GET', `/api/form-submissions/${sub.id}/investigators`).then((users) => {
          const sel = host.querySelector('#ivWho');
          if (sel) sel.innerHTML += users.map((u) => `<option value="${u.id}">Investigator: ${esc(u.display_name)} (${esc(u.role.toLowerCase().replace('_', ' '))})</option>`).join('');
        }).catch(() => {});
        host.querySelector('#ivStart').onclick = async () => {
          try { await api('POST', `/api/form-submissions/${sub.id}/investigation/start`, { investigator_user_id: Number(host.querySelector('#ivWho').value) || undefined }); reload(); }
          catch (e) { host.querySelector('#ivErr').textContent = e.message; }
        };
      }
      return;
    }

    const editable = sub.can_investigate && ['UNDER_INVESTIGATION', 'RETURNED_FOR_CORRECTION'].includes(sub.status);
    const ra = sub.risk_assessment || {};
    const opt = (v, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${v ? v.charAt(0) + v.slice(1).toLowerCase() : '—'}</option>`;
    const actions = inv.actions || [];
    const notes = inv.external_notifications || [];
    host.innerHTML = `
      <div style="${box};border-left:4px solid var(--on-task)">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <strong style="flex:1">Investigation — ${esc(STATUS_LABEL[sub.status] || sub.status)}</strong>
          ${sub.can_see_trail ? '<button class="btn" style="padding:2px 10px;font-size:11px" data-iv-pdf>Investigation report PDF</button>' : ''}
        </div>
        <p class="dim" style="${small};margin:4px 0 0">Started ${esc(fmt(inv.started_at))} by ${esc(inv.started_by)} · investigator <strong>${esc(inv.investigator || '—')}</strong></p>
        ${isAdmin && editable ? `<div style="display:flex;gap:6px;margin-top:6px"><select id="ivAssign" style="flex:1"><option value="">Change investigator…</option></select><button class="btn" id="ivAssignGo">Assign</button></div>` : ''}

        ${FIELDS.map(([k, label, help]) => `<label style="margin-top:10px;display:block">${esc(label)}${k === 'findings' || k === 'root_cause' ? ' <span class="dim">(needed to sign off)</span>' : ''}</label>
          ${editable ? `<textarea data-iv-f="${k}" rows="3" placeholder="${esc(help)}" style="width:100%;box-sizing:border-box">${esc(inv[k] || '')}</textarea>`
            : `<div style="white-space:pre-wrap">${esc(inv[k] || '—')}</div>`}`).join('')}
        ${editable ? '<div class="btn-row" style="margin-top:6px"><button class="btn primary" id="ivSave">Save investigation notes</button><span class="dim" id="ivSaved" style="font-size:12px"></span></div>' : ''}

        <label style="margin-top:14px;display:block">Risk assessment</label>
        ${editable ? `<div style="display:flex;gap:6px;flex-wrap:wrap">
            <select id="raL" style="flex:1">${['', 'LOW', 'MEDIUM', 'HIGH'].map((v) => opt(v, ra.likelihood || '')).join('')}</select>
            <select id="raS" style="flex:1">${['', 'LOW', 'MEDIUM', 'HIGH'].map((v) => opt(v, ra.severity || '')).join('')}</select>
            <input id="raD" type="date" value="${esc(ra.review_date || '')}" style="flex:1" title="Review date"></div>
            <p class="dim" style="${small};margin:2px 0">Likelihood · severity · review date. Rating: <strong>${esc(ra.risk_rating || '—')}</strong></p>
            <textarea id="raC" rows="2" placeholder="Control measures" style="width:100%;box-sizing:border-box">${esc(ra.control_measures || '')}</textarea>
            <div class="btn-row"><button class="btn" id="raSave">Save risk assessment</button></div>`
          : `<div>${esc(ra.risk_rating || '—')}${ra.likelihood ? ` <span class="dim">(likelihood ${esc(ra.likelihood)}, severity ${esc(ra.severity)})</span>` : ''}${ra.control_measures ? `<div style="white-space:pre-wrap">${esc(ra.control_measures)}</div>` : ''}</div>`}

        <label style="margin-top:14px;display:block">Actions <span class="dim">(all must be done or cancelled before sign-off)</span></label>
        ${actions.length ? actions.map((a) => `<div style="padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:13px">
            <strong class="mono">${esc(a.id)}</strong> ${esc(a.description)}
            <div class="dim" style="${small}">${a.owner ? `Owner ${esc(a.owner)} · ` : ''}${a.due_date ? `due ${esc(a.due_date)} · ` : ''}${a.status === 'OPEN' ? '<span style="color:var(--busy)">Open</span>' : `${a.status === 'DONE' ? 'Done' : 'Cancelled'} by ${esc(a.closed_by)} ${esc(fmt(a.closed_at))}${a.note ? ` — ${esc(a.note)}` : ''}`}</div>
            ${editable && a.status === 'OPEN' ? `<div style="display:flex;gap:6px;margin-top:4px"><input data-iv-note="${esc(a.id)}" placeholder="Note (needed to cancel)" style="flex:1;font-size:13px"><button class="btn" data-iv-done="${esc(a.id)}">Done</button><button class="btn" data-iv-cancel="${esc(a.id)}">Cancel</button></div>` : ''}
          </div>`).join('') : '<p class="dim" style="margin:2px 0">None yet.</p>'}
        ${editable ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            <input id="acD" placeholder="New action" style="flex:2;min-width:160px"><input id="acO" placeholder="Owner" style="flex:1;min-width:100px"><input id="acDue" type="date" style="flex:1" title="Due date">
            <button class="btn" id="acAdd">Add</button></div>` : ''}

        <label style="margin-top:14px;display:block">Who has been told</label>
        <p class="dim" style="${small};margin:0 0 4px">Record each body you notified — or that you considered it and it wasn't needed, and why. Reminders only, not legal advice: check each regulator's current guidance.</p>
        ${notes.length ? notes.map((n) => `<div style="padding:4px 0;font-size:13px;border-bottom:1px solid var(--line-soft)"><strong>${esc(n.label)}</strong> — ${n.decision === 'NOTIFIED' ? `notified ${esc(fmt(n.notified_at))}${n.reference ? `, ref ${esc(n.reference)}` : ''}` : 'not required'}${n.notes ? ` <span class="dim">· ${esc(n.notes)}</span>` : ''} <span class="dim">(${esc(n.recorded_by)})</span></div>`).join('') : '<p class="dim" style="margin:2px 0">Nothing recorded yet.</p>'}
        ${editable ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px;margin-top:6px">
            <select id="nbB">${BODIES.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
            <select id="nbDec"><option value="NOTIFIED">Notified</option><option value="NOT_REQUIRED">Not required</option></select>
            <input id="nbAt" type="datetime-local" title="When they were told">
            <input id="nbRef" placeholder="Their reference">
          </div>
          <p class="dim" id="nbHint" style="${small};margin:4px 0"></p>
          <div style="display:flex;gap:6px"><input id="nbNotes" placeholder="Notes (needed if not required)" style="flex:1"><button class="btn" id="nbAdd">Record</button></div>` : ''}

        ${(inv.sign_offs || []).length ? `<label style="margin-top:14px;display:block">Sign-off</label>${inv.sign_offs.map((so) => `<div style="font-size:13px">${esc(fmt(so.at))} — <strong>${esc(so.by)}</strong> (${esc(so.outcome.toLowerCase())}${so.independent ? '' : ', who was also the investigator'}): ${esc(so.statement)}</div>`).join('')}` : ''}
        ${isAdmin && sub.status === 'ACTIONED' ? `<div style="display:flex;gap:6px;margin-top:10px"><input id="ivReason" placeholder="Reason for reopening" style="flex:1"><button class="btn" id="ivReopen">Reopen</button></div>` : ''}
        ${isAdmin && sub.status === 'UNDER_INVESTIGATION' ? `<div style="display:flex;gap:6px;margin-top:10px"><input id="ivRet" placeholder="What the officer needs to correct or add" style="flex:1"><button class="btn" id="ivReturn">Return to officer</button></div>` : ''}
        <p class="err" id="ivErr"></p>
      </div>${trailButtons(sub)}`;

    const err = (e) => { host.querySelector('#ivErr').textContent = e.message; };
    const q = (s) => host.querySelector(s);
    const pdfBtn = q('[data-iv-pdf]');
    if (pdfBtn) pdfBtn.onclick = () => openPdf(`/api/form-submissions/${sub.id}/investigation-report`, pdfBtn);
    wireTrail(host, sub);

    if (q('#ivAssign')) {
      api('GET', `/api/form-submissions/${sub.id}/investigators`).then((users) => {
        q('#ivAssign').innerHTML += users.filter((u) => u.id !== inv.investigator_user_id).map((u) => `<option value="${u.id}">${esc(u.display_name)}</option>`).join('');
      }).catch(() => {});
      q('#ivAssignGo').onclick = async () => { if (!q('#ivAssign').value) return; try { await api('POST', `/api/form-submissions/${sub.id}/investigation/assign`, { user_id: Number(q('#ivAssign').value) }); reload(); } catch (e) { err(e); } };
    }
    if (q('#ivSave')) q('#ivSave').onclick = async () => {
      const body = {}; host.querySelectorAll('[data-iv-f]').forEach((t) => (body[t.dataset.ivF] = t.value));
      try { await api('PATCH', `/api/form-submissions/${sub.id}/investigation`, body); q('#ivSaved').textContent = ' Saved'; setTimeout(reload, 400); } catch (e) { err(e); }
    };
    if (q('#raSave')) q('#raSave').onclick = async () => {
      try { await api('PATCH', `/api/form-submissions/${sub.id}/risk-assessment`, { likelihood: q('#raL').value, severity: q('#raS').value, review_date: q('#raD').value || null, control_measures: q('#raC').value }); reload(); } catch (e) { err(e); }
    };
    if (q('#acAdd')) q('#acAdd').onclick = async () => {
      try { await api('POST', `/api/form-submissions/${sub.id}/investigation/actions`, { description: q('#acD').value, owner: q('#acO').value, due_date: q('#acDue').value || null }); reload(); } catch (e) { err(e); }
    };
    const setAction = async (id, status) => {
      try { await api('PATCH', `/api/form-submissions/${sub.id}/investigation/actions/${encodeURIComponent(id)}`, { status, note: (host.querySelector(`[data-iv-note="${CSS.escape(id)}"]`) || {}).value || '' }); reload(); } catch (e) { err(e); }
    };
    host.querySelectorAll('[data-iv-done]').forEach((b) => (b.onclick = () => setAction(b.dataset.ivDone, 'DONE')));
    host.querySelectorAll('[data-iv-cancel]').forEach((b) => (b.onclick = () => setAction(b.dataset.ivCancel, 'CANCELLED')));
    if (q('#nbB')) {
      const hint = () => { const b = BODIES.find(([k]) => k === q('#nbB').value); q('#nbHint').textContent = b[2]; q('#nbAt').disabled = q('#nbRef').disabled = q('#nbDec').value !== 'NOTIFIED'; };
      q('#nbB').onchange = hint; q('#nbDec').onchange = hint; hint();
      q('#nbAdd').onclick = async () => {
        const at = q('#nbAt').value ? new Date(q('#nbAt').value).toISOString() : null;
        try { await api('POST', `/api/form-submissions/${sub.id}/investigation/notifications`, { body: q('#nbB').value, decision: q('#nbDec').value, notified_at: at, reference: q('#nbRef').value, notes: q('#nbNotes').value }); reload(); } catch (e) { err(e); }
      };
    }
    if (q('#ivReopen')) q('#ivReopen').onclick = async () => { try { await api('POST', `/api/form-submissions/${sub.id}/investigation/reopen`, { reason: q('#ivReason').value }); reload(); } catch (e) { err(e); } };
    if (q('#ivReturn')) q('#ivReturn').onclick = async () => { try { await api('POST', `/api/form-submissions/${sub.id}/return-for-correction`, { reason: q('#ivRet').value }); reload(); } catch (e) { err(e); } };
  }

  function trailButtons(sub) {
    return sub.can_see_trail ? `<div style="margin-top:10px"><button class="btn" style="font-size:12px" data-iv-trail>Audit trail — who viewed or changed this</button><div data-iv-trail-host></div></div>` : '';
  }
  function wireTrail(host, sub) {
    const btn = host.querySelector('[data-iv-trail]');
    if (!btn) return;
    btn.onclick = async () => {
      const out = host.querySelector('[data-iv-trail-host]');
      out.innerHTML = '<p class="dim">Loading…</p>';
      try {
        const t = await api('GET', `/api/form-submissions/${sub.id}/audit-trail`);
        const i = t.integrity;
        const val = (v) => (v === null || v === undefined || v === '' ? '(blank)' : String(v).length > 200 ? String(v).slice(0, 200) + '…' : String(v));
        out.innerHTML = `
          <p style="${small};margin:6px 0;color:${i.ok ? 'var(--available)' : 'var(--emergency)'}">${i.ok
            ? `Integrity check passed — ${i.entries} entries, none changed or removed${i.anchored_in_global_trail !== null ? `; ${i.anchored_in_global_trail} also anchored in the system audit log` : ''}.`
            : `Integrity check FAILED at entry ${i.broken_at}: ${esc(i.reason)}.`}</p>
          <div style="max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:8px">
          ${t.entries.slice().reverse().map((e) => `<div style="padding:6px 10px;border-bottom:1px solid var(--line-soft);font-size:12.5px">
            <span class="dim mono">#${e.seq}</span> <strong>${esc(e.by || '—')}</strong> <span class="dim">${esc(fmt(e.at))}</span> — ${esc(e.summary)}
            ${(e.changes || []).length ? `<ul style="margin:2px 0 0 18px;padding:0">${e.changes.map((c) => `<li>${esc(c.label)}: <span class="dim">${esc(val(c.from))}</span> → ${esc(val(c.to))}</li>`).join('')}</ul>` : ''}
          </div>`).join('')}</div>`;
      } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    };
  }

  return { render };
})();
