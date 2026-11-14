/**
 * Stores — the store room's scan-two-codes page (public/stores.html).
 *
 * Everything is two scans: first the THING, then WHERE / WHO it goes.
 *   thing                      second code            what happens
 *   stock item barcode    +    location QR      =  move stock there (from the
 *                                                  place it is now; the batch
 *                                                  and expiry are confirmed)
 *   stock item barcode    +    goods-in code    =  receive a delivery into that
 *                                                  store (batch + expiry taken)
 *   stock item barcode    +    staff ID card    =  issue to that person
 *   asset tag             +    staff ID card    =  sign the asset out to them
 *   asset tag             +    location QR /    =  sign it back in, put away
 *                              goods-in code       there
 * The order can be swapped (card first, then item) — the page pairs them.
 *
 * WHAT A CODE CAN BE (resolve(), in this order):
 *   LOC-0003 / GIN-0003 / ITM-0012 — the labels printed by
 *     stores-labels.html for a location, a store's goods-in point, and a
 *     stock item (a drawer label);
 *   a staff ID card — its QR holds the /verify.html#<code> link
 *     (routes-staff-id.js); a staff number also works;
 *   an asset's tag or serial number;
 *   any code an admin has linked to an item, asset or location from this
 *     page (stored in its `barcodes` list) — e.g. the maker's barcode on a
 *     box of dressings, or a QR already stuck on a bag;
 *   a pack barcode saved for one batch when it was received (the batch
 *     and expiry come with it — routes-inventory.js linkBatchCode);
 *   a GS1 code (the DataMatrix / GS1-128 on medical packs): matched by its
 *     GTIN, and its batch (10) and expiry (17) fill in the form.
 *
 * The ledger is the stock ledger (routes-inventory.js) and the asset check-
 * out record (server.js) — the same rows the Stock and Sign in / out pages
 * write, marked via: 'STORES'. Never below zero, first-expiry-first, one
 * expiry per batch number all hold here because the same functions do it.
 *
 * WHO: the control roles, and only those an admin has given the Stores
 * section in Admin → Menu & sections (SYSTEM_ADMIN by default) — the route
 * checks that itself, the menu is not trusted. Linking a new code to an
 * item is admin-only.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const crypto = require('crypto');

const VIA = 'STORES';
const FIXED_AI = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
const VAR_AI = ['10', '21', '22', '30', '37', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99', '240', '241', '250', '251', '400', '7003'];
const GS = '\x1d';

/** Scanners prefix some codes with an AIM symbology id (]d2, ]C1, ]Q3). */
const clean = (raw) => String(raw == null ? '' : raw).replace(/[\r\n\t]/g, '').replace(/^\][A-Za-z]\d/, '').trim();

function gs1Date(yymmdd) {
  if (!/^\d{6}$/.test(yymmdd || '')) return null;
  const y = 2000 + Number(yymmdd.slice(0, 2)), m = Number(yymmdd.slice(2, 4));
  let d = Number(yymmdd.slice(4, 6));
  if (m < 1 || m > 12) return null;
  if (d === 0) d = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 00 = end of month
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** GS1 element string → { gtin, batch, expiry, serial } or null. Takes the
 * bracketed form (01)…(17)…(10)… and the raw form with GS separators. A
 * keyboard scanner often drops the GS character: then a batch running into
 * an expiry at the end ("…10ABC12317261231") is still split, and anything
 * else ambiguous stays in the batch, where it can be corrected on screen. */
function parseGs1(raw) {
  const s = clean(raw);
  const out = {};
  if (/^\(\d{2,4}\)/.test(s)) {
    const re = /\((\d{2,4})\)([^(]*)/g; let m;
    while ((m = re.exec(s))) out[m[1]] = m[2].replace(new RegExp(GS, 'g'), '');
  } else {
    if (!/^(01|02)\d{14}/.test(s)) return null;
    let i = 0;
    while (i < s.length) {
      if (s[i] === GS) { i++; continue; }
      const two = s.substr(i, 2);
      if (FIXED_AI[two]) { out[two] = s.substr(i + 2, FIXED_AI[two]); i += 2 + FIXED_AI[two]; continue; }
      const ai = VAR_AI.find((a) => s.startsWith(a, i));
      if (!ai) break;
      const j = s.indexOf(GS, i + ai.length);
      if (j < 0) {
        const rest = s.slice(i + ai.length);
        const tail = rest.match(/^(.+?)17(\d{6})$/);
        if (tail && gs1Date(tail[2]) && !out['17']) { out[ai] = tail[1]; out['17'] = tail[2]; } else out[ai] = rest;
        break;
      }
      out[ai] = s.slice(i + ai.length, j); i = j + 1;
    }
  }
  const gtin = out['01'] || out['02'];
  if (!gtin || !/^\d{14}$/.test(gtin)) return null;
  return { gtin, batch: out['10'] || null, expiry: gs1Date(out['17']), serial: out['21'] || null };
}
/** An EAN-13 / UPC-A / EAN-8 and the GTIN-14 in a GS1 code are the same
 * number padded with zeros. */
const gtinKey = (code) => (/^\d{8,14}$/.test(code) ? code.padStart(14, '0') : null);

module.exports = function registerStores({
  route, httpError, CONTROL, ADMIN, db, nextId, logEvent, sections, stock, publicAsset, checkoutAsset, returnAsset, flushNow = () => {},
}) {
  const { findItem, findLocation, takeStock, addStock, batches, levelsByLocation, cleanBatch, cleanExpiry, publicMovement, describeLocation, label, unitText, qty, person, linkBatchCode, findBatchCode } = stock;

  const guard = (user) => {
    if (!sections.canSee('stores', user.role)) throw httpError(403, 'the Stores page is not turned on for your role (Admin → Menu & sections)');
  };
  const R = (method, path, fn, roles = CONTROL) => route(method, path, roles, (ctx) => { guard(ctx.user); return fn(ctx); });

  const pad = (n) => String(n).padStart(4, '0');
  const locCode = (l) => `LOC-${pad(l.id)}`;
  const ginCode = (l) => `GIN-${pad(l.id)}`;
  const itemCode = (a) => `ITM-${pad(a.id)}`;
  const today = () => new Date().toISOString().slice(0, 10);
  const lc = (x) => String(x || '').toLowerCase();
  const codesOf = (x) => (Array.isArray(x.barcodes) ? x.barcodes : []);
  const hasCode = (x, code) => {
    const g = gtinKey(code);
    return codesOf(x).some((c) => lc(c) === lc(code) || (g && gtinKey(c) === g));
  };

  /* ---------------- what a scanned code is ---------------- */
  const byToken = (t) => db.personnel.find((p) => p.verify_token && p.verify_token.length === t.length && crypto.timingSafeEqual(Buffer.from(p.verify_token), Buffer.from(t)));
  const swapCase = (t) => t.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  function findPerson(code) {
    // The card's link. A scanner set to a US keyboard on a UK PC types
    // "#" as "£", so take the code after verify.html whatever comes between.
    const m = code.match(/verify\.html[^A-Za-z0-9_-]?([A-Za-z0-9_-]{20,})\s*$/i);
    const tokens = m ? [m[1], m[1].slice(1)] : (/^[A-Za-z0-9_-]{24}$/.test(code) ? [code] : []);
    for (const token of tokens) {
      // Caps Lock on flips the case of everything the scanner types.
      const p = byToken(token) || byToken(swapCase(token));
      if (p) return p;
    }
    return db.personnel.find((p) => p.employee_no && lc(p.employee_no) === lc(code)) || null;
  }
  const activeLocation = (id) => db.stock_locations.find((l) => l.id === id && l.active !== false);

  function resolve(raw, user) {
    const code = clean(raw);
    if (!code) throw httpError(400, 'scan a code');
    const own = code.match(/^(LOC|GIN|ITM)-0*(\d+)$/i);
    if (own) {
      const kind = own[1].toUpperCase(), id = Number(own[2]);
      if (kind === 'ITM') { const a = db.assets.find((x) => x.id === id && x.is_stock_tracked); if (a) return itemView(a, user, null, code); }
      else { const l = activeLocation(id); if (l) return { kind: kind === 'GIN' ? 'receive' : 'location', code, location: describeLocation(l) }; }
    }
    const p = findPerson(code);
    if (p) return personView(p, code);
    const loc = db.stock_locations.find((l) => l.active !== false && hasCode(l, code));
    if (loc) return { kind: 'location', code, location: describeLocation(loc) };
    const asset = db.assets.find((a) => !a.is_stock_tracked && ((a.tag && lc(a.tag) === lc(code)) || hasCode(a, code)))
      || db.assets.find((a) => !a.is_stock_tracked && a.serial_no && lc(a.serial_no) === lc(code));
    if (asset) return assetView(asset, code);
    // A pack barcode saved against one batch when it was received.
    const bc = findBatchCode(code);
    if (bc) { const a = db.assets.find((x) => x.id === bc.item_id && x.is_stock_tracked); if (a) return itemView(a, user, { gtin: null, batch: bc.batch_no, expiry: bc.expiry_date, pack_code: true }, code); }
    const gs1 = parseGs1(code);
    const item = db.assets.find((a) => a.is_stock_tracked && a.status !== 'RETIRED' && (hasCode(a, code) || (gs1 && hasCode(a, gs1.gtin)) || (a.sku && lc(a.sku) === lc(code))));
    if (item) return itemView(item, user, gs1, code);
    return { kind: 'unknown', code, gs1 };
  }

  function itemView(a, user, gs1, code) {
    findItem(a.id, user); // branch visibility
    const levels = levelsByLocation(a.id);
    const locName = (id) => { const l = db.stock_locations.find((x) => x.id === Number(id)); return l ? l.name : '?'; };
    const t = today();
    return {
      kind: 'item', code, gs1: gs1 || null,
      item: {
        id: a.id, label: label(a), unit: a.unit || '', category: a.category, code: itemCode(a), barcodes: codesOf(a),
        total: Object.values(levels).reduce((n, v) => n + v, 0),
        levels: Object.entries(levels).filter(([, n]) => n > 0).map(([id, n]) => ({ location_id: Number(id), location_name: locName(id), qty: n })),
        batches: batches(a.id).map((b) => ({ ...b, location_name: locName(b.location_id), expired: Boolean(b.expiry_date && b.expiry_date < t) })),
      },
    };
  }
  function assetView(a, code) {
    const co = db.asset_checkouts.find((c) => c.asset_id === a.id && !c.returned_at);
    const p = co ? db.personnel.find((x) => x.id === co.personnel_id) : null;
    const l = a.location_id ? db.stock_locations.find((x) => x.id === a.location_id) : null;
    return {
      kind: 'asset', code,
      asset: {
        id: a.id, tag: a.tag, description: a.description, status: a.status, condition: a.condition || null, serial_no: a.serial_no || '',
        location_id: l ? l.id : null, location_name: l ? l.name : null, barcodes: codesOf(a),
        checkout: co ? { id: co.id, personnel_id: co.personnel_id, personnel_name: p ? p.name : null, checked_out_at: co.checked_out_at, expected_return_at: co.expected_return_at || null } : null,
      },
    };
  }
  function personView(p, code) {
    const out = db.asset_checkouts.filter((c) => c.personnel_id === p.id && !c.returned_at).map((c) => {
      const a = db.assets.find((x) => x.id === c.asset_id);
      return { asset_id: c.asset_id, tag: a ? a.tag : null, description: a ? a.description : '(deleted)', checked_out_at: c.checked_out_at };
    });
    return {
      kind: 'person', code: /verify\.html/i.test(code) ? 'staff ID card' : code,
      person: { id: p.id, name: p.name, employee_no: p.employee_no || null, rank: p.rank || null, employed: (p.employment_status || 'ACTIVE') !== 'TERMINATED', assets_out: out },
    };
  }

  R('GET', '/api/stores/resolve', ({ query, user }) => resolve(query.get('code'), user));

  /* ---------------- the actions ---------------- */
  const itemFor = (body, user) => findItem(body.item_id, user);
  const assetFor = (id) => {
    const a = db.assets.find((x) => x.id === Number(id) && !x.is_stock_tracked);
    if (!a) throw httpError(404, 'asset not found');
    return a;
  };
  const note = (body) => String(body.note || '').trim().slice(0, 300);
  /** The batch the person confirmed on screen. A location holding batched
   * stock must say which one — that is the "check the expiry" step. */
  function chosenBatch(item, location, body) {
    const here = batches(item.id).filter((b) => b.location_id === location.id);
    const tracked = here.some((b) => b.batch_no || b.expiry_date);
    const given = (body.batch_no != null && body.batch_no !== '') || body.expiry_date;
    if (tracked && !given && !body.no_batch) throw httpError(400, 'confirm which batch / expiry date you are taking');
    if (!given) return {};
    const pick = here.find((b) => (b.batch_no || '') === cleanBatch(body.batch_no) && (b.expiry_date || '') === (body.expiry_date || ''));
    if (!pick) throw httpError(409, `there is no batch ${body.batch_no || '(no batch)'}${body.expiry_date ? ` expiring ${body.expiry_date}` : ''} of ${label(item)} at ${location.name}`);
    if (pick.expiry_date && pick.expiry_date < today() && !body.allow_expired) throw httpError(409, `that batch expired on ${pick.expiry_date} — tick "use it anyway" to move it (e.g. to quarantine)`);
    return { batch_no: pick.batch_no || '', expiry_date: pick.expiry_date || undefined };
  }

  R('POST', '/api/stores/receive', ({ body, user }) => {
    const item = itemFor(body, user), location = findLocation(body.location_id), n = qty(body.quantity);
    const batch = cleanBatch(body.batch_no), expiry = cleanExpiry(body.expiry_date);
    if (!batch && !expiry && !body.no_batch) throw httpError(400, 'enter the batch number and/or expiry date (or tick "no batch or expiry")');
    const known = batch && db.stock_movements.find((m) => m.asset_id === item.id && m.batch_no === batch && m.expiry_date);
    if (known && expiry && known.expiry_date !== expiry) throw httpError(409, `batch ${batch} is already on record expiring ${known.expiry_date} — check the pack`);
    const finalExpiry = expiry || (known ? known.expiry_date : '');
    // The pack's own barcode for this batch, if one was scanned in. A GS1
    // code needs no saving: it carries its batch and expiry itself.
    let packCode = null;
    if (body.pack_code && !parseGs1(body.pack_code)) {
      packCode = linkBatchCode(item, clean(body.pack_code), batch, finalExpiry, user, { taken: (c) => {
        const r = resolve(c, user);
        if (r.kind === 'unknown') return null;
        return r.kind === 'item' ? `the product barcode of ${r.item.label} — it is the same on every batch, so it can't name one` : r.kind === 'asset' ? `asset ${r.asset.tag || r.asset.description}` : r.kind === 'person' ? 'a staff ID card' : `location ${r.location.name}`;
      } });
    }
    const [m] = addStock(item, n, 'RESTOCK', {
      location, user, note: note(body), batch_no: batch, expiry_date: finalExpiry,
      supplier: String(body.supplier || item.supplier || '').slice(0, 120), reference: String(body.reference || '').slice(0, 80), unit_cost: null, via: VIA,
    });
    logEvent('stock.received', `RECEIVED ${n} × ${label(item)}${batch ? ` BATCH ${batch}` : ''}${m.expiry_date ? ` EXP ${m.expiry_date}` : ''} INTO ${location.name} (STORES SCAN BY ${user.username})`, { asset_id: item.id, stock_movement_id: m.id });
    flushNow();
    return { __status: 201, __body: { done: `Received ${unitText(item, n)} of ${label(item)} into ${location.name}${packCode ? ' — pack barcode saved for this batch' : ''}`, movements: [publicMovement(m)] } };
  });

  R('POST', '/api/stores/move', ({ body, user }) => {
    const item = itemFor(body, user), from = findLocation(body.from_location_id), to = findLocation(body.to_location_id), n = qty(body.quantity);
    if (from.id === to.id) throw httpError(400, `it is already at ${to.name} — choose where it is coming from`);
    if (to.active === false) throw httpError(400, `${to.name} is closed`);
    const pick = chosenBatch(item, from, body);
    const outs = takeStock(item, n, 'TRANSFER_OUT', { location: from, user, note: note(body), ...pick, counterpart_location_id: to.id, via: VIA });
    const ins = outs.flatMap((o) => addStock(item, -o.delta, 'TRANSFER_IN', { location: to, user, note: note(body), batch_no: o.batch_no, expiry_date: o.expiry_date, counterpart_location_id: from.id, via: VIA }));
    const b = outs[0];
    logEvent('stock.transferred', `${n} × ${label(item)}${b.batch_no ? ` BATCH ${b.batch_no}` : ''}${b.expiry_date ? ` EXP ${b.expiry_date}` : ''} MOVED ${from.name} → ${to.name} (STORES SCAN BY ${user.username})`, { asset_id: item.id, stock_movement_id: ins[0].id });
    flushNow();
    return { __status: 201, __body: { done: `Moved ${unitText(item, n)} of ${label(item)} from ${from.name} to ${to.name}`, movements: [...outs, ...ins].map(publicMovement) } };
  });

  R('POST', '/api/stores/issue', ({ body, user }) => {
    const item = itemFor(body, user), location = findLocation(body.location_id), n = qty(body.quantity), p = person(body.personnel_id);
    if ((p.employment_status || 'ACTIVE') === 'TERMINATED') throw httpError(409, `${p.name} has left — kit can't be issued to them`);
    const pick = chosenBatch(item, location, body);
    const ms = takeStock(item, n, 'ISSUED', { location, user, note: note(body), ...pick, personnel_id: p.id, site_id: null, person_delta: true, via: VIA });
    logEvent('stock.issued', `ISSUED ${n} × ${label(item)} TO ${p.name} FROM ${location.name} (STORES SCAN BY ${user.username})`, { asset_id: item.id, stock_movement_id: ms[0].id });
    flushNow();
    return { __status: 201, __body: { done: `Issued ${unitText(item, n)} of ${label(item)} to ${p.name}`, movements: ms.map(publicMovement) } };
  });

  R('POST', '/api/stores/asset-out', ({ body, user }) => {
    const a = assetFor(body.asset_id), p = person(body.personnel_id);
    if ((p.employment_status || 'ACTIVE') === 'TERMINATED') throw httpError(409, `${p.name} has left — kit can't be signed out to them`);
    const co = db.asset_checkouts.find((c) => c.asset_id === a.id && !c.returned_at);
    let from = null;
    if (co) {
      if (co.personnel_id === p.id) throw httpError(409, `${a.tag || a.description} is already signed out to ${p.name}`);
      if (!body.handover) { const was = db.personnel.find((x) => x.id === co.personnel_id); throw httpError(409, `${a.tag || a.description} is signed out to ${was ? was.name : 'someone else'} — confirm the handover`); }
      from = db.personnel.find((x) => x.id === co.personnel_id);
      returnAsset(a, co, user, { notes: `Handed over to ${p.name}`, via: VIA });
    }
    checkoutAsset(a, p.id, user, { notes: note(body), expected_return_at: body.expected_return_at || null, condition: body.condition, via: VIA });
    flushNow();
    return { __status: 201, __body: { done: `${a.tag || a.description} signed out to ${p.name}${from ? ` (handed over from ${from.name})` : ''}`, asset: publicAsset(a) } };
  });

  R('POST', '/api/stores/asset-in', ({ body, user }) => {
    const a = assetFor(body.asset_id);
    const location = body.location_id ? findLocation(body.location_id) : null;
    const co = db.asset_checkouts.find((c) => c.asset_id === a.id && !c.returned_at);
    if (!co && !location) throw httpError(409, `${a.tag || a.description} is not signed out`);
    if (!co && ['ON_HIRE'].includes(a.status)) throw httpError(409, 'it is on hire — book it back in through the rental');
    let who = null;
    if (co) { who = db.personnel.find((x) => x.id === co.personnel_id); returnAsset(a, co, user, { condition: body.condition, notes: note(body), via: VIA }); }
    if (location) {
      const before = a.location_id;
      a.location_id = location.id;
      if (before !== location.id) {
        db.asset_events.push({ id: nextId('asset_events'), asset_id: a.id, type: 'MOVED', at: new Date().toISOString(), by: user.display_name, note: `Put away at ${location.name} (stores scan)`, detail: `→ ${location.name}` });
        if (!co) logEvent('asset.moved', `ASSET ${a.tag || a.description} PUT AWAY AT ${location.name} (STORES SCAN BY ${user.username})`, { asset_id: a.id });
      }
    }
    flushNow();
    const parts = [co ? `signed back in${who ? ` from ${who.name}` : ''}` : null, location ? `put away at ${location.name}` : null].filter(Boolean);
    return { __status: 201, __body: { done: `${a.tag || a.description} ${parts.join(' and ')}`, asset: publicAsset(a) } };
  });

  /* ---------------- teaching it a new code (admin) ---------------- */
  const KINDS = { item: (id) => db.assets.find((x) => x.id === Number(id) && x.is_stock_tracked), asset: (id) => db.assets.find((x) => x.id === Number(id) && !x.is_stock_tracked), location: (id) => db.stock_locations.find((x) => x.id === Number(id)) };
  const nameOf = (kind, x) => (kind === 'location' ? x.name : kind === 'asset' ? (x.tag || x.description) : label(x));
  R('POST', '/api/stores/codes', ({ body, user }) => {
    const code = clean(body.code);
    if (!code || code.length > 200) throw httpError(400, 'scan the code to link');
    const find = KINDS[body.kind]; if (!find) throw httpError(400, 'link it to an item, an asset or a location');
    const target = find(body.id); if (!target) throw httpError(404, `${body.kind} not found`);
    const now = resolve(code, user);
    if (now.kind !== 'unknown') throw httpError(409, `that code already means ${now.kind === 'item' ? now.item.label : now.kind === 'asset' ? (now.asset.tag || now.asset.description) : now.kind === 'person' ? 'a staff ID card' : now.location.name}`);
    // A GS1 pack code changes with every batch: keep its product number.
    const gs1 = parseGs1(code);
    const keep = gs1 ? gs1.gtin : code;
    if (gs1 && body.kind !== 'item') throw httpError(400, 'that is a product barcode (GS1) — link it to a stock item');
    target.barcodes = [...codesOf(target), keep];
    logEvent('stores.code_linked', `CODE ${keep} LINKED TO ${body.kind.toUpperCase()} ${nameOf(body.kind, target)} BY ${user.username}`, { [body.kind === 'location' ? 'location_id' : 'asset_id']: target.id });
    flushNow();
    return { __status: 201, __body: { kind: body.kind, id: target.id, code: keep, barcodes: target.barcodes } };
  }, ADMIN);
  R('DELETE', '/api/stores/codes', ({ body, user }) => {
    const find = KINDS[body.kind]; if (!find) throw httpError(400, 'kind must be item, asset or location');
    const target = find(body.id); if (!target) throw httpError(404, `${body.kind} not found`);
    const before = codesOf(target).length;
    target.barcodes = codesOf(target).filter((c) => c !== body.code);
    if (target.barcodes.length === before) throw httpError(404, 'that code is not linked to it');
    logEvent('stores.code_unlinked', `CODE ${body.code} UNLINKED FROM ${body.kind.toUpperCase()} ${nameOf(body.kind, target)} BY ${user.username}`, {});
    flushNow();
    return { ok: true };
  }, ADMIN);

  /* ---------------- lists for the page ---------------- */
  R('GET', '/api/stores/catalogue', ({ user }) => ({
    items: db.assets.filter((a) => a.is_stock_tracked && a.status !== 'RETIRED').filter((a) => { try { findItem(a.id, user); return true; } catch { return false; } })
      .map((a) => ({ id: a.id, label: label(a), category: a.category, unit: a.unit || '', code: itemCode(a), barcodes: codesOf(a) })).sort((x, y) => x.label.localeCompare(y.label)),
    assets: db.assets.filter((a) => !a.is_stock_tracked && a.status !== 'RETIRED')
      .map((a) => ({ id: a.id, tag: a.tag, description: a.description, barcodes: codesOf(a) })).sort((x, y) => String(x.tag || x.description).localeCompare(String(y.tag || y.description))),
    locations: db.stock_locations.filter((l) => l.active !== false).map((l) => ({ ...describeLocation(l), code: locCode(l), goods_in_code: ginCode(l), barcodes: codesOf(l) }))
      .sort((x, y) => Number(Boolean(y.is_main)) - Number(Boolean(x.is_main)) || x.name.localeCompare(y.name)),
    can_link: user.role === 'SYSTEM_ADMIN',
  }));

  /** The last things done: stock moves (from any page) and asset sign-outs. */
  R('GET', '/api/stores/activity', ({ query }) => {
    const limit = Math.min(Number(query.get('limit')) || 40, 200);
    const mv = db.stock_movements.slice(-limit * 2).map(publicMovement).map((m) => ({
      at: m.recorded_at, by: m.recorded_by, via: m.via || null, kind: 'stock', reason: m.reason, item: m.item, qty: m.delta, unit: m.unit,
      location: m.location_name, person: m.personnel_name,
      from: m.reason === 'TRANSFER_IN' && m.counterpart_location_id ? ((db.stock_locations.find((l) => l.id === m.counterpart_location_id) || {}).name || null) : null, batch_no: m.batch_no || null, expiry_date: m.expiry_date || null,
    }));
    const co = [];
    for (const c of db.asset_checkouts.slice(-limit)) {
      const a = db.assets.find((x) => x.id === c.asset_id), p = db.personnel.find((x) => x.id === c.personnel_id);
      const by = (id) => { const u = db.users.find((x) => x.id === id); return u ? u.display_name : null; };
      const what = a ? (a.tag ? `${a.tag} — ${a.description}` : a.description) : '(deleted asset)';
      co.push({ at: c.checked_out_at, by: by(c.checked_out_by), via: c.via || null, kind: 'asset', reason: 'SIGNED_OUT', item: what, person: p ? p.name : null });
      if (c.returned_at) co.push({ at: c.returned_at, by: by(c.returned_by), via: c.returned_via || null, kind: 'asset', reason: 'SIGNED_IN', item: what, person: p ? p.name : null });
    }
    return [...mv, ...co].sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, limit);
  });

  return { resolve, parseGs1 };
};
module.exports.parseGs1 = parseGs1;
