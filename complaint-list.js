/**
 * Chief-complaint list for a medical-flagged job, and the priority each
 * one suggests. Deliberately NOT the real MPDS/AMPDS protocol — that is
 * Priority Dispatch Corp / IAED licensed IP (card numbers, determinant
 * codes and the underlying algorithm are proprietary), and reproducing it
 * without a licence would be both legally wrong and clinically dishonest
 * (pretending to be a validated protocol this isn't). This is our own
 * short list, styled after NHS Pathways' public symptom-category
 * language, scoped to what an event/site first aider actually sees.
 *
 * `priority` is only ever a starting suggestion a dispatcher can change —
 * see server.js's job PATCH/POST handlers, which never force it.
 */
'use strict';

const CHIEF_COMPLAINTS = [
  { code: 'cardiac', label: 'Chest pain / cardiac symptoms', priority: 'RED' },
  { code: 'breathing', label: 'Breathing difficulty / shortness of breath', priority: 'RED' },
  { code: 'unresponsive', label: 'Unconscious / unresponsive', priority: 'RED' },
  { code: 'bleeding_severe', label: 'Severe bleeding / haemorrhage', priority: 'RED' },
  { code: 'anaphylaxis', label: 'Anaphylaxis / severe allergic reaction', priority: 'RED' },
  { code: 'seizure', label: 'Seizure / fitting', priority: 'RED' },
  { code: 'stroke', label: 'Stroke symptoms (face / arm / speech)', priority: 'RED' },
  { code: 'choking', label: 'Choking', priority: 'RED' },
  { code: 'major_trauma', label: 'Major trauma / fall from height', priority: 'RED' },
  { code: 'burns_major', label: 'Burns — significant', priority: 'AMBER' },
  { code: 'fracture', label: 'Fracture / suspected broken bone', priority: 'AMBER' },
  { code: 'head_injury', label: 'Head injury', priority: 'AMBER' },
  { code: 'abdo_pain', label: 'Abdominal pain — severe', priority: 'AMBER' },
  { code: 'diabetic', label: 'Diabetic emergency', priority: 'AMBER' },
  { code: 'intoxication', label: 'Alcohol / drug intoxication', priority: 'AMBER' },
  { code: 'mental_health', label: 'Mental health crisis / self-harm', priority: 'AMBER' },
  { code: 'allergic_mild', label: 'Allergic reaction — mild', priority: 'AMBER' },
  { code: 'bleeding_minor', label: 'Minor bleeding / laceration', priority: 'GREEN' },
  { code: 'sprain_strain', label: 'Sprain / strain', priority: 'GREEN' },
  { code: 'burns_minor', label: 'Burns — minor', priority: 'GREEN' },
  { code: 'nausea_vomiting', label: 'Nausea / vomiting', priority: 'GREEN' },
  { code: 'headache', label: 'Headache — non-severe', priority: 'GREEN' },
  { code: 'faint_dizzy', label: 'Fainting / dizziness — recovered', priority: 'GREEN' },
  { code: 'other', label: 'Other / unspecified', priority: 'AMBER' },
];

const CHIEF_COMPLAINT_CODES = CHIEF_COMPLAINTS.map((c) => c.code);
const suggestedPriority = (code) => (CHIEF_COMPLAINTS.find((c) => c.code === code) || {}).priority || null;
const complaintLabel = (code) => (CHIEF_COMPLAINTS.find((c) => c.code === code) || {}).label || '';

module.exports = { CHIEF_COMPLAINTS, CHIEF_COMPLAINT_CODES, suggestedPriority, complaintLabel };
