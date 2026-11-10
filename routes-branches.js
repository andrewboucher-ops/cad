/**
 * Branches: list, add, rename and delete.
 *
 * Moved out of server.js unchanged. Registrar pattern: server.js passes in
 * what this needs, at the same point in route order as before.
 */
'use strict';

module.exports = function registerBranches({ route, httpError, ALL, ADMIN, db, nextId, logEvent }) {
  /* Branches — see the comment on BRANCH_SCOPED_ROLES for what this does and
   * doesn't restrict. Read is open to ALL (a name is not sensitive, and every
   * scoped role needs the list for its own branch's label); only ADMIN
   * manages the branches themselves. */
  route('GET', '/api/branches', ALL, () => db.branches);
  route('POST', '/api/branches', ADMIN, ({ body }) => {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name required');
    if (db.branches.some((b) => b.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'branch already exists');
    const b = { id: nextId('branches'), name, created_at: new Date().toISOString() };
    db.branches.push(b);
    logEvent('branch.created', `BRANCH ${name} ADDED`);
    return { __status: 201, __body: b };
  });
  route('PATCH', '/api/branches/:id', ADMIN, ({ params, body }) => {
    const b = db.branches.find((x) => x.id === Number(params.id));
    if (!b) throw httpError(404, 'branch not found');
    if ('name' in body) {
      const name = String(body.name || '').trim();
      if (!name) throw httpError(400, 'name required');
      if (db.branches.some((x) => x.id !== b.id && x.name.toLowerCase() === name.toLowerCase())) throw httpError(409, 'branch already exists');
      b.name = name;
    }
    logEvent('branch.updated', `BRANCH ${b.name} UPDATED`, { branch_id: b.id });
    return b;
  });
  route('DELETE', '/api/branches/:id', ADMIN, ({ params }) => {
    const b = db.branches.find((x) => x.id === Number(params.id));
    if (!b) throw httpError(404, 'branch not found');
    const inUse = db.sites.some((s) => s.branch_id === b.id) || db.personnel.some((p) => p.branch_id === b.id)
      || db.vehicles.some((v) => v.branch_id === b.id) || db.assets.some((a) => a.branch_id === b.id)
      || db.users.some((u) => u.branch_id === b.id);
    if (inUse) throw httpError(409, 'branch is still in use — reassign its sites, personnel, vehicles, assets and accounts first');
    db.branches = db.branches.filter((x) => x.id !== b.id);
    logEvent('branch.deleted', `BRANCH ${b.name} DELETED`);
    return { ok: true };
  });
};
