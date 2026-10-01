/**
 * Stock and asset management — the two halves of "kit":
 *
 * STOCK is things you count: uniform, PPE, first-aid refills, batteries.
 * A stock item is an asset with is_stock_tracked (so the rota's shift
 * allocations in routes-fleet-stock.js keep working on the same records).
 * Every change is a row in the stock_movements ledger; nobody ever types a
 * level in. On top of that ledger:
 *   - store LOCATIONS (main store, a van, a site cupboard). A level is kept
 *     per location — the sum of that location's movements. Ledger rows from
 *     before locations existed count as the main store;
 *   - BATCHES, optional: a delivery can carry a batch number and/or an
 *     expiry date. Stock is then held per batch, and anything taken out
 *     (issued, moved, written off) comes from the batch that expires first
 *     unless a batch is chosen. Stock with neither is simply "no batch";
 *   - RECEIVE (from a supplier, with cost and reference), ISSUE (to a person
 *     or a site), RETURN (back into stock, or written off as worn out),
 *     TRANSFER (between locations) and ADJUST (damaged, expired, lost,
 *     found, count correction);
 *   - STOCKTAKE: count a location (per batch where there are batches), and
 *     the differences are booked as adjustments, the count itself kept;
 *   - REORDER: an item at or under its reorder level is listed with a
 *     suggested quantity, grouped by supplier;
 *   - HOLDINGS: what each person has been issued and not returned — the
 *     uniform-issue record — from the ledger's person_delta.
 * Levels can never go below zero at any location or in any batch.
 *
 * ASSETS are things with a tag: radios, body cameras, keys, laptops. The
 * register adds where each one lives, its condition, value and warranty,
 * two separate check cycles — PAT testing (yes/no, with its own interval)
 * and inspections (a frequency set when the asset is created) — due-back
 * dates on check-outs, and repair / lost / retired with a reason. Every one
 * of those is an asset_events row, merged with the check-out history (and
 * hires, routes-rentals.js) into one timeline per asset.
 *
 * Who: stock and the asset register are ADMIN only, even though they sit
 * outside the Admin page. Day-to-day signing kit in and out to staff is the
 * Sign in / out desk (control roles), which uses the check-out routes in
 * server.js and the lookup in routes-rentals.js. An officer may read only
 * their own holdings.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const LOCATION_KINDS = ['STORE', 'VEHICLE', 'SITE', 'OTHER'];
const ADJUST_REASONS = { DAMAGED: 'Damaged', EXPIRED: 'Expired', LOST: 'Lost', AUDIT_CORRECTION: 'Count correction', FOUND: 'Found' };
const DUE_SOON_DAYS = 30;

module.exports = function registerInventoryRoutes({
  route, httpError, ALL, CONTROL, ADMIN, db, nextId, logEvent, visibleToUser, isControlRole,
  publicAsset, stockLevel, recordStockMovement, ASSET_STATUSES, flushNow = () => {},
}) {
  for (const t of ['stock_locations', 'asset_events', 'stocktakes', 'stock_movements', 'assets', 'asset_checkouts']) if (!Array.isArray(db[t])) db[t] = [];

  /** The main store always exists; ledger rows with no location are its. */
  function mainStore() {
    let m = db.stock_locations.find((l) => l.is_main);
    if (!m) {
      m = { id: nextId('stock_locations'), name: 'Main store', kind: 'STORE', is_main: true, active: true, notes: '', created_at: new Date().toISOString() };
      db.stock_locations.push(m);
    }
    return m;
  }
  const locOf = (mv) => mv.location_id || mainStore().id;
  const findLocation = (id) => {
    const l = id ? db.stock_locations.find((x) => x.id === Number(id)) : mainStore();
    if (!l) throw httpError(400, 'store location not found');
    return l;
  };
  const findItem = (id, user) => {
    const a = db.assets.find((x) => x.id === Number(id));
    if (!a || !a.is_stock_tracked || (user && !visibleToUser(a, user))) throw httpError(404, 'stock item not found');
    return a;
  };
  const findAsset = (id, user) => {
    const a = db.assets.find((x) => x.id === Number(id));
    if (!a || a.is_stock_tracked || (user && !visibleToUser(a, user))) throw httpError(404, 'asset not found');
    return a;
  };
  const qty = (raw, what = 'quantity') => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw httpError(400, `${what} must be more than 0`);
    return n;
  };
  const person = (id) => { const p = db.personnel.find((x) => x.id === Number(id)); if (!p) throw httpError(400, 'person not found'); return p; };
  const label = (a) => `${a.description}${a.size ? ` (${a.size})` : ''}`;
  const unitText = (item, n) => `${n}${item.unit ? ' ' + item.unit : ''}`;

  /* ---- levels: per location, and per batch within a location ---- */
  function levelsByLocation(itemId, rows) {
    const out = {};
    for (const m of rows || db.stock_movements.filter((x) => x.asset_id === itemId)) out[locOf(m)] = (out[locOf(m)] || 0) + m.delta;
    return out;
  }
  const levelAt = (itemId, locId) => levelsByLocation(itemId)[locId] || 0;
  const cleanBatch = (b) => (b == null ? '' : String(b).trim().slice(0, 60));
  const cleanExpiry = (d) => {
    if (!d) return '';
    if (!/^\d{4}-\d{2}-\d{2}/.test(String(d)) || isNaN(Date.parse(d))) throw httpError(400, 'expiry must be a date');
    return String(d).slice(0, 10);
  };
  const bkey = (batch, expiry) => `${batch || ''}|${expiry || ''}`;
  /** [{ location_id, batch_no, expiry_date, qty }] with stock, in use-first
   * order (earliest expiry first, no-expiry last). Rows written without a
   * batch (e.g. by the rota's shift kit) are taken from the earliest batch,
   * so the per-batch figures always add up to the location level. */
  function batches(itemId, rows) {
    const byLoc = new Map();
    for (const m of rows || db.stock_movements.filter((x) => x.asset_id === itemId)) {
      const loc = locOf(m);
      if (!byLoc.has(loc)) byLoc.set(loc, new Map());
      const k = bkey(m.batch_no, m.expiry_date);
      byLoc.get(loc).set(k, (byLoc.get(loc).get(k) || 0) + m.delta);
    }
    const out = [];
    for (const [loc, map] of byLoc) {
      let list = [...map].map(([k, n]) => { const [batch_no, expiry_date] = k.split('|'); return { location_id: loc, batch_no: batch_no || null, expiry_date: expiry_date || null, qty: n }; });
      // Net any negative (un-batched withdrawals) against the use-first order.
      let debt = -list.filter((b) => b.qty < 0).reduce((n, b) => n + b.qty, 0);
      list = list.filter((b) => b.qty > 0).sort(useFirst);
      for (const b of list) { if (!debt) break; const t = Math.min(debt, b.qty); b.qty -= t; debt -= t; }
      out.push(...list.filter((b) => b.qty > 0));
    }
    return out;
  }
  function useFirst(a, b) {
    if (a.expiry_date && b.expiry_date) return a.expiry_date.localeCompare(b.expiry_date);
    if (a.expiry_date) return -1;
    if (b.expiry_date) return 1;
    return (a.batch_no ? 1 : 0) - (b.batch_no ? 1 : 0);
  }

  function addStock(item, n, reason, { location, note, user, batch_no = '', expiry_date = '', ...extra }) {
    const m = recordStockMovement(item.id, n, reason, note, null, user);
    Object.assign(m, { location_id: location.id, batch_no: batch_no || null, expiry_date: expiry_date || null }, extra);
    return [m];
  }
  /** Takes n out of a location — from the named batch, or use-first across
   * batches. Returns one movement per batch touched. */
  function takeStock(item, n, reason, { location, note, user, batch_no, expiry_date, person_delta, ...extra }) {
    const here = batches(item.id).filter((b) => b.location_id === location.id);
    const total = here.reduce((x, b) => x + b.qty, 0);
    let pick = here;
    if ((batch_no != null && batch_no !== '') || expiry_date) {
      pick = here.filter((b) => (b.batch_no || '') === cleanBatch(batch_no) && (!expiry_date || b.expiry_date === expiry_date));
      const inBatch = pick.reduce((x, b) => x + b.qty, 0);
      if (inBatch < n) throw httpError(409, `only ${unitText(item, inBatch)} of ${label(item)} in batch ${batch_no || '(no batch)'} at ${location.name}`);
    } else if (total < n) {
      throw httpError(409, `only ${unitText(item, total)} of ${label(item)} at ${location.name}`);
    }
    const out = [];
    let left = n;
    for (const b of pick) {
      if (!left) break;
      const t = Math.min(left, b.qty);
      const m = recordStockMovement(item.id, -t, reason, note, null, user);
      Object.assign(m, { location_id: location.id, batch_no: b.batch_no, expiry_date: b.expiry_date }, extra, person_delta ? { person_delta: t } : {});
      out.push(m); left -= t;
    }
    return out;
  }

  /* ================================================================== *
   * Stock
   * ================================================================== */

  route('GET', '/api/stock/locations', ALL, () => { mainStore(); return db.stock_locations; });
  route('POST', '/api/stock/locations', ADMIN, ({ body, user }) => {
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) throw httpError(400, 'name required');
    if (db.stock_locations.some((l) => l.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'a location with that name already exists');
    const kind = LOCATION_KINDS.includes(body.kind) ? body.kind : 'STORE';
    mainStore();
    const l = { id: nextId('stock_locations'), name, kind, vehicle_id: body.vehicle_id ? Number(body.vehicle_id) : null, site_id: body.site_id ? Number(body.site_id) : null, active: true, notes: String(body.notes || '').slice(0, 300), created_at: new Date().toISOString() };
    db.stock_locations.push(l);
    logEvent('stock.location_created', `STORE LOCATION "${name}" ADDED BY ${user.username}`, { location_id: l.id });
    return { __status: 201, __body: l };
  });
  route('PATCH', '/api/stock/locations/:id', ADMIN, ({ params, body }) => {
    const l = findLocation(params.id);
    if ('name' in body) { const n = String(body.name || '').trim().slice(0, 80); if (!n) throw httpError(400, 'name required'); l.name = n; }
    if ('kind' in body && LOCATION_KINDS.includes(body.kind)) l.kind = body.kind;
    if ('notes' in body) l.notes = String(body.notes || '').slice(0, 300);
    if ('active' in body) {
      if (!body.active && l.is_main) throw httpError(400, 'the main store cannot be closed');
      if (!body.active && db.assets.some((a) => a.is_stock_tracked && levelAt(a.id, l.id) > 0)) throw httpError(409, 'move or write off the stock held there first');
      l.active = Boolean(body.active);
    }
    return l;
  });

  /** Everything the stock page needs in one read. */
  route('GET', '/api/stock/overview', ADMIN, ({ user }) => {
    mainStore();
    const now = Date.now();
    const soon = new Date(now + DUE_SOON_DAYS * 86400000).toISOString().slice(0, 10), today = new Date(now).toISOString().slice(0, 10);
    const byItem = new Map();
    for (const m of db.stock_movements) { if (!byItem.has(m.asset_id)) byItem.set(m.asset_id, []); byItem.get(m.asset_id).push(m); }
    const expiringBatches = [];
    const items = db.assets.filter((a) => a.is_stock_tracked && visibleToUser(a, user)).map((a) => {
      const rows = byItem.get(a.id) || [];
      const levels = levelsByLocation(a.id, rows);
      const total = Object.values(levels).reduce((n, v) => n + v, 0);
      const issued = rows.reduce((n, m) => n + (m.person_delta || 0), 0);
      const reorder = a.low_stock_threshold;
      const held = batches(a.id, rows);
      const tracked = held.filter((b) => b.batch_no || b.expiry_date);
      const dated = held.filter((b) => b.expiry_date).map((b) => b.expiry_date).sort();
      const nextExpiry = dated[0] || (total > 0 ? a.expiry_date || null : null);
      for (const b of held) if (b.expiry_date && b.expiry_date <= soon) expiringBatches.push({ item_id: a.id, item: label(a), unit: a.unit || '', ...b, expired: b.expiry_date < today });
      return {
        ...publicAsset(a, byItem), levels, total, issued_out: issued, batches: tracked,
        value: a.unit_cost != null ? Math.round(a.unit_cost * total * 100) / 100 : null,
        below_reorder: reorder != null && total <= reorder,
        suggested_order: reorder != null && total <= reorder ? Math.max(a.reorder_qty || 0, reorder - total + 1) : 0,
        next_expiry: nextExpiry,
        expired: Boolean(nextExpiry && nextExpiry < today),
        expiring_soon: Boolean(nextExpiry && nextExpiry >= today && nextExpiry <= soon),
        last_movement_at: rows.length ? rows[rows.length - 1].recorded_at : null,
      };
    }).sort((x, y) => x.description.localeCompare(y.description) || String(x.size || '').localeCompare(String(y.size || '')));
    return {
      locations: db.stock_locations,
      items,
      expiring_batches: expiringBatches.sort((x, y) => x.expiry_date.localeCompare(y.expiry_date)),
      summary: {
        items: items.length,
        value: Math.round(items.reduce((n, i) => n + (i.value || 0), 0) * 100) / 100,
        below_reorder: items.filter((i) => i.below_reorder).length,
        expiring: items.filter((i) => i.expired || i.expiring_soon).length,
        issued_out: items.reduce((n, i) => n + i.issued_out, 0),
      },
    };
  });

  function publicMovement(m) {
    const a = db.assets.find((x) => x.id === m.asset_id);
    const l = db.stock_locations.find((x) => x.id === locOf(m));
    const p = m.personnel_id ? db.personnel.find((x) => x.id === m.personnel_id) : null;
    const site = m.site_id ? db.sites.find((x) => x.id === m.site_id) : null;
    return { ...m, item: a ? label(a) : '(deleted item)', unit: a ? a.unit || '' : '', location_name: l ? l.name : '—', personnel_name: p ? p.name : null, site_name: site ? site.name : null };
  }
  route('GET', '/api/stock/movements', ADMIN, ({ query, user }) => {
    const item = query.get('item_id'), loc = query.get('location_id'), pid = query.get('personnel_id');
    const limit = Math.min(Number(query.get('limit') || 200), 2000);
    return db.stock_movements.filter((m) => {
      const a = db.assets.find((x) => x.id === m.asset_id);
      return a && visibleToUser(a, user) && (!item || m.asset_id === Number(item)) && (!loc || locOf(m) === Number(loc)) && (!pid || m.personnel_id === Number(pid));
    }).slice(-limit).reverse().map(publicMovement);
  });

  route('POST', '/api/stock/:id/receive', ADMIN, ({ params, body, user }) => {
    const item = findItem(params.id, user), location = findLocation(body.location_id), n = qty(body.quantity);
    const unitCost = body.unit_cost != null && body.unit_cost !== '' ? Number(body.unit_cost) : null;
    if (unitCost != null && (!Number.isFinite(unitCost) || unitCost < 0)) throw httpError(400, 'unit cost must be 0 or more');
    const batch = cleanBatch(body.batch_no), expiry = cleanExpiry(body.expiry_date);
    // The same batch number always carries the same expiry.
    const known = batch && db.stock_movements.find((m) => m.asset_id === item.id && m.batch_no === batch && m.expiry_date);
    if (known && expiry && known.expiry_date !== expiry) throw httpError(409, `batch ${batch} is already on record expiring ${known.expiry_date}`);
    const [m] = addStock(item, n, 'RESTOCK', { location, user, note: body.note, batch_no: batch, expiry_date: expiry || (known ? known.expiry_date : ''), supplier: String(body.supplier || item.supplier || '').slice(0, 120), reference: String(body.reference || '').slice(0, 80), unit_cost: unitCost });
    if (unitCost != null) item.unit_cost = unitCost;
    logEvent('stock.received', `RECEIVED ${n} × ${label(item)}${batch ? ` BATCH ${batch}` : ''} INTO ${location.name}`, { asset_id: item.id, stock_movement_id: m.id });
    flushNow();
    return { __status: 201, __body: publicMovement(m) };
  });

  route('POST', '/api/stock/:id/issue', ADMIN, ({ params, body, user }) => {
    const item = findItem(params.id, user), location = findLocation(body.location_id), n = qty(body.quantity);
    const p = body.personnel_id ? person(body.personnel_id) : null;
    const site = !p && body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null;
    if (!p && !site) throw httpError(400, 'issue to a person or a site');
    const ms = takeStock(item, n, 'ISSUED', { location, user, note: body.note, batch_no: body.batch_no, expiry_date: body.expiry_date || undefined, personnel_id: p ? p.id : null, site_id: site ? site.id : null, person_delta: Boolean(p) });
    logEvent('stock.issued', `ISSUED ${n} × ${label(item)} TO ${p ? p.name : site.name}`, { asset_id: item.id, stock_movement_id: ms[0].id });
    flushNow();
    return { __status: 201, __body: ms.map(publicMovement) };
  });

  /** Back from a person: into stock if reusable, otherwise written off —
   * either way it comes off what they hold. */
  route('POST', '/api/stock/:id/return', ADMIN, ({ params, body, user }) => {
    const item = findItem(params.id, user), location = findLocation(body.location_id), n = qty(body.quantity);
    const p = person(body.personnel_id);
    const held = db.stock_movements.filter((m) => m.asset_id === item.id && m.personnel_id === p.id).reduce((x, m) => x + (m.person_delta || 0), 0);
    if (n > held) throw httpError(409, `${p.name} only holds ${held} of ${label(item)}`);
    const restock = body.restock !== false;
    const [m] = addStock(item, restock ? n : 0, restock ? 'RETURNED' : 'RETURNED_DISPOSED', { location, user, note: body.note, batch_no: restock ? cleanBatch(body.batch_no) : '', expiry_date: restock ? cleanExpiry(body.expiry_date) : '', personnel_id: p.id, person_delta: -n });
    logEvent('stock.returned', `${n} × ${label(item)} RETURNED BY ${p.name}${restock ? '' : ' (written off)'}`, { asset_id: item.id, stock_movement_id: m.id });
    flushNow();
    return { __status: 201, __body: publicMovement(m) };
  });

  route('POST', '/api/stock/:id/transfer', ADMIN, ({ params, body, user }) => {
    const item = findItem(params.id, user), from = findLocation(body.from_location_id), to = findLocation(body.to_location_id), n = qty(body.quantity);
    if (from.id === to.id) throw httpError(400, 'choose two different locations');
    const outs = takeStock(item, n, 'TRANSFER_OUT', { location: from, user, note: body.note, batch_no: body.batch_no, counterpart_location_id: to.id });
    // The same batches arrive at the other end.
    const ins = outs.flatMap((o) => addStock(item, -o.delta, 'TRANSFER_IN', { location: to, user, note: body.note, batch_no: o.batch_no, expiry_date: o.expiry_date, counterpart_location_id: from.id }));
    logEvent('stock.transferred', `${n} × ${label(item)} MOVED ${from.name} → ${to.name}`, { asset_id: item.id, stock_movement_id: ins[0].id });
    flushNow();
    return { __status: 201, __body: [...outs, ...ins].map(publicMovement) };
  });

  route('POST', '/api/stock/:id/adjust', ADMIN, ({ params, body, user }) => {
    const item = findItem(params.id, user), location = findLocation(body.location_id);
    const reason = String(body.reason || '');
    if (!ADJUST_REASONS[reason]) throw httpError(400, `reason must be one of ${Object.keys(ADJUST_REASONS).join(', ')}`);
    const delta = Number(body.delta);
    if (!Number.isFinite(delta) || delta === 0) throw httpError(400, 'enter how many to add or remove');
    if (['DAMAGED', 'EXPIRED', 'LOST'].includes(reason) && delta > 0) throw httpError(400, `${ADJUST_REASONS[reason].toLowerCase()} stock can only be removed`);
    if (reason === 'FOUND' && delta < 0) throw httpError(400, 'found stock can only be added');
    const note = String(body.note || '').trim();
    if (!note && reason === 'AUDIT_CORRECTION') throw httpError(400, 'say why the count is being corrected');
    const ms = delta > 0
      ? addStock(item, delta, reason, { location, user, note, batch_no: cleanBatch(body.batch_no), expiry_date: cleanExpiry(body.expiry_date) })
      : takeStock(item, -delta, reason, { location, user, note, batch_no: body.batch_no, expiry_date: body.expiry_date || undefined });
    logEvent('stock.adjusted', `${delta > 0 ? '+' : ''}${delta} ${label(item)} AT ${location.name} (${ADJUST_REASONS[reason]})`, { asset_id: item.id, stock_movement_id: ms[0].id });
    flushNow();
    return { __status: 201, __body: ms.map(publicMovement) };
  });

  /** A count of one location. A line with batch_no/expiry_date counts that
   * batch; a line without counts the item as a whole. Items not listed are
   * not touched. */
  route('POST', '/api/stock/stocktake', ADMIN, ({ body, user }) => {
    const location = findLocation(body.location_id);
    if (!Array.isArray(body.counts) || !body.counts.length) throw httpError(400, 'counts required');
    const lines = body.counts.map((c) => {
      const item = findItem(c.item_id, user);
      const counted = Number(c.counted);
      if (!Number.isFinite(counted) || counted < 0) throw httpError(400, `${label(item)}: count must be 0 or more`);
      const perBatch = c.batch_no != null || c.expiry_date;
      const batch = cleanBatch(c.batch_no), expiry = perBatch ? cleanExpiry(c.expiry_date) : '';
      const expected = perBatch
        ? batches(item.id).filter((b) => b.location_id === location.id && (b.batch_no || '') === batch && (b.expiry_date || '') === expiry).reduce((n, b) => n + b.qty, 0)
        : levelAt(item.id, location.id);
      return { item, counted, expected, diff: counted - expected, perBatch, batch, expiry };
    });
    const take = { id: nextId('stocktakes'), location_id: location.id, location_name: location.name, at: new Date().toISOString(), by: user.display_name, note: String(body.note || '').slice(0, 300), lines: [] };
    const note = `Stocktake #${take.id}${take.note ? ` — ${take.note}` : ''}`;
    for (const l of lines) {
      if (l.diff > 0) addStock(l.item, l.diff, 'AUDIT_CORRECTION', { location, user, note, batch_no: l.batch, expiry_date: l.expiry, stocktake_id: take.id });
      if (l.diff < 0) takeStock(l.item, -l.diff, 'AUDIT_CORRECTION', l.perBatch ? { location, user, note, batch_no: l.batch, expiry_date: l.expiry || undefined, stocktake_id: take.id } : { location, user, note, stocktake_id: take.id });
      take.lines.push({ item_id: l.item.id, item: label(l.item), batch_no: l.batch || null, expiry_date: l.expiry || null, expected: l.expected, counted: l.counted, diff: l.diff });
    }
    db.stocktakes.push(take);
    const off = take.lines.filter((x) => x.diff).length;
    logEvent('stock.stocktake', `STOCKTAKE AT ${location.name} BY ${user.display_name}: ${take.lines.length} COUNTED, ${off} CORRECTED`, { stocktake_id: take.id });
    flushNow();
    return { __status: 201, __body: take };
  });
  route('GET', '/api/stock/stocktakes', ADMIN, () => db.stocktakes.slice(-50).reverse());

  /** Who holds what. An admin may see anyone's; everyone else their own. */
  route('GET', '/api/stock/holdings', ALL, ({ query, user }) => {
    let pid = query.get('personnel_id') ? Number(query.get('personnel_id')) : null;
    if (user.role !== 'SYSTEM_ADMIN') { if (!user.personnel_id) return []; pid = user.personnel_id; }
    const map = new Map();
    for (const m of db.stock_movements) {
      if (!m.personnel_id || !m.person_delta || (pid && m.personnel_id !== pid)) continue;
      const key = `${m.personnel_id}:${m.asset_id}`;
      const r = map.get(key) || { personnel_id: m.personnel_id, item_id: m.asset_id, quantity: 0, last_issued_at: null };
      r.quantity += m.person_delta;
      if (m.person_delta > 0) r.last_issued_at = m.recorded_at;
      map.set(key, r);
    }
    return [...map.values()].filter((r) => r.quantity > 0).map((r) => {
      const a = db.assets.find((x) => x.id === r.item_id), p = db.personnel.find((x) => x.id === r.personnel_id);
      return { ...r, item: a ? label(a) : '(deleted item)', unit: a ? a.unit || '' : '', personnel_name: p ? p.name : '(removed)' };
    }).sort((x, y) => x.personnel_name.localeCompare(y.personnel_name) || x.item.localeCompare(y.item));
  });

  /* ================================================================== *
   * Assets
   * ================================================================== */

  const event = (a, type, user, note = '', data = {}) => {
    const e = { id: nextId('asset_events'), asset_id: a.id, type, at: new Date().toISOString(), by: user.display_name, note: String(note || '').slice(0, 500), ...data };
    db.asset_events.push(e);
    return e;
  };
  // By calendar day: something due today is due, not overdue.
  const dueState = (iso) => {
    if (!iso) return 'NONE';
    const day = String(iso).slice(0, 10), today = new Date().toISOString().slice(0, 10);
    return day < today ? 'OVERDUE' : day <= addDays(DUE_SOON_DAYS) ? 'DUE_SOON' : 'OK';
  };
  const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  route('GET', '/api/assets/register', ADMIN, ({ user }) => {
    const open = new Map(db.asset_checkouts.filter((c) => !c.returned_at).map((c) => [c.asset_id, c]));
    const assets = db.assets.filter((a) => !a.is_stock_tracked && visibleToUser(a, user)).map((a) => {
      const co = open.get(a.id) || null;
      const holder = co ? db.personnel.find((p) => p.id === co.personnel_id) : null;
      const loc = a.location_id ? db.stock_locations.find((l) => l.id === a.location_id) : null;
      const rental = a.rental_id ? (db.rentals || []).find((r) => r.id === a.rental_id) : null;
      return {
        ...publicAsset(a), location_name: loc ? loc.name : null,
        checkout: co ? { id: co.id, personnel_id: co.personnel_id, personnel_name: holder ? holder.name : null, checked_out_at: co.checked_out_at, expected_return_at: co.expected_return_at || null, overdue: Boolean(co.expected_return_at && Date.parse(co.expected_return_at) < Date.now()) } : null,
        rental: rental ? { id: rental.id, reference: rental.reference, hirer_name: rental.hirer_name, expected_return_at: rental.expected_return_at } : null,
        check_state: a.check_interval_days || a.next_check_due_at ? dueState(a.next_check_due_at) : 'NONE',
        pat_state: a.pat_required ? (a.pat_next_due_at ? dueState(a.pat_next_due_at) : 'OVERDUE') : 'NONE',
        warranty_state: dueState(a.warranty_expires_at),
      };
    }).sort((x, y) => String(x.tag || x.description).localeCompare(String(y.tag || y.description)));
    const live = assets.filter((a) => a.status !== 'RETIRED');
    const due = (s) => ['OVERDUE', 'DUE_SOON'].includes(s);
    return {
      assets,
      summary: {
        total: live.length,
        in_store: live.filter((a) => a.status === 'IN_STORE').length,
        issued: live.filter((a) => a.checkout || a.status === 'IN_USE').length,
        on_hire: live.filter((a) => a.status === 'ON_HIRE').length,
        overdue_returns: live.filter((a) => a.checkout && a.checkout.overdue).length,
        checks_due: live.filter((a) => due(a.check_state) || due(a.pat_state)).length,
        pat_due: live.filter((a) => due(a.pat_state)).length,
        in_repair: live.filter((a) => a.status === 'IN_REPAIR').length,
        lost: live.filter((a) => a.status === 'LOST').length,
        value: Math.round(live.reduce((n, a) => n + (a.purchase_cost || 0), 0) * 100) / 100,
      },
    };
  });

  /** One timeline: register events plus the check-out history. */
  route('GET', '/api/assets/:id/history', ADMIN, ({ params, user }) => {
    const a = findAsset(params.id, user);
    const name = (id) => { const p = db.personnel.find((x) => x.id === id); return p ? p.name : 'someone'; };
    const userName = (id) => { const u = db.users.find((x) => x.id === id); return u ? u.display_name : null; };
    const rows = db.asset_events.filter((e) => e.asset_id === a.id).map((e) => ({ at: e.at, type: e.type, by: e.by, note: e.note, detail: e.detail || null }));
    for (const c of db.asset_checkouts.filter((x) => x.asset_id === a.id)) {
      rows.push({ at: c.checked_out_at, type: 'CHECKED_OUT', by: userName(c.checked_out_by), note: c.notes || '', detail: `to ${name(c.personnel_id)}${c.expected_return_at ? `, due back ${c.expected_return_at.slice(0, 10)}` : ''}${c.condition_out ? `, condition ${c.condition_out.toLowerCase()}` : ''}` });
      if (c.returned_at) rows.push({ at: c.returned_at, type: 'RETURNED', by: userName(c.returned_by), note: c.return_notes || '', detail: `from ${name(c.personnel_id)}${c.condition_in ? `, condition ${c.condition_in.toLowerCase()}` : ''}` });
    }
    return rows.sort((x, y) => (x.at < y.at ? 1 : -1));
  });

  /** A PAT test or an inspection. Each has its own cycle on the asset. */
  route('POST', '/api/assets/:id/inspect', ADMIN, ({ params, body, user }) => {
    const a = findAsset(params.id, user);
    const kind = String(body.kind || 'INSPECTION').toUpperCase();
    if (!['INSPECTION', 'PAT'].includes(kind)) throw httpError(400, 'kind must be INSPECTION or PAT');
    if (kind === 'PAT' && !a.pat_required) throw httpError(400, 'this asset is not set up for PAT testing — edit it first');
    const result = String(body.result || 'PASS').toUpperCase();
    if (!['PASS', 'FAIL'].includes(result)) throw httpError(400, 'result must be PASS or FAIL');
    const now = new Date().toISOString();
    let next;
    if (kind === 'PAT') {
      a.pat_last_at = now.slice(0, 10);
      a.pat_next_due_at = next = a.pat_interval_days ? addDays(a.pat_interval_days) : (body.next_due_at ? String(body.next_due_at).slice(0, 10) : null);
    } else {
      a.last_checked_at = now;
      a.next_check_due_at = next = a.check_interval_days ? addDays(a.check_interval_days) : (body.next_due_at || body.next_check_due_at ? String(body.next_due_at || body.next_check_due_at).slice(0, 10) : a.next_check_due_at || null);
    }
    if (result === 'FAIL') { a.condition = 'DAMAGED'; if (a.status === 'IN_STORE') a.status = 'IN_REPAIR'; }
    const what = kind === 'PAT' ? 'PAT test' : (a.check_type || 'Inspection');
    event(a, result === 'PASS' ? (kind === 'PAT' ? 'PAT_PASSED' : 'INSPECTED') : (kind === 'PAT' ? 'PAT_FAILED' : 'FAILED_INSPECTION'), user, body.note, { detail: `${what} — ${result.toLowerCase()}${next ? `, next due ${next}` : ''}` });
    logEvent('asset.inspected', `ASSET ${a.tag || a.description} ${what.toUpperCase()} ${result}`, { asset_id: a.id });
    flushNow();
    return publicAsset(a);
  });

  /** Repair, lost, found, retire — always with a reason, always in the history. */
  route('POST', '/api/assets/:id/status', ADMIN, ({ params, body, user }) => {
    const a = findAsset(params.id, user);
    const status = String(body.status || '').toUpperCase();
    if (!ASSET_STATUSES.includes(status) || ['IN_USE', 'ON_HIRE'].includes(status)) throw httpError(400, 'status must be IN_STORE, IN_REPAIR, LOST or RETIRED (check it out or hire it to send it out)');
    if (a.status === 'ON_HIRE') throw httpError(409, 'it is on hire — book it back in through the rental first');
    const note = String(body.note || '').trim();
    if (!note && ['LOST', 'RETIRED', 'IN_REPAIR'].includes(status)) throw httpError(400, 'a reason is required');
    const co = db.asset_checkouts.find((c) => c.asset_id === a.id && !c.returned_at);
    if (co) {
      if (status !== 'LOST') throw httpError(409, 'it is checked out — return it first');
      // Lost while issued: the issue ends here, recorded against that person.
      co.returned_at = new Date().toISOString(); co.returned_by = user.id; co.return_notes = `Reported lost: ${note}`;
    }
    const before = a.status;
    a.status = status;
    a.assigned_to = null;
    if (status === 'RETIRED') a.retired_at = new Date().toISOString();
    const TYPE = { IN_STORE: before === 'LOST' ? 'FOUND' : 'BACK_IN_STORE', IN_REPAIR: 'SENT_FOR_REPAIR', LOST: 'REPORTED_LOST', RETIRED: 'RETIRED' };
    event(a, TYPE[status], user, note, { detail: `${before.replace('_', ' ').toLowerCase()} → ${status.replace('_', ' ').toLowerCase()}` });
    logEvent('asset.status', `ASSET ${a.tag || a.description} → ${status}${note ? ` (${note.slice(0, 80)})` : ''}`, { asset_id: a.id });
    flushNow();
    return publicAsset(a);
  });

  /** New asset: first PAT due now unless a last test date was given; first
   * inspection one interval from today. Called by POST /api/assets. */
  function firstDueDates(a) {
    if (a.pat_required) {
      if (!a.pat_interval_days) a.pat_interval_days = 365;
      if (!a.pat_next_due_at) a.pat_next_due_at = a.pat_last_at ? new Date(Date.parse(a.pat_last_at) + a.pat_interval_days * 86400000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    }
    if (a.check_interval_days && !a.next_check_due_at) a.next_check_due_at = addDays(a.check_interval_days);
  }

  return { mainStore, firstDueDates };
};
