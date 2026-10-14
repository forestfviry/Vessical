/* =========================================================================
 * CoronaryCare AI — frontend client
 * Matches the FastAPI backend: POST /predict, GET /metrics,
 * GET /dataset/patient/{i}, GET /dataset/size (optional), GET /features, GET /
 *
 * Pure logic (offline schema, /features normalizer, response validator,
 * label vocabulary, payload casing, error formatting) lives in contract.js
 * so test.js can exercise exactly the same code.
 * ========================================================================= */
"use strict";

const { FALLBACK_SCHEMA, VESSELS } = CCAI;

const VESSEL_REGIONS = {
  LAD: "Anterior wall · anterior interventricular septum · apex",
  LCX: "Lateral wall of the left ventricle",
  RCA: "Inferior wall · right ventricle · SA/AV nodal branches",
};

// Semicircle length for r=90 (π·90 ≈ 282.7). Single source of truth: it is
// written to the arc's stroke-dasharray from JS (initGauge), not from CSS.
const ARC = 283;
const DATASET_SIZE = 303;            // fallback when GET /dataset/size is unavailable
const LAST_KEY = "ccai_last";
const GT_KEYS = ["CAD", "CATH", "LAD", "LCX", "RCA"];
const NARROW_MQ = window.matchMedia("(max-width:1180px)");

const EXPLAIN_EMPTY = `
  <div class="empty-state">
    <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 2.4 1.2 4.5 3 5.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3c1.8-1.3 3-3.4 3-5.7a7 7 0 0 0-7-7zm-2 19a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-1h-4v1z" fill="currentColor"/></svg>
    <p>Run an analysis to reveal the physiological factor breakdown.</p>
  </div>`;

/* ------------------------------------------------------------------ state */
const VESSEL_EMPTY = `<div class="empty-state small"><p>Run an analysis to see the per-artery stenosis probabilities.</p></div>`;

const state = {
  schema: FALLBACK_SCHEMA,
  groundTruth: null,
  lastResponse: null,
  activeVessel: "LAD",
  explainTarget: "CAD",
  bmiTouched: false,
  formDirty: false,
  demoIndex: null,
  _vessels: {},
  _expl: null,
};
let datasetSize = null;

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const pretty = (n) => String(n).replace(/_/g, " ");

function apiBase() { return ($("#api-url").value || "").replace(/\/+$/, ""); }

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), isErr ? 7000 : 4200);
}

/** fetch + JSON with readable errors (item 14: 422 `detail` arrays are joined). */
async function fetchApi(path, options = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(apiBase() + path, { ...options, signal: ctrl.signal });
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`request timed out after ${timeoutMs / 1000}s`);
      throw new Error(location.protocol === "file:"
        ? "network error — this page was opened from file://; serve it with `python -m http.server 5500` and open http://localhost:5500"
        : "network error — is the API running, and is CORS enabled for this origin?");
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = CCAI.formatDetail(CCAI.isPlainObject(body) && "detail" in body ? body.detail : body);
      } catch (_) { /* body was not JSON */ }
      throw new Error(`HTTP ${res.status}${detail ? " — " + detail : ""}`);
    }
    return await res.json();
  } finally { clearTimeout(timer); }
}

/* ------------------------------------------------------------- form build */
function syncGroupsOpen() {
  // narrow screens: groups collapsed by default (item 16b); wide: all open
  $$("#patient-form details.fieldset").forEach((d) => { d.open = !NARROW_MQ.matches; });
}

function buildForm(schema) {
  const wrap = $("#patient-form");
  wrap.innerHTML = "";
  state.bmiTouched = false;
  for (const g of schema) {
    const det = document.createElement("details");
    det.className = "fieldset";
    det.open = true;
    const sum = document.createElement("summary");
    sum.textContent = g.group;
    det.appendChild(sum);
    const grid = document.createElement("div");
    grid.className = "fields";
    for (const f of g.fields) grid.appendChild(buildField(f));
    det.appendChild(grid);
    wrap.appendChild(det);
  }
  syncGroupsOpen();
}

function setSeg(seg, raw) {
  seg.dataset.value = raw;
  seg.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.v === raw;
    b.className = on ? (raw === "1" ? "on-y" : "on-n") : "";
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function buildField(f) {
  const div = document.createElement("div");
  div.className = "field";
  div.dataset.field = f.name;
  const id = `fld-${f.name}`;

  const lab = document.createElement("label");
  lab.id = `lbl-${f.name}`;
  lab.innerHTML = `<span>${esc(f.label || pretty(f.name))}</span>${f.unit ? `<span class="unit">${esc(f.unit)}</span>` : ""}`;
  div.appendChild(lab);

  if (f.type === "bool" || f.type === "yn") {
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.setAttribute("role", "radiogroup");
    seg.setAttribute("aria-labelledby", lab.id);
    seg.innerHTML = `
      <button type="button" role="radio" data-v="1">Yes</button>
      <button type="button" role="radio" data-v="0">No</button>`;
    setSeg(seg, CCAI.truthy(f.def) ? "1" : "0");
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) setSeg(seg, b.dataset.v);
    });
    div.appendChild(seg);
  } else if (f.type === "select") {
    // item 4: never render a select without real options
    const opts = Array.isArray(f.options)
      ? f.options.filter((o) => o !== null && o !== undefined && o !== "") : [];
    if (!opts.length) {
      console.error(`[ccai] select field "${f.name}" has no options — not rendered`);
      div.dataset.invalid = "1";
      const hint = document.createElement("p");
      hint.className = "hint err";
      hint.textContent = "No options supplied by /features for this field.";
      div.appendChild(hint);
    } else {
      lab.htmlFor = id;
      const sel = document.createElement("select");
      sel.id = id;
      opts.forEach((o) => {
        const opt = document.createElement("option");
        opt.value = o; opt.textContent = o;
        if (String(o).toLowerCase() === String(f.def).toLowerCase()) opt.selected = true;
        sel.appendChild(opt);
      });
      div.appendChild(sel);
    }
  } else {
    lab.htmlFor = id;
    const inp = document.createElement("input");
    inp.type = "number";
    inp.id = id;
    if (f.min !== undefined) inp.min = f.min;
    if (f.max !== undefined) inp.max = f.max;
    inp.step = f.type === "int" ? "1" : "any";
    inp.value = f.def;
    if (f.name === "BMI") {
      // editing BMI by hand switches auto-calc off; clearing it switches it back on
      inp.addEventListener("input", () => { state.bmiTouched = inp.value !== ""; });
    }
    div.appendChild(inp);
  }
  return div;
}

function getInput(f) {
  const holder = $(`.field[data-field="${f.name}"]`);
  if (!holder || holder.dataset.invalid) return undefined;
  if (f.type === "bool" || f.type === "yn") {
    const raw = holder.querySelector(".seg").dataset.value;
    return f.type === "bool" ? Number(raw) : (raw === "1" ? "Y" : "N");
  }
  if (f.type === "select") return holder.querySelector("select").value;
  const v = holder.querySelector("input").value;
  return v === "" ? undefined : Number(v);
}

function collectPayload() {
  const payload = {};
  const missing = [];
  for (const g of state.schema) {
    for (const f of g.fields) {
      const v = getInput(f);
      if (v === undefined || Number.isNaN(v)) { missing.push(f.label || f.name); continue; }
      payload[f.name] = v;
    }
  }
  return { payload: CCAI.normalizePayload(payload, state.schema), missing };
}

function fillForm(features) {
  state.bmiTouched = false;
  state.formDirty = true;
  const flat = {};
  for (const g of state.schema) for (const f of g.fields) flat[f.name.toLowerCase()] = f;
  let sawBmi = false;
  for (const [k, v] of Object.entries(features || {})) {
    const f = flat[k.toLowerCase()];
    if (!f || v === null || v === undefined || v === "") continue;
    const holder = $(`.field[data-field="${f.name}"]`);
    if (!holder || holder.dataset.invalid) continue;
    if (f.name === "BMI") sawBmi = true;
    if (f.type === "bool" || f.type === "yn") {
      setSeg(holder.querySelector(".seg"), CCAI.truthy(v) ? "1" : "0");
    } else if (f.type === "select") {
      const sel = holder.querySelector("select");
      const match = Array.from(sel.options).find((o) => o.value.toLowerCase() === String(v).toLowerCase());
      if (match) sel.value = match.value;
      else console.warn(`[ccai] "${v}" is not an option of ${f.name}`);
    } else {
      holder.querySelector("input").value = v;
    }
  }
  // item 9: backend omitted BMI -> derive it from the weight/height we just set
  if (!sawBmi) recalcBmi();
}

/* --------------------------------------------------------------- BMI calc */
function recalcBmi() {
  if (state.bmiTouched) return;
  const w = $('.field[data-field="Weight"] input');
  const h = $('.field[data-field="Length"] input');
  const b = $('.field[data-field="BMI"] input');
  if (!w || !h || !b) return;
  const wv = parseFloat(w.value), hv = parseFloat(h.value);
  if (wv > 0 && hv > 0) b.value = (wv / ((hv / 100) ** 2)).toFixed(1);
}

function wireBmiAutocalcReal() {
  const w = $('.field[data-field="Weight"] input');
  const h = $('.field[data-field="Length"] input');
  if (w) w.addEventListener("input", recalcBmi);
  if (h) h.addEventListener("input", recalcBmi);
}

/* ------------------------------------------------------------ API status */
async function checkApi() {
  const pill = $("#api-status"), txt = $("#api-status-text");
  pill.className = "status-pill status-unknown";
  pill.removeAttribute("title");
  txt.textContent = "Checking API…";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(apiBase() + "/", { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pill.className = "status-pill status-ok";
    txt.textContent = "API connected";
    return true;
  } catch (e) {
    // tell "server down" apart from "browser blocked it (CORS / file://)"
    const why = await CCAI.diagnoseNetwork(apiBase());
    pill.className = "status-pill status-bad";
    txt.textContent = why.kind === "cors" ? "Blocked by CORS" : "API unreachable";
    pill.title = why.message;
    console.warn("[ccai]", why.message);
    toast(why.message, true);
    return false;
  }
}

/* ------------------------------------------------------------ /features */
async function tryLoadRemoteSchema() {
  let data;
  try {
    data = await fetchApi("/features", {}, 5000);
  } catch (e) {
    console.warn("[ccai] /features unavailable:", e);
    toast(`Using offline schema — /features unavailable (${e.message})`);
    return;
  }
  const groups = CCAI.normalizeFeaturesEndpoint(data);
  if (!groups.length) {
    console.warn("[ccai] /features returned an unrecognized shape:", data);
    toast("Using offline schema — /features returned an unrecognized shape", true);
    return;
  }
  const diffs = CCAI.diffSchemas(groups, FALLBACK_SCHEMA);
  if (diffs.length) console.warn(`[ccai] /features differs from FALLBACK_SCHEMA (${diffs.length}):\n - ` + diffs.join("\n - "));
  else console.info("[ccai] /features matches FALLBACK_SCHEMA (groups, fields, widget types)");

  // keep anything the user already typed / restored across the rebuild
  const keep = state.formDirty ? collectPayload().payload : null;
  state.schema = groups;
  buildForm(state.schema);
  wireBmiAutocalcReal();
  if (keep) fillForm(keep);
  toast(diffs.length
    ? `Form generated from /features (${diffs.length} difference${diffs.length > 1 ? "s" : ""} vs offline schema — see console)`
    : "Form generated from /features metadata");
}

/* ----------------------------------------------------------- demo patient */
async function getDatasetSize() {
  if (datasetSize) return datasetSize;
  try {
    const d = await fetchApi("/dataset/size", {}, 4000);
    const n = typeof d === "number" ? d : (d && (d.size ?? d.n ?? d.count ?? d.rows ?? d.length));
    if (Number.isInteger(n) && n > 0) return (datasetSize = n);
  } catch (_) { /* endpoint is optional */ }
  return (datasetSize = DATASET_SIZE);
}

async function loadDemoPatient(forcedIndex) {
  const btn = $("#btn-demo");
  btn.disabled = true;
  btn.classList.add("is-loading");
  btn.setAttribute("aria-busy", "true");
  try {
    const size = await getDatasetSize();
    const idx = Number.isInteger(forcedIndex) ? forcedIndex : Math.floor(Math.random() * size);
    const rec = await fetchApi(`/dataset/patient/${idx}`);
    fillForm(rec.features || rec);
    state.groundTruth = rec.ground_truth || null;
    state.demoIndex = idx;
    if (state.groundTruth) {
      const odd = Object.keys(state.groundTruth).filter((k) => !GT_KEYS.includes(k.toUpperCase()));
      if (odd.length) console.warn("[ccai] unexpected ground_truth keys (no ✓/✗ comparison for them):", odd);
    }
    renderTruthChips(null);
    $("#truth-box").classList.remove("hidden");
    toast(`Loaded dataset record #${idx} of ${size} · repeat it with ?patient=${idx}`);
  } catch (e) {
    toast(`Could not load demo patient: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-loading");
    btn.removeAttribute("aria-busy");
  }
}

function predictedFor(key, pred) {
  const k = key.toUpperCase();
  if (k === "CATH" || k === "CAD") return (pred.cad || {}).predicted_status;
  if (VESSELS.includes(k)) return ((pred.vessels || {})[k] || {}).predicted_label;
  return undefined;
}

function renderTruthChips(pred) {
  const box = $("#truth-chips");
  if (!state.groundTruth) { box.innerHTML = ""; return; }
  box.innerHTML = Object.entries(state.groundTruth).map(([k, v]) => {
    const pol = CCAI.labelPolarity(v);               // true | false | null (unknown)
    let match = "";
    if (pred) {
      const pv = predictedFor(k, pred);
      if (pv !== undefined) {
        const pp = CCAI.labelPolarity(pv);
        if (pol === null || pp === null) match = '<span title="Label not in the known vocabulary — cannot compare">?</span>';
        else match = pol === pp ? '<span title="Model agrees">✓</span>' : '<span title="Model disagrees">✗</span>';
      }
    }
    const cls = pol === null ? "neutral" : (pol ? "bad" : "ok");
    return `<span class="chip ${cls}">${esc(k)}: ${esc(v)} ${match}</span>`;
  }).join("");
}

/* ---------------------------------------------------------------- predict */
async function runPrediction() {
  const { payload, missing } = collectPayload();
  if (missing.length) {
    toast(`Missing or invalid: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "…" : ""}`, true);
    return;
  }
  const btn = $("#btn-predict");
  btn.disabled = true;
  btn.classList.add("is-loading");
  const t0 = performance.now();
  try {
    const explain = $("#opt-explain").checked;
    const raw = await fetchApi(`/predict?explain=${explain}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, 60000);

    // item 3: refuse to render a response that breaks the contract
    const v = CCAI.validatePredictResponse(raw, { explain });
    if (!v.ok) {
      console.error("[ccai] /predict response violates the contract:", v.errors, raw);
      toast(`Unexpected /predict response — ${v.errors.slice(0, 2).join("; ")}${v.errors.length > 2 ? ` (+${v.errors.length - 2} more, see console)` : ""}`, true);
      return;
    }
    const out = v.data;
    state.lastResponse = out;
    const seconds = ((performance.now() - t0) / 1000).toFixed(2);
    renderResults(out, seconds);
    saveLast(payload, out, seconds);
    if (v.warnings.length) {
      console.warn("[ccai] /predict warnings:", v.warnings);
      toast(`Analysis complete, but: ${v.warnings[0]}`, true);
    } else {
      toast("Analysis complete");
    }
  } catch (e) {
    toast(`Prediction failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-loading");
  }
}

/* ----------------------------------------------- persistence (item 7) */
function saveLast(payload, out, seconds) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({
      payload, out, seconds, ts: Date.now(),
      demoIndex: state.demoIndex, groundTruth: state.groundTruth,
    }));
  } catch (_) { /* storage full / disabled — persistence is best-effort */ }
}

function restoreLast() {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    const v = CCAI.validatePredictResponse(s.out);
    if (!v.ok) { localStorage.removeItem(LAST_KEY); return false; }
    fillForm(s.payload || {});
    state.groundTruth = s.groundTruth || null;
    state.demoIndex = s.demoIndex ?? null;
    if (state.groundTruth) $("#truth-box").classList.remove("hidden");
    state.lastResponse = v.data;
    renderResults(v.data, s.seconds, { scroll: false });
    toast(`Restored last result from ${new Date(s.ts).toLocaleTimeString()}`);
    return true;
  } catch (e) {
    console.warn("[ccai] could not restore last result:", e);
    try { localStorage.removeItem(LAST_KEY); } catch (_) {}
    return false;
  }
}

function clearLast() {
  try { localStorage.removeItem(LAST_KEY); } catch (_) {}
  resetResults();
  toast("Cleared last result");
}

function resetResults() {
  state.lastResponse = null;
  state._expl = null;
  state._vessels = {};
  initGauge();
  $("#gauge-value").textContent = "—";
  const bandEl = $("#gauge-band");
  bandEl.className = "band band-idle";
  bandEl.textContent = "Awaiting input";
  $("#cad-status").textContent = "—";
  $("#cad-time").textContent = "—";
  $("#vessel-cards").innerHTML = VESSEL_EMPTY;
  updateSchematic({});
  setActiveVessel(state.activeVessel, {});
  $$("#explain-tabs .tab").forEach((t) => { t.style.display = ""; });
  $("#explain-body").innerHTML = EXPLAIN_EMPTY;
  selectExplainTab("CAD");
  renderTruthChips(null);
}

/* --------------------------------------------------------------- render */
function renderResults(out, seconds, { scroll = true } = {}) {
  renderGauge(out.cad);
  $("#cad-status").textContent = out.cad.predicted_status;
  $("#cad-time").textContent = seconds !== undefined && seconds !== null ? `${seconds}s` : "—";
  renderVessels(out.vessels);
  renderExplanation(out.explanation);
  renderTruthChips(out);
  if (scroll) $("#panel-cad").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function cancelAnimations(...els) {
  els.forEach((el) => { if (typeof el.getAnimations === "function") el.getAnimations().forEach((a) => a.cancel()); });
}

function initGauge() {
  const arc = $("#gauge-arc"), needle = $("#gauge-needle");
  cancelAnimations(arc, needle);
  arc.style.strokeDasharray = String(ARC);
  arc.style.strokeDashoffset = String(ARC);
  needle.style.transform = "rotate(-90deg)";
}

function renderGauge(cad) {
  const p = Math.min(1, Math.max(0, cad.cad_probability));
  const arc = $("#gauge-arc"), needle = $("#gauge-needle");
  // item 12: drop any in-flight transitions so arc and needle restart together
  cancelAnimations(arc, needle);
  arc.style.strokeDasharray = String(ARC);
  arc.style.strokeDashoffset = String(ARC * (1 - p));
  needle.style.transform = `rotate(${-90 + 180 * p}deg)`;
  $("#gauge-value").textContent = `${(p * 100).toFixed(1)}%`;
  const band = (cad.risk_band || "").toLowerCase();
  const bandEl = $("#gauge-band");
  bandEl.className = "band band-" + (["low", "moderate", "medium", "high"].includes(band) ? band : "idle");
  bandEl.textContent = cad.risk_band || "—";
}

function probColor(p) {
  if (p < 0.35) return "#10b981";
  if (p < 0.65) return "#f59e0b";
  return "#ef4444";
}

function renderVessels(vessels) {
  const wrap = $("#vessel-cards");
  wrap.innerHTML = VESSELS.map((v) => {
    const d = vessels[v] || {};
    const p = d.stenosis_probability ?? 0;
    const label = d.predicted_label || "—";
    return `
      <div class="vcard ${v === state.activeVessel ? "active" : ""}" data-vessel="${v}" tabindex="0" role="button" aria-label="Inspect ${v}">
        <div class="vcard-top">
          <h3>${v} <span class="muted">· ${esc(VESSEL_REGIONS[v])}</span></h3>
          <span class="vprob" style="color:${probColor(p)}">${(p * 100).toFixed(1)}%</span>
        </div>
        <div class="vbar"><div style="background:${probColor(p)}" data-w="${(p * 100).toFixed(1)}"></div></div>
        <div class="vcard-top" style="margin-top:.5rem">
          <span class="vregion">Stenosis probability (≥50% narrowing)</span>
          <span class="vlabel ${String(label).toLowerCase().startsWith("sten") ? "stenotic" : "normal"}">${esc(label)}</span>
        </div>
      </div>`;
  }).join("");

  wrap.querySelectorAll(".vcard").forEach((c) => {
    c.addEventListener("click", () => setActiveVessel(c.dataset.vessel));
    c.addEventListener("keydown", activateOnKey(() => setActiveVessel(c.dataset.vessel)));
  });

  requestAnimationFrame(() =>
    wrap.querySelectorAll(".vbar > div").forEach((b) => (b.style.width = b.dataset.w + "%"))
  );

  updateSchematic(vessels);
  setActiveVessel(state.activeVessel, vessels);
}

function activateOnKey(fn) {
  return (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } };
}

function updateSchematic(vessels) {
  for (const v of VESSELS) {
    const path = $(`#vessel-${v}`);
    const p = (vessels[v] || {}).stenosis_probability;
    if (p === undefined) {
      path.style.stroke = "";
      path.style.opacity = "";
    } else {
      path.style.stroke = probColor(p);
      path.style.opacity = String(0.45 + 0.55 * p);
    }
  }
}

function setActiveVessel(v, vessels) {
  if (vessels) state._vessels = vessels;
  const vs = vessels || state._vessels || {};
  state.activeVessel = v;
  $$(".vcard").forEach((c) => c.classList.toggle("active", c.dataset.vessel === v));
  $$(".vessel-label").forEach((l) => l.classList.toggle("active", l.dataset.vessel === v));
  VESSELS.forEach((x) => {
    const path = $(`#vessel-${x}`);
    path.classList.toggle("active", x === v);
    path.style.filter = x === v ? "url(#glow)" : "";
  });
  const d = vs[v] || {};
  const note = $(".schematic-note");
  if (note) {
    note.textContent = d.stenosis_probability !== undefined
      ? `${v} selected — stenosis probability ${(d.stenosis_probability * 100).toFixed(1)}% · ${d.predicted_label ?? "—"}`
      : "Schematic illustration — not to anatomical scale";
  }
}

/* ------------------------------------------------------------ explanation */
function selectExplainTab(target) {
  state.explainTarget = target;
  $$("#explain-tabs .tab").forEach((t) => {
    const on = t.dataset.target === target;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
  });
  $("#explain-body").setAttribute("aria-labelledby", `tab-${target}`);
}

function renderExplanation(expl) {
  const body = $("#explain-body");
  const e = CCAI.upperKeys(expl) || {};          // item 5: case-insensitive keys
  if (!Object.keys(e).length) {
    state._expl = null;
    body.innerHTML = `<div class="empty-state small"><p>No explanation returned (enable “Include LIME explanation”).</p></div>`;
    return;
  }
  state._expl = e;
  if (!e[state.explainTarget]) state.explainTarget = Object.keys(e)[0];
  $$("#explain-tabs .tab").forEach((t) => { t.style.display = e[t.dataset.target] ? "" : "none"; });
  selectExplainTab(state.explainTarget);
  drawExplanation(e[state.explainTarget] || []);
}

function drawExplanation(items) {
  const body = $("#explain-body");
  items = (items || []).filter((i) => i && Number.isFinite(Number(i.contribution)));
  if (!items.length) {
    body.innerHTML = `<div class="empty-state small"><p>No local contributions available for this target.</p></div>`;
    return;
  }
  const maxAbs = Math.max(...items.map((i) => Math.abs(i.contribution)), 1e-6);
  body.innerHTML = items.map((it) => {
    const c = Number(it.contribution);
    const pct = (Math.abs(c) / maxAbs) * 50;
    const pos = c > 0;
    return `
      <div class="xbar-row" title="${esc(it.feature)} = ${esc(it.value)} · ${esc(it.direction)}">
        <div class="xfeat">${esc(pretty(it.feature))}<span class="xval">value: ${esc(it.value)}</span></div>
        <div class="xtrack"><span class="zero"></span><div class="xfill ${pos ? "pos" : "neg"}" data-w="${pct.toFixed(1)}"></div></div>
        <div class="xval-out ${pos ? "pos" : "neg"}">${pos ? "+" : ""}${c.toFixed(3)}</div>
      </div>`;
  }).join("") + `
    <div class="xlegend">
      <span><i style="background:#ef4444"></i>Increases risk</span>
      <span><i style="background:#10b981"></i>Decreases risk</span>
      <span style="margin-left:auto">Weighted linear (LIME) approximation · local to this patient</span>
    </div>`;
  requestAnimationFrame(() =>
    body.querySelectorAll(".xfill").forEach((b) => (b.style.width = b.dataset.w + "%"))
  );
}

/* ---------------------------------------------------------------- metrics
 * Expected /metrics shape (documented in contract.js and the README):
 *   { "<metric>": number,
 *     "<TARGET>": { "<metric>": number, "<key>": [ {feature, importance} ] },
 *     "<key>": [ {feature, importance} ] }
 * Anything else is dumped verbatim in a <pre>, never silently dropped.
 * ------------------------------------------------------------------- */
async function loadMetrics() {
  const body = $("#metrics-body");
  try {
    const m = await fetchApi("/metrics", {}, 8000);
    body.innerHTML = renderMetrics(m);
  } catch (e) {
    body.innerHTML = `<div class="empty-state small"><p>Metrics unavailable — ${esc(e.message)}</p></div>`;
  }
}

function fmtMetric(v) {
  if (typeof v === "number") return Math.abs(v) <= 1 ? v.toFixed(3) : v.toLocaleString();
  return String(v);
}

function metricCards(entries) {
  return `<div class="metric-grid">${entries.map(([k, v]) =>
    `<div class="mcard"><h4>${esc(pretty(k))}</h4><div class="mval">${fmtMetric(v)}</div></div>`).join("")}</div>`;
}

function isImportanceList(arr) {
  return Array.isArray(arr) && arr.length > 0 && arr.every((it) =>
    CCAI.isPlainObject(it) && (it.feature || it.name) &&
    ["importance", "value", "score"].some((k) => typeof it[k] === "number"));
}

function renderMetrics(m) {
  if (Array.isArray(m) && isImportanceList(m)) return renderImportanceTable(m);
  if (!CCAI.isPlainObject(m)) return rawDump("Unrecognised /metrics payload", m);
  if (!Object.keys(m).length) return `<div class="empty-state small"><p>Empty metrics payload.</p></div>`;

  const sections = [];
  const left = {};
  const topNums = [], targets = [], topLists = [];
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === "number") topNums.push([k, v]);
    else if (isImportanceList(v)) topLists.push([k, v]);
    else if (CCAI.isPlainObject(v)) targets.push([k, v]);
    else left[k] = v;
  }
  if (topNums.length) {
    if (targets.length || topLists.length) sections.push(`<div class="metric-section-title">Overall</div>`);
    sections.push(metricCards(topNums));
  }
  for (const [k, arr] of topLists) {
    sections.push(`<div class="metric-section-title">${esc(pretty(k))}</div>${renderImportanceTable(arr)}`);
  }
  for (const [k, obj] of targets) {
    const nums = [], lists = [];
    for (const [kk, vv] of Object.entries(obj)) {
      if (typeof vv === "number") nums.push([kk, vv]);
      else if (isImportanceList(vv)) lists.push([kk, vv]);
      else (left[k] = left[k] || {})[kk] = vv;      // nested objects, strings, odd lists…
    }
    if (nums.length) sections.push(`<div class="metric-section-title">${esc(pretty(k))}</div>${metricCards(nums)}`);
    for (const [lk, arr] of lists) {
      sections.push(`<div class="metric-section-title">${esc(pretty(k))} · ${esc(pretty(lk))}</div>${renderImportanceTable(arr)}`);
    }
  }
  if (Object.keys(left).length) sections.push(rawDump("Unrendered fields (shape not recognised)", left));
  return sections.join("");
}

function rawDump(title, value) {
  return `<details class="metric-raw" open><summary>${esc(title)}</summary><pre>${esc(JSON.stringify(value, null, 2))}</pre></details>`;
}

function renderImportanceTable(arr) {
  const rows = arr.slice(0, 12).map((it) => {
    const f = it.feature || it.name || "—";
    const val = it.importance ?? it.value ?? it.score ?? "";
    return `<tr><td>${esc(pretty(f))}</td><td style="font-family:'JetBrains Mono',monospace">${typeof val === "number" ? val.toFixed(4) : esc(val)}</td></tr>`;
  }).join("");
  return `<table class="mtable"><thead><tr><th>Feature</th><th>Importance</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------------------------------------------- copy payload (item 17) */
async function copyPayload() {
  const { payload, missing } = collectPayload();
  const text = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement("textarea");   // non-secure-context fallback
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) { toast("Could not copy to the clipboard", true); }
    ta.remove();
  }
  toast(missing.length
    ? `Payload copied (${Object.keys(payload).length} fields) — missing: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`
    : `Payload copied — ${Object.keys(payload).length} fields, ready to paste into /docs`, missing.length > 0);
}

/* ----------------------------------------------------------------- init */
function init() {
  // restore API base
  const saved = localStorage.getItem("ccai_api");
  if (saved) $("#api-url").value = saved;

  buildForm(state.schema);
  wireBmiAutocalcReal();

  // the sticky form rail needs the real height of the (sticky) header
  const measureHeader = () => {
    const h = $(".site-head");
    if (h) document.documentElement.style.setProperty("--head-h", h.offsetHeight + "px");
  };
  measureHeader();
  window.addEventListener("resize", measureHeader);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureHeader);

  // item 13: put gauge + schematic in a defined state before any prediction
  $("#vessel-cards").innerHTML = VESSEL_EMPTY;
  initGauge();
  updateSchematic({});
  setActiveVessel("LAD", {});

  $("#api-save").addEventListener("click", async () => {
    localStorage.setItem("ccai_api", $("#api-url").value.trim());
    toast("API address saved");
    const ok = await checkApi();
    if (ok) { tryLoadRemoteSchema(); loadMetrics(); }
  });
  $("#api-url").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#api-save").click(); });

  $("#btn-predict").addEventListener("click", runPrediction);
  $("#btn-copy-json").addEventListener("click", copyPayload);
  $("#btn-demo").addEventListener("click", () => loadDemoPatient());
  $("#btn-clear-last").addEventListener("click", clearLast);
  $("#btn-reset").addEventListener("click", () => {
    state.groundTruth = null;
    state.demoIndex = null;
    $("#truth-box").classList.add("hidden");
    state.bmiTouched = false;                 // item 9: reset re-enables BMI auto-calc
    buildForm(state.schema);
    wireBmiAutocalcReal();
    state.formDirty = false;
    toast("Form reset to defaults");
  });
  $("#btn-refresh-metrics").addEventListener("click", loadMetrics);

  // any manual edit marks the form dirty so a late /features rebuild keeps it
  const formEl = $("#patient-form");
  formEl.addEventListener("input", () => { state.formDirty = true; });
  formEl.addEventListener("click", (e) => { if (e.target.closest(".seg button")) state.formDirty = true; });

  const onMq = () => syncGroupsOpen();
  if (NARROW_MQ.addEventListener) NARROW_MQ.addEventListener("change", onMq);
  else if (NARROW_MQ.addListener) NARROW_MQ.addListener(onMq);

  $$(".vessel-label").forEach((l) => {
    l.addEventListener("click", () => setActiveVessel(l.dataset.vessel));
    l.addEventListener("keydown", activateOnKey(() => setActiveVessel(l.dataset.vessel)));
  });
  VESSELS.forEach((v) => $(`#vessel-${v}`).addEventListener("click", () => setActiveVessel(v)));

  const tabs = $$("#explain-tabs .tab");
  tabs.forEach((t) => {
    t.addEventListener("click", () => {
      selectExplainTab(t.dataset.target);
      if (state._expl) drawExplanation(state._expl[state.explainTarget] || []);
    });
    t.addEventListener("keydown", (e) => {          // arrow-key navigation between tabs
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const vis = tabs.filter((x) => x.style.display !== "none");
      const next = vis[(vis.indexOf(t) + (e.key === "ArrowRight" ? 1 : -1) + vis.length) % vis.length];
      if (next) { next.focus(); next.click(); }
    });
  });
  selectExplainTab("CAD");

  restoreLast();

  const wanted = parseInt(new URLSearchParams(location.search).get("patient"), 10);
  checkApi().then(async (ok) => {
    if (!ok) return;
    loadMetrics();
    await tryLoadRemoteSchema();
    if (Number.isInteger(wanted) && wanted >= 0) loadDemoPatient(wanted);
  });
}

document.addEventListener("DOMContentLoaded", init);
