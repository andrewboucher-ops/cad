/**
 * Fleet dashboard — one read that answers "is every vehicle fit to go out
 * today?" without the page making a request per vehicle.
 *
 * Per vehicle: its compliance dates (MOT, service, insurance, tax) graded
 * OVERDUE / DUE_SOON (within 30 days) / OK, its most recent inspection with
 * any check that was NOT ticked or any defect written down, whether it has
 * been inspected today, its last fuel and maintenance entries, today's shift
 * allocation, and the forms that can be filed against a vehicle — which is
 * what the page turns into "Inspect", "Report damage" style links.
 *
 * Inspections are read through routes-forms.js's own canRead(), not
 * straight off db.form_submissions: a vehicle form an admin has made
 * RESTRICTED must not leak out through this summary just because it is a
 * different route. Control roles only, branch-scoped like /api/vehicles.
 *
 * Registrar pattern — server.js passes in what this needs.
 */
'use strict';

const DUE_SOON_DAYS = 30;
const COMPLIANCE_FIELDS = [['mot_due_at', 'MOT'], ['service_due_at', 'Service'], ['insurance_due_at', 'Insurance'], ['tax_due_at', 'Tax']];

module.exports = function registerFleetDashboardRoutes({ route, CONTROL, db, forms, visibleToUser, publicVehicle }) {
  /** Unticked check boxes and any written defects, from an inspection. */
  function issuesFrom(sub) {
    const out = [];
    for (const f of sub.fields) {
      const v = sub.values[f.id];
      if (f.type === 'checkbox' && v === false) out.push(`${f.label}: not ticked`);
      if (f.type === 'textarea' && /defect|damage|fault|issue/i.test(f.id + ' ' + f.label) && v && String(v).trim()) out.push(`${f.label}: ${String(v).trim().slice(0, 160)}`);
    }
    return out;
  }

  route('GET', '/api/fleet-dashboard', CONTROL, ({ user }) => {
    const now = Date.now();
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const vehicleForms = (db.form_definitions || []).filter((d) => d.active && d.subject_types.includes('VEHICLE'))
      .map((d) => ({ id: d.id, key: d.key, name: d.name }));
    const inspectionIds = new Set((db.form_definitions || []).filter((d) => d.key === 'vehicle-inspection' || /inspection|walk.?round/i.test(d.name)).map((d) => d.id));
    const vehicleSubs = (db.form_submissions || []).filter((s) => s.subject_type === 'VEHICLE' && forms.canRead(s, user));
    const todaysShiftIds = new Set((db.shifts || []).filter((sh) => sh.status !== 'CANCELLED'
      && Date.parse(sh.starts_at) < midnight.getTime() + 86400000 && Date.parse(sh.ends_at) > midnight.getTime()).map((sh) => sh.id));

    const vehicles = db.vehicles.filter((v) => visibleToUser(v, user)).map((v) => {
      const compliance = COMPLIANCE_FIELDS.map(([field, label]) => {
        const at = v[field] ? Date.parse(v[field]) : NaN;
        const state = isNaN(at) ? 'UNKNOWN' : at < now ? 'OVERDUE' : at - now < DUE_SOON_DAYS * 86400000 ? 'DUE_SOON' : 'OK';
        return { field, label, due_at: v[field] || null, state };
      });
      const mine = vehicleSubs.filter((s) => s.subject_id === v.id).sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : -1));
      const inspection = mine.find((s) => inspectionIds.has(s.definition_id));
      const fuel = (db.fuel_logs || []).filter((f) => f.vehicle_id === v.id).sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1))[0] || null;
      const maint = (db.maintenance_logs || []).filter((m) => m.vehicle_id === v.id).sort((a, b) => (a.performed_at < b.performed_at ? 1 : -1))[0] || null;
      const allocation = (db.shift_vehicle_allocations || []).find((a) => a.vehicle_id === v.id && todaysShiftIds.has(a.shift_id)) || null;
      const allocShift = allocation ? db.shifts.find((sh) => sh.id === allocation.shift_id) : null;
      const driver = allocation && allocation.driver_personnel_id ? db.personnel.find((p) => p.id === allocation.driver_personnel_id) : null;
      return {
        ...publicVehicle(v),
        compliance,
        worst_compliance: compliance.some((c) => c.state === 'OVERDUE') ? 'OVERDUE' : compliance.some((c) => c.state === 'DUE_SOON') ? 'DUE_SOON' : 'OK',
        last_inspection: inspection ? {
          id: inspection.id, reference: inspection.reference, submitted_at: inspection.submitted_at, submitted_by: inspection.submitted_by_name,
          issues: issuesFrom(inspection), status: inspection.status || 'OPEN', outcome: inspection.outcome || null,
        } : null,
        inspected_today: Boolean(inspection && Date.parse(inspection.submitted_at) >= midnight.getTime()),
        recent_reports: mine.slice(0, 5).map((s) => ({ id: s.id, reference: s.reference, definition_name: s.definition_name, submitted_at: s.submitted_at, status: s.status || 'OPEN' })),
        last_fuel: fuel ? { recorded_at: fuel.recorded_at, litres: fuel.litres, odometer: fuel.odometer, cost: fuel.cost } : null,
        last_maintenance: maint ? { performed_at: maint.performed_at, description: maint.description, next_due_at: maint.next_due_at } : null,
        today: allocShift ? { shift_id: allocShift.id, starts_at: allocShift.starts_at, ends_at: allocShift.ends_at, driver: driver ? driver.name : null } : null,
      };
    });

    return {
      generated_at: new Date().toISOString(),
      vehicle_forms: vehicleForms,
      summary: {
        total: vehicles.length,
        active: vehicles.filter((v) => (v.status || 'ACTIVE') === 'ACTIVE').length,
        off_road: vehicles.filter((v) => v.status === 'OFF_ROAD').length,
        in_service: vehicles.filter((v) => v.status === 'IN_SERVICE').length,
        inspected_today: vehicles.filter((v) => v.inspected_today).length,
        with_issues: vehicles.filter((v) => v.last_inspection && v.last_inspection.issues.length).length,
        compliance_overdue: vehicles.filter((v) => v.worst_compliance === 'OVERDUE').length,
        compliance_due_soon: vehicles.filter((v) => v.worst_compliance === 'DUE_SOON').length,
        out_today: vehicles.filter((v) => v.today).length,
      },
      vehicles,
    };
  });
};
