/* Training records (hybrid: tracked + in-app delivery) — node --test
 *
 * Mirrors the SIA/DBS compliance pattern (never/overdue/expiring/ok, based
 * on the most recent record) but for a variable admin-defined set of
 * courses, with an in-app assessment path alongside admin-logged external
 * completions. The one hard rule worth a dedicated test: an officer taking
 * the assessment must never receive the answer key. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.PORT = '4019';
process.env.AUTH_SECRET = 'training-test-secret';
process.env.SIMULATION = 'off';
process.env.PERSISTENCE = 'off';

const app = require('../server.js');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p })).body.token;

let adminT, dispT, danT, dan;
before(async () => {
  app.start();
  await new Promise((r) => setTimeout(r, 200));
  adminT = await login('admin', 'admin123');
  dispT = await login('dispatcher', 'dispatch123');
  danT = await login('dwhitfield', 'field123');
  dan = app.db.personnel.find((p) => p.name === 'Dan Whitfield');
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

test('a course with an assessment is validated on create; a plain logged-only course needs no questions', async () => {
  assert.equal((await call('POST', '/api/training-courses', { name: 'Bad course', has_assessment: true, questions: [] }, adminT)).status, 400);
  assert.equal((await call('POST', '/api/training-courses', { name: 'Bad course 2', has_assessment: true, questions: [{ text: 'Q', options: ['A'], correct_index: 0 }] }, adminT)).status, 400, 'needs 2+ options');
  assert.equal((await call('POST', '/api/training-courses', { name: 'x' }, dispT)).status, 403, 'only admin creates courses');

  const induction = await call('POST', '/api/training-courses', { name: 'Site Induction', category: 'Onboarding' }, adminT);
  assert.equal(induction.status, 201);
  assert.equal(induction.body.validity_months, null);
  assert.equal(induction.body.has_assessment, false);
});

test('officers cannot see the answer key; control/admin can', async () => {
  const quiz = await call('POST', '/api/training-courses', {
    name: 'Manual Handling', validity_months: 12, has_assessment: true, pass_mark_pct: 50,
    material: 'Lift with your legs, not your back.',
    questions: [
      { text: 'Best lifting technique?', options: ['Bend your back', 'Bend your knees'], correct_index: 1 },
      { text: 'Max solo lift?', options: ['25kg', '50kg'], correct_index: 0 },
    ],
  }, adminT);
  assert.equal(quiz.status, 201, JSON.stringify(quiz.body));

  const asOfficer = await call('GET', '/api/training-courses', undefined, danT);
  const course = asOfficer.body.find((c) => c.id === quiz.body.id);
  assert.ok(course.questions.every((q) => !('correct_index' in q)), 'no answer key reaches an officer');
  assert.equal(course.questions[0].options.length, 2);

  const asAdmin = await call('GET', '/api/training-courses?all=1', undefined, adminT);
  assert.ok(asAdmin.body.find((c) => c.id === quiz.body.id).questions[0].correct_index != null);
});

test('an officer completing the assessment is scored server-side; failing creates no record; passing does, and the status flows through to GET /api/personnel', async () => {
  const quiz = (await call('POST', '/api/training-courses', {
    name: 'Fire Safety', validity_months: 12, has_assessment: true, pass_mark_pct: 100,
    questions: [{ text: 'What do you do first?', options: ['Raise the alarm', 'Panic'], correct_index: 0 }],
  }, adminT)).body;

  const fail = await call('POST', `/api/training-courses/${quiz.id}/complete`, { answers: [1] }, danT);
  assert.equal(fail.status, 400, 'below pass mark, no record created');

  const pass = await call('POST', `/api/training-courses/${quiz.id}/complete`, { answers: [0] }, danT);
  assert.equal(pass.status, 201, JSON.stringify(pass.body));
  assert.equal(pass.body.score_pct, 100);
  assert.equal(pass.body.method, 'IN_APP');

  const personnel = await call('GET', '/api/personnel', undefined, dispT);
  const danNow = personnel.body.find((p) => p.id === dan.id);
  const status = danNow.training.find((t) => t.course_id === quiz.id);
  assert.equal(status.status, 'ok');
  assert.ok(status.expires_at);
});

test('admin can log an external completion; a never-done or lapsed course shows up as never/overdue', async () => {
  const course = (await call('POST', '/api/training-courses', { name: 'First Aid', validity_months: 1 }, adminT)).body;

  let personnel = await call('GET', '/api/personnel', undefined, dispT);
  let status = personnel.body.find((p) => p.id === dan.id).training.find((t) => t.course_id === course.id);
  assert.equal(status.status, 'never');

  const overdueDate = new Date(Date.now() - 100 * 86400000).toISOString();
  const logged = await call('POST', `/api/personnel/${dan.id}/training-records`, { course_id: course.id, completed_at: overdueDate }, adminT);
  assert.equal(logged.status, 201, JSON.stringify(logged.body));
  assert.equal(logged.body.method, 'LOGGED');
  assert.equal((await call('POST', `/api/personnel/${dan.id}/training-records`, { course_id: course.id }, dispT)).status, 403, 'only admin logs external completions');

  personnel = await call('GET', '/api/personnel', undefined, dispT);
  status = personnel.body.find((p) => p.id === dan.id).training.find((t) => t.course_id === course.id);
  assert.equal(status.status, 'overdue', 'a 1-month course completed 100 days ago has lapsed');

  const history = await call('GET', `/api/personnel/${dan.id}/training-records`, undefined, dispT);
  assert.ok(history.body.some((r) => r.course_id === course.id && r.course_name === 'First Aid'));
});

test('a retired course (active:false) is excluded from the default course list and from a person\'s training summary', async () => {
  const course = (await call('POST', '/api/training-courses', { name: 'Old Course' }, adminT)).body;
  await call('POST', `/api/personnel/${dan.id}/training-records`, { course_id: course.id }, adminT);
  await call('PATCH', `/api/training-courses/${course.id}`, { active: false }, adminT);

  const list = await call('GET', '/api/training-courses', undefined, dispT);
  assert.ok(!list.body.some((c) => c.id === course.id));

  const personnel = await call('GET', '/api/personnel', undefined, dispT);
  const dan_ = personnel.body.find((p) => p.id === dan.id);
  assert.ok(!dan_.training.some((t) => t.course_id === course.id), 'a retired course drops out of the live summary, though its records still exist');
});
