/**
 * Vehicle and asset allocation per shift, plus the stock ledger for
 * stock-tracked assets (consumables and kit with contents). Three
 * distinct concerns sharing one file because they're small and closely
 * related — a shift's "Resources" panel needs all three.
 *
 * Vehicle allocation and non-stock-tracked asset allocation share a
 * conflict rule: a physical thing can't be on two overlapping shifts at
 * once. A stock-tracked asset has no such rule — allocating a quantity
 * just withdraws it from the ledger; the only limit is how much is on
 * hand. stockLevel()/recordStockMovement() live in server.js next to
 * publicAsset() (which already needs stockLevel for every GET /api/assets
 * response), not duplicated here.
 *
 * Registrar pattern, like routes-leave.js and routes-shift-applications.js.
 */
'use strict';

const STOCK_REASONS = ['RESTOCK', 'USED_ON_SHIFT', 'DAMAGED', 'AUDIT_CORRECTION', 'ALLOCATED', 'RETURNED'];

module.exports = function registerFleetStockRoutes({
  route, httpError, ALL, CONTROL, db, nextId, logEvent,
  findShift, publicVehicleAllocation, publicAssetAllocation, publicAsset, stockLevel, recordStockMovement,
}) {
  for (const t of ['shift_vehicle_allocations', 'shift_asset_allocations', 'stock_movements']) if (!Array.isArray(db[t])) db[t] = [];

  /** Whether two shifts' time windows overlap, ignoring one that's been
   * cancelled — a cancelled shift was never going to need the vehicle. */
  function shiftsOverlap(shiftIdA, shiftIdB) {
    const a = db.shifts.find((x) => x.id === shiftIdA);
    const b = db.shifts.find((x) => x.id === shiftIdB);
    if (!a || !b || a.status === 'CANCELLED' || b.status === 'CANCELLED') return false;
    return Date.parse(a.starts_at) < Date.parse(b.ends_at) && Date.parse(b.starts_at) < Date.parse(a.ends_at);
  }

  /* ---- Vehicle allocation ---- */
  route('GET', '/api/vehicles/:id/allocations', ALL, ({ params }) => {
    const v = db.vehicles.find((x) => x.id === Number(params.id)); if (!v) throw httpError(404, 'vehicle not found');
    return db.shift_vehicle_allocations.filter((a) => a.vehicle_id === v.id)
      .map((a) => publicVehicleAllocation(a))
      .sort((a, b) => { const sa = db.shifts.find((s) => s.id === a.shift_id), sb = db.shifts.find((s) => s.id === b.shift_id); return Date.parse((sa || {}).starts_at || 0) - Date.parse((sb || {}).starts_at || 0); });
  });
  route('POST', '/api/shifts/:id/vehicles', CONTROL, ({ params, body, user }) => {
    const s = findShift(params.id);
    const v = db.vehicles.find((x) => x.id === Number(body.vehicle_id)); if (!v) throw httpError(400, 'vehicle not found');
    if (v.status === 'OFF_ROAD') throw httpError(409, `${v.registration} is off road`);
    const conflict = db.shift_vehicle_allocations.find((a) => a.vehicle_id === v.id && a.shift_id !== s.id && shiftsOverlap(a.shift_id, s.id));
    if (conflict) throw httpError(409, `${v.registration} is already allocated to an overlapping shift`);
    const driver = body.driver_personnel_id ? db.personnel.find((x) => x.id === Number(body.driver_personnel_id)) : null;
    const a = {
      id: nextId('shift_vehicle_allocations'), shift_id: s.id, vehicle_id: v.id,
      driver_personnel_id: driver ? driver.id : null, created_by: user.id, created_at: new Date().toISOString(),
    };
    db.shift_vehicle_allocations.push(a);
    logEvent('shift.vehicle_allocated', `${v.registration} ALLOCATED TO SHIFT ${s.id}`, { shift_id: s.id, vehicle_id: v.id });
    return { __status: 201, __body: publicVehicleAllocation(a) };
  });
  route('DELETE', '/api/shift-vehicle-allocations/:id', CONTROL, ({ params }) => {
    const a = db.shift_vehicle_allocations.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'allocation not found');
    db.shift_vehicle_allocations = db.shift_vehicle_allocations.filter((x) => x.id !== a.id);
    logEvent('shift.vehicle_unallocated', `VEHICLE ALLOCATION ${a.id} REMOVED`, { shift_id: a.shift_id, vehicle_id: a.vehicle_id });
    return { ok: true };
  });

  /* ---- Asset allocation — quantity for a stock-tracked asset, a single
   * reserved item otherwise ---- */
  route('POST', '/api/shifts/:id/assets', CONTROL, ({ params, body, user }) => {
    const s = findShift(params.id);
    const asset = db.assets.find((x) => x.id === Number(body.asset_id)); if (!asset) throw httpError(400, 'asset not found');
    const quantity = body.quantity != null && body.quantity !== '' ? Number(body.quantity) : 1;
    if (!Number.isFinite(quantity) || quantity <= 0) throw httpError(400, 'quantity must be a positive number');
    if (asset.is_stock_tracked) {
      const level = stockLevel(asset.id);
      if (quantity > level) throw httpError(409, `only ${level} of ${asset.description} in stock`);
    } else {
      if (quantity !== 1) throw httpError(400, 'this asset is not stock-tracked — quantity must be 1');
      const conflict = db.shift_asset_allocations.find((x) => x.asset_id === asset.id && !x.returned_at && x.shift_id !== s.id && shiftsOverlap(x.shift_id, s.id));
      if (conflict) throw httpError(409, `${asset.description} is already allocated to an overlapping shift`);
    }
    const a = {
      id: nextId('shift_asset_allocations'), shift_id: s.id, asset_id: asset.id,
      quantity_out: quantity, quantity_returned: 0, returned_at: null,
      condition_out: body.condition_out || '', condition_in: '',
      created_by: user.id, created_at: new Date().toISOString(),
    };
    db.shift_asset_allocations.push(a);
    if (asset.is_stock_tracked) recordStockMovement(asset.id, -quantity, 'ALLOCATED', `Allocated to shift ${s.id}`, s.id, user);
    logEvent('shift.asset_allocated', `${quantity} × ${asset.description} ALLOCATED TO SHIFT ${s.id}`, { shift_id: s.id, asset_id: asset.id });
    return { __status: 201, __body: publicAssetAllocation(a) };
  });
  route('PATCH', '/api/shift-asset-allocations/:id', CONTROL, ({ params, body, user }) => {
    const a = db.shift_asset_allocations.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'allocation not found');
    if (a.returned_at) throw httpError(409, 'already returned');
    const asset = db.assets.find((x) => x.id === a.asset_id);
    const quantityReturned = body.quantity_returned != null && body.quantity_returned !== '' ? Number(body.quantity_returned) : a.quantity_out;
    if (!Number.isFinite(quantityReturned) || quantityReturned < 0 || quantityReturned > a.quantity_out) {
      throw httpError(400, 'quantity_returned must be between 0 and the quantity allocated');
    }
    a.quantity_returned = quantityReturned; a.returned_at = new Date().toISOString(); a.condition_in = body.condition_in || '';
    // The gap between what went out and what came back (used, lost,
    // damaged) is already reflected: the ledger only ever credits back
    // what's physically returned, never the full amount allocated.
    if (asset && asset.is_stock_tracked && quantityReturned > 0) recordStockMovement(asset.id, quantityReturned, 'RETURNED', `Returned from shift ${a.shift_id}`, a.shift_id, user);
    logEvent('shift.asset_returned', `${asset ? asset.description : 'ASSET'} RETURNED FROM SHIFT ${a.shift_id} (${quantityReturned}/${a.quantity_out})`, { shift_id: a.shift_id, asset_id: a.asset_id });
    return publicAssetAllocation(a);
  });

  /* ---- Stock ledger ---- */
  route('GET', '/api/assets/:id/stock-movements', ALL, ({ params }) => {
    const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
    return db.stock_movements.filter((m) => m.asset_id === a.id).sort((x, y) => Date.parse(y.recorded_at) - Date.parse(x.recorded_at));
  });
  route('POST', '/api/assets/:id/stock-movements', ALL, ({ params, body, user }) => {
    const a = db.assets.find((x) => x.id === Number(params.id)); if (!a) throw httpError(404, 'asset not found');
    if (!a.is_stock_tracked) throw httpError(400, 'this asset is not stock-tracked');
    if (!STOCK_REASONS.includes(body.reason)) throw httpError(400, `reason must be one of ${STOCK_REASONS.join(', ')}`);
    const delta = Number(body.delta);
    if (!Number.isFinite(delta) || delta === 0) throw httpError(400, 'delta must be a non-zero number');
    if (stockLevel(a.id) + delta < 0) throw httpError(400, 'this would take stock below zero');
    const m = recordStockMovement(a.id, delta, body.reason, body.note, null, user);
    logEvent('asset.stock_movement', `${delta > 0 ? '+' : ''}${delta} ${a.description} (${body.reason})`, { asset_id: a.id, stock_movement_id: m.id });
    return { __status: 201, __body: m };
  });
  route('GET', '/api/stock-dashboard', CONTROL, () => {
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 86400000;
    // One pass over stock_movements grouped by asset, instead of every
    // stock-tracked asset re-scanning the whole collection for its own rows.
    const movementsByAsset = new Map();
    for (const m of db.stock_movements) { if (!movementsByAsset.has(m.asset_id)) movementsByAsset.set(m.asset_id, []); movementsByAsset.get(m.asset_id).push(m); }
    return db.assets.filter((a) => a.is_stock_tracked).map((a) => {
      const level = stockLevel(a.id, movementsByAsset);
      const expiryMs = a.expiry_date ? Date.parse(a.expiry_date) : null;
      return {
        ...publicAsset(a, movementsByAsset),
        below_threshold: a.low_stock_threshold != null && level <= a.low_stock_threshold,
        expired: expiryMs != null && expiryMs < now,
        expiring_soon: expiryMs != null && expiryMs >= now && expiryMs - now < THIRTY_DAYS_MS,
      };
    }).sort((a, b) => a.description.localeCompare(b.description));
  });
};
