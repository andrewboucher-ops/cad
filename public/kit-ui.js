/* Shared by assets.html and stock.html: a dialog, CSV export, small
 * formatters and the page's common styles. Needs app.js first. */
'use strict';
const KIT = (() => {
  const { esc } = CCCS;

  const st = document.createElement('style');
  st.textContent = `
    body { min-height: 100vh; }
    .k-top { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .k-top h1 { font-size: 17px; margin: 0; flex: 1; min-width: 120px; }
    .k-top .btn { padding: 7px 12px; font-size: 13px; }
    .k-body { padding: 16px; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; cursor: pointer; text-align: left; font: inherit; color: var(--ink); }
    .tile .n { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .tile .l { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-dim); }
    .tile.bad .n { color: var(--emergency); } .tile.warn .n { color: var(--busy); } .tile.good .n { color: var(--available); }
    .bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
    .bar input, .bar select { width: auto; min-width: 160px; }
    .chip { font-size: 12.5px; padding: 5px 12px; border-radius: 20px; border: 1px solid var(--line); background: transparent; color: var(--ink-dim); cursor: pointer; }
    .chip.on { background: var(--accent-dim); color: #eafffb; border-color: var(--accent-dim); }
    table.k { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.k th { text-align: left; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-dim); font-weight: 700; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
    table.k td { padding: 9px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
    table.k tr:hover td { background: var(--panel-2); }
    table.k .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .acts { display: flex; gap: 4px; flex-wrap: wrap; }
    .acts .btn { padding: 3px 9px; font-size: 12px; }
    .pill { font-size: 10px; font-weight: 700; letter-spacing: .05em; padding: 2px 8px; border-radius: 20px; text-transform: uppercase; white-space: nowrap; display: inline-block; }
    .pill.ok { background: rgba(34,197,94,.16); color: var(--available); }
    .pill.warn { background: rgba(234,179,8,.18); color: var(--busy); }
    .pill.bad { background: rgba(239,68,68,.18); color: var(--emergency); }
    .pill.off { background: rgba(100,116,139,.18); color: var(--offline); }
    .pill.info { background: rgba(59,130,246,.16); color: #3b82f6; }
    .k-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
    .k-form .full { grid-column: 1 / -1; }
    .k-form label { display: block; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-dim); margin-bottom: 4px; }
    .k-form input, .k-form select, .k-form textarea { width: 100%; }
    .k-section { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-dim); margin: 6px 0 -2px; grid-column: 1 / -1; border-top: 1px solid var(--line); padding-top: 10px; }
    .tl { list-style: none; margin: 0; padding: 0; }
    .tl li { padding: 8px 0; border-bottom: 1px solid var(--line-soft); font-size: 13px; }
    .tl .when { color: var(--ink-dim); font-size: 12px; }
    @media (max-width: 640px) { .k-form { grid-template-columns: 1fr; } .bar input, .bar select { min-width: 0; flex: 1; } .modal { max-height: 94vh; } }`;
  document.head.appendChild(st);

  let host = null;
  /** onMount(root) runs once the dialog is in the page. Returns close(). */
  function modal(title, html, onMount, { wide = false } = {}) {
    close();
    host = document.createElement('div');
    host.innerHTML = `<div class="modal-back"><div class="modal" style="${wide ? 'width:min(860px,100%)' : 'width:min(620px,100%)'}"><h2>${esc(title)}</h2><div class="content">${html}</div></div></div>`;
    document.body.appendChild(host);
    host.querySelector('.modal-back').addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-back')) close(); });
    onMount && onMount(host.querySelector('.content'));
    const first = host.querySelector('input:not([type=hidden]),select,textarea'); if (first && window.innerWidth > 640) first.focus();
    return close;
  }
  function close() { if (host) { host.remove(); host = null; } }
  /** Standard footer: Cancel + primary button wired to an async action;
   * errors appear in the dialog instead of an alert. */
  const foot = (label = 'Save', danger = '') => `<p class="err" data-k-err style="min-height:16px;margin:8px 0 0"></p>
    <div class="btn-row" style="margin-top:6px;justify-content:space-between"><span>${danger}</span><span style="display:flex;gap:8px"><button type="button" class="btn" data-k-cancel>Cancel</button><button type="button" class="btn primary" data-k-go>${esc(label)}</button></span></div>`;
  function wire(root, action) {
    root.querySelector('[data-k-cancel]').onclick = close;
    const go = root.querySelector('[data-k-go]'), err = root.querySelector('[data-k-err]');
    go.onclick = async () => {
      err.textContent = ''; go.disabled = true;
      try { await action(); } catch (e) { err.textContent = e.message; } finally { go.disabled = false; }
    };
  }
  const v = (root, sel) => { const x = root.querySelector(sel); return x ? x.value.trim() : ''; };
  const numOrNull = (s) => (s === '' ? null : Number(s));

  function csv(filename, header, rows) {
    const cell = (x) => { const t = x == null ? '' : String(x); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  }
  const money = (n) => (n == null ? '—' : `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const ACRONYM = { PPE: 'PPE', IT: 'IT' };
  const words = (s) => ACRONYM[s] || String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const options = (list, selected, blank) => (blank != null ? `<option value="">${esc(blank)}</option>` : '')
    + list.map(([val, text]) => `<option value="${esc(val)}" ${String(val) === String(selected ?? '') ? 'selected' : ''}>${esc(text)}</option>`).join('');

  /* ---- Tag scanner ----
   * One box that takes a tag however it arrives: typed, from a USB or
   * Bluetooth barcode scanner (they type the code and press Enter), or
   * from the device camera. The camera uses the browser's own barcode
   * reader where there is one (Chrome on Android) and otherwise loads a
   * small QR reader, so it also works on iPhone/iPad. It stays open for
   * several items in a row; onCode(code) is called once per new code. */
  function scanner(host, onCode, { placeholder = 'Scan or type an asset tag, then Enter' } = {}) {
    host.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap">
        <input data-scan-in placeholder="${esc(placeholder)}" autocomplete="off" autocapitalize="characters" style="flex:1;min-width:200px;font-size:16px">
        <button type="button" class="btn" data-scan-add>Add</button>
        <button type="button" class="btn primary" data-scan-cam>Scan with camera</button>
      </div>
      <div data-scan-video class="hide" style="margin-top:10px;position:relative">
        <video playsinline muted style="width:100%;max-height:50vh;border-radius:10px;background:#000"></video>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px"><span class="dim" data-scan-msg>Point the camera at a tag's QR code</span><button type="button" class="btn" data-scan-stop>Done scanning</button></div>
      </div>`;
    const input = host.querySelector('[data-scan-in]');
    const submit = () => { const c = input.value.trim(); if (c) { onCode(c); input.value = ''; } input.focus(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    host.querySelector('[data-scan-add]').onclick = submit;
    let stream = null, running = false, last = '', lastAt = 0;
    const box = host.querySelector('[data-scan-video]'), video = box.querySelector('video'), msg = box.querySelector('[data-scan-msg]');
    const stop = () => { running = false; if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; box.classList.add('hide'); };
    host.querySelector('[data-scan-stop]').onclick = stop;
    host.querySelector('[data-scan-cam]').onclick = async () => {
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
      catch (e) { alert(`Camera not available (${e.message}). Type the tag or use a barcode scanner instead.`); return; }
      video.srcObject = stream; await video.play(); box.classList.remove('hide'); running = true;
      let detect;
      if ('BarcodeDetector' in window) {
        const d = new BarcodeDetector({ formats: ['qr_code', 'code_128', 'code_39', 'ean_13'] });
        detect = async () => { const r = await d.detect(video); return r[0] && r[0].rawValue; };
      } else {
        if (!window.jsQR) await new Promise((ok, bad) => { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js'; sc.onload = ok; sc.onerror = () => bad(new Error('could not load the QR reader')); document.head.appendChild(sc); }).catch((e) => { msg.textContent = e.message; });
        const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true });
        detect = async () => {
          if (!window.jsQR || !video.videoWidth) return null;
          c.width = video.videoWidth; c.height = video.videoHeight; ctx.drawImage(video, 0, 0);
          const r = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
          return r && r.data;
        };
      }
      const tick = async () => {
        if (!running) return;
        try {
          const code = await detect();
          if (code && (code !== last || Date.now() - lastAt > 2500)) {
            last = code; lastAt = Date.now(); msg.textContent = `Read ${code}`;
            if (navigator.vibrate) navigator.vibrate(60);
            onCode(String(code).trim());
          }
        } catch {}
        setTimeout(tick, 250);
      };
      tick();
    };
    setTimeout(() => input.focus(), 50);
    return { stop, focus: () => input.focus() };
  }

  return { modal, close, foot, wire, v, numOrNull, csv, money, date, when, words, options, scanner };
})();
