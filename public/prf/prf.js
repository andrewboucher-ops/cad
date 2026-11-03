/* CCCS patient report form (PRF) — client.
 *
 * Workflow follows common ePCR practice: section tabs along the bottom in the
 * order a call is charted, sub-sections inside each, and Review always one tap
 * away. Storage, finalising and the audit trail are CCCS's (see /prf.js).
 * Needs /app.js (CCCS client), uk.js and rules.js loaded first. */
"use strict";
if (!CCCS.requireAuth(["FIELD_USER", "SUPERVISOR", "SYSTEM_ADMIN"])) throw new Error("auth");

const { api, getSession, clearSession } = CCCS;
const me = getSession().user;
const MY_NAME = me.display_name || me.username;
const READS_ALL = ["SUPERVISOR", "SYSTEM_ADMIN"].includes(me.role);

/* ------------------------------------------------------------------ *
 * Pick lists
 * ------------------------------------------------------------------ */
const choice = {
  callType: ["Medical", "Trauma", "Event Medical / First Aid", "Inter-hospital Transfer", "Standby", "Public Assist", "Other"],
  mpds: [
    "01 - Abdominal Pain",
    "06 - Breathing Problems",
    "09 - Cardiac / Respiratory Arrest",
    "10 - Chest Pain",
    "12 - Convulsions / Fitting",
    "17 - Falls",
    "23 - Overdose / Poisoning",
    "26 - Sick Person",
    "29 - Traffic Incident",
    "32 - Unknown Problem",
  ],
  precautions: ["None", "Infection risk", "Violence / aggression", "Hazardous materials", "Crowd / public order", "Dog / animal", "Working at height"],
  locationType: ["Event venue", "Public place", "Street / road", "Licensed premises", "Workplace", "Home", "Sports ground", "Other"],
  destinationType: [
    "Emergency department",
    "Urgent treatment centre",
    "Minor injuries unit",
    "GP / primary care",
    "Home / discharged on scene",
    "Handed to NHS ambulance",
    "On-site medical centre",
    "Other",
  ],
  destinationReason: ["Closest appropriate", "Specialist centre", "Patient choice", "Clinical advice (111 / GP)", "Not applicable"],
  responseMode: ["On foot", "Buggy / cart", "Vehicle - normal", "Vehicle - emergency"],
  transportMode: ["Not transported", "NHS ambulance", "Private ambulance", "Event vehicle", "Own transport / taxi", "Walked"],
  transportPriority: ["Routine", "Urgent", "Emergency"],
  sex: ["Female", "Male", "Intersex", "Not known"],
  contactRel: ["Partner", "Parent", "Child", "Friend", "Carer", "Other"],
  catHaem: ["No", "Yes - controlled", "Yes - uncontrolled"],
  airway: ["Patent", "Partially obstructed", "Obstructed", "Maintained with adjunct"],
  breathing: ["Normal", "Laboured", "Shallow", "Noisy", "Apnoeic", "Assisted ventilation"],
  circulation: ["Normal", "Pale / clammy", "Weak pulse", "No pulse", "Catastrophic haemorrhage"],
  loc: ["Alert", "New confusion", "Responds to voice", "Responds to pain", "Unresponsive"],
  chief: [
    "Abdominal pain",
    "Allergic reaction",
    "Altered consciousness",
    "Asthma / breathing difficulty",
    "Chest pain",
    "Collapse / faint",
    "Diabetic problem",
    "Fall",
    "Head injury",
    "Intoxication",
    "Limb injury",
    "Seizure",
    "Wound / bleeding",
    "Other",
  ],
  priority: ["Routine", "Urgent", "Emergency", "Life-threatening"],
  allergies: ["No known allergies", "Unknown", "Refused to say", "Penicillin", "Other antibiotic", "NSAIDs / aspirin", "Opioids", "Latex", "Nuts", "Shellfish", "Insect stings", "Other"],
  medsStatus: ["Takes regular medication", "No regular medication", "Unknown", "Refused to say"],
  pmh: ["None", "Asthma", "COPD", "Diabetes", "Epilepsy", "Heart disease", "Hypertension", "Stroke / TIA", "Mental health", "Anaphylaxis", "Pregnancy", "Other"],
  sceneFindings: ["Alcohol involved", "Drugs involved", "Weapon present", "Vehicle involved", "Fall from height", "Unsafe scene", "Bystander CPR", "Nothing of note"],
  fast: ["Negative", "Positive", "Not assessed"],
  disposition: ["Treated and released", "Transported", "Handed to NHS ambulance", "Refused care", "Advice only", "No patient found", "Deceased"],
  capacity: ["Has capacity", "Lacks capacity (best interests)", "Not assessed"],
  consent: ["Verbal consent", "Implied consent", "Treated in best interests", "Refused"],
  safeguarding: ["No", "Yes - adult", "Yes - child"],
  impression: [
    "Minor injury",
    "Musculoskeletal injury",
    "Head injury",
    "Asthma",
    "Anaphylaxis / allergy",
    "Cardiac chest pain",
    "Non-cardiac chest pain",
    "Collapse / syncope",
    "Hypoglycaemia",
    "Seizure",
    "Intoxication",
    "Heat illness",
    "Mental health crisis",
    "Other",
  ],
  txProcedure: [
    "Wound care / dressing",
    "Haemorrhage control",
    "Splint / sling",
    "Ice / cold compress",
    "Recovery position",
    "Oxygen",
    "Suction",
    "Airway adjunct",
    "Bag-valve-mask",
    "CPR",
    "Defibrillation",
    "Spinal motion restriction",
    "Blood glucose",
    "12-lead ECG",
    "Observation only",
  ],
  txMedication: ["Paracetamol", "Ibuprofen", "Salbutamol", "Glyceryl trinitrate (GTN)", "Aspirin", "Oral glucose", "Glucagon", "Adrenaline 1:1000 IM", "Chlorphenamine", "Entonox", "Oxygen"],
  route: ["Oral", "Inhaled", "Nebulised", "Sublingual", "IM", "IV", "IO", "Topical", "Buccal"],
  success: ["Successful", "Unsuccessful", "Partially successful"],
  response: ["Improved", "No change", "Worse", "Not assessed"],
  examStatus: ["Normal", "Abnormal", "Not examined"],
  injuryType: ["Wound", "Bruise", "Burn", "Deformity", "Pain", "Swelling", "Other"],
};
// Symptoms by body system. Each can be marked present, or as a pertinent negative.
const SYMPTOMS = {
  General: ["Fever", "Feeling unwell", "Dizziness", "Fatigue", "Sweating"],
  Respiratory: ["Shortness of breath", "Wheeze", "Cough", "Chest tightness"],
  Cardiovascular: ["Chest pain", "Palpitations", "Syncope", "Leg swelling"],
  Neurological: ["Headache", "Confusion", "Weakness", "Numbness / tingling", "Vision change", "Seizure"],
  Gastrointestinal: ["Nausea", "Vomiting", "Abdominal pain", "Diarrhoea"],
  Musculoskeletal: ["Limb pain", "Back pain", "Neck pain", "Reduced movement"],
};
const EXAM_SYSTEMS = ["Head & face", "Neck", "Chest", "Abdomen", "Pelvis", "Back / spine", "Upper limbs", "Lower limbs", "Neurological", "Skin"];

/* ------------------------------------------------------------------ *
 * Layout: tabs along the bottom, sub-sections across the top.
 * A field is [key, label, type, options]. Types: text, number, date,
 * datetime (with a Now button), area, pick (dialog), multi (chips).
 * ------------------------------------------------------------------ */
const TABS = [
  {
    name: "Incident",
    help: "Event-level details: the call, crew, location, destination and times.",
    subs: [
      {
        name: "General",
        fields: [
          ["event", "Event Number", "text"],
          ["callType", "Call Type", "pick"],
          ["mpds", "MPDS Determinant", "pick"],
          ["patientNo", "Patient", "number", { cls: "narrow" }],
          ["patientOf", "Of", "number", { cls: "narrow" }],
          ["precautions", "Special Precautions", "multi", { cls: "full" }],
        ],
      },
      {
        name: "Crew & Vehicle",
        fields: [
          ["callsign", "Call Sign", "text"],
          ["vehicle", "Vehicle", "text"],
          ["crew", "Crew on this PRF", "area", { cls: "full" }],
        ],
      },
      {
        name: "Location",
        fields: [
          ["address", "Incident Address", "text", { cls: "wide" }],
          ["address2", "Address Line 2", "text"],
          ["roomLocation", "Area / Room / Gate", "text"],
          ["municipality", "Town / City", "text"],
          ["incidentPostcode", "Incident Postcode", "text", { hint: 1 }],
          ["locationType", "Location Type", "pick"],
          ["sceneNotes", "Scene Notes", "area", { cls: "full" }],
        ],
      },
      {
        name: "Destination & Mode",
        fields: [
          ["destination", "Destination", "text", { cls: "wide" }],
          ["destinationType", "Destination Type", "pick"],
          ["destinationReason", "Reason for Destination", "pick"],
          ["responseMode", "Response to Scene", "pick"],
          ["transportMode", "Transport", "pick"],
          ["transportPriority", "Transport Priority", "pick"],
        ],
      },
      { name: "Times", render: () => timesPanel() },
    ],
  },
  {
    name: "Patient ID",
    help: "Who the patient is and who to contact.",
    subs: [
      {
        name: "Identification",
        fields: [
          ["first", "First Name", "text"],
          ["last", "Last Name", "text"],
          ["dob", "Date of Birth", "date", { after: () => ageText() }],
          ["sex", "Sex", "pick"],
          ["health", "NHS Number", "text", { hint: 1 }],
          ["weight", "Weight (kg)", "number"],
        ],
      },
      {
        name: "Address & Contacts",
        fields: [
          ["home", "Home Address", "text", { cls: "wide" }],
          ["postal", "Postcode", "text", { hint: 1 }],
          ["contactName", "Next of Kin / Contact", "text"],
          ["contactRel", "Relationship", "pick"],
          ["contactPhone", "Contact Phone", "text"],
          ["gp", "GP Practice", "text", { cls: "wide" }],
        ],
      },
    ],
  },
  {
    name: "Primary",
    help: "First impressions: primary survey, presenting problem and scene findings.",
    subs: [
      {
        name: "Primary Survey",
        fields: [
          ["primaryTime", "Primary Survey Time", "datetime"],
          ["catHaem", "Catastrophic Haemorrhage", "pick"],
          ["airway", "Airway", "pick"],
          ["breathing", "Breathing", "pick"],
          ["circulation", "Circulation", "pick"],
          ["loc", "Consciousness (ACVPU)", "pick"],
        ],
      },
      {
        name: "Presenting Problem",
        fields: [
          ["chief", "Chief Complaint", "pick"],
          ["onset", "Onset", "datetime"],
          ["priority", "Priority", "pick"],
          ["statement", "Patient's Own Words", "area", { cls: "full" }],
        ],
      },
      { name: "Scene Findings", fields: [["sceneFindings", "Scene Findings", "multi", { cls: "full" }]] },
    ],
  },
  {
    name: "History",
    help: "The story so far: complaint, symptoms, allergies, medication and past history.",
    subs: [
      {
        name: "Complaint & PQRST",
        fields: [
          ["pqrsP", "Provocation / Palliation", "text", { cls: "wide" }],
          ["pqrsQ", "Quality", "text"],
          ["pqrsR", "Region / Radiation", "text"],
          ["pqrsS", "Severity (0-10)", "number"],
          ["pqrsT", "Time / Duration", "text"],
          ["events", "Events Leading Up", "area", { cls: "full" }],
          ["intake", "Last Oral Intake", "text"],
        ],
      },
      { name: "Symptoms", render: () => symptomsPanel() },
      {
        name: "Allergies & Meds",
        fields: [
          ["allergies", "Allergies", "multi", { cls: "full" }],
          ["allergyNotes", "Allergy Details", "text", { cls: "full" }],
          ["medsStatus", "Medication Status", "pick"],
          ["meds", "Current Medications", "area", { cls: "full" }],
        ],
      },
      {
        name: "Past History",
        fields: [
          ["pmh", "Past Medical History", "multi", { cls: "full" }],
          ["history", "History Details", "area", { cls: "full" }],
          ["social", "Social / Family", "area", { cls: "wide" }],
          ["alerts", "Alerts (e.g. DNACPR, care plan)", "text", { cls: "wide" }],
        ],
      },
    ],
  },
  {
    name: "Vital Signs",
    help: "Serial observations. NEWS2 is scored on every complete set.",
    subs: [
      { name: "Vital Sets", render: () => vitalsPanel() },
      {
        name: "Scores",
        fields: [
          ["pain", "Pain Score (0-10)", "number"],
          ["glucose", "Blood Glucose (mmol/L)", "number"],
          ["fast", "FAST", "pick"],
          ["gcsE", "GCS Eyes (1-4)", "number"],
          ["gcsV", "GCS Verbal (1-5)", "number"],
          ["gcsM", "GCS Motor (1-6)", "number", { after: () => gcsText() }],
        ],
      },
    ],
  },
  {
    name: "Assess / Tx",
    help: "Examination findings, and everything done for the patient, as it happens.",
    subs: [
      { name: "Assessment", fields: [["assessment", "Focused Assessment", "area", { cls: "full" }]], render: () => examPanel() },
      { name: "Treatment Log", render: () => txPanel() },
      { name: "Body Diagram", render: () => bodyPanel() },
    ],
  },
  {
    name: "Outcomes",
    help: "What happened next, consent and capacity, and any safeguarding concern.",
    subs: [
      {
        name: "Disposition",
        fields: [
          ["disposition", "Disposition", "pick"],
          ["receiver", "Care Handed To", "text"],
          ["handover", "Handover Notes", "area", { cls: "full" }],
        ],
      },
      {
        name: "Capacity & Consent",
        fields: [
          ["capacity", "Mental Capacity", "pick"],
          ["consent", "Consent", "pick"],
          ["refusal", "Refusal of Care: Risks Explained & Advice Given", "area", { cls: "full" }],
        ],
      },
      {
        name: "Safeguarding",
        fields: [
          ["safeguarding", "Safeguarding Concern", "pick"],
          ["safeguardingDetails", "Safeguarding Details & Referral", "area", { cls: "full" }],
        ],
      },
    ],
  },
  {
    name: "Care Plan",
    help: "Your impression and the clinical narrative.",
    subs: [
      {
        name: "Impressions",
        fields: [
          ["impression", "Clinician's Impression", "pick"],
          ["narrative", "Care Summary / Narrative", "area", { cls: "full tall" }],
          ["concerns", "Patient / Carer Concerns & Wishes", "area", { cls: "full" }],
          ["monitoring", "Safety-netting & Ongoing Monitoring", "area", { cls: "full" }],
        ],
      },
    ],
  },
  {
    name: "Review",
    help: "Check required items, sign, preview and finalise.",
    subs: [
      { name: "Required Items", render: () => reviewPanel() },
      { name: "Signatures", render: () => signaturesPanel() },
      { name: "Print Preview", render: () => `<div class="preview">${recordHtml({ pcr: rec.pcr, status: "DRAFT", data: s, job_reference: rec.job_reference, addenda: [] })}</div>` },
    ],
  },
];
// Where each field lives, for review "go to" links. Panels own a few keys too.
const FIELD_LOC = {};
const LABEL = {};
TABS.forEach((t, ti) =>
  t.subs.forEach((sub, si) =>
    (sub.fields || []).forEach(([k, l]) => {
      FIELD_LOC[k] = [ti, si];
      LABEL[k] = l;
    }),
  ),
);
Object.assign(FIELD_LOC, {
  callReceived: [0, 4],
  dispatch: [0, 4],
  enRoute: [0, 4],
  scene: [0, 4],
  contact: [0, 4],
  depart: [0, 4],
  arrive: [0, 4],
  transfer: [0, 4],
  available: [0, 4],
  vitals: [4, 0],
  txLog: [5, 1],
  sig_clinician: [8, 1],
  sig_patient: [8, 1],
  unableToSign: [8, 1],
});

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
let rec = null; // the open PRF: { pcr, version, status, ... }
let s = {}; // its data
let tab = 0,
  sub = TABS.map(() => 0),
  pickKey = "";
const q = (x) => document.querySelector(x),
  qa = (x) => [...document.querySelectorAll(x)],
  v = (k, d = "") => s[k] ?? d;
function esc(x) {
  return String(x ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]);
}
const nowLocal = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const hhmm = () => nowLocal().slice(11, 16);

/* ---- Autosave ----
   Edits are sent a moment after typing stops. If the network drops, the draft
   stays in this tab's memory and is retried; it is never written to browser
   storage, so a lost or shared device holds no patient data. */
let saveTimer = null,
  saving = false,
  dirty = false;
function setStatus(text, state) {
  q("#connection").textContent = text;
  q("#dot").className = state || "";
}
function scheduleSave() {
  dirty = true;
  setStatus("Unsaved changes", "pending");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1500);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!rec || rec.status !== "DRAFT" || !dirty) return true;
  if (saving) {
    saveTimer = setTimeout(saveNow, 500);
    return false;
  }
  saving = true;
  dirty = false;
  setStatus("Saving…", "pending");
  try {
    const out = await api("PUT", `/api/prfs/${encodeURIComponent(rec.pcr)}`, { version: rec.version, data: s });
    rec.version = out.version;
    setStatus("Saved to CCCS", "");
    return true;
  } catch (e) {
    dirty = true;
    if (/changed elsewhere/.test(e.message)) {
      setStatus("Changed elsewhere — reopen this PRF", "off");
      toast("This PRF was changed in another window. Reopen it before editing.");
      return false;
    }
    setStatus("Not saved — retrying", "off");
    saveTimer = setTimeout(saveNow, 5000);
    return false;
  } finally {
    saving = false;
  }
}
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
function set(k, x) {
  s[k] = x;
  scheduleSave();
  refreshChrome();
}

/* ---- Rules shared with the server ---- */
const checks = () => PRFRules.checkRecord(s);
const blockingItems = () => checks().filter((c) => !c.ok && c.level !== "warning");
function completion() {
  const c = checks().filter((x) => x.level !== "warning");
  return (c.filter((x) => x.ok).length / c.length) * 100;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
function field([key, label, type, o = {}]) {
  const req = PRFRules.requiredKeys(s).has(key) ? "required" : "";
  const late = PRFRules.timeIssues(s).has(key) ? " bad-time" : "";
  const c = `field ${o.cls || ""}${late}`;
  const lab = `<label class="${req}" for="f-${key}">${esc(label)}</label>`;
  const after = o.after ? `<small class="aside" data-after="${key}">${esc(o.after())}</small>` : "";
  if (type === "pick")
    return `<div class="${c}">${lab}<div class="input-row"><input id="f-${key}" data-key="${key}" value="${esc(v(key))}" readonly data-open-pick="${key}"><button type="button" data-pick="${key}" aria-label="Choose ${esc(label)}">▾</button></div></div>`;
  if (type === "multi") {
    const sel = s[key] || [];
    return `<div class="${c}">${lab}<div class="chips">${choice[key].map((x) => `<button type="button" class="chip ${sel.includes(x) ? "on" : ""}" data-multi="${key}" data-val="${esc(x)}">${esc(x)}</button>`).join("")}</div></div>`;
  }
  if (type === "area") return `<div class="${c}">${lab}<textarea id="f-${key}" data-key="${key}">${esc(v(key))}</textarea></div>`;
  if (type === "datetime")
    return `<div class="${c}">${lab}<div class="input-row"><input id="f-${key}" data-key="${key}" type="datetime-local" value="${esc(v(key))}"><button type="button" class="now" data-now="${key}">Now</button></div></div>`;
  const hint = o.hint ? `<small class="hint" data-hint="${key}">${esc(PRFRules.formatHint(s, key))}</small>` : "";
  return `<div class="${c}">${lab}<input id="f-${key}" data-key="${key}" type="${type}" ${type === "number" ? 'inputmode="decimal" step="any"' : ""} value="${esc(v(key))}">${hint}${after}</div>`;
}
const grid = (fields) => `<div class="grid">${fields.map(field).join("")}</div>`;

function ageText() {
  if (!s.dob) return "";
  const b = new Date(s.dob),
    n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--;
  return a >= 0 && a < 130 ? `Age ${a}` : "";
}
function gcsText() {
  const e = +s.gcsE,
    vv = +s.gcsV,
    m = +s.gcsM;
  return e && vv && m ? `GCS ${e + vv + m}/15 (E${e} V${vv} M${m})` : "";
}

function timesPanel() {
  const issues = PRFRules.timeIssues(s);
  const rows = PRFRules.TIME_ORDER.map(([k, l]) => {
    const req = PRFRules.requiredKeys(s).has(k) ? "required" : "";
    return `<div class="time-row ${issues.has(k) ? "bad-time" : ""}"><label class="${req}" for="f-${k}">${esc(l)}</label><input id="f-${k}" type="datetime-local" data-key="${k}" value="${esc(v(k))}"><button type="button" class="now" data-now="${k}">Now</button></div>`;
  }).join("");
  const cad =
    rec && rec.job_id
      ? `<p><button type="button" id="cadPull">Update from CCCS job</button> <span class="muted" id="cadNote"></span></p>`
      : `<p class="muted">Not linked to a CCCS job, so times are entered by hand.</p>`;
  return `<div class="times">${rows}</div>${issues.size ? `<p class="blocked">Times in red are out of sequence.</p>` : ""}${cad}`;
}

function symptomsPanel() {
  const st = s.symptoms || {};
  return `<p class="muted">Tap once for present, twice for a pertinent negative (asked and absent), again to clear.</p>${Object.entries(SYMPTOMS)
    .map(
      ([sys, list]) =>
        `<div class="sys"><h4>${esc(sys)}</h4><div class="chips">${list
          .map((x) => {
            const val = st[x];
            return `<button type="button" class="chip tri ${val === "yes" ? "on" : val === "no" ? "neg" : ""}" data-sym="${esc(x)}">${val === "no" ? "No " : ""}${esc(x)}</button>`;
          })
          .join("")}</div></div>`,
    )
    .join("")}`;
}

const VITAL_COLS = [
  ["time", "Time"],
  ["hr", "HR"],
  ["rr", "RR"],
  ["sys", "BP Sys"],
  ["dia", "BP Dia"],
  ["spo2", "SpO₂ %"],
  ["o2", "Air / O₂", ["", "Air", "O₂"]],
  ["acvpu", "ACVPU", ["", "A", "C", "V", "P", "U"]],
  ["gcs", "GCS"],
  ["temp", "Temp °C"],
  ["doneBy", "Done By"],
];
function newsText(r) {
  const n = news2(r);
  return n.missing ? "—" : `${n.score} · ${n.risk}`;
}
function newsClass(r) {
  const n = news2(r);
  if (n.missing) return "news";
  return "news " + (n.score >= 7 ? "high" : n.score >= 5 ? "med" : Object.values(n.parts).includes(3) ? "lowmed" : "low");
}
function vitalsPanel() {
  const rows = s.vitals || [];
  const cell = (r, i, [k, , opts]) =>
    opts
      ? `<td><select data-vital="${i}" data-vkey="${k}">${opts.map((o) => `<option ${r[k] === o ? "selected" : ""}>${o}</option>`).join("")}</select></td>`
      : `<td><input data-vital="${i}" data-vkey="${k}" type="${k === "time" ? "time" : k === "doneBy" ? "text" : "number"}" ${k === "temp" ? 'step="0.1"' : ""} value="${esc(r[k])}"></td>`;
  return `<table class="vitals"><thead><tr>${VITAL_COLS.map(([, l]) => `<th>${l}</th>`).join("")}<th>NEWS2</th><th></th></tr></thead><tbody>${rows
    .map(
      (r, i) =>
        `<tr>${VITAL_COLS.map((c) => cell(r, i, c)).join("")}<td class="${newsClass(r)}" id="news-${i}">${newsText(r)}</td><td><button data-remove="${i}" aria-label="Remove set">×</button></td></tr>`,
    )
    .join(
      "",
    )}</tbody></table>${rows.length ? "" : `<p class="muted">No observations yet.</p>`}<p><button id="addVital" class="primary">+ New vital set (now)</button></p><p class="hint-muted">NEWS2 uses SpO₂ scale 1 and appears once RR, SpO₂, Air/O₂, BP Sys, HR, ACVPU and Temp are all entered. C = new confusion.</p>`;
}

function examPanel() {
  const ex = s.exam || {};
  return `<h4>Examination by body system</h4><table class="exam"><tbody>${EXAM_SYSTEMS.map((sys) => {
    const e = ex[sys] || {};
    return `<tr><th>${esc(sys)}</th><td><div class="seg">${choice.examStatus
      .map((st) => `<button type="button" class="${e.status === st ? "on" : ""}" data-exam="${esc(sys)}" data-status="${esc(st)}">${esc(st)}</button>`)
      .join("")}</div></td><td><input data-examnote="${esc(sys)}" placeholder="Findings" value="${esc(e.note)}"></td></tr>`;
  }).join("")}</tbody></table>`;
}

function txPanel() {
  const log = s.txLog || [];
  const sel = (i, k, list, val) => `<select data-tx="${i}" data-tkey="${k}"><option></option>${list.map((o) => `<option ${val === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  const inp = (i, k, val, ph, type = "text") => `<input data-tx="${i}" data-tkey="${k}" type="${type}" value="${esc(val)}" placeholder="${ph}">`;
  const rows = log
    .map((x, i) => {
      const list = x.kind === "Medication" ? choice.txMedication : choice.txProcedure;
      return `<tr><td>${inp(i, "time", x.time, "", "time")}</td><td><b>${esc(x.kind)}</b></td><td>${sel(i, "name", list, x.name)}</td><td>${x.kind === "Medication" ? inp(i, "dose", x.dose, "Dose") + sel(i, "route", choice.route, x.route) : sel(i, "success", choice.success, x.success)}</td><td>${sel(i, "response", choice.response, x.response)}</td><td>${inp(i, "doneBy", x.doneBy, "Done by")}</td><td>${inp(i, "complications", x.complications, "Complications / notes")}</td><td><button data-txremove="${i}" aria-label="Remove entry">×</button></td></tr>`;
    })
    .join("");
  return `<p class="muted">Add each intervention when it happens; it's stamped with the time and your name. Record the response once you've reassessed.</p><p class="quick"><button class="primary" data-txadd="Procedure">+ Procedure</button> <button class="primary" data-txadd="Medication">+ Medication</button></p>${
    log.length
      ? `<table class="txlog"><thead><tr><th>Time</th><th>Type</th><th>What</th><th>Dose / route · Success</th><th>Response</th><th>By</th><th>Notes</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="muted">Nothing logged yet.</p>`
  }`;
}

// A simple outline figure, front and back. Tap to place a marker.
const FIGURE = `<g fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="50" cy="10" r="7"/><path d="M43 18h14l8 4 6 26-5 2-6-22v30l4 50h-8l-5-42-5 42h-8l4-50V30l-6 22-5-2 6-26z"/></g>`;
function bodyPanel() {
  const inj = s.injuries || [];
  const view = (name) =>
    `<figure><svg viewBox="0 0 100 120" class="body" data-view="${name}" role="img" aria-label="${name} of body">${FIGURE}${inj
      .map((m, i) => (m.view === name ? `<g class="mark" data-mark="${i}"><circle cx="${m.x}" cy="${m.y * 1.2}" r="3"/><text x="${m.x + 4}" y="${m.y * 1.2 + 1.5}">${i + 1}</text></g>` : ""))
      .join("")}</svg><figcaption>${name === "front" ? "Front" : "Back"}</figcaption></figure>`;
  return `<p class="muted">Choose a finding, then tap the figure where it is.</p><div class="seg" id="injType">${choice.injuryType.map((t, i) => `<button type="button" class="${i === 0 ? "on" : ""}" data-itype="${t}">${t}</button>`).join("")}</div><div class="bodies">${view("front")}${view("back")}</div>${
    inj.length
      ? `<table class="record"><tbody>${inj.map((m, i) => `<tr><th>${i + 1}. ${esc(m.type)} (${m.view})</th><td><input data-inote="${i}" placeholder="Details" value="${esc(m.note)}"></td><td><button data-iremove="${i}" aria-label="Remove marker">×</button></td></tr>`).join("")}</tbody></table>`
      : ""
  }`;
}

function reviewPanel() {
  const c = checks();
  const levels = [
    ["mandatory", "Required"],
    ["format", "Invalid values"],
    ["warning", "Warnings (don't block finalising)"],
  ];
  const blocking = blockingItems().length;
  return (
    `<div class="review-head"><b>${Math.round(completion())}% complete</b>${blocking ? `<span class="blocked">${blocking} item${blocking > 1 ? "s" : ""} to complete before finalising</span>` : `<span class="okmsg">Ready to finalise</span>`}</div>` +
    levels
      .map(([lvl, title]) => {
        // Outstanding items first; completed ones fold away.
        const items = c.filter((x) => x.level === lvl && !x.ok);
        const done = c.filter((x) => x.level === lvl && x.ok);
        const doneHtml = done.length
          ? `<details class="done-items"><summary>${done.length} complete</summary>${done.map((x) => `<div class="review-row ok"><b>${esc(x.label)}</b><span>Complete</span></div>`).join("")}</details>`
          : "";
        if (!items.length) return lvl === "mandatory" ? `<h4>${title}</h4><p class="okmsg">All required items complete.</p>${doneHtml}` : "";
        return `<h4>${title}</h4>${items
          .map(
            (x) =>
              `<div class="review-row ${x.ok ? "ok" : lvl}"><b>${esc(x.label)}</b><span>${esc(x.status)}</span>${!x.ok && FIELD_LOC[x.key] ? `<button type="button" class="small" data-goto="${esc(x.key)}">Go to</button>` : ""}</div>`,
          )
          .join("")}${doneHtml}`;
      })
      .join("") +
    `<p class="finalise-row"><button id="openFinalise" class="success" ${blocking ? "disabled" : ""}>Finalise PRF…</button></p>`
  );
}

function sigBox(who, title, sub) {
  const g = (s.signatures || {})[who];
  return `<div class="sigbox"><h4>${title}</h4><p class="muted">${sub}</p>${
    g
      ? `<img src="${esc(g.data)}" alt="${title}"><p><small>${esc(g.name)}${g.role ? " · " + esc(g.role) : ""} · ${esc(fmt(g.at))}</small></p><button type="button" data-sigclear="${who}">Clear signature</button>`
      : `<canvas class="sigpad" data-sig="${who}" width="600" height="180"></canvas><div class="sig-actions"><input data-signame="${who}" placeholder="Name" value="${who === "clinician" ? esc(MY_NAME) : esc([s.first, s.last].filter(Boolean).join(" "))}">${who === "patient" ? `<select data-sigrole="patient"><option>Patient</option><option>Parent / guardian</option><option>Carer</option><option>Witness</option></select>` : ""}<button type="button" data-sigsave="${who}" class="primary">Save signature</button><button type="button" data-sigwipe="${who}">Clear</button></div>`
  }</div>`;
}
function signaturesPanel() {
  const refused = PRFRules.refused(s);
  return (
    sigBox("clinician", "Clinician", "Confirms you completed this record.") +
    sigBox(
      "patient",
      refused ? "Patient refusal of care" : "Patient / carer (optional)",
      refused ? "The patient confirms the risks were explained and they decline treatment or transport." : "For example, to acknowledge treatment or discharge advice.",
    ) +
    (refused ? `<div class="grid">${field(["unableToSign", "If the patient couldn't or wouldn't sign, why", "area", { cls: "full" }])}</div>` : "")
  );
}

function render() {
  const t = TABS[tab],
    sb = t.subs[sub[tab]];
  q("#title").textContent = t.name;
  q("#help").textContent = t.help;
  q("#subtabs").innerHTML = t.subs.map((x, i) => `<button class="${i === sub[tab] ? "on" : ""}" data-sub="${i}">${esc(x.name)}</button>`).join("");
  q("#panel").innerHTML =
    `<div class="form-section"><div class="section-title">${esc(sb.name)}</div><div class="section-body">${sb.fields ? grid(sb.fields) : ""}${sb.render ? sb.render() : ""}</div></div>`;
  bind();
  refreshChrome();
  if (sb.name === "Signatures") initSigPads();
}
function refreshChrome() {
  // Update the tab bar in place: rebuilding it on every keystroke would swallow
  // a tap that lands while an input is blurring.
  const bar = q("#tabbar");
  if (!bar.children.length) {
    bar.innerHTML = TABS.map((t, i) => `<button data-tab="${i}">${esc(t.name)}<i class="gap" hidden></i></button>`).join("");
    qa("[data-tab]").forEach((b) => (b.onclick = () => go(+b.dataset.tab)));
  }
  const gaps = blockingItems();
  [...bar.children].forEach((b, i) => {
    const n = gaps.filter((c) => FIELD_LOC[c.key] && FIELD_LOC[c.key][0] === i).length;
    b.classList.toggle("on", i === tab);
    const g = b.querySelector(".gap");
    g.hidden = !n;
    g.textContent = n || "";
  });
  q("#pcr").textContent = rec ? rec.pcr : "";
  q("#patient").textContent = [v("first"), v("last")].filter(Boolean).join(" ") || "Unknown patient";
  q("#patientMeta").textContent = [ageText(), v("sex"), v("patientNo") && v("patientOf") ? `Patient ${v("patientNo")} of ${v("patientOf")}` : ""].filter(Boolean).join(" · ");
  q("#jobref").textContent = rec && rec.job_reference ? rec.job_reference : "No linked job";
  q("#complete").textContent = Math.round(completion()) + "%";
  qa("[data-after]").forEach((el) => {
    const f = TABS.flatMap((t) => t.subs.flatMap((x) => x.fields || [])).find(([k]) => k === el.dataset.after);
    if (f) el.textContent = f[3].after();
  });
}
function go(t, si) {
  tab = Math.max(0, Math.min(TABS.length - 1, t));
  if (si != null) sub[tab] = si;
  render();
  scrollTo(0, 0);
}
function goTo(key) {
  const loc = FIELD_LOC[key];
  if (!loc) return;
  go(loc[0], loc[1]);
  const el = q(`#f-${key}`) || q(`[data-key="${key}"]`);
  if (el) {
    el.focus();
    el.closest(".field, .time-row")?.classList.add("flash");
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function bind() {
  qa("[data-sub]").forEach((b) => (b.onclick = () => go(tab, +b.dataset.sub)));
  qa("[data-key]").forEach(
    (x) =>
      (x.oninput = () => {
        if (x.readOnly) return;
        set(x.dataset.key, x.value);
        const h = q(`[data-hint="${x.dataset.key}"]`);
        if (h) h.textContent = PRFRules.formatHint(s, x.dataset.key);
        if (PRFRules.TIME_ORDER.some(([k]) => k === x.dataset.key)) markTimes();
      }),
  );
  qa("[data-now]").forEach(
    (b) =>
      (b.onclick = () => {
        const k = b.dataset.now;
        set(k, nowLocal());
        q(`#f-${k}`).value = s[k];
        markTimes();
      }),
  );
  qa("[data-pick], [data-open-pick]").forEach((x) => (x.onclick = () => openPick(x.dataset.pick || x.dataset.openPick)));
  qa("[data-multi]").forEach(
    (b) =>
      (b.onclick = () => {
        const k = b.dataset.multi,
          val = b.dataset.val;
        let a = (s[k] || []).slice();
        const exclusive = ["None", "No known allergies", "Unknown", "Refused to say", "Nothing of note"];
        if (a.includes(val)) a = a.filter((x) => x !== val);
        else a = exclusive.includes(val) ? [val] : a.filter((x) => !exclusive.includes(x)).concat(val);
        set(k, a);
        render();
      }),
  );
  qa("[data-sym]").forEach(
    (b) =>
      (b.onclick = () => {
        const st = { ...(s.symptoms || {}) },
          k = b.dataset.sym;
        st[k] = st[k] === "yes" ? "no" : st[k] === "no" ? undefined : "yes";
        if (!st[k]) delete st[k];
        set("symptoms", st);
        render();
      }),
  );
  // Vitals
  qa("[data-vital]").forEach(
    (x) =>
      (x.oninput = x.onchange =
        () => {
          const i = +x.dataset.vital,
            r = s.vitals[i];
          r[x.dataset.vkey] = x.value;
          scheduleSave();
          const cellEl = q("#news-" + i);
          cellEl.textContent = newsText(r);
          cellEl.className = newsClass(r);
          refreshChrome();
        }),
  );
  qa("[data-remove]").forEach(
    (x) =>
      (x.onclick = () => {
        s.vitals.splice(+x.dataset.remove, 1);
        scheduleSave();
        render();
      }),
  );
  if (q("#addVital"))
    q("#addVital").onclick = () => {
      s.vitals = s.vitals || [];
      s.vitals.push({ time: hhmm(), doneBy: MY_NAME });
      scheduleSave();
      render();
    };
  // Examination
  qa("[data-exam]").forEach(
    (b) =>
      (b.onclick = () => {
        const ex = { ...(s.exam || {}) },
          k = b.dataset.exam;
        ex[k] = { ...(ex[k] || {}), status: ex[k] && ex[k].status === b.dataset.status ? undefined : b.dataset.status };
        set("exam", ex);
        render();
      }),
  );
  qa("[data-examnote]").forEach(
    (x) =>
      (x.oninput = () => {
        const ex = { ...(s.exam || {}) },
          k = x.dataset.examnote;
        ex[k] = { ...(ex[k] || {}), note: x.value };
        set("exam", ex);
      }),
  );
  // Treatment log
  qa("[data-txadd]").forEach(
    (b) =>
      (b.onclick = () => {
        s.txLog = s.txLog || [];
        s.txLog.push({ time: hhmm(), kind: b.dataset.txadd, doneBy: MY_NAME });
        scheduleSave();
        render();
      }),
  );
  qa("[data-tx]").forEach(
    (x) =>
      (x.oninput = x.onchange =
        () => {
          s.txLog[+x.dataset.tx][x.dataset.tkey] = x.value;
          scheduleSave();
          refreshChrome();
        }),
  );
  qa("[data-txremove]").forEach(
    (b) =>
      (b.onclick = () => {
        s.txLog.splice(+b.dataset.txremove, 1);
        scheduleSave();
        render();
      }),
  );
  // Body diagram
  qa("[data-itype]").forEach(
    (b) =>
      (b.onclick = () => {
        qa("[data-itype]").forEach((x) => x.classList.toggle("on", x === b));
      }),
  );
  qa("svg.body").forEach(
    (svg) =>
      (svg.onclick = (e) => {
        if (e.target.closest(".mark")) return;
        const r = svg.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 100,
          y = ((e.clientY - r.top) / r.height) * 100;
        const type = (q("[data-itype].on") || {}).dataset?.itype || "Other";
        s.injuries = (s.injuries || []).concat({ view: svg.dataset.view, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, type });
        scheduleSave();
        render();
        q(`[data-itype="${type}"]`)?.click();
      }),
  );
  qa("[data-inote]").forEach(
    (x) =>
      (x.oninput = () => {
        s.injuries[+x.dataset.inote].note = x.value;
        scheduleSave();
      }),
  );
  qa("[data-iremove]").forEach(
    (b) =>
      (b.onclick = () => {
        s.injuries.splice(+b.dataset.iremove, 1);
        scheduleSave();
        render();
      }),
  );
  // Review
  qa("[data-goto]").forEach((b) => (b.onclick = () => goTo(b.dataset.goto)));
  if (q("#openFinalise")) q("#openFinalise").onclick = openFinalise;
  if (q("#cadPull")) q("#cadPull").onclick = pullFromCad;
  // Signatures
  qa("[data-sigclear]").forEach(
    (b) =>
      (b.onclick = () => {
        const g = { ...(s.signatures || {}) };
        delete g[b.dataset.sigclear];
        set("signatures", g);
        render();
      }),
  );
}
function markTimes() {
  const issues = PRFRules.timeIssues(s);
  qa(".time-row, .field").forEach((row) => {
    const inp = row.querySelector("[data-key]");
    if (inp) row.classList.toggle("bad-time", issues.has(inp.dataset.key));
  });
}

/* ---- Signature pads ---- */
function initSigPads() {
  qa("canvas.sigpad").forEach((c) => {
    const ctx = c.getContext("2d");
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111";
    let drawing = false,
      inked = false;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height];
    };
    c.onpointerdown = (e) => {
      drawing = true;
      c.setPointerCapture(e.pointerId);
      ctx.beginPath();
      ctx.moveTo(...pos(e));
    };
    c.onpointermove = (e) => {
      if (!drawing) return;
      ctx.lineTo(...pos(e));
      ctx.stroke();
      inked = true;
    };
    c.onpointerup = () => (drawing = false);
    const who = c.dataset.sig;
    q(`[data-sigwipe="${who}"]`).onclick = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      inked = false;
    };
    q(`[data-sigsave="${who}"]`).onclick = () => {
      if (!inked) return toast("Sign in the box first");
      const g = { ...(s.signatures || {}) };
      g[who] = {
        data: c.toDataURL("image/png"),
        name: q(`[data-signame="${who}"]`).value.trim(),
        role: who === "patient" ? q('[data-sigrole="patient"]').value : me.role === "FIELD_USER" ? "Clinician" : me.role,
        at: new Date().toISOString(),
      };
      set("signatures", g);
      render();
      toast("Signature saved");
    };
  });
}

/* ---- Pick list dialog ---- */
function openPick(key) {
  pickKey = key;
  q("#pickTitle").textContent = "Select " + (LABEL[key] || key);
  const a = choice[key] || ["Normal", "Abnormal", "Unknown"];
  draw(a);
  q("#search").value = "";
  q("#search").oninput = () => draw(a.filter((x) => x.toLowerCase().includes(q("#search").value.toLowerCase())));
  q("#picker").showModal();
}
function draw(a) {
  q("#items").innerHTML = (v(pickKey) ? [`<button class="clear">Clear</button>`] : []).concat(a.map((x) => `<button class="${x === v(pickKey) ? "on" : ""}">${esc(x)}</button>`)).join("");
  qa("#items button").forEach(
    (x) =>
      (x.onclick = () => {
        set(pickKey, x.classList.contains("clear") ? "" : x.textContent);
        q("#picker").close();
        render();
      }),
  );
}

/* ---- CCCS job updates ---- */
async function pullFromCad() {
  try {
    const { facts } = await api("GET", `/api/prfs/${encodeURIComponent(rec.pcr)}/cad`);
    const changed = Object.entries(facts).filter(([k, x]) => x && String(s[k] || "") !== String(x));
    if (!changed.length) {
      q("#cadNote").textContent = "Already up to date with the job.";
      return;
    }
    changed.forEach(([k, x]) => (s[k] = x));
    scheduleSave();
    render();
    q("#cadNote").textContent = `Updated ${changed.map(([k]) => LABEL[k] || (PRFRules.TIME_ORDER.find(([t]) => t === k) || [])[1] || k).join(", ")}.`;
  } catch (e) {
    toast(e.message);
  }
}
async function checkCad() {
  if (!rec || !rec.job_id) return (q("#cadState").textContent = "");
  try {
    const { facts } = await api("GET", `/api/prfs/${encodeURIComponent(rec.pcr)}/cad`);
    const n = Object.entries(facts).filter(([k, x]) => x && String(s[k] || "") !== String(x)).length;
    q("#cadState").textContent = n ? `CCCS: ${n} update${n > 1 ? "s" : ""}` : "CCCS ✓";
    q("#cadState").className = n ? "cad pending" : "cad";
  } catch {
    /* offline: leave as is */
  }
}
q("#cadState").onclick = () => go(0, 4);

function toast(t) {
  q("#toast").textContent = t;
  q("#toast").classList.add("show");
  setTimeout(() => q("#toast").classList.remove("show"), 2500);
}

/* ------------------------------------------------------------------ *
 * Screens
 * ------------------------------------------------------------------ */
function show(screen) {
  q("#home").hidden = screen !== "home";
  q("#editor").hidden = screen !== "editor";
  document.body.classList.toggle("editing", screen === "editor");
}
let cadTimer = null;
async function openPrf(pcr) {
  const r = await api("GET", `/api/prfs/${encodeURIComponent(pcr)}`);
  if (r.status === "FINAL") return showRecord(r);
  rec = r;
  s = r.data || {};
  tab = 0;
  sub = TABS.map(() => 0);
  dirty = false;
  setStatus("Saved to CCCS", "");
  show("editor");
  render();
  checkCad();
  clearInterval(cadTimer);
  cadTimer = setInterval(checkCad, 60000);
}
async function newPrf(jobId) {
  const r = await api("POST", "/api/prfs", jobId ? { job_id: jobId } : {});
  await openPrf(r.pcr);
  toast(`${r.pcr} started`);
}
async function backHome() {
  if (!(await saveNow()) && dirty) {
    toast("Can't reach CCCS — this draft isn't saved yet. Stay here until it is.");
    return;
  }
  clearInterval(cadTimer);
  rec = null;
  s = {};
  show("home");
  loadHome();
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString("en-GB") : "");
function rowHtml(r) {
  return `<button class="record-item" data-open="${esc(r.pcr)}"><b>${esc(r.pcr)} <span class="badge ${r.status === "FINAL" ? "final" : "draft"}">${r.status === "FINAL" ? "Finalised" : "Draft"}</span></b><span>${esc(r.patient || "Unknown patient")} · ${esc(r.chief || "No complaint yet")}${r.job_reference ? " · " + esc(r.job_reference) : ""}</span><small>${esc(r.author_name)} · updated ${esc(fmt(r.updated_at))}${r.addenda ? ` · ${r.addenda} addend${r.addenda > 1 ? "a" : "um"}` : ""}</small></button>`;
}
if (me.role !== "FIELD_USER") {
  q(".hbtn").href = "/admin.html";
  q(".hbtn").textContent = "Admin console";
}
async function loadHome() {
  q("#who").textContent = `${MY_NAME} (${me.role.replace("_", " ").toLowerCase()})`;
  q("#scopeWrap").hidden = !READS_ALL;
  const scope = READS_ALL && q("#scope").checked ? "&scope=all" : "";
  try {
    const [drafts, finals, jobs] = await Promise.all([api("GET", "/api/prfs?status=DRAFT"), api("GET", "/api/prfs?status=FINAL" + scope), api("GET", "/api/prfs/jobs")]);
    q("#drafts").innerHTML = drafts.length ? drafts.map(rowHtml).join("") : "<p class='muted'>No drafts.</p>";
    q("#finals").innerHTML = finals.length ? finals.map(rowHtml).join("") : "<p class='muted'>No finalised PRFs yet.</p>";
    q("#jobSelect").innerHTML =
      `<option value="">No linked job</option>` + jobs.map((j) => `<option value="${j.id}">${esc(j.reference)} · ${esc(j.incident_type || "")} · ${esc(j.location || "")}</option>`).join("");
    qa("[data-open]").forEach((x) => (x.onclick = () => openPrf(x.dataset.open).catch((e) => toast(e.message))));
  } catch (e) {
    q("#drafts").innerHTML = `<p class="blocked">${esc(e.message)}</p>`;
  }
}

/* ---- Finalise ---- */
function openFinalise() {
  const gaps = blockingItems();
  if (gaps.length) return toast("Complete the required items first");
  const warns = checks().filter((c) => c.level === "warning");
  q("#reviewBody").innerHTML =
    (warns.length ? `<p><b>Warnings you can still address:</b></p><ul>${warns.map((w) => `<li>${esc(w.label)}: ${esc(w.status)}</li>`).join("")}</ul>` : `<p>No outstanding warnings.</p>`) +
    `<p>Once finalised this PRF is locked. Corrections are made as signed addenda.</p>`;
  q("#attest").checked = false;
  q("#review").showModal();
}
async function finalise() {
  if (blockingItems().length) return toast("Complete the required items first");
  if (!q("#attest").checked) return toast("Confirm the record is accurate first");
  q("#submit").disabled = true;
  try {
    if (!(await saveNow()) && dirty) throw new Error("Couldn't save the latest changes — try again when connected");
    const r = await api("POST", `/api/prfs/${encodeURIComponent(rec.pcr)}/finalise`, { attest: true });
    q("#review").close();
    clearInterval(cadTimer);
    rec = null;
    s = {};
    show("home");
    loadHome();
    showRecord(r);
    toast(`${r.pcr} finalised`);
  } catch (e) {
    toast(e.message);
  } finally {
    q("#submit").disabled = false;
  }
}

/* ---- Transfer ---- */
async function openTransfer() {
  try {
    const people = await api("GET", "/api/prfs/colleagues");
    q("#transferTo").innerHTML = people.map((p) => `<option value="${p.id}">${esc(p.name)} (${esc(p.role.replace("_", " ").toLowerCase())})</option>`).join("");
    q("#transferDialog").showModal();
  } catch (e) {
    toast(e.message);
  }
}
async function doTransfer() {
  try {
    if (!(await saveNow()) && dirty) throw new Error("Couldn't save the latest changes first");
    const r = await api("POST", `/api/prfs/${encodeURIComponent(rec.pcr)}/transfer`, { user_id: Number(q("#transferTo").value) });
    q("#transferDialog").close();
    toast(`${r.pcr} handed to ${r.author_name}`);
    dirty = false;
    clearInterval(cadTimer);
    rec = null;
    show("home");
    loadHome();
  } catch (e) {
    toast(e.message);
  }
}

/* ------------------------------------------------------------------ *
 * Finalised record view (also the print preview)
 * ------------------------------------------------------------------ */
// UK date display for date / datetime-local values.
function readable(x) {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d:\d\d))?$/.exec(String(x));
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? " " + m[4] : ""}` : x;
}
let shown = null;
function recordHtml(r) {
  const d = r.data || {};
  const val = (k) => {
    const x = d[k];
    return Array.isArray(x) ? x.join(", ") : readable(x);
  };
  const sections = TABS.slice(0, 8)
    .map((t) => {
      const rows = t.subs
        .flatMap((x) => x.fields || [])
        .concat(t.name === "Incident" ? PRFRules.TIME_ORDER.map(([k, l]) => [k, l]) : [])
        .filter(([k]) => String(val(k) ?? "").trim())
        .map(([k, l]) => `<tr><th>${esc(l)}</th><td>${esc(val(k))}</td></tr>`)
        .join("");
      return rows ? `<h3>${esc(t.name)}</h3><table class="record">${rows}</table>` : "";
    })
    .join("");
  const sym = Object.entries(d.symptoms || {});
  const symHtml = sym.length
    ? `<h3>Symptoms</h3><p>${
        sym
          .filter(([, x]) => x === "yes")
          .map(([k]) => esc(k))
          .join(", ") || "None recorded"
      }${
        sym.some(([, x]) => x === "no")
          ? `<br><small>Denies: ${sym
              .filter(([, x]) => x === "no")
              .map(([k]) => esc(k))
              .join(", ")}</small>`
          : ""
      }</p>`
    : "";
  const vit = (d.vitals || []).filter((x) => Object.values(x).some(Boolean));
  const vitHtml = vit.length
    ? `<h3>Vital signs</h3><table class="vitals"><thead><tr><th>Time</th><th>HR</th><th>RR</th><th>BP</th><th>SpO₂</th><th>Air/O₂</th><th>ACVPU</th><th>GCS</th><th>Temp °C</th><th>NEWS2</th><th>By</th></tr></thead><tbody>${vit
        .map(
          (x) =>
            `<tr><td>${esc(x.time)}</td><td>${esc(x.hr)}</td><td>${esc(x.rr)}</td><td>${esc(x.sys)}${x.sys || x.dia ? "/" : ""}${esc(x.dia)}</td><td>${esc(x.spo2)}</td><td>${esc(x.o2)}</td><td>${esc(x.acvpu)}</td><td>${esc(x.gcs)}</td><td>${esc(x.temp)}</td><td>${esc(newsText(x))}</td><td>${esc(x.doneBy)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : "";
  const ex = Object.entries(d.exam || {});
  const exHtml = ex.length
    ? `<h3>Examination</h3><table class="record">${ex.map(([k, e]) => `<tr><th>${esc(k)}</th><td>${esc([e.status, e.note].filter(Boolean).join(" — "))}</td></tr>`).join("")}</table>`
    : "";
  const tx = d.txLog || [];
  const txHtml = tx.length
    ? `<h3>Treatment log</h3><table class="vitals"><thead><tr><th>Time</th><th>Type</th><th>What</th><th>Dose / route · Success</th><th>Response</th><th>By</th><th>Notes</th></tr></thead><tbody>${tx
        .map(
          (x) =>
            `<tr><td>${esc(x.time)}</td><td>${esc(x.kind)}</td><td>${esc(x.name)}</td><td>${esc([x.dose, x.route, x.success].filter(Boolean).join(" "))}</td><td>${esc(x.response)}</td><td>${esc(x.doneBy)}</td><td>${esc(x.complications)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : "";
  const inj = d.injuries || [];
  const injHtml = inj.length ? `<h3>Body diagram</h3><ol>${inj.map((m) => `<li>${esc(m.type)} (${esc(m.view)})${m.note ? " — " + esc(m.note) : ""}</li>`).join("")}</ol>` : "";
  const sigs = d.signatures || {};
  const sigHtml = ["clinician", "patient"]
    .filter((w) => sigs[w])
    .map(
      (w) =>
        `<div class="sigshow"><img src="${esc(sigs[w].data)}" alt="${w} signature"><small>${esc(sigs[w].name)}${sigs[w].role ? " · " + esc(sigs[w].role) : ""} · ${esc(fmt(sigs[w].at))}</small></div>`,
    )
    .join("");
  const unable = d.unableToSign ? `<p><b>Patient did not sign:</b> ${esc(d.unableToSign)}</p>` : "";
  const add = (r.addenda || []).length ? `<h3>Addenda</h3>${r.addenda.map((a) => `<div class="addendum"><small>${esc(fmt(a.at))} · ${esc(a.by)}</small><p>${esc(a.text)}</p></div>`).join("")}` : "";
  const head =
    r.status === "FINAL"
      ? `<p class="meta">Finalised ${esc(fmt(r.finalised_at))} by ${esc(r.finalised_by)}${r.job_reference ? " · " + esc(r.job_reference) : ""}<br><small>Content hash ${esc((r.content_hash || "").slice(0, 16))}…</small></p>`
      : `<p class="meta">DRAFT — not finalised${r.job_reference ? " · " + esc(r.job_reference) : ""}</p>`;
  return `<h2>${esc(r.pcr)}</h2>${head}${sections}${symHtml}${exHtml}${vitHtml}${txHtml}${injHtml}${sigHtml ? `<h3>Signatures</h3>${sigHtml}` : ""}${unable}${add}`;
}
function showRecord(r) {
  shown = r;
  q("#recordBody").innerHTML = recordHtml(r);
  q("#addendumText").value = "";
  q("#auditBtn").hidden = !READS_ALL;
  q("#record").showModal();
}
async function addAddendum() {
  const text = q("#addendumText").value.trim();
  if (!text) return toast("Write the addendum first");
  try {
    const r = await api("POST", `/api/prfs/${encodeURIComponent(shown.pcr)}/addenda`, { text });
    showRecord(r);
    loadHome();
    toast("Addendum added");
  } catch (e) {
    toast(e.message);
  }
}
async function printRecord() {
  try {
    await api("POST", `/api/prfs/${encodeURIComponent(shown.pcr)}/printed`);
  } catch {
    /* printing still works; the audit row is best-effort */
  }
  window.print();
}
async function showAudit() {
  const rows = await api("GET", `/api/prf-audit?pcr=${encodeURIComponent(shown.pcr)}`);
  // Readable detail: changed field names as a list, hashes shortened.
  const detail = (d) => {
    if (!d) return "";
    if (d.fields) return "Fields changed: " + d.fields.join(", ");
    return Object.entries(d)
      .map(([k, x]) => `${k.replace(/_/g, " ")}: ${typeof x === "string" && /^[0-9a-f]{64}$/.test(x) ? x.slice(0, 12) + "…" : x}`)
      .join(" · ");
  };
  q("#auditBody").innerHTML = `<table class="record audit"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows
    .map((a) => `<tr><td>${esc(fmt(a.at))}</td><td>${esc(a.username)}</td><td>${esc(a.action)}</td><td><small>${esc(detail(a.detail))}</small></td></tr>`)
    .join("")}</tbody></table>`;
  q("#audit").showModal();
}
async function verifyAudit() {
  try {
    const v2 = await api("GET", "/api/prf-audit/verify");
    toast(v2.ok ? `Audit trail intact: ${v2.rows} rows, head ${v2.head.slice(0, 12)}…` : `Audit trail BROKEN at row ${v2.broken_at}: ${v2.reason}`);
  } catch (e) {
    toast(e.message);
  }
}

/* ---- Buttons ---- */
q("#save").onclick = async () => {
  dirty = true;
  if (await saveNow()) toast("Draft saved to CCCS");
};
q("#reviewBtn").onclick = () => go(8, 0);
q("#submit").onclick = finalise;
q("#home-btn").onclick = backHome;
q("#transferBtn").onclick = openTransfer;
q("#transferYes").onclick = doTransfer;
q("#discard").onclick = () => rec && q("#discardDialog").showModal();
q("#discardYes").onclick = async () => {
  try {
    await api("DELETE", `/api/prfs/${encodeURIComponent(rec.pcr)}`);
    dirty = false;
    q("#discardDialog").close();
    toast(`${rec.pcr} discarded`);
    clearInterval(cadTimer);
    rec = null;
    show("home");
    loadHome();
  } catch (e) {
    toast(e.message);
  }
};
q("#newPrf").onclick = () => newPrf(q("#jobSelect").value).catch((e) => toast(e.message));
q("#scope").onchange = loadHome;
q("#auditVerify").onclick = verifyAudit;
q("#addAddendum").onclick = addAddendum;
q("#printRecord").onclick = printRecord;
q("#auditBtn").onclick = () => showAudit().catch((e) => toast(e.message));
q("#signOut").onclick = async () => {
  await saveNow();
  clearSession();
  location.href = "/index.html";
};
qa("[data-close]").forEach((b) => (b.onclick = () => q("#" + b.dataset.close).close()));

show("home");
loadHome();
