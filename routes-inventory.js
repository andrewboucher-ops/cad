/**
 * Stock and asset management — the two halves of "kit":
 *
 * STOCK is things you count: uniform, PPE, first-aid refills, batteries.
 * A stock item is an asset with is_stock_tracked (so the rota's shift
 * allocations in routes-fleet-stock.js keep working on the same records).
 * Every change is a row in the stock_movements ledger; nobody ever types a
 * level in. This adds:
 *   - store LOCATIONS (main store, a van, a site cupboard). A level is kept
 *     per location — the sum of that location's movements. Ledger rows from
 *     before locations existed count as the main store;
 *   - RECEIVE (from a supplier, with cost and reference), ISSUE (to a person
 *     or a site), RETURN (back into stock, or written off as worn out),
 *     TRANSFER (between locations) and ADJUST (damaged, expired, lost,
 *     count correction);
 *   - STOCKTAKE: count a location, and the differences are booked as
 *     adjustments, with the count itself kept as a record;
 *   - REORDER: an item at or under its reorder level is listed with a
 *     suggested quantity, grouped by supplier;
 *   - HOLDINGS: what each person has been issued and not returned — the
 *     uniform-issue record — from the ledger's person_delta.
 * Levels can never go below zero at any location.
 *
 * ASSETS are things with a tag: radios, body cameras, keys, laptops. The
 * register adds where each one lives, its condition, value and warranty,
 * an inspection cycle (PAT test, calibration, service) with due dates,
 * due-back dates on check-outs, and repair / lost / retired with a reason.
 * Every one of those is an asset_events row, merged with the check-out
 * history into one timeline per asset.
 *
 * Who: control roles run the stores (receive, issue, count, check out,
 * inspect); creating and editing items, assets and locations stays with
 * admins, as it always was. An officer may read only their own holdings.
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

  /** Levels for one item: { [locationId]: n }. */
  function levelsByLocation(itemId, rows) {
    const out = {};
    for (const m of rows || db.stock_movements.filter((x) => x.asset_id === itemId)) out[locOf(m)] = (out[locOf(m)] || 0) + m.delta;
    return out;
  }
  const levelAt = (itemId, locId) => levelsByLocation(itemId)[locId] || 0;
  function move(item, delta, reason, { location, note, user, ...extra }) {
    if (delta < 0 && levelAt(item.id, location.id) + delta < 0) {
      throw httpError(409, `only ${levelAt(item.id, location.id)} ${item.unit || ''} of ${item.description} at ${location.name}`.replace(/\s+/g, ' '));
    }
    const m = recordStockMovement(item.id, delta, reason, note, null, user);
    Object.assign(m, { location_id: location.id }, extra);
    return m;
  }
  const label = (a) => `${a.description}${a.size ? ` (${a.size})` : ''}`;

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
  route('GET', '/api/stock/overview', CONTROL, ({ user }) => {
    mainStore();
    const now = Date.now();
    const byItem = new Map();
    for (const m of db.stock_movements) { if (!byItem.has(m.asset_id)) byItem.set(m.asset_id, []); byItem.get(m.asset_id).push(m); }
    const items = db.assets.filter((a) => a.is_stock_tracked && visibleToUser(a, user)).map((a) => {
      const rows = byItem.get(a.id) || [];
      const levels = levelsByLocation(a.id, rows);
      const total = Object.values(levels).reduce((n, v) => n + v, 0);
      const issued = rows.reduce((n, m) => n + (m.person_delta || 0), 0);
      const reorder = a.low_stock_threshold;
      const exp = a.expiry_date ? Date.parse(a.expiry_date) : null;
      return {
        ...publicAsset(a, byItem), levels, total, issued_out: issued,
        value: a.unit_cost != null ? Math.round(a.unit_cost * total * 100) / 100 : null,
        below_reorder: reorder != null && total <= reorder,
        suggested_order: reorder != null && total <= reorder ? Math.max(a.reorder_qty || 0, reorder - total + 1) : 0,
        expired: exp != null && exp < now, expiring_soon: exp != null && exp >= now && exp - now < DUE_SOON_DAYS * 86400000,
        last_movement_at: rows.length ? rows[rows.length - 1].recorded_at : null,
      };
    }).sort((x, y) => x.description.localeCompare(y.description) || String(x.size || '').localeCompare(String(y.size || '')));
    return {
      locations: db.stock_locations,
      items,
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
  route('GET', '/api/stock/movements', CONTROL, ({ query, user }) => {
    const item = query.get('item_id'), loc = query.get('location_id'), pid = query.get('personnel_id');
    const limit = Math.min(Number(query.get('limit') || 200), 2000);
    return db.stock_movements.filter((m) => {
      const a = db.assets.find((x) => x.id === m.asset_id);
      return a && visibleToUser(a, user) && (!item || m.asset_id === Number(item)) && (!loc || locOf(m) === Number(loc)) && (!pid || m.personnel_id === Number(pid));
    }).slice(-limit).reverse().map(publicMovement);
  });

  route('POST', '/api/stock/:id/receive', CONTROL, ({ params, body, user }) => {
    const item = findItem(params.id, user), location = findLocation(body.location_id), n = qty(body.quantity);
    const unitCost = body.unit_cost != null && body.unit_cost !== '' ? Number(body.unit_cost) : null;
    if (unitCost != null && (!Number.isFinite(unitCost) || unitCost < 0)) throw httpError(400, 'unit cost must be 0 or more');
    const m = move(item, n, 'RESTOCK', { location, user, note: body.note, supplier: String(body.supplier || item.supplier || '').slice(0, 120), reference: String(body.reference || '').slice(0, 80), unit_cost: unitCost });
    if (unitCost != null) item.unit_cost = unitCost;
    logEvent('stock.received', `RECEIVED ${n} × ${label(item)} INTO ${location.name}`, { asset_id: item.id, stock_movement_id: m.id });
    flushNow();
    return { __status: 201, __body: publicMovement(m) };
  });

  route('POST', '/api/stock/:id/issue', CONTROL, ({ params, body, user }) => {
    const item = findItem(params.id, user), location = findLocation(body.location_id), n = qty(body.quantity);
    const p = body.personnel_id ? person(body.personnel_id) : null;
    const site = !p && body.site_id ? db.sites.find((x) => x.id === Number(body.site_id)) : null;
    if (!p && !site) throw httpError(400, 'issue to a person or a site');
    const m = move(item, -n, 'ISSUED', { location, user, note: body.note, personnel_id: p ? p.id : null, site_id: site ? site.id : null, person_delta: p ? n : 0 });
    logEvent('stock.issued', `ISSUED ${n} × ${label(item)} TO ${p ? p.name : site.name}`, { asset_id: item.id, stock_movement_id: m.id });
    flushNow();
    return { __status: 201, __body: publicMovement(m) };
  });

  /** Back from a person: into stock if reusable, otherwise written off —
   * either way it comes off what they hold. */
  route('POST', '/api/stock/:id/return', CONTROL, ({ params, body, user }) => {
    const item = findItem(params.id, user), location = findLocation(body.location_id), n = qty(body.quantity);
    const p = person(body.personnel_id);
    const held = db.stock_movements.filter((m) => m.asset_id === item.id && m.personnel_id === p.id).reduce((x, m) => x + (m.person_delta || 0), 0);
    if (n > held) throw httpError(409, `${p.name} only holds ${held} of ${label(item)}`);
    const restock = body.restock !== false;
    const m = move(item, restock ? n : 0, restock ? 'RETURNED' : 'RETURNED_DISPOSED', { location, user, note: body.note, personnel_id: p.id, person_delta: -n });
    logEvent('stock.returned', `${n} × ${label(item)} RETURNED BY ${p.name}${restock ? '' : ' (written off)'}`, { asset_id: item.id, stock_movement_id: m.id });
    flushNow();
    return { __status: 201, __body: publicMovement(m) };
  });

  route('POST', '/api/stock/:id/transfer', CONTROL, ({ params, body, user }) => {
    const item = findItem(params.id, user), from = findLocation(body.from_location_id), to = findLocation(body.to_location_id), n = qty(body.quantity);
    if (from.id === to.id) throw httpError(400, 'choose two different locations');
    const out = move(item, -n, 'TRANSFER_OUT', { location: from, user, note: body.note, counterpart_location_id: to.id });
    const inn = move(item, n, 'TRANSFER_IN', { location: to, user, note: body.note, counterpart_location_id: from.id });
    logEvent('stock.transferred', `${n} × ${label(item)} MOVED ${from.name} → ${to.name}`, { asset_id: item.id, stock_movement_id: inn.id });
    flushNow();
    return { __status: 201, __body: [publicMovement(out), publicMovement(inn)] };
  });

  route('POST', '/api/stock/:id/adjust', CONTROL, ({ params, body, user }) => {
    const item = findItem(params.id, user), location = findLocation(body.location_id);
    const reason = String(body.reason || '');
    if (!ADJUST_REASONS[reason]) throw httpError(400, `reason must be one of ${Object.keys(ADJUST_REASONS).join(', ')}`);
    const delta = Number(body.delta);
    if (!Number.isFinite(delta) || delta === 0) throw httpError(400, 'enter how many to add or remove');
    if (['DAMAGED', 'EXPIRED', 'LOST'].includes(reason) && delta > 0) throw httpError(400, `${ADJUST_REASONS[reason].toLowerCase()} stock can only be removed`);
    if (reason === 'FOUND' && delta < 0) throw httpError(400, 'found stock can only be added');
    const note = String(body.note || '').trim();
    if (!note && reason === 'AUDIT_CORRECTION') throw httpError(400, 'say why the count is being corrected');
    const m = move(item, delta, reason, { location, user, note });
    logEvent('stock.adjusted', `${delta > 0 ? '+' : ''}${delta} ${label(item)} AT ${location.name} (${ADJUST_REASONS[reason]})`, { asset_id: item.id, stock_movement_id: m.id });
    flushNow();
    return { __status: 201, __body: publicMovement(m) };
  });

  /** A count of one location. Items not listed are not touched. */
  route('POST', '/api/stock/stocktake', CONTROL, ({ body, user }) => {
    const location = findLocation(body.location_id);
    if (!Array.isArray(body.counts) || !body.counts.length) throw httpError(400, 'counts required');
    const lines = body.counts.map((c) => {
      const item = findItem(c.item_id, user);
      const counted = Number(c.counted);
      if (!Number.isFinite(counted) || counted < 0) throw httpError(400, `${label(item)}: count must be 0 or more`);
      const expected = levelAt(item.id, location.id);
      return { item, counted, expected, diff: counted - expected };
    });
    const take = { id: nextId('stocktakes'), location_id: location.id, location_name: location.name, at: new Date().toISOString(), by: user.display_name, note: String(body.note || '').slice(0, 300), lines: [] };
    for (const l of lines) {
      if (l.diff) move(l.item, l.diff, 'AUDIT_CORRECTION', { location, user, note: `Stocktake #${take.id}${take.note ? ` — ${take.note}` : ''}`, stocktake_id: take.id });
      take.lines.push({ item_id: l.item.id, item: label(l.item), expected: l.expected, counted: l.counted, diff: l.diff });
    }
    db.stocktakes.push(take);
    const off = take.lines.filter((x) => x.diff).length;
    logEvent('stock.stocktake', `STOCKTAKE AT ${location.name} BY ${user.display_name}: ${take.lines.length} COUNTED, ${off} CORRECTED`, { stocktake_id: take.id });
    flushNow();
    return { __status: 201, __body: take };
  });
  route('GET', '/api/stock/stocktakes', CONTROL, () => db.stocktakes.slice(-50).reverse());

  /** Who holds what. An officer may ask for their own only. */
  route('GET', '/api/stock/holdings', ALL, ({ query, user }) => {
    let pid = query.get('personnel_id') ? Number(query.get('personnel_id')) : null;
    if (!isControlRole(user.role)) { if (!user.personnel_id) return []; pid = user.personnel_id; }
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
  const days = (iso) => (iso ? Math.floor((Date.parse(iso) - Date.now()) / 86400000) : null);
  const dueState = (iso) => { const d = days(iso); return d == null ? 'NONE' : d < 0 ? 'OVERDUE' : d <= DUE_SOON_DAYS ? 'DUE_SOON' : 'OK'; };

  route('GET', '/api/assets/register', CONTROL, ({ user }) => {
    const open = new Map(db.asset_checkouts.filter((c) => !c.returned_at).map((c) => [c.asset_id, c]));
    const assets = db.assets.filter((a) => !a.is_stock_tracked && visibleToUser(a, user)).map((a) => {
      const co = open.get(a.id) || null;
      const holder = co ? db.personnel.find((p) => p.id === co.personnel_id) : null;
      const loc = a.location_id ? db.stock_locations.find((l) => l.id === a.location_id) : null;
      return {
        ...publicAsset(a), location_name: loc ? loc.name : null,
        checkout: co ? { id: co.id, personnel_id: co.personnel_id, personnel_name: holder ? holder.name : null, checked_out_at: co.checked_out_at, expected_return_at: co.expected_return_at || null, overdue: Boolean(co.expected_return_at && Date.parse(co.expected_return_at) < Date.now()) } : null,
        check_state: dueState(a.next_check_due_at), warranty_state: dueState(a.warranty_expires_at),
      };
    }).sort((x, y) => String(x.tag || x.description).localeCompare(String(y.tag || y.description)));
    const live = assets.filter((a) => a.status !== 'RETIRED');
    return {
      assets,
      summary: {
        total: live.length,
        in_store: live.filter((a) => a.status === 'IN_STORE').length,
        issued: live.filter((a) => a.checkout || a.status === 'IN_USE').length,
        overdue_returns: live.filter((a) => a.checkout && a.checkout.overdue).length,
        checks_due: live.filter((a) => ['OVERDUE', 'DUE_SOON'].includes(a.check_state)).length,
        in_repair: live.filter((a) => a.status === 'IN_REPAIR').length,
        lost: live.filter((a) => a.status === 'LOST').length,
        value: Math.round(live.reduce((n, a) => n + (a.purchase_cost || 0), 0) * 100) / 100,
      },
    };
  });

  /** One timeline: register events plus the check-out history. */
  route('GET', '/api/assets/:id/history', CONTROL, ({ params, user }) => {
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

  /** An inspection: PAT test, calibration, service, visual check. */
  route('POST', '/api/assets/:id/inspect', CONTROL, ({ params, body, user }) => {
    const a = findAsset(params.id, user);
    const result = String(body.result || 'PASS').toUpperCase();
    if (!['PASS', 'FAIL'].includes(result)) throw httpError(400, 'result must be PASS or FAIL');
    a.last_checked_at = new Date().toISOString();
    if (a.check_interval_days) a.next_check_due_at = new Date(Date.now() + a.check_interval_days * 86400000).toISOString().slice(0, 10);
    else if (body.next_check_due_at) a.next_check_due_at = String(body.next_check_due_at).slice(0, 10);
    if (result === 'FAIL') { a.condition = 'DAMAGED'; if (!db.asset_checkouts.some((c) => c.asset_id === a.id && !c.returned_at)) a.status = 'IN_REPAIR'; }
    event(a, result === 'PASS' ? 'INSPECTED' : 'FAILED_INSPECTION', user, body.note, { detail: `${a.check_type || 'Check'} — ${result.toLowerCase()}${a.next_check_due_at ? `, next due ${a.next_check_due_at}` : ''}` });
    logEvent('asset.inspected', `ASSET ${a.tag || a.description} ${a.check_type || 'CHECK'} ${result}`, { asset_id: a.id });
    flushNow();
    return publicAsset(a);
  });

  /** Repair, lost, found, retire — always with a reason, always in the history. */
  route('POST', '/api/assets/:id/status', CONTROL, ({ params, body, user }) => {
    const a = findAsset(params.id, user);
    const status = String(body.status || '').toUpperCase();
    if (!ASSET_STATUSES.includes(status) || status === 'IN_USE') throw httpError(400, 'status must be IN_STORE, IN_REPAIR, LOST or RETIRED (use check out to issue it)');
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

  return { mainStore };
};
