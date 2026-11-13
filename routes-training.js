/**
 * Training — a hybrid of the SIA/DBS "record what happened" pattern and
 * actual in-app delivery. A course is either logged externally (a
 * classroom session, a toolbox talk — admin records that it happened) or
 * taken in-app: officer reads `material`, answers a short multiple-choice
 * assessment if the course has one, and a training_records row is created
 * either way. training_records is append-only, like dial_log — the
 * current status is always derived from the most recent one, never
 * mutated in place, so a course's real history survives a retake.
 *
 * No versioning on course edits, unlike form_definitions: a quiz's
 * content changing later doesn't need the audit fidelity a restricted
 * safeguarding report does, so this is a deliberate v1 simplification, not
 * an oversight. A course is retired via `active: false`, never deleted —
 * training_records must always be able to resolve their course_id.
 *
 * Moved out of server.js unchanged. Registrar pattern: server.js passes in
 * what this needs, at the same point in route order as before.
 */
'use strict';

const crypto = require('crypto');

module.exports = function registerTraining({ route, httpError, ALL, ADMIN, db, nextId, logEvent, findPersonnel, isControlRole, trainingStatusForPerson }) {
  function validQuestions(qs) {
    if (!Array.isArray(qs) || !qs.length) return false;
    return qs.every((q) => q && typeof q.text === 'string' && q.text.trim()
      && Array.isArray(q.options) && q.options.length >= 2 && q.options.every((o) => typeof o === 'string' && o.trim())
      && Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index < q.options.length);
  }
  const normalizeQuestions = (qs) => qs.map((q) => ({ id: q.id || crypto.randomUUID(), text: String(q.text).trim(), options: q.options.map((o) => String(o).trim()), correct_index: q.correct_index }));
  /** Strips answers for anyone who isn't managing the course — an officer
   * about to take the assessment must not receive correct_index in the
   * response, any more than an exam paper comes with the mark scheme
   * stapled to it. */
  function publicCourse(c, user) {
    const isAdmin = user.role === 'SYSTEM_ADMIN';
    return {
      id: c.id, name: c.name, category: c.category, description: c.description,
      validity_months: c.validity_months, has_assessment: c.has_assessment,
      pass_mark_pct: c.pass_mark_pct, material: c.material, active: c.active,
      questions: c.has_assessment ? c.questions.map((q) => (isAdmin ? q : { id: q.id, text: q.text, options: q.options })) : [],
    };
  }
  route('GET', '/api/training-courses', ALL, ({ query, user }) => {
    const showAll = query.get('all') === '1' && user.role === 'SYSTEM_ADMIN';
    return db.training_courses.filter((c) => showAll || c.active).map((c) => publicCourse(c, user));
  });
  route('POST', '/api/training-courses', ADMIN, ({ body, user }) => {
    const name = String(body.name || '').trim();
    if (!name) throw httpError(400, 'name required');
    const hasAssessment = Boolean(body.has_assessment);
    if (hasAssessment && !validQuestions(body.questions)) {
      throw httpError(400, 'a course with an assessment needs at least one question, each with 2+ options and a valid correct_index');
    }
    const c = {
      id: nextId('training_courses'), name, category: String(body.category || '').trim(),
      description: String(body.description || '').trim(), material: String(body.material || '').trim(),
      validity_months: body.validity_months ? Number(body.validity_months) : null,
      has_assessment: hasAssessment, questions: hasAssessment ? normalizeQuestions(body.questions) : [],
      pass_mark_pct: hasAssessment ? Number(body.pass_mark_pct || 80) : null,
      active: true, created_at: new Date().toISOString(),
    };
    db.training_courses.push(c);
    logEvent('training_course.created', `TRAINING COURSE ${name} ADDED`);
    return { __status: 201, __body: publicCourse(c, user) };
  });
  route('PATCH', '/api/training-courses/:id', ADMIN, ({ params, body, user }) => {
    const c = db.training_courses.find((x) => x.id === Number(params.id));
    if (!c) throw httpError(404, 'training course not found');
    if ('name' in body) { const name = String(body.name || '').trim(); if (!name) throw httpError(400, 'name required'); c.name = name; }
    if ('category' in body) c.category = String(body.category || '').trim();
    if ('description' in body) c.description = String(body.description || '').trim();
    if ('material' in body) c.material = String(body.material || '').trim();
    if ('validity_months' in body) c.validity_months = body.validity_months ? Number(body.validity_months) : null;
    if ('has_assessment' in body) c.has_assessment = Boolean(body.has_assessment);
    if ('questions' in body || 'has_assessment' in body) {
      if (c.has_assessment) {
        if (!validQuestions(body.questions || c.questions)) throw httpError(400, 'a course with an assessment needs at least one valid question');
        c.questions = normalizeQuestions(body.questions || c.questions);
      } else c.questions = [];
    }
    if ('pass_mark_pct' in body) c.pass_mark_pct = c.has_assessment ? Number(body.pass_mark_pct || 80) : null;
    if ('active' in body) c.active = Boolean(body.active);
    logEvent('training_course.updated', `TRAINING COURSE ${c.name} UPDATED`, { training_course_id: c.id });
    return publicCourse(c, user);
  });

  /** An officer completing their own course — the in-app half of the hybrid.
   * Scored server-side only: the client never has correct_index to begin
   * with, but this also means a replayed/tampered `passed` claim from the
   * client is simply never consulted. */
  route('POST', '/api/training-courses/:id/complete', ALL, ({ params, body, user }) => {
    const c = db.training_courses.find((x) => x.id === Number(params.id) && x.active);
    if (!c) throw httpError(404, 'training course not found');
    if (!user.personnel_id) throw httpError(403, 'this login has no personnel record to record training against');
    const p = db.personnel.find((x) => x.id === user.personnel_id);
    if (!p) throw httpError(403, 'this login has no personnel record to record training against');

    let scorePct = null;
    if (c.has_assessment) {
      const answers = Array.isArray(body.answers) ? body.answers : [];
      if (answers.length !== c.questions.length) throw httpError(400, `expected ${c.questions.length} answers`);
      const correct = c.questions.filter((q, i) => Number(answers[i]) === q.correct_index).length;
      scorePct = Math.round((correct / c.questions.length) * 100);
      if (scorePct < c.pass_mark_pct) throw httpError(400, `score ${scorePct}% is below the ${c.pass_mark_pct}% pass mark — no record created, try again`);
    }
    const r = {
      id: nextId('training_records'), personnel_id: p.id, course_id: c.id, method: 'IN_APP',
      completed_at: new Date().toISOString(), score_pct: scorePct, recorded_by: null,
    };
    db.training_records.push(r);
    logEvent('training.completed', `${p.name} COMPLETED ${c.name}${scorePct != null ? ` (${scorePct}%)` : ''}`, { personnel_id: p.id, training_course_id: c.id });
    return { __status: 201, __body: { ...r, training: trainingStatusForPerson(p.id) } };
  });

  /** Admin logging a completion that happened outside CCCS — a classroom
   * session, a toolbox talk, a certificate someone brought in. */
  route('POST', '/api/personnel/:id/training-records', ADMIN, ({ params, body, user }) => {
    const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
    const c = db.training_courses.find((x) => x.id === Number(body.course_id));
    if (!c) throw httpError(400, 'course_id must reference an existing course');
    const r = {
      id: nextId('training_records'), personnel_id: p.id, course_id: c.id, method: 'LOGGED',
      completed_at: body.completed_at ? new Date(body.completed_at).toISOString() : new Date().toISOString(),
      score_pct: body.score_pct != null && body.score_pct !== '' ? Number(body.score_pct) : null,
      recorded_by: user.display_name,
    };
    if (isNaN(Date.parse(r.completed_at))) throw httpError(400, 'invalid completed_at');
    db.training_records.push(r);
    logEvent('training.logged', `${p.name} — ${c.name} LOGGED BY ${user.username}`, { personnel_id: p.id, training_course_id: c.id });
    return { __status: 201, __body: { ...r, training: trainingStatusForPerson(p.id) } };
  });
  route('GET', '/api/personnel/:id/training-records', ALL, ({ params, user }) => {
    const p = findPersonnel(params.id); if (!p) throw httpError(404, 'personnel not found');
    if (!isControlRole(user.role) && user.personnel_id !== p.id) throw httpError(403, 'not your training record');
    return db.training_records.filter((r) => r.personnel_id === p.id)
      .sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1))
      .map((r) => ({ ...r, course_name: (db.training_courses.find((c) => c.id === r.course_id) || {}).name || 'Unknown course' }));
  });
};
