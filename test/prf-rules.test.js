/* Completeness rules shared by the form and the server (public/prf/rules.js). */
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../public/prf/rules.js');
const keys = (d) => R.blocking(d).map((x) => x.key);

test('lacking capacity needs the MCA two-stage test and a best-interests decision', () => {
  assert.ok(keys({ capacity: 'Lacks capacity (best interests)' }).includes('bestInterests'));
  assert.ok(keys({ capacity: 'Lacks capacity (best interests)' }).includes('mcaImpairment'));
  const done = { capacity: 'Lacks capacity (best interests)', mcaImpairment: 'Yes', mcaUnderstand: 'No', mcaRetain: 'No', mcaWeigh: 'No', mcaCommunicate: 'No', bestInterests: 'Conveyed to ED; friend consulted' };
  assert.ok(!keys(done).includes('bestInterests') && !keys(done).includes('mcaImpairment'));
  assert.ok(!keys({ capacity: 'Has capacity' }).includes('bestInterests'));
});

test('under-18s need who gave consent, from the date of birth or approximate age', () => {
  const y = new Date().getFullYear();
  assert.ok(keys({ dob: `${y - 15}-01-01` }).includes('consentBy'));
  assert.ok(keys({ ageApprox: '12' }).includes('consentBy'));
  assert.ok(!keys({ ageApprox: '40' }).includes('consentBy'));
  assert.ok(!keys({ dob: `${y - 15}-01-01`, consentBy: 'Parent / guardian' }).includes('consentBy'));
});

test('a medicine not recorded in the register, and a possible RIDDOR case, are warnings that do not block', () => {
  const c = R.checkRecord({ txLog: [{ kind: 'Medication', name: 'Paracetamol', response: 'Improved' }], riddor: 'Possibly RIDDOR reportable: tell the employer' });
  assert.ok(c.some((x) => x.level === 'warning' && x.label === 'Medicines'));
  assert.ok(c.some((x) => x.level === 'warning' && x.label === 'RIDDOR'));
  assert.ok(!R.blocking({ txLog: [{ kind: 'Medication' }] }).some((x) => x.label === 'Medicines'));
});

test('MPDS determinant codes: protocol 1-37, level, number, optional suffix', () => {
  for (const ok of ['10-D-01', '10D01', '17-A-02G', '9-E-1', '26-Ω-01', '26-O-01', ''])
    assert.strictEqual(R.formatHint({ mpdsCode: ok }, 'mpdsCode'), '', ok);
  for (const bad of ['10-F-01', '40-D-01', '0-A-1', 'chest pain', '10-D'])
    assert.ok(R.formatHint({ mpdsCode: bad }, 'mpdsCode'), bad);
});
