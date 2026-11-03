/* CCCS patient report form (PRF).
 * Form layout and clinical pick lists come from the ResponseChart prototype;
 * storage, finalising and the audit trail are CCCS's (see /prf.js on the server).
 * Needs /app.js (CCCS client), uk.js and rules.js loaded first. */
"use strict";
if (!CCCS.requireAuth(["FIELD_USER", "SUPERVISOR", "SYSTEM_ADMIN"]))
  throw new Error("auth");

const steps = [
  ["Incident", "Document dispatch and incident details."],
  ["Patient ID", "Record identity and demographics."],
  ["Primary", "Document the primary survey and complaint."],
  ["History", "Capture history, medications and allergies."],
  ["Vital Signs", "Enter serial clinical observations."],
  ["Assess / Tx", "Record assessments and treatment."],
  ["Outcomes", "Document transport and destination."],
  ["Care Plan", "Complete the clinical narrative."],
  ["Review", "Review required items and finalise."],
];
const choice = {
  "Call Type": [
    "Medical",
    "Trauma",
    "Inter-hospital Transfer",
    "Event Medical / First Aid",
    "Standby",
    "Public Assist",
    "Other",
  ],
  "MPDS Determinant": [
    "01 - Abdominal Pain",
    "06 - Breathing Problems",
    "10 - Chest Pain",
    "17 - Falls",
    "23 - Overdose / Poisoning",
    "29 - Traffic Incident",
    "32 - Unknown Problem",
  ],
  Sex: ["Female", "Male", "Intersex", "Unknown"],
  "Chief Complaint": [
    "Abdominal pain",
    "Altered consciousness",
    "Breathing difficulty",
    "Chest pain",
    "Fall",
    "Fever",
    "Injury",
    "Seizure",
    "Weakness",
  ],
  Airway: ["Patent", "Obstructed", "Maintained with adjunct", "Intubated"],
  Breathing: ["Normal", "Laboured", "Apnoeic", "Assisted ventilation"],
  Circulation: [
    "Pulse present",
    "Weak pulse",
    "No pulse",
    "Catastrophic haemorrhage",
  ],
  Allergies: [
    "No known allergies",
    "Penicillin",
    "Sulphonamides",
    "Latex",
    "Food allergy",
    "Other",
  ],
  Treatment: [
    "Oxygen",
    "IV / IO access",
    "Cardiac monitor",
    "12-lead ECG",
    "Medication administration",
    "Wound care",
    "Spinal motion restriction",
    "Reassessment",
  ],
  Priority: ["Routine", "Urgent", "Emergency", "Resuscitation"],
  "Consciousness (ACVPU)": [
    "Alert",
    "New confusion",
    "Responds to voice",
    "Responds to pain",
    "Unresponsive",
  ],
  "Mental Capacity": [
    "Has capacity",
    "Lacks capacity (best interests)",
    "Not assessed",
  ],
  Consent: [
    "Verbal consent",
    "Implied consent",
    "Treated in best interests",
    "Refused",
  ],
  "Safeguarding Concern": ["No", "Yes - adult", "Yes - child"],
  Disposition: [
    "Transported",
    "Treated and released",
    "Refused care",
    "Transferred care",
    "No patient found",
  ],
};
function esc(x) {
  return String(x || "").replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        m
      ],
  );
}
function field(label, key, type = "text", o = {}) {
  let c = "field " + (o.cls || ""),
    r = o.req ? "required" : "";
  if (type === "pick")
    return `<div class="${c}"><label class="${r}">${label}</label><div class="input-row"><input data-key="${key}" value="${esc(v(key))}" readonly><button type="button" data-pick="${label}" data-key="${key}">Pick List</button></div></div>`;
  if (type === "area")
    return `<div class="${c}"><label class="${r}">${label}</label><textarea data-key="${key}">${esc(v(key))}</textarea></div>`;
  const hint = o.hint
    ? `<small class="hint" data-hint="${key}">${esc(hintFor(key))}</small>`
    : "";
  return `<div class="${c}"><label class="${r}">${label}</label><input data-key="${key}" type="${type}" value="${esc(v(key))}">${hint}</div>`;
}
const sec = (t, b) =>
  `<div class="form-section"><div class="section-title">${t}</div>${b}</div>`;
function render() {
  let h = "";
  if (cur === 0)
    h =
      sec(
        "CAD Event",
        `<div class="grid">${field("Event Number", "event", "text", { req: 1 })}${field("Call Type", "callType", "pick", { req: 1 })}${field("MPDS Determinant", "mpds", "pick")}${field("Dispatch Time", "dispatch", "datetime-local", { req: 1 })}${field("Arrive Scene", "scene", "datetime-local")}${field("Patient Contact", "contact", "datetime-local")}</div>`,
      ) +
      sec(
        "Location",
        `<div class="grid">${field("Incident Address", "address", "text", { cls: "wide", req: 1 })}${field("Town / City", "municipality")}${field("Incident Postcode", "incidentPostcode", "text", { hint: 1 })}${field("Scene Notes", "sceneNotes", "area", { cls: "full" })}</div>`,
      );
  if (cur === 1)
    h = sec(
      "Patient Identification",
      `<div class="grid">${field("First Name", "first")}${field("Last Name", "last")}${field("Date of Birth", "dob", "date")}${field("NHS Number", "health", "text", { hint: 1 })}${field("Sex", "sex", "pick")}${field("Weight (kg)", "weight", "number")}${field("Home Address", "home", "text", { cls: "wide" })}${field("Postcode", "postal", "text", { hint: 1 })}</div>`,
    );
  if (cur === 2)
    h =
      sec(
        "Presenting Problem",
        `<div class="grid">${field("Chief Complaint", "chief", "pick", { req: 1 })}${field("Onset", "onset", "datetime-local")}${field("Priority", "priority", "pick")}${field("Patient Statement", "statement", "area", { cls: "full" })}</div>`,
      ) +
      sec(
        "Primary Survey",
        `<div class="grid">${field("Airway", "airway", "pick", { req: 1 })}${field("Breathing", "breathing", "pick", { req: 1 })}${field("Circulation", "circulation", "pick", { req: 1 })}${field("Consciousness (ACVPU)", "loc", "pick")}${field("Primary Impression", "impression", "text", { cls: "wide" })}</div>`,
      );
  if (cur === 3)
    h = sec(
      "Clinical History",
      `<div class="grid">${field("Signs / Symptoms", "symptoms", "area", { cls: "full" })}${field("Allergies", "allergies", "pick")}${field("Medications", "meds", "area", { cls: "wide" })}${field("Medical History", "history", "area", { cls: "full" })}${field("Last Oral Intake", "intake")}${field("Events Leading to Illness / Injury", "events", "area", { cls: "wide" })}</div>`,
    );
  if (cur === 4) h = sec("Vital Sign Sets", vitals());
  if (cur === 5)
    h =
      sec(
        "Assessment",
        `<div class="grid">${field("Focused Assessment", "assessment", "area", { cls: "full", req: 1 })}${field("Pain Score (0-10)", "pain", "number")}${field("Treatment", "treatment", "pick")}${field("Response to Treatment", "response", "text", { cls: "wide" })}</div>`,
      ) +
      sec(
        "Quick Treatments",
        `<div class="picks">${choice.Treatment.map((x) => `<button type="button" class="pick ${(s.treatments || []).includes(x) ? "selected" : ""}" data-multi="${x}">${x}</button>`).join("")}</div>`,
      );
  if (cur === 6)
    h =
      sec(
        "Transport Outcome",
        `<div class="grid">${field("Disposition", "disposition", "pick", { req: 1 })}${field("Destination", "destination", "text", { req: 1 })}${field("Transport Priority", "transportPriority", "pick")}${field("Depart Scene", "depart", "datetime-local")}${field("Arrive Destination", "arrive", "datetime-local")}${field("Transfer of Care", "transfer", "datetime-local")}${field("Receiving Clinician", "receiver")}${field("Unit Available", "available", "datetime-local")}</div>`,
      ) +
      sec(
        "Capacity & Consent",
        `<div class="grid">${field("Mental Capacity", "capacity", "pick", { req: 1 })}${field("Consent", "consent", "pick", { req: 1 })}${field("Refusal of Care: Risks Explained & Advice Given", "refusal", "area", { cls: "full", req: v("disposition") === "Refused care" || v("consent") === "Refused" })}</div>`,
      ) +
      sec(
        "Safeguarding",
        `<div class="grid">${field("Safeguarding Concern", "safeguarding", "pick", { req: 1 })}${field("Safeguarding Details & Referral", "safeguardingDetails", "area", { cls: "full", req: String(v("safeguarding")).startsWith("Yes") })}</div>`,
      );
  if (cur === 7)
    h = sec(
      "Clinical Narrative",
      `<div class="grid">${field("Care Plan / Narrative", "narrative", "area", { cls: "full", req: 1 })}${field("Ongoing Monitoring", "monitoring", "area", { cls: "full" })}${field("Handover Notes", "handover", "area", { cls: "full" })}</div>`,
    );
  if (cur === 8) h = sec("Record Review", reviewRows());
  q("#panel").innerHTML = h;
  bind();
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
];
function newsText(r) {
  const n = news2(r);
  return n.missing ? "—" : `${n.score} · ${n.risk}`;
}
function newsClass(r) {
  const n = news2(r);
  if (n.missing) return "news";
  return (
    "news " +
    (n.score >= 7
      ? "high"
      : n.score >= 5
        ? "med"
        : Object.values(n.parts).includes(3)
          ? "lowmed"
          : "low")
  );
}
function vitals() {
  let rows = s.vitals || [{}];
  const cell = (r, i, [k, , opts]) =>
    opts
      ? `<td><select data-vital="${i}" data-vkey="${k}">${opts.map((o) => `<option ${r[k] === o ? "selected" : ""}>${o}</option>`).join("")}</select></td>`
      : `<td><input data-vital="${i}" data-vkey="${k}" type="${k === "time" ? "time" : "number"}" ${k === "temp" ? 'step="0.1"' : ""} value="${esc(r[k])}"></td>`;
  return `<table class="vitals"><thead><tr>${VITAL_COLS.map(([, l]) => `<th>${l}</th>`).join("")}<th>NEWS2</th><th></th></tr></thead><tbody>${rows.map((r, i) => `<tr>${VITAL_COLS.map((c) => cell(r, i, c)).join("")}<td class="${newsClass(r)}" id="news-${i}">${newsText(r)}</td><td><button data-remove="${i}">×</button></td></tr>`).join("")}</tbody></table><p class="hint">NEWS2 uses SpO₂ scale 1 and appears once RR, SpO₂, Air/O₂, BP Sys, HR, ACVPU and Temp are all entered. C = new confusion.</p><p><button id="addVital">+ Add Vital Set</button></p>`;
}

/* ------------------------------------------------------------------ *
 * CCCS integration: records live on the server, never in the browser.
 * ------------------------------------------------------------------ */
const { api, getSession, clearSession } = CCCS;
const me = getSession().user;
const READS_ALL = ["SUPERVISOR", "SYSTEM_ADMIN"].includes(me.role);

let rec = null; // the open PRF: { pcr, version, status, ... }
let s = {}; // its data
let cur = 0,
  pickKey = "";
const q = (x) => document.querySelector(x),
  qa = (x) => [...document.querySelectorAll(x)],
  v = (k, d = "") => s[k] ?? d;

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
    const out = await api("PUT", `/api/prfs/${encodeURIComponent(rec.pcr)}`, {
      version: rec.version,
      data: s,
    });
    rec.version = out.version;
    setStatus("Saved to CCCS", "");
    return true;
  } catch (e) {
    dirty = true;
    if (/changed elsewhere/.test(e.message)) {
      setStatus("Changed elsewhere — reopen this PRF", "off");
      toast(
        "This PRF was changed in another window. Reopen it before editing.",
      );
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

const set = (k, x) => {
  s[k] = x;
  scheduleSave();
  summary();
};

/* ---- Rules shared with the server ---- */
const hintFor = (key) => PRFRules.formatHint(s, key);
const checks = () => PRFRules.checkRecord(s);
const missing = () => checks().filter((c) => !c.ok);
function completion() {
  const c = checks();
  return (c.filter((x) => x.ok).length / c.length) * 100;
}
function reviewRows() {
  return checks()
    .map(
      (c) =>
        `<div class="review-row"><b>${esc(c.label)}</b><span style="color:${c.ok ? "#287a4f" : "#b23c3c"}">${esc(c.status)}</span></div>`,
    )
    .join("");
}

/* ---- Editor wiring ---- */
function bind() {
  qa("[data-key]").forEach(
    (x) =>
      (x.oninput = () => {
        set(x.dataset.key, x.value);
        const h = q(`[data-hint="${x.dataset.key}"]`);
        if (h) h.textContent = hintFor(x.dataset.key);
      }),
  );
  qa("[data-pick]").forEach(
    (x) => (x.onclick = () => openPick(x.dataset.pick, x.dataset.key)),
  );
  qa("[data-multi]").forEach(
    (x) =>
      (x.onclick = () => {
        const a = s.treatments || [],
          z = x.dataset.multi;
        a.includes(z) ? a.splice(a.indexOf(z), 1) : a.push(z);
        s.treatments = a;
        scheduleSave();
        render();
      }),
  );
  qa("[data-vital]").forEach(
    (x) =>
      (x.oninput = x.onchange =
        () => {
          s.vitals = s.vitals || [{}];
          const i = +x.dataset.vital,
            r = s.vitals[i];
          r[x.dataset.vkey] = x.value;
          scheduleSave();
          const cellEl = q("#news-" + i);
          cellEl.textContent = newsText(r);
          cellEl.className = newsClass(r);
        }),
  );
  qa("[data-remove]").forEach(
    (x) =>
      (x.onclick = () => {
        s.vitals = s.vitals || [{}];
        s.vitals.splice(+x.dataset.remove, 1);
        scheduleSave();
        render();
      }),
  );
  if (q("#addVital"))
    q("#addVital").onclick = () => {
      s.vitals = s.vitals || [{}];
      s.vitals.push({});
      scheduleSave();
      render();
    };
}
function openPick(label, key) {
  pickKey = key;
  q("#pickTitle").textContent = "Select " + label;
  const a =
    choice[label] ||
    (label.includes("Priority")
      ? choice.Priority
      : ["Normal", "Abnormal", "Unknown"]);
  draw(a);
  q("#search").value = "";
  q("#search").oninput = () =>
    draw(
      a.filter((x) =>
        x.toLowerCase().includes(q("#search").value.toLowerCase()),
      ),
    );
  q("#picker").showModal();
}
function draw(a) {
  q("#items").innerHTML = a.map((x) => `<button>${esc(x)}</button>`).join("");
  qa("#items button").forEach(
    (x) =>
      (x.onclick = () => {
        set(pickKey, x.textContent);
        q("#picker").close();
        render();
      }),
  );
}
function nav() {
  q("#nav").innerHTML = steps
    .map(
      (x, i) =>
        `<button class="step ${i === cur ? "active" : ""} ${i < cur ? "done" : ""}" data-step="${i}"><span class="num">${i < cur ? "✓" : i + 1}</span>${x[0]}</button>`,
    )
    .join("");
  qa("[data-step]").forEach((x) => (x.onclick = () => go(+x.dataset.step)));
  q("#title").textContent = steps[cur][0];
  q("#help").textContent = steps[cur][1];
  q("#complete").textContent = Math.round(completion()) + "%";
  q("#prev").disabled = cur === 0;
  q("#next").textContent = cur === 8 ? "Open Final Review" : "Next →";
}
function go(i) {
  cur = Math.max(0, Math.min(8, i));
  nav();
  render();
  scrollTo(0, 0);
}
function summary() {
  q("#pcr").textContent = rec ? rec.pcr : "";
  q("#patient").textContent =
    [v("first"), v("last")].filter(Boolean).join(" ") || "Unknown patient";
  q("#jobref").textContent =
    rec && rec.job_reference ? rec.job_reference : "No linked job";
  nav();
}
function toast(t) {
  q("#toast").textContent = t;
  q("#toast").classList.add("show");
  setTimeout(() => q("#toast").classList.remove("show"), 2500);
}

/* ---- Screens ---- */
function show(screen) {
  q("#home").hidden = screen !== "home";
  q("#editor").hidden = screen !== "editor";
}
async function openPrf(pcr) {
  const r = await api("GET", `/api/prfs/${encodeURIComponent(pcr)}`);
  if (r.status === "FINAL") return showRecord(r);
  rec = r;
  s = r.data || {};
  cur = 0;
  dirty = false;
  setStatus("Saved to CCCS", "");
  show("editor");
  summary();
  render();
}
async function newPrf(jobId) {
  const r = await api("POST", "/api/prfs", jobId ? { job_id: jobId } : {});
  await openPrf(r.pcr);
  toast(`${r.pcr} started`);
}
async function backHome() {
  if (!(await saveNow()) && dirty) {
    toast(
      "Can't reach CCCS — this draft isn't saved yet. Stay here until it is.",
    );
    return;
  }
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
  q("#who").textContent =
    `${me.display_name || me.username} (${me.role.replace("_", " ").toLowerCase()})`;
  q("#scopeWrap").hidden = !READS_ALL;
  q("#auditVerify").hidden = !READS_ALL;
  const scope = READS_ALL && q("#scope").checked ? "&scope=all" : "";
  try {
    const [drafts, finals, jobs] = await Promise.all([
      api("GET", "/api/prfs?status=DRAFT"),
      api("GET", "/api/prfs?status=FINAL" + scope),
      api("GET", "/api/prfs/jobs"),
    ]);
    q("#drafts").innerHTML = drafts.length
      ? drafts.map(rowHtml).join("")
      : "<p class='muted'>No drafts.</p>";
    q("#finals").innerHTML = finals.length
      ? finals.map(rowHtml).join("")
      : "<p class='muted'>No finalised PRFs yet.</p>";
    q("#jobSelect").innerHTML =
      `<option value="">No linked job</option>` +
      jobs
        .map(
          (j) =>
            `<option value="${j.id}">${esc(j.reference)} · ${esc(j.incident_type || "")} · ${esc(j.location || "")}</option>`,
        )
        .join("");
    qa("[data-open]").forEach(
      (x) =>
        (x.onclick = () =>
          openPrf(x.dataset.open).catch((e) => toast(e.message))),
    );
  } catch (e) {
    q("#drafts").innerHTML = `<p class="blocked">${esc(e.message)}</p>`;
  }
}

/* ---- Review & finalise ---- */
function openReview() {
  const gaps = missing();
  q("#reviewBody").innerHTML =
    `<p><b>Completion:</b> ${Math.round(completion())}%</p>${reviewRows()}` +
    (gaps.length
      ? `<p class="blocked">${gaps.length} required item${gaps.length > 1 ? "s" : ""} still to complete before this PRF can be finalised.</p>`
      : "") +
    `<p>Once finalised this PRF is locked. Corrections are made as signed addenda.</p>`;
  q("#submit").disabled = gaps.length > 0;
  q("#attest").checked = false;
  q("#review").showModal();
}
async function finalise() {
  if (missing().length) return toast("Complete the required items first");
  if (!q("#attest").checked)
    return toast("Confirm the record is accurate first");
  q("#submit").disabled = true;
  try {
    if (!(await saveNow()) && dirty)
      throw new Error(
        "Couldn't save the latest changes — try again when connected",
      );
    const r = await api(
      "POST",
      `/api/prfs/${encodeURIComponent(rec.pcr)}/finalise`,
      { attest: true },
    );
    q("#review").close();
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

/* ---- Finalised record view ---- */
const LABELS = {
  event: "Event Number",
  callType: "Call Type",
  mpds: "MPDS Determinant",
  dispatch: "Dispatch Time",
  scene: "Arrive Scene",
  contact: "Patient Contact",
  address: "Incident Address",
  municipality: "Town / City",
  incidentPostcode: "Incident Postcode",
  sceneNotes: "Scene Notes",
  first: "First Name",
  last: "Last Name",
  dob: "Date of Birth",
  health: "NHS Number",
  sex: "Sex",
  weight: "Weight (kg)",
  home: "Home Address",
  postal: "Postcode",
  chief: "Chief Complaint",
  onset: "Onset",
  priority: "Priority",
  statement: "Patient Statement",
  airway: "Airway",
  breathing: "Breathing",
  circulation: "Circulation",
  loc: "Consciousness (ACVPU)",
  impression: "Primary Impression",
  symptoms: "Signs / Symptoms",
  allergies: "Allergies",
  meds: "Medications",
  history: "Medical History",
  intake: "Last Oral Intake",
  events: "Events Leading to Illness / Injury",
  assessment: "Focused Assessment",
  pain: "Pain Score (0-10)",
  treatment: "Treatment",
  response: "Response to Treatment",
  disposition: "Disposition",
  destination: "Destination",
  transportPriority: "Transport Priority",
  depart: "Depart Scene",
  arrive: "Arrive Destination",
  transfer: "Transfer of Care",
  receiver: "Receiving Clinician",
  available: "Unit Available",
  capacity: "Mental Capacity",
  consent: "Consent",
  refusal: "Refusal of Care Details",
  safeguarding: "Safeguarding Concern",
  safeguardingDetails: "Safeguarding Details & Referral",
  narrative: "Care Plan / Narrative",
  monitoring: "Ongoing Monitoring",
  handover: "Handover Notes",
};
let shown = null;
function recordHtml(r) {
  const d = r.data || {};
  const rows = Object.entries(LABELS)
    .filter(([k]) => String(d[k] ?? "").trim())
    .map(([k, l]) => `<tr><th>${l}</th><td>${esc(d[k])}</td></tr>`)
    .join("");
  const vit = (d.vitals || []).filter((x) => Object.values(x).some(Boolean));
  const vitHtml = vit.length
    ? `<h3>Vital signs</h3><table class="vitals"><thead><tr><th>Time</th><th>HR</th><th>RR</th><th>BP</th><th>SpO₂</th><th>Air/O₂</th><th>ACVPU</th><th>GCS</th><th>Temp °C</th><th>NEWS2</th></tr></thead><tbody>${vit
        .map(
          (x) =>
            `<tr><td>${esc(x.time)}</td><td>${esc(x.hr)}</td><td>${esc(x.rr)}</td><td>${esc(x.sys)}${x.sys || x.dia ? "/" : ""}${esc(x.dia)}</td><td>${esc(x.spo2)}</td><td>${esc(x.o2)}</td><td>${esc(x.acvpu)}</td><td>${esc(x.gcs)}</td><td>${esc(x.temp)}</td><td>${esc(newsText(x))}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : "";
  const tx = (d.treatments || []).length
    ? `<h3>Treatments</h3><p>${d.treatments.map(esc).join(", ")}</p>`
    : "";
  const add = (r.addenda || []).length
    ? `<h3>Addenda</h3>${r.addenda.map((a) => `<div class="addendum"><small>${esc(fmt(a.at))} · ${esc(a.by)}</small><p>${esc(a.text)}</p></div>`).join("")}`
    : "";
  return `<h2>${esc(r.pcr)}</h2><p class="meta">Finalised ${esc(fmt(r.finalised_at))} by ${esc(r.finalised_by)}${r.job_reference ? " · " + esc(r.job_reference) : ""}<br><small>Content hash ${esc((r.content_hash || "").slice(0, 16))}…</small></p><table class="record">${rows}</table>${vitHtml}${tx}${add}`;
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
    const r = await api(
      "POST",
      `/api/prfs/${encodeURIComponent(shown.pcr)}/addenda`,
      { text },
    );
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
  const rows = await api(
    "GET",
    `/api/prf-audit?pcr=${encodeURIComponent(shown.pcr)}`,
  );
  q("#auditBody").innerHTML =
    `<table class="record"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows
      .map(
        (a) =>
          `<tr><td>${esc(fmt(a.at))}</td><td>${esc(a.username)}</td><td>${esc(a.action)}</td><td><small>${esc(a.detail && a.detail.fields ? a.detail.fields.join(", ") : JSON.stringify(a.detail || {}))}</small></td></tr>`,
      )
      .join("")}</tbody></table>`;
  q("#audit").showModal();
}
async function verifyAudit() {
  try {
    const v = await api("GET", "/api/prf-audit/verify");
    toast(
      v.ok
        ? `Audit trail intact: ${v.rows} rows, head ${v.head.slice(0, 12)}…`
        : `Audit trail BROKEN at row ${v.broken_at}: ${v.reason}`,
    );
  } catch (e) {
    toast(e.message);
  }
}

/* ---- Buttons ---- */
q("#prev").onclick = () => go(cur - 1);
q("#next").onclick = () => (cur === 8 ? openReview() : go(cur + 1));
q("#save").onclick = async () => {
  dirty = true;
  if (await saveNow()) toast("Draft saved to CCCS");
};
q("#finalize").onclick = openReview;
q("#submit").onclick = finalise;
q("#home-btn").onclick = backHome;
q("#discard").onclick = async () => {
  if (!rec) return;
  q("#discardDialog").showModal();
};
q("#discardYes").onclick = async () => {
  try {
    await api("DELETE", `/api/prfs/${encodeURIComponent(rec.pcr)}`);
    dirty = false;
    q("#discardDialog").close();
    toast(`${rec.pcr} discarded`);
    rec = null;
    show("home");
    loadHome();
  } catch (e) {
    toast(e.message);
  }
};
q("#newPrf").onclick = () =>
  newPrf(q("#jobSelect").value).catch((e) => toast(e.message));
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
qa("[data-close]").forEach(
  (b) => (b.onclick = () => q("#" + b.dataset.close).close()),
);

show("home");
loadHome();
