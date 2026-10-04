/* Forms UI — filling in and viewing a configurable form.
 *
 * Shared by officer.html (filing), forms.html (reading) and the control
 * room's Detail panel. Needs app.js loaded first (CCCS.api / CCCS.esc).
 *
 * Deliberately NOT routed through CCCS.send()'s offline outbox. The outbox
 * stores queued writes in plain localStorage and replays them under whoever
 * is signed in when the link returns — on a shared handset that would leave a
 * safeguarding report readable in storage, then file it under the next
 * officer's name. Photos would also overflow localStorage's quota. So a
 * submission goes straight to the server; if the link is down the filled-in
 * form stays on screen, in memory only, and the officer is told plainly that
 * it has NOT been sent.
 *
 * Nothing here decides who may read what. The server returns only what the
 * signed-in user is entitled to (routes-forms.js); this file renders it. */
'use strict';
const CCCSForms = (() => {
  const { api, esc } = CCCS;

  // Self-contained styles: this component renders into pages whose own
  // stylesheets differ (officer.html defines .field, admin.html .stack).
  if (!document.getElementById('ff-style')) {
    const st = document.createElement('style'); st.id = 'ff-style';
    st.textContent = `
      .ff-stack { display:flex; flex-direction:column; gap:8px; }
      .ff-stack > label { font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-dim); margin-top:4px; }
      .ff-stack input:not([type=checkbox]), .ff-stack select, .ff-stack textarea { width:100%; box-sizing:border-box; }
      .ff-field { margin-bottom:6px; }
      .ff-field > span { display:block; font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-dim); }
      .ff-field > div { font-size:14px; color:var(--ink); }`;
    document.head.appendChild(st);
  }

  const OUTCOME_LABEL = { APPROVED: 'Approved', REJECTED: 'Rejected', NOTED: 'Noted' };
  const OUTCOME_COLOUR = { APPROVED: 'var(--available)', REJECTED: 'var(--emergency)', NOTED: 'var(--ink-dim)' };
  const SUBJECT_LABEL = { JOB: 'Job', SITE_VISIT: 'Patrol visit', SITE: 'Site', PERSONNEL: 'Person', VEHICLE: 'Vehicle' };
  const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  const SEVERITY_PRI = { LOW: 'ROUTINE', MEDIUM: 'GREEN', HIGH: 'AMBER', CRITICAL: 'RED' };

  /** Best-effort device location, never blocking a submission on it: resolves
   * null on denial, timeout, or a browser with no geolocation at all. Short
   * timeout and no high-accuracy request — this is "were you roughly here",
   * not a tracking fix. */
  function bestEffortGeo() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      const done = (v) => resolve(v);
      navigator.geolocation.getCurrentPosition(
        (pos) => done({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy || 0) }),
        () => done(null),
        { timeout: 4000, maximumAge: 60000 },
      );
    });
  }

  /* ---------------- signature pad ---------------- */

  /** A canvas you sign with a finger or mouse. Exports PNG, because that is
   * the only type the server accepts for a signature. `inked` tracks whether
   * anything was drawn, so an untouched pad counts as unsigned rather than
   * submitting a blank white rectangle as someone's signature. */
  function signaturePad(host) {
    host.innerHTML = `
      <canvas style="width:100%;height:150px;background:#fff;border-radius:8px;border:1px solid var(--line);touch-action:none;display:block"></canvas>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
        <span class="dim" style="font-size:11px">Sign above</span>
        <button type="button" class="btn" style="padding:3px 10px;font-size:11px">Clear</button>
      </div>`;
    const canvas = host.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    let inked = false, drawing = false, last = null;
    function size() {
      const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, r.width, r.height);
      ctx.strokeStyle = '#111'; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      inked = false;
    }
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      last = p; inked = true;
    });
    const end = () => { drawing = false; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    host.querySelector('button').onclick = size;
    requestAnimationFrame(size);
    return {
      get inked() { return inked; },
      png: () => canvas.toDataURL('image/png').split(',')[1],
      // JPEG (white background) for documents that embed it, e.g. a PDF.
      jpeg: () => canvas.toDataURL('image/jpeg', 0.9).split(',')[1],
    };
  }

  /* ---------------- photos ---------------- */

  /** Phone cameras produce 4-12MB files. Downscaled to 1600px JPEG on the
   * device, so a report with several photos fits the server's request limit
   * and uploads over a weak mobile signal. */
  function downscale(file, maxPx = 1600, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', quality).split(',')[1]);
      };
      img.onerror = () => reject(new Error('could not read that image'));
      img.src = URL.createObjectURL(file);
    });
  }

  /* ---------------- filling in ---------------- */

  const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  /**
   * Renders `def` into `host` for filling in against `subject`
   * ({ type, id, label }). Calls onDone(submission) once the server has
   * accepted it. `signerName` pre-fills each signature's name.
   *
   * `submit(values)` replaces the default POST — the public application page
   * (apply.html) has no session and posts elsewhere — and `subject` may then
   * be null. `submitLabel` names the button.
   */
  function fill(host, def, subject, { signerName = '', onDone, onCancel, submit, submitLabel = 'Submit report', extra = null } = {}) {
    const pads = {}, photos = {};
    host.innerHTML = `
      <div class="ff-stack">
        ${def.visibility === 'RESTRICTED' ? `<p style="margin:0;padding:8px 10px;border-radius:8px;border:1px solid var(--priority);font-size:12.5px">
          <strong>Restricted report.</strong> Only you and the named people responsible for these reports will be able to read it. It will not appear in the control-room log.</p>` : ''}
        ${subject ? `<p class="dim" style="margin:0;font-size:12.5px">${esc(SUBJECT_LABEL[subject.type] || subject.type)}: <strong>${esc(subject.label)}</strong></p>` : ''}
        ${def.fields.map((f) => fieldHtml(f)).join('')}
        ${extra ? extra.html : ''}
        <p class="err" data-ff-err style="min-height:16px;margin:0"></p>
        <div class="btn-row">
          ${onCancel ? '<button type="button" class="btn" data-ff-cancel>Cancel</button>' : ''}
          <button type="button" class="btn primary" data-ff-submit>${esc(submitLabel)}</button>
        </div>
      </div>`;

    for (const f of def.fields) {
      if (f.type === 'signature') {
        pads[f.id] = signaturePad(host.querySelector(`[data-ff-pad="${f.id}"]`));
        host.querySelector(`[data-ff-signer="${f.id}"]`).value = signerName;
      }
      if (f.type === 'photo') {
        const input = host.querySelector(`[data-ff-photo="${f.id}"]`);
        const status = host.querySelector(`[data-ff-photostatus="${f.id}"]`);
        host.querySelector(`[data-ff-photobtn="${f.id}"]`).onclick = () => input.click();
        input.onchange = async () => {
          const file = input.files[0]; if (!file) return;
          status.textContent = 'Preparing…';
          try { photos[f.id] = await downscale(file); status.textContent = 'Photo attached ✓'; }
          catch (e) { status.textContent = e.message; }
          input.value = '';
        };
      }
      if (f.type === 'datetime') host.querySelector(`[data-ff="${f.id}"]`).value = toLocalInput(new Date());
    }

    const errEl = host.querySelector('[data-ff-err]');
    if (onCancel) host.querySelector('[data-ff-cancel]').onclick = onCancel;
    const submitBtn = host.querySelector('[data-ff-submit]');
    submitBtn.onclick = async () => {
      errEl.textContent = '';
      const values = {};
      for (const f of def.fields) {
        const input = host.querySelector(`[data-ff="${f.id}"]`);
        switch (f.type) {
          case 'checkbox': values[f.id] = input.checked; break;
          case 'number': if (input.value !== '') values[f.id] = Number(input.value); break;
          case 'datetime': if (input.value) values[f.id] = new Date(input.value).toISOString(); break;
          case 'signature': {
            const signer = host.querySelector(`[data-ff-signer="${f.id}"]`).value.trim();
            if (pads[f.id].inked) values[f.id] = { mimetype: 'image/png', data: pads[f.id].png(), signer_name: signer };
            else if (f.required) { errEl.textContent = `${f.label}: please sign`; return; }
            break;
          }
          case 'photo': if (photos[f.id]) values[f.id] = { mimetype: 'image/jpeg', data: photos[f.id] }; break;
          default: if (input.value.trim() !== '') values[f.id] = input.value.trim();
        }
      }
      let more = {};
      if (extra) { try { more = extra.collect(host) || {}; } catch (e) { errEl.textContent = e.message; return; } }
      submitBtn.disabled = true; submitBtn.textContent = 'Sending…';
      try {
        const sub = submit ? await submit(values)
          : await api('POST', '/api/form-submissions', { definition_id: def.id, subject_type: subject.type, subject_id: subject.id, values, geo: await bestEffortGeo(), ...more });
        onDone && onDone(sub);
      } catch (e) {
        const offline = e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(e.message || '');
        errEl.textContent = offline
          ? 'NOT SENT — no connection. Your answers are still here; keep this screen open and press Submit again when you have signal.'
          : e.message;
        submitBtn.disabled = false; submitBtn.textContent = submitLabel;
      }
    };
  }

  function fieldHtml(f) {
    const req = f.required ? ' <span style="color:var(--priority)">*</span>' : '';
    const label = `<label>${esc(f.label)}${req}</label>${f.help ? `<p class="dim" style="margin:0 0 4px;font-size:12px">${esc(f.help)}</p>` : ''}`;
    switch (f.type) {
      case 'textarea': return `${label}<textarea data-ff="${f.id}" rows="3"></textarea>`;
      case 'number': return `${label}<input data-ff="${f.id}" type="number" inputmode="decimal">`;
      case 'date': return `${label}<input data-ff="${f.id}" type="date">`;
      case 'datetime': return `${label}<input data-ff="${f.id}" type="datetime-local">`;
      case 'select': return `${label}<select data-ff="${f.id}"><option value="">— choose —</option>${f.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
      case 'severity': return `${label}<select data-ff="${f.id}"><option value="">— choose —</option>${SEVERITIES.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
      case 'checkbox': return `<label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-size:14px"><input data-ff="${f.id}" type="checkbox" style="width:20px;height:20px">${esc(f.label)}${req}</label>`;
      case 'signature': return `${label}<div data-ff-pad="${f.id}"></div><input data-ff-signer="${f.id}" placeholder="Name of person signing" style="margin-top:6px">`;
      case 'photo': return `${label}<div style="display:flex;gap:8px;align-items:center"><button type="button" class="btn" data-ff-photobtn="${f.id}">Take / choose photo</button><span class="dim" data-ff-photostatus="${f.id}"></span></div><input type="file" accept="image/*" capture="environment" class="hide" data-ff-photo="${f.id}">`;
      default: return `${label}<input data-ff="${f.id}" autocomplete="off">`;
    }
  }

  /* ---------------- viewing ---------------- */

  /** Image URLs need the bearer token, which an <img src> cannot send, so
   * they are fetched and shown as blob URLs. */
  async function loadImages(host) {
    for (const img of host.querySelectorAll('img[data-ff-src]')) {
      try {
        const res = await fetch(img.dataset.ffSrc, { headers: { authorization: `Bearer ${CCCS.getSession().token}` } });
        if (res.ok) img.src = URL.createObjectURL(await res.blob());
      } catch {}
    }
  }

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

  /** `onChanged(sub)` is called after an edit is saved (to refresh lists). */
  function view(host, sub, { onChanged } = {}) {
    const valueHtml = (f) => {
      const v = sub.values[f.id];
      if (v === null || v === undefined || v === '') return '<span class="dim">—</span>';
      switch (f.type) {
        case 'checkbox': return v ? 'Yes' : 'No';
        case 'datetime': return esc(fmt(v));
        case 'signature': return `<img data-ff-src="${esc(v.url)}" alt="signature" style="max-width:260px;height:90px;object-fit:contain;background:#fff;border-radius:6px;border:1px solid var(--line)"><div class="dim" style="font-size:12px">${esc(v.signer_name)} · ${esc(fmt(v.signed_at))}</div>`;
        case 'photo': return `<img data-ff-src="${esc(v.url)}" alt="photo" style="max-width:100%;max-height:260px;border-radius:6px;border:1px solid var(--line)">${v.caption ? `<div class="dim">${esc(v.caption)}</div>` : ''}`;
        case 'textarea': return `<div style="white-space:pre-wrap">${esc(v)}</div>`;
        case 'severity': return `<span class="pri pri-${SEVERITY_PRI[v] || 'ROUTINE'}">${esc(v)}</span>`;
        default: return esc(v);
      }
    };
    host.innerHTML = `
      <div class="ff-stack">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <span class="mono" style="font-weight:700">${esc(sub.reference)}</span>
          <span>${esc(sub.definition_name)}</span>
          ${sub.visibility === 'RESTRICTED' ? '<span class="pri pri-RED">RESTRICTED</span>' : ''}
          <button type="button" class="btn" style="padding:2px 10px;font-size:11px;margin-left:auto" data-ff-pdf>PDF</button>
        </div>
        <p class="dim" style="margin:0;font-size:12.5px">${esc(SUBJECT_LABEL[sub.subject_type] || sub.subject_type)} ${esc(sub.subject_label)} · filed by ${esc(sub.submitted_by)} · ${esc(fmt(sub.submitted_at))} · form v${sub.definition_version}</p>
        ${sub.geo ? `<p class="dim" style="margin:0;font-size:12px">Filed near <a href="https://www.openstreetmap.org/?mlat=${sub.geo.lat}&mlon=${sub.geo.lon}#map=17/${sub.geo.lat}/${sub.geo.lon}" target="_blank" rel="noopener">${sub.geo.lat.toFixed(5)}, ${sub.geo.lon.toFixed(5)}</a>${sub.geo.accuracy ? ` (±${sub.geo.accuracy}m)` : ''}</p>` : ''}
        ${sub.client_share ? `<p class="dim" style="margin:0;font-size:12px;color:var(--available)">Shared with the client ${esc(fmt(sub.client_share.shared_at))} by ${esc(sub.client_share.shared_by)}</p>` : ''}
        ${sub.status === 'ACTIONED' ? `<div style="border:1px solid var(--line);border-left:4px solid ${OUTCOME_COLOUR[sub.outcome] || 'var(--line)'};border-radius:8px;padding:8px 10px">
          <div style="font-weight:700">${esc(OUTCOME_LABEL[sub.outcome] || sub.outcome)} <span class="dim" style="font-weight:400;font-size:12px">by ${esc(sub.actioned_by)} · ${esc(fmt(sub.actioned_at))}</span></div>
          ${sub.feedback ? `<div style="white-space:pre-wrap;margin-top:4px">${esc(sub.feedback)}</div>` : ''}</div>` : ''}
        ${sub.fields.map((f) => `<div class="ff-field"><span>${esc(f.label)}</span><div>${valueHtml(f)}</div></div>`).join('')}
        ${(sub.kit_check || []).length ? `<div class="ff-field"><span>Kit on the vehicle</span><div>${sub.kit_check.map((k) => `${esc(k.tag ? k.tag + ' — ' : '')}${esc(k.description)}: ${k.present ? 'present' : '<strong style="color:var(--emergency)">MISSING</strong>'}${k.note ? ` <span class="dim">(${esc(k.note)})</span>` : ''}`).join('<br>')}</div></div>` : ''}
        ${(sub.amendments || []).length ? `<div style="border-top:1px solid var(--line);padding-top:8px;margin-top:4px">
          <div class="dim" style="font-size:11px;letter-spacing:.1em;text-transform:uppercase">Edits</div>
          ${sub.amendments.map((a) => `<div style="font-size:12.5px;margin-top:6px"><strong>${esc(a.by)}</strong> <span class="dim">${esc(fmt(a.at))}</span> — ${esc(a.reason)}
            <ul style="margin:2px 0 0 18px;padding:0">${a.changes.map((c) => `<li>${esc(c.label)}: <span class="dim">${esc(shortVal(c.from))}</span> → ${esc(shortVal(c.to))}</li>`).join('')}</ul></div>`).join('')}
        </div>` : ''}
        ${sub.editable ? '<div class="btn-row"><button type="button" class="btn" data-ff-edit>Edit this report</button></div>' : ''}
      </div>`;
    loadImages(host);
    const pdfBtn = host.querySelector('[data-ff-pdf]');
    if (pdfBtn) pdfBtn.onclick = async () => {
      pdfBtn.disabled = true; const was = pdfBtn.textContent; pdfBtn.textContent = '…';
      try {
        const res = await fetch(`/api/form-submissions/${sub.id}/pdf`, { headers: { authorization: `Bearer ${CCCS.getSession().token}` } });
        if (!res.ok) throw new Error('could not build the PDF');
        window.open(URL.createObjectURL(await res.blob()), '_blank');
      } catch (e) { alert(e.message); }
      pdfBtn.disabled = false; pdfBtn.textContent = was;
    };
    const btn = host.querySelector('[data-ff-edit]');
    if (btn) btn.onclick = () => edit(host, sub, {
      onSaved: (updated) => { view(host, updated, { onChanged }); onChanged && onChanged(updated); },
      onCancel: () => view(host, sub, { onChanged }),
    });
  }
  const shortVal = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (v === true) return 'Yes'; if (v === false) return 'No';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return fmt(v);
    return String(v).slice(0, 80);
  };

  /* ---------------- correcting (vehicle reports) ---------------- */

  const EDITABLE = ['text', 'textarea', 'number', 'select', 'checkbox', 'date', 'datetime'];
  /** The server decides whether this report may be edited (sub.editable)
   * and keeps every change with who, when and why. Photos and signatures
   * are not editable and are not shown here. */
  function edit(host, sub, { onSaved, onCancel } = {}) {
    const fields = sub.fields.filter((f) => EDITABLE.includes(f.type));
    host.innerHTML = `
      <div class="ff-stack">
        <p class="dim" style="margin:0;font-size:12.5px">Editing <strong>${esc(sub.reference)}</strong> — ${esc(sub.definition_name)}, ${esc(sub.subject_label)}. The original answers are kept with the report.</p>
        ${fields.map((f) => fieldHtml(f)).join('')}
        <label>Why are you changing it? <span style="color:var(--priority)">*</span></label>
        <input data-ff-reason placeholder="e.g. odometer mistyped">
        <p class="err" data-ff-err style="min-height:16px;margin:0"></p>
        <div class="btn-row"><button type="button" class="btn" data-ff-cancel>Cancel</button><button type="button" class="btn primary" data-ff-save>Save changes</button></div>
      </div>`;
    for (const f of fields) {
      const input = host.querySelector(`[data-ff="${f.id}"]`), v = sub.values[f.id];
      if (f.type === 'checkbox') input.checked = v === true;
      else if (f.type === 'datetime') input.value = v ? toLocalInput(new Date(v)) : '';
      else input.value = v ?? '';
    }
    host.querySelector('[data-ff-cancel]').onclick = () => onCancel && onCancel();
    const errEl = host.querySelector('[data-ff-err]'), save = host.querySelector('[data-ff-save]');
    save.onclick = async () => {
      errEl.textContent = '';
      const values = {};
      for (const f of fields) {
        const input = host.querySelector(`[data-ff="${f.id}"]`);
        if (f.type === 'checkbox') values[f.id] = input.checked;
        else if (f.type === 'number') values[f.id] = input.value === '' ? null : Number(input.value);
        else if (f.type === 'datetime') values[f.id] = input.value ? new Date(input.value).toISOString() : null;
        else values[f.id] = input.value.trim() === '' ? null : input.value.trim();
      }
      const reason = host.querySelector('[data-ff-reason]').value.trim();
      if (!reason) { errEl.textContent = 'Say why you are changing it.'; return; }
      save.disabled = true;
      try { onSaved && onSaved(await api('PATCH', `/api/form-submissions/${sub.id}`, { values, reason })); }
      catch (e) { errEl.textContent = e.message; save.disabled = false; }
    };
  }

  /* ---------------- sharing a redacted copy with the client ---------------- */

  /** Admin-only redaction UI: lets an admin type a client-safe copy of each
   * field (prefilled from the last shared copy, or the original answers if
   * never shared) and release or revoke it. There is no auto-redaction —
   * see routes-forms.js's cleanSharedValues() for why — so this is a manual
   * editor, not a toggle. Renders nothing for a report whose subject type
   * can never be shared (sub.client_shareable is false). */
  function shareEditor(host, sub, { onChanged } = {}) {
    if (!sub.client_shareable) { host.innerHTML = ''; return; }
    const fields = sub.fields.filter((f) => f.type !== 'signature' && f.type !== 'photo');
    const prefillSrc = sub.client_share ? sub.client_share.values : sub.values;
    host.innerHTML = `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">
        <label>Share a redacted copy with the client</label>
        <p class="dim" style="font-size:12px;margin:2px 0 8px">Edit the text below to remove any names or other personal details before sharing — only this version is ever visible in the client portal. Photos and signatures are never shared. Leave a field blank to leave it out entirely.</p>
        <div class="ff-stack">
          <label>What the client sees this is about</label>
          <input data-sh-subject value="${esc(sub.client_share ? sub.client_share.subject_label : sub.subject_label)}">
          ${fields.map((f) => fieldHtml(f)).join('')}
        </div>
        <div class="btn-row" style="margin-top:8px">
          <button type="button" class="btn primary" data-sh-go>${sub.client_share ? 'Update shared copy' : 'Share with client'}</button>
          ${sub.client_share ? '<button type="button" class="btn danger" data-sh-unshare>Unshare</button>' : ''}
        </div>
        <p class="err" data-sh-err style="min-height:16px;margin:4px 0 0"></p>
      </div>`;
    for (const f of fields) {
      const input = host.querySelector(`[data-ff="${f.id}"]`);
      const v = prefillSrc[f.id];
      if (!input || v === undefined || v === null) continue;
      if (f.type === 'checkbox') input.checked = v === true;
      else if (f.type === 'datetime') input.value = toLocalInput(new Date(v));
      else input.value = v;
    }
    const errEl = host.querySelector('[data-sh-err]');
    host.querySelector('[data-sh-go]').onclick = async () => {
      errEl.textContent = '';
      const values = {};
      for (const f of fields) {
        const input = host.querySelector(`[data-ff="${f.id}"]`);
        if (f.type === 'checkbox') values[f.id] = input.checked;
        else if (f.type === 'number') { if (input.value !== '') values[f.id] = Number(input.value); }
        else if (f.type === 'datetime') { if (input.value) values[f.id] = new Date(input.value).toISOString(); }
        else if (input.value.trim() !== '') values[f.id] = input.value.trim();
      }
      try {
        onChanged && onChanged(await api('POST', `/api/form-submissions/${sub.id}/share`, { values, subject_label: host.querySelector('[data-sh-subject]').value }));
      } catch (e) { errEl.textContent = e.message; }
    };
    const unshareBtn = host.querySelector('[data-sh-unshare]');
    if (unshareBtn) unshareBtn.onclick = async () => {
      try { onChanged && onChanged(await api('DELETE', `/api/form-submissions/${sub.id}/share`)); }
      catch (e) { errEl.textContent = e.message; }
    };
  }

  /** A compact list of submission summaries; onOpen(id) when one is clicked. */
  function list(host, rows, onOpen, empty = 'No reports.') {
    host.innerHTML = rows.length ? rows.map((s) => `
      <div class="row clickable" data-ff-open="${s.id}" style="display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line-soft);cursor:pointer">
        <span class="mono" style="font-size:12px">${esc(s.reference)}</span>
        <span style="flex:1">${esc(s.definition_name)} <span class="dim">— ${esc(s.subject_label)}</span></span>
        ${s.visibility === 'RESTRICTED' ? '<span class="pri pri-RED" style="font-size:10px">R</span>' : ''}
        ${s.status === 'ACTIONED' ? `<span style="font-size:10px;font-weight:700;color:${OUTCOME_COLOUR[s.outcome] || 'inherit'}">${esc(OUTCOME_LABEL[s.outcome] || s.outcome)}</span>` : ''}
        <span class="dim" style="font-size:11px">${esc(fmt(s.submitted_at))}</span>
      </div>`).join('') : `<p class="dim">${esc(empty)}</p>`;
    host.querySelectorAll('[data-ff-open]').forEach((r) => (r.onclick = () => onOpen(Number(r.dataset.ffOpen))));
  }

  /* ---------------- kit on a vehicle ---------------- */

  /** For a vehicle check: the vehicle's kit as Present / Missing questions,
   * with what is inside each bag and anything out of date. Returns an
   * `extra` for fill(), or null if the vehicle carries no kit. */
  async function vehicleKitExtra(vehicleId) {
    let kit;
    try { kit = await api('GET', `/api/vehicles/${vehicleId}/kit`); } catch { return null; }
    if (!kit.assets.length && !kit.locations.length) return null;
    const date = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const contents = (l) => l.contents.map((c) => `${c.qty} × ${esc(c.item)}${c.next_expiry ? ` <span style="color:${c.expired ? 'var(--emergency)' : c.expiring_soon ? 'var(--busy)' : 'var(--ink-dim)'}">(${c.expired ? 'EXPIRED' : 'exp'} ${esc(date(c.next_expiry))})</span>` : ''}`).join(', ') || '<span class="dim">empty</span>';
    const html = `<label>Kit on this vehicle</label>
      <div style="border:1px solid var(--line);border-radius:8px;padding:6px 10px">
      ${kit.assets.map((a) => {
        const loc = kit.locations.find((l) => l.asset_id === a.id);
        return `<div style="padding:8px 0;border-bottom:1px solid var(--line-soft)">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong style="flex:1;min-width:160px">${esc(a.tag ? a.tag + ' — ' : '')}${esc(a.description)}</strong>
            <label style="display:flex;gap:4px;align-items:center;text-transform:none;letter-spacing:0;font-size:14px;margin:0"><input type="radio" name="kit${a.id}" value="1" data-kit="${a.id}" style="width:20px;height:20px"> Present</label>
            <label style="display:flex;gap:4px;align-items:center;text-transform:none;letter-spacing:0;font-size:14px;margin:0"><input type="radio" name="kit${a.id}" value="0" data-kit="${a.id}" style="width:20px;height:20px"> Missing</label></div>
          ${loc ? `<div class="dim" style="font-size:12.5px;margin-top:4px">Contains: ${contents(loc)}</div>` : ''}
          <input data-kit-note="${a.id}" placeholder="Note (optional)" style="margin-top:6px;font-size:14px">
        </div>`;
      }).join('')}
      ${kit.locations.filter((l) => !l.asset_id).map((l) => `<div style="padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:13px"><strong>${esc(l.name)}</strong> <span class="dim">— ${contents(l)}</span></div>`).join('')}
      ${kit.expired ? `<p style="color:var(--emergency);font-size:13px;margin:8px 0 2px">${kit.expired} item${kit.expired === 1 ? ' is' : 's are'} out of date — tell control so it can be replaced.</p>` : ''}
      </div>`;
    return {
      html,
      collect(host) {
        return { kit_check: kit.assets.map((a) => {
          const pick = host.querySelector(`[data-kit="${a.id}"]:checked`);
          if (!pick) throw new Error(`Kit: say whether ${a.tag || a.description} is present`);
          return { asset_id: a.id, present: pick.value === '1', note: (host.querySelector(`[data-kit-note="${a.id}"]`) || {}).value || '' };
        }) };
      },
    };
  }

  return { fill, view, edit, list, signaturePad, downscale, vehicleKitExtra, shareEditor, SUBJECT_LABEL, OUTCOME_LABEL };
})();
