// UK clinical helpers: NHS number check digit, postcode format and NEWS2.
// Pure functions with no DOM access, so they can be tested on their own.

// NHS number: 10 digits; digit 10 is a modulus-11 check digit over digits 1-9
// weighted 10..2. A result of 11 means a check digit of 0; 10 is never valid.
function validNhsNumber(raw) {
  const d = String(raw || "").replace(/\s/g, "");
  if (!/^\d{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += +d[i] * (10 - i);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === +d[9];
}

// UK postcode shape (format only, not a lookup), e.g. "SW1A 1AA", "m11ae".
function validPostcode(raw) {
  return /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i.test(String(raw || "").trim());
}

// NEWS2 (Royal College of Physicians, 2017), SpO2 scale 1.
// Each band is [upper bound inclusive, score]; the last band catches the rest.
const NEWS2_BANDS = {
  rr: [
    [8, 3],
    [11, 1],
    [20, 0],
    [24, 2],
    [Infinity, 3],
  ],
  spo2: [
    [91, 3],
    [93, 2],
    [95, 1],
    [Infinity, 0],
  ],
  sys: [
    [90, 3],
    [100, 2],
    [110, 1],
    [219, 0],
    [Infinity, 3],
  ],
  hr: [
    [40, 3],
    [50, 1],
    [90, 0],
    [110, 1],
    [130, 2],
    [Infinity, 3],
  ],
  temp: [
    [35.0, 3],
    [36.0, 1],
    [38.0, 0],
    [39.0, 1],
    [Infinity, 2],
  ],
};
function band(key, value) {
  return NEWS2_BANDS[key].find(([max]) => value <= max)[1];
}

// Returns { score, risk, parts } when every parameter is present,
// or { missing: [...] } listing what's still needed.
function news2(set) {
  const need = ["rr", "spo2", "o2", "sys", "hr", "acvpu", "temp"];
  const missing = need.filter((k) => String(set[k] ?? "").trim() === "");
  if (missing.length) return { missing };
  const parts = {
    rr: band("rr", +set.rr),
    spo2: band("spo2", +set.spo2),
    o2: set.o2 === "O₂" ? 2 : 0,
    sys: band("sys", +set.sys),
    hr: band("hr", +set.hr),
    acvpu: set.acvpu === "A" ? 0 : 3,
    temp: band("temp", +set.temp),
  };
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  const single3 = Object.values(parts).includes(3);
  const risk =
    score >= 7
      ? "High"
      : score >= 5
        ? "Medium"
        : single3
          ? "Low–medium (single parameter 3)"
          : "Low";
  return { score, risk, parts };
}

if (typeof module !== "undefined")
  module.exports = { validNhsNumber, validPostcode, news2 };
