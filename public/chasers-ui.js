/* Invoices → "Reminders & statements": who owes what (from Xero and CCCS),
 * the automatic 7/14/30-day reminders, and sending a statement by hand.
 * Server side: routes-invoice-chasers.js. Loaded by invoices.html. */
'use strict';
(function () {
  const { api, el, esc } = CCCS;
  const { modal, close, foot, wire, v, money, when } = KIT;
  const admin = () => CCCS.getSession().user.role === 'SYSTEM_ADMIN';
  const sd = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  let data = null;

  async function open() {
    modal('Reminders & statements', '<p class="dim">Asking Xero what is owed…</p>', null, { wide: true });
    try { data = await api('GET', '/api/invoice-chasers'); } catch (e) { modal('Reminders & statements', `<p class="err">${esc(e.message)}</p><div class="btn-row" style="justify-content:flex-end"><button class="btn" onclick="KIT.close()">Close</button></div>`); return; }
    paint();
  }

  function paint() {
    const st = data.settings;
    const groups = data.groups;
    const overdue = groups.filter((g) => g.overdue.length);
    const tot = (f) => money(groups.reduce((n, g) => n + g[f], 0));
    const status = st.enabled
      ? `<span class="pill ok">On</span> Automatic reminders at <strong>${st.stages.join(', ')}</strong> days overdue, ${st.weekdays_only ? 'weekdays' : 'every day'} from ${String(st.send_hour).padStart(2, '0')}:00, with a statement attached.`
      : '<span class="pill off">Off</span> Automatic reminders are off. Nothing is sent unless you press a button below.';
    const last = st.last_run_at ? ` <span class="dim">Last run ${esc(when(st.last_run_at))}${st.last_run_result ? (st.last_run_result.error ? `: <span class="err">${esc(st.last_run_result.error)}</span>` : `: ${st.last_run_result.sent} sent${st.last_run_result.failed ? `, ${st.last_run_result.failed} failed` : ''}${st.last_run_result.held ? `, ${st.last_run_result.held} held back` : ''}`) : ''}.</span>` : '';
    const warn = [
      !data.email_ready ? 'Email is not set up on this server, so nothing can be sent.' : '',
      !data.xero_connected ? 'Xero is not connected, so only invoices made in CCCS are listed. Connect Xero to include the ones raised there.' : '',
    ].filter(Boolean).map((w) => `<div class="checks">${esc(w)}</div>`).join('');
    const row = (g) => {
      const p = g.plan, oldest = g.overdue.length ? Math.max(...g.overdue.map((x) => x.days_overdue)) : 0;
      const next = p.due ? `<span class="pill warn">${esc(g.stage_name)} due</span>` : `<span class="dim" style="font-size:12px">${esc(p.reason || '')}</span>`;
      const paused = g.paused && (!g.paused.until || g.paused.until >= data.today);
      return `<tr>
        <td><strong>${esc(g.name)}</strong><div class="dim" style="font-size:11.5px">${g.emails.length ? esc(g.emails.join(', ')) : '<span class="err">no email address</span>'}${g.email_from ? ` · from ${esc(g.email_from)}` : ''}</div>
          <details><summary class="dim" style="font-size:11.5px">${g.items.length} open invoice${g.items.length === 1 ? '' : 's'}${p.last_sent_at ? ` · last emailed ${esc(sd(p.last_sent_at))}` : ''}</summary>
          <table class="k shifts"><tbody>${g.items.map((x) => `<tr><td class="mono">${esc(x.number)}</td><td>due ${esc(sd(x.due_date))}</td><td>${x.days_overdue > 0 ? `${x.days_overdue} days overdue` : 'not yet due'}</td><td class="num">${money(x.amount_due)}</td></tr>`).join('')}</tbody></table></details></td>
        <td class="num">${g.overdue_total ? `<strong>${money(g.overdue_total)}</strong>` : '—'}<div class="dim" style="font-size:11px">${oldest ? `oldest ${oldest} days` : ''}</div></td>
        <td class="num">${money(g.total_due)}</td>
        <td>${next}</td>
        <td><div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;min-width:220px">
          <a class="btn" target="_blank" href="/api/invoice-chasers/${encodeURIComponent(g.key)}/statement" title="The statement PDF">PDF</a>
          <button class="btn" data-send="${esc(g.key)}" data-stage="statement">Send statement</button>
          ${g.overdue.length ? `<button class="btn" data-send="${esc(g.key)}" data-stage="${p.stage || st.stages.filter((s) => s <= oldest).pop() || st.stages[0]}">Send reminder</button>` : ''}
          <button class="btn" data-pause="${esc(g.key)}" data-name="${esc(g.name)}" data-on="${paused ? 1 : 0}">${paused ? 'Resume' : 'Pause'}</button></div></td></tr>`;
    };
    const log = data.log.length ? `<details style="margin-top:10px"><summary class="dim" style="font-size:12.5px">Sent (${data.log.length})</summary><ul class="tl">${data.log.map((e) => `<li><span class="when">${esc(when(e.at))}</span> — ${e.ok ? '✓' : '<span class="err">✕</span>'} ${esc(e.stage === 'statement' ? 'Statement' : `${e.stage}-day reminder`)} to <strong>${esc(e.name)}</strong> (${esc(e.to)}), ${money(e.stage === 'statement' ? e.total_due : e.overdue_total)} <span class="dim">(${esc(e.auto ? 'automatic' : e.by)})</span>${e.ok ? '' : ` <span class="err">${esc(e.error || '')}</span>`}</li>`).join('')}</ul></details>` : '';
    modal('Reminders & statements', `
      <p style="margin-top:0;font-size:13.5px">${status}${last}</p>${warn}
      <div class="tiles" style="margin:8px 0"><div class="tile warn"><div class="n">${tot('overdue_total')}</div><div class="l">Overdue (${overdue.length} customer${overdue.length === 1 ? '' : 's'})</div></div><div class="tile"><div class="n">${tot('total_due')}</div><div class="l">Owed in total</div></div></div>
      ${groups.length ? `<div style="overflow-x:auto"><table class="k"><thead><tr><th>Customer</th><th class="num">Overdue</th><th class="num">Balance</th><th>Next reminder</th><th></th></tr></thead><tbody>${groups.map(row).join('')}</tbody></table></div>` : '<p class="dim">Nobody owes anything. 🎉</p>'}
      ${log}
      <p class="err" id="chErr"></p>
      <div class="btn-row" style="justify-content:flex-end;flex-wrap:wrap">
        ${admin() ? '<button class="btn" id="chSettings">Settings</button>' : ''}
        ${admin() && st.enabled ? '<button class="btn" id="chRun">Send due reminders now</button>' : ''}
        ${overdue.length ? '<button class="btn" id="chAll">Send statements to everyone overdue</button>' : ''}
        <button class="btn" onclick="KIT.close()">Close</button></div>`, (root) => {
      const err = root.querySelector('#chErr');
      root.querySelectorAll('[data-send]').forEach((b) => (b.onclick = () => preview(b.dataset.send, b.dataset.stage)));
      root.querySelectorAll('[data-pause]').forEach((b) => (b.onclick = async () => {
        try {
          if (b.dataset.on === '1') await api('POST', `/api/invoice-chasers/${encodeURIComponent(b.dataset.pause)}/pause`, { resume: true });
          else {
            const until = prompt(`Pause reminders to ${b.dataset.name} until which date? (YYYY-MM-DD, or leave blank to pause until you resume them)`, '');
            if (until === null) return;
            await api('POST', `/api/invoice-chasers/${encodeURIComponent(b.dataset.pause)}/pause`, { until: until.trim() || null, name: b.dataset.name });
          }
          await open();
        } catch (e) { err.textContent = e.message; }
      }));
      const all = root.querySelector('#chAll');
      if (all) all.onclick = async () => {
        if (!confirm(`Email a statement to every customer with something overdue (${overdue.length})? Anyone paused, emailed in the last ${st.min_gap_days} days, or with no email address is skipped.`)) return;
        all.disabled = true; all.textContent = 'Sending…';
        try { const r = await api('POST', '/api/invoice-chasers/statements'); alert(`${r.sent.length} statement${r.sent.length === 1 ? '' : 's'} sent.${r.skipped.length ? `\n\nSkipped:\n${r.skipped.map((s) => `${s.name}: ${s.reason}`).join('\n')}` : ''}`); await open(); }
        catch (e) { err.textContent = e.message; all.disabled = false; all.textContent = 'Send statements to everyone overdue'; }
      };
      const run = root.querySelector('#chRun');
      if (run) run.onclick = async () => {
        if (!confirm('Send every reminder that is due now?')) return;
        run.disabled = true;
        try { const r = await api('POST', '/api/invoice-chasers/run'); alert(`${r.sent.length} sent, ${r.failed.length} failed, ${r.held.length} held back.`); await open(); }
        catch (e) { err.textContent = e.message; run.disabled = false; }
      };
      const sb = root.querySelector('#chSettings');
      if (sb) sb.onclick = settings;
    }, { wide: true });
  }

  async function preview(key, stage) {
    let m;
    try { m = await api('GET', `/api/invoice-chasers/${encodeURIComponent(key)}/preview?stage=${encodeURIComponent(stage)}`); } catch (e) { alert(e.message); return; }
    modal(`Send ${m.stage === 'statement' ? 'statement' : m.stage_name.toLowerCase()}`, `
      <p style="margin-top:0;font-size:13px"><strong>To:</strong> ${esc(m.to || '(no address)')}${data.settings.copy_to ? `<br><strong>Bcc:</strong> ${esc(data.settings.copy_to)}` : ''}<br><strong>Subject:</strong> ${esc(m.subject)}<br><strong>Attached:</strong> <a target="_blank" href="/api/invoice-chasers/${encodeURIComponent(key)}/statement">statement PDF</a></p>
      <div style="border:1px solid var(--line);border-radius:8px;padding:10px 14px;font-size:13.5px;max-height:45vh;overflow:auto;background:#fff;color:#111">${m.html}</div>
      ${foot('Send it')}`, (root) => wire(root, async () => {
      await api('POST', `/api/invoice-chasers/${encodeURIComponent(key)}/send`, { stage: m.stage });
      await open();
    }), { wide: true });
  }

  function settings() {
    const st = data.settings;
    const stageBoxes = st.stages.map((s, i) => `<div class="full"><label>${i === st.stages.length - 1 ? 'Final reminder' : i === 0 ? 'First reminder' : 'Second reminder'} (${s} days)</label><textarea data-w="${s}" rows="2">${esc(st.wording[s] || '')}</textarea></div>`).join('');
    modal('Reminder settings', `<div class="k-form">
      <div class="full"><label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-weight:400;font-size:13.5px"><input type="checkbox" id="cOn" ${st.enabled ? 'checked' : ''} style="width:auto"> <strong>Send reminders automatically</strong></label></div>
      <div><label>Days overdue to remind at</label><input id="cStages" value="${esc(st.stages.join(', '))}"></div>
      <div><label>Send from (hour, UK time)</label><input id="cHour" type="number" min="0" max="23" value="${st.send_hour}"></div>
      <div><label>At least this many days between emails to one customer</label><input id="cGap" type="number" min="0" max="60" value="${st.min_gap_days}"></div>
      <div><label>After the final reminder, repeat every (days, 0 = never)</label><input id="cRep" type="number" min="0" max="90" value="${st.repeat_days}"></div>
      <div class="full"><label style="display:flex;gap:8px;align-items:center;text-transform:none;letter-spacing:0;font-weight:400;font-size:13px"><input type="checkbox" id="cWk" ${st.weekdays_only ? 'checked' : ''} style="width:auto"> Weekdays only</label></div>
      <div class="full"><label>Send me a copy (BCC)</label><input id="cCopy" value="${esc(st.copy_to || '')}" placeholder="accounts@… — separate several with commas"></div>
      <div class="k-section">Wording</div>
      <p class="dim full" style="font-size:12.5px;margin:0">The overdue invoices, the total and how to pay are added below this text. You can use {name}, {overdue_total}, {total} and {count}. If you change the days above, save, then reopen to word any new stage.</p>
      ${stageBoxes}
      <div class="full"><label>Statement (sent by hand)</label><textarea id="cStmt" rows="2">${esc(st.statement_wording || '')}</textarea></div>
    </div>
    <p class="dim" style="font-size:12.5px">Each invoice is chased once at each stage. One that is already past several stages gets one email at the latest stage. If Xero also sends its own invoice reminders (Xero → Invoice settings → Invoice reminders), turn those off so customers don't get both.</p>${foot('Save')}`, (root) => wire(root, async () => {
      const wording = {};
      root.querySelectorAll('[data-w]').forEach((t) => { wording[t.dataset.w] = t.value; });
      await api('PUT', '/api/invoice-chasers/settings', {
        enabled: root.querySelector('#cOn').checked, stages: v(root, '#cStages'), send_hour: Number(v(root, '#cHour')), min_gap_days: Number(v(root, '#cGap')),
        repeat_days: Number(v(root, '#cRep')), weekdays_only: root.querySelector('#cWk').checked, copy_to: v(root, '#cCopy'), wording, statement_wording: root.querySelector('#cStmt').value,
      });
      await open();
    }), { wide: true });
  }

  document.addEventListener('DOMContentLoaded', () => { const b = el('#bChasers'); if (b) b.onclick = open; });
  const b = document.querySelector('#bChasers'); if (b) b.onclick = open;
}());
