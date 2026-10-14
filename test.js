/* =========================================================================
 * CoronaryCare AI — API integration test (no framework).
 * Calls /, /features, /metrics, /dataset/patient/0, /predict?explain=true
 * (patient.json) and asserts the response shapes the dashboard relies on,
 * using the SAME validators as app.js (contract.js).
 * ========================================================================= */
"use strict";

const rowsEl = document.getElementById("rows");
const apiEl = document.getElementById("api");
const summaryEl = document.getElementById("summary");
apiEl.value = localStorage.getItem("ccai_api") || apiEl.value;

let counter = 0;
const tally = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };

function row(name, status, detail = "") {
  counter++;
  tally[status]++;
  const tr = document.createElement("tr");
  const cells = [String(counter), name, status, detail];
  cells.forEach((text, i) => {
    const td = document.createElement("td");
    td.textContent = text;
    if (i === 2) td.className = `st ${status}`;
    if (i === 3) td.className = "detail";
    tr.appendChild(td);
  });
  rowsEl.appendChild(tr);
}

const base = () => apiEl.value.replace(/\/+$/, "");

async function call(path, opts = {}) {
  let res;
  try {
    res = await fetch(base() + path, opts);
  } catch (e) {
    const err = new Error("network error — API down, wrong URL, or CORS not enabled for " + location.origin);
    err.network = true;
    throw err;
  }
  let body = null;
  try { body = await res.json(); } catch (_) { /* not JSON */ }
  return { res, body };
}

/** Map a model-input value / payload value to the numeric encoding the backend uses. */
function encode(v) {
  if (typeof v === "number") return v;
  const s = String(v).trim().toLowerCase();
  const map = { y: 1, yes: 1, n: 0, no: 0, male: 1, female: 0, fmale: 0,
                mild: 1, moderate: 2, severe: 3, lbbb: 1, rbbb: 1 };
  return s in map ? map[s] : (Number.isFinite(Number(s)) ? Number(s) : null);
}
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

async function loadPayload() {
  try {
    const r = await fetch("patient.json");
    if (r.ok) return { payload: await r.json(), source: "patient.json" };
  } catch (_) {}
  // fall back to the offline-schema defaults
  const payload = {};
  for (const g of CCAI.FALLBACK_SCHEMA) for (const f of g.fields) {
    payload[f.name] = f.type === "bool" ? Number(CCAI.truthy(f.def)) : f.type === "yn" ? (CCAI.truthy(f.def) ? "Y" : "N") : f.def;
  }
  return { payload, source: "offline-schema defaults (patient.json not found)" };
}

async function run() {
  rowsEl.innerHTML = "";
  counter = 0;
  Object.keys(tally).forEach((k) => (tally[k] = 0));
  summaryEl.textContent = "Running…";

  /* 1. GET / ---------------------------------------------------------- */
  let reachable = true;
  try {
    const { res } = await call("/");
    row("GET /  → 200", res.ok ? "PASS" : "FAIL", `HTTP ${res.status}`);
    // A cross-origin fetch only resolves when CORS allows it, so reaching this
    // line from another origin proves access-control-allow-origin is present.
    const cross = new URL(base()).origin !== location.origin;
    row("CORS allows this page's origin", "PASS",
      cross ? `page ${location.origin} → API ${new URL(base()).origin}: request succeeded` : "same origin — CORS not needed");
  } catch (e) {
    reachable = false;
    row("GET /  → 200", "FAIL", e.message);
  }
  if (!reachable) { finish(); return; }

  /* 2. GET /features --------------------------------------------------- */
  try {
    const { res, body } = await call("/features");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const warnings = [];
    const groups = CCAI.normalizeFeaturesEndpoint(body, (...a) => warnings.push(a.join(" ")));
    if (!groups.length) {
      row("GET /features → recognised shape", "FAIL", "normalizeFeaturesEndpoint returned no groups (dashboard falls back to the offline schema)");
    } else {
      const n = groups.reduce((s, g) => s + g.fields.length, 0);
      row("GET /features → recognised shape", "PASS", `${groups.length} groups, ${n} fields`);
      const diffs = CCAI.diffSchemas(groups, CCAI.FALLBACK_SCHEMA);
      row("/features == FALLBACK_SCHEMA (groups, names, widget types)", diffs.length ? "FAIL" : "PASS",
        diffs.length ? diffs.slice(0, 12).join("\n") + (diffs.length > 12 ? `\n… +${diffs.length - 12} more` : "") : "identical");
      const badSelect = groups.flatMap((g) => g.fields).filter((f) => f.type === "select" && !(f.options && f.options.length));
      row("every select field has options", badSelect.length ? "FAIL" : "PASS", badSelect.map((f) => f.name).join(", "));
      if (warnings.length) row("/features encodings the UI could not use", "WARN", warnings.join("\n"));
    }
  } catch (e) {
    row("GET /features", "WARN", `${e.message} — dashboard uses the offline schema`);
  }

  /* 3. GET /metrics ---------------------------------------------------- */
  try {
    const { res, body } = await call("/metrics");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ok = CCAI.isPlainObject(body) && Object.keys(body).length > 0;
    row("GET /metrics → non-empty JSON object", ok ? "PASS" : "FAIL",
      ok ? "top-level keys: " + Object.keys(body).join(", ") : "unexpected shape");
  } catch (e) {
    row("GET /metrics", "FAIL", e.message);
  }

  /* 4. GET /dataset/patient/0 ------------------------------------------ */
  try {
    const { res, body } = await call("/dataset/patient/0");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const feats = body && (body.features || body);
    row("GET /dataset/patient/0 → features object", CCAI.isPlainObject(feats) ? "PASS" : "FAIL",
      CCAI.isPlainObject(feats) ? `${Object.keys(feats).length} features` : "no features object");
    const gt = body && body.ground_truth;
    if (!gt) {
      row("ground_truth present", "WARN", "no ground_truth — ✓/✗ chips will not render");
    } else {
      const known = ["CAD", "CATH", "LAD", "LCX", "RCA"];
      const oddKeys = Object.keys(gt).filter((k) => !known.includes(k.toUpperCase()));
      row("ground_truth keys ⊆ {CAD|Cath, LAD, LCX, RCA}", oddKeys.length ? "WARN" : "PASS",
        oddKeys.length ? "unexpected keys: " + oddKeys.join(", ") : Object.keys(gt).join(", "));
      const unknownVals = Object.entries(gt).filter(([, v]) => CCAI.labelPolarity(v) === null);
      row("ground_truth labels are in the known vocabulary", unknownVals.length ? "WARN" : "PASS",
        unknownVals.length ? unknownVals.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ") + " → neutral chips" : JSON.stringify(gt));
    }
  } catch (e) {
    row("GET /dataset/patient/0", "FAIL", e.message);
  }

  /* 5. POST /predict?explain=true -------------------------------------- */
  const { payload, source } = await loadPayload();
  try {
    const { res, body } = await call("/predict?explain=true", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = CCAI.formatDetail(body && "detail" in body ? body.detail : body);
      throw new Error(`HTTP ${res.status}${detail ? " — " + detail : ""}`);
    }
    row(`POST /predict?explain=true (payload: ${source})`, "PASS", `HTTP ${res.status}`);

    const v = CCAI.validatePredictResponse(body, { explain: true, strictExplain: true });
    const checks = [
      ["cad.cad_probability ∈ [0,1]", /^cad\.cad_probability/],
      ["cad.predicted_status is a string", /^cad\.predicted_status/],
      ["cad.risk_band ∈ {low, moderate|medium, high}", /^cad\.risk_band|^cad: missing/],
      ["vessels.LAD|LCX|RCA.stenosis_probability ∈ [0,1]", /^vessels(\.\w+\.stenosis_probability|: missing|\.\w+: missing)/],
      ["vessels.*.predicted_label present", /^vessels\.\w+\.predicted_label: expected/],
      ["explanation.CAD[] has {feature, contribution, direction, value}", /^explanation/],
    ];
    for (const [name, re] of checks) {
      const bad = v.errors.filter((e) => re.test(e));
      row(name, bad.length ? "FAIL" : "PASS", bad.join("\n"));
    }
    if (v.warnings.length) row("contract warnings", "WARN", v.warnings.join("\n"));
    const leftover = v.errors.filter((e) => !checks.some(([, re]) => re.test(e)));
    if (leftover.length) row("other contract errors", "FAIL", leftover.join("\n"));

    // item 1: each LIME entry's `value` must equal the request payload value of that feature
    if (v.data && v.data.explanation) {
      const byName = new Map(Object.keys(payload).map((k) => [squash(k), k]));
      let checked = 0, skipped = 0;
      const mismatches = [];
      for (const [target, items] of Object.entries(v.data.explanation)) {
        if (!Array.isArray(items)) continue;
        for (const it of items) {
          const key = byName.get(squash(it.feature));
          const expected = key === undefined ? null : encode(payload[key]);
          const got = encode(it.value);
          if (expected === null || got === null) { skipped++; continue; }
          checked++;
          if (Math.abs(expected - got) > 1e-6) mismatches.push(`${target}: ${it.feature} value=${it.value} but payload ${key}=${JSON.stringify(payload[key])}`);
        }
      }
      row("LIME `value` equals the request field (item 1)", mismatches.length ? "FAIL" : (checked ? "PASS" : "WARN"),
        mismatches.length ? mismatches.slice(0, 8).join("\n")
          : `${checked} entries compared${skipped ? `, ${skipped} not mappable to a payload field` : ""}`);
    }
  } catch (e) {
    row("POST /predict?explain=true", "FAIL", e.message);
  }

  /* 6. 422 detail is readable (item 14) -------------------------------- */
  try {
    const { res, body } = await call("/predict", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (res.status !== 422) {
      row("POST /predict {} → 422 with readable detail", "WARN", `expected 422, got HTTP ${res.status}`);
    } else {
      const text = CCAI.formatDetail(body && body.detail);
      const ok = text && !text.includes("[object Object]");
      row("POST /predict {} → 422 with readable detail", ok ? "PASS" : "FAIL", text.slice(0, 240));
    }
  } catch (e) {
    row("POST /predict {} → 422", "WARN", e.message);
  }

  finish();
}

function finish() {
  summaryEl.textContent = `${tally.PASS} passed · ${tally.FAIL} failed · ${tally.WARN} warnings`;
  summaryEl.className = tally.FAIL ? "FAIL" : (tally.WARN ? "WARN" : "PASS");
}

document.getElementById("run").addEventListener("click", () => {
  localStorage.setItem("ccai_api", apiEl.value.trim());
  run();
});
run();
