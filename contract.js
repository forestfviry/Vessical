/* =========================================================================
 * CoronaryCare AI — contract.js
 *
 * DOM-free logic shared by app.js (the dashboard), test.js (the integration
 * test page) and node (module.exports at the bottom, for quick unit tests):
 *
 *   FALLBACK_SCHEMA            offline form schema (mirrors PatientInput)
 *   normalizeFeaturesEndpoint  GET /features  -> schema groups   (item 4)
 *   diffSchemas                remote vs. fallback schema diff   (item 4)
 *   validatePredictResponse    POST /predict contract check      (items 3, 5)
 *   labelPolarity              explicit label vocabulary         (item 6)
 *   normalizePayload           casing the backend expects        (item 10)
 *   formatDetail               FastAPI 422 detail -> string      (item 14)
 *
 * EXPECTED /metrics SHAPE (item 11) — app.js renders ONLY this, everything
 * else is shown verbatim in a <pre> block so nothing is silently dropped:
 *
 *   {
 *     "<metric>": number,                       // optional overall metrics
 *     "<TARGET>": {                             // optional, e.g. CAD/LAD/LCX/RCA
 *        "<metric>": number,                    //   auc, accuracy, f1 ...
 *        "<any key>": [ {feature, importance} ] //   permutation importance
 *     },
 *     "<any key>": [ {feature, importance} ]    // optional top-level list
 *   }
 * ========================================================================= */
"use strict";

const CCAI = (() => {
  const VESSELS = ["LAD", "LCX", "RCA"];
  const RISK_BANDS = ["low", "moderate", "medium", "high"];
  const FIELD_TYPES = ["number", "int", "yn", "bool", "select"];
  const YN_TOKEN = /^(y|n|yes|no)$/i;

  /* ------------------------------------------------------------------ *
   *  Embedded fallback feature schema (mirrors the backend PatientInput)
   *  type: "number" | "int" | "yn" (Y/N string) | "bool" (1/0) | "select"
   * ------------------------------------------------------------------ */
  const FALLBACK_SCHEMA = [
    { group: "Demographics", fields: [
      { name: "Age",    label: "Age",            type: "int",    min: 18,  max: 100, def: 58 },
      { name: "Sex",    label: "Sex",            type: "select", options: ["Male", "Female"], def: "Male" },
      { name: "Weight", label: "Weight",         type: "number", min: 25,  max: 200, unit: "kg", def: 80 },
      { name: "Length", label: "Height",         type: "number", min: 100, max: 220, unit: "cm", def: 170 },
      { name: "BMI",    label: "BMI (auto from weight/height)", type: "number", min: 10, max: 60, unit: "kg/m²", def: 27.7 },
    ]},
    { group: "Risk factors & history", fields: [
      { name: "DM",             label: "Diabetes mellitus",    type: "bool", def: 0 },
      { name: "HTN",            label: "Hypertension",         type: "bool", def: 0 },
      { name: "Current_Smoker", label: "Current smoker",       type: "bool", def: 0 },
      { name: "EX_Smoker",      label: "Ex-smoker",            type: "bool", def: 0 },
      { name: "FH",             label: "Family history of CAD",type: "bool", def: 0 },
      { name: "Obesity",        label: "Obesity",              type: "yn", def: "N" },
      { name: "DLP",            label: "Dyslipidemia",         type: "yn", def: "N" },
      { name: "CRF",            label: "Chronic renal failure",type: "yn", def: "N" },
      { name: "CVA",            label: "Cerebrovascular accident", type: "yn", def: "N" },
      { name: "Airway_disease", label: "Airway disease",       type: "yn", def: "N" },
      { name: "Thyroid_Disease",label: "Thyroid disease",      type: "yn", def: "N" },
      { name: "CHF",            label: "Congestive heart failure", type: "yn", def: "N" },
    ]},
    { group: "Examination & vitals", fields: [
      { name: "BP",    label: "Blood pressure (systolic)", type: "int", min: 60,  max: 260, unit: "mmHg", def: 130 },
      { name: "PR",    label: "Pulse rate",                type: "int", min: 30,  max: 180, unit: "bpm",  def: 85 },
      { name: "Edema", label: "Peripheral edema",          type: "bool", def: 0 },
      { name: "Weak_Peripheral_Pulse", label: "Weak peripheral pulse", type: "yn", def: "N" },
      { name: "Lung_rales",        label: "Lung rales",            type: "yn", def: "N" },
      { name: "Systolic_Murmur",   label: "Systolic murmur",       type: "yn", def: "N" },
      { name: "Diastolic_Murmur",  label: "Diastolic murmur",      type: "yn", def: "N" },
    ]},
    { group: "Symptoms", fields: [
      { name: "Typical_Chest_Pain", label: "Typical chest pain", type: "bool", def: 0 },
      { name: "Atypical",     label: "Atypical chest pain",   type: "yn", def: "N" },
      { name: "Nonanginal",   label: "Non-anginal pain",      type: "yn", def: "N" },
      { name: "Exertional_CP",label: "Exertional chest pain", type: "yn", def: "N" },
      { name: "LowTH_Ang",    label: "Low-threshold angina",  type: "yn", def: "N" },
      { name: "Dyspnea",      label: "Dyspnea",               type: "yn", def: "N" },
      { name: "Function_Class", label: "NYHA functional class", type: "int", min: 0, max: 4, def: 0 },
    ]},
    { group: "Electrocardiogram", fields: [
      { name: "Q_Wave",      label: "Q wave",        type: "bool", def: 0 },
      { name: "St_Elevation",label: "ST elevation",  type: "bool", def: 0 },
      { name: "St_Depression",label: "ST depression",type: "bool", def: 0 },
      { name: "Tinversion",  label: "T-wave inversion", type: "bool", def: 0 },
      { name: "LVH",             label: "LV hypertrophy",        type: "yn", def: "N" },
      { name: "Poor_R_Progression", label: "Poor R-wave progression", type: "yn", def: "N" },
      { name: "BBB", label: "Bundle branch block", type: "yn", def: "N" },
    ]},
    { group: "Laboratory", fields: [
      { name: "FBS",  label: "Fasting blood sugar", type: "number", min: 40,   max: 500,  unit: "mg/dL", def: 95 },
      { name: "CR",   label: "Creatinine",          type: "number", min: 0.2,  max: 12,   unit: "mg/dL", def: 1.0 },
      { name: "BUN",  label: "Blood urea nitrogen", type: "number", min: 2,    max: 120,  unit: "mg/dL", def: 15 },
      { name: "TG",   label: "Triglycerides",       type: "number", min: 20,   max: 1000, unit: "mg/dL", def: 180 },
      { name: "LDL",  label: "LDL cholesterol",     type: "number", min: 10,   max: 400,  unit: "mg/dL", def: 130 },
      { name: "HDL",  label: "HDL cholesterol",     type: "number", min: 5,    max: 120,  unit: "mg/dL", def: 40 },
      { name: "ESR",  label: "Erythrocyte sedimentation rate", type: "number", min: 1, max: 150, unit: "mm/h", def: 12 },
      { name: "HB",   label: "Hemoglobin",          type: "number", min: 5,    max: 22,   unit: "g/dL", def: 14.2 },
      { name: "K",    label: "Potassium",           type: "number", min: 2,    max: 8,    unit: "mEq/L", def: 4.5 },
      { name: "Na",   label: "Sodium",              type: "number", min: 110,  max: 170,  unit: "mEq/L", def: 140 },
      { name: "WBC",  label: "White blood cells",   type: "number", min: 1000, max: 50000,unit: "/µL",  def: 7000 },
      { name: "Lymph",label: "Lymphocytes",         type: "number", min: 1,    max: 80,   unit: "%",   def: 35 },
      { name: "Neut", label: "Neutrophils",         type: "number", min: 5,    max: 95,   unit: "%",   def: 55 },
      { name: "PLT",  label: "Platelets",           type: "number", min: 20000,max: 900000,unit:"/µL",  def: 250 },
    ]},
    { group: "Echocardiography", fields: [
      { name: "EF_TTE",      label: "Ejection fraction", type: "int", min: 5, max: 80, unit: "%", def: 45 },
      { name: "Region_RWMA", label: "Regions with RWMA", type: "int", min: 0, max: 17, def: 0 },
      { name: "VHD",         label: "Valvular heart disease", type: "select", options: ["N", "Mild", "Moderate", "Severe"], def: "N" },
    ]},
  ];

  /* ------------------------------------------------------------ helpers */
  const isPlainObject = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
  const show = (v) => (v === undefined ? "undefined" : JSON.stringify(v));
  const isProb = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  const nonEmptyStr = (v) => typeof v === "string" && v.trim() !== "";

  /** Shallow copy of an object with UPPERCASE keys (item 5). null if not an object. */
  function upperKeys(o) {
    if (!isPlainObject(o)) return null;
    const out = {};
    for (const k of Object.keys(o)) out[k.toUpperCase()] = o[k];
    return out;
  }

  /**
   * Is a form value "yes"? Anything that is not an explicit negative counts,
   * so dataset values such as "LBBB"/"RBBB" (BBB column) map to Yes and the
   * schema default "N" maps to No. (A plain `def ? yes : no` treats the
   * string "N" as truthy, which silently defaulted every Y/N field to Yes.)
   */
  function truthy(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === "string") return !/^(|n|no|0|false|f|normal|none|absent)$/i.test(v.trim());
    return !!v;
  }

  /* -------------------------------------------- label vocabulary (item 6) */
  // true = positive finding (disease / stenosis), false = negative, anything
  // not listed => null (unknown): the UI shows a neutral chip, never a guess.
  const LABEL_POLARITY = {
    "normal": false, "no cad": false, "no_cad": false, "non-cad": false, "non cad": false,
    "noncad": false, "healthy": false, "negative": false, "no": false, "n": false,
    "0": false, "false": false,
    "cad": true, "stenotic": true, "stenosis": true, "mild": true, "moderate": true,
    "severe": true, "positive": true, "yes": true, "y": true, "1": true, "true": true,
  };
  function labelPolarity(v) {
    if (v === null || v === undefined) return null;
    const k = String(v).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(LABEL_POLARITY, k) ? LABEL_POLARITY[k] : null;
  }

  /* ------------------------------------------- FastAPI errors (item 14) */
  function formatDetail(detail) {
    if (detail === null || detail === undefined || detail === "") return "";
    if (Array.isArray(detail)) {
      return detail.map((d) => {
        if (d && typeof d === "object") {
          const loc = Array.isArray(d.loc) ? d.loc.join(".") : "?";
          return `${loc}: ${d.msg !== undefined ? d.msg : JSON.stringify(d)}`;
        }
        return String(d);
      }).join("; ");
    }
    if (typeof detail === "object") return detail.msg ? String(detail.msg) : JSON.stringify(detail);
    return String(detail);
  }

  /* ------------------------------------- "why can't I reach the API?" */
  /**
   * A failed fetch() looks identical whether the server is down or the browser
   * blocked the response for lack of CORS headers. A `no-cors` request resolves
   * (opaque) as long as *something* answers, which tells the two apart.
   * Returns { kind: "cors" | "down", message }.
   */
  async function diagnoseNetwork(base, loc = (typeof location !== "undefined" ? location : null)) {
    const isFile = !!loc && loc.protocol === "file:";
    const origin = loc ? (isFile ? "file:// (origin “null”)" : loc.origin) : "this page";
    let answered = false;
    try { await fetch(base + "/", { mode: "no-cors" }); answered = true; } catch (_) { /* nothing listening */ }
    const serveHint = "Serve the frontend over http instead of opening the file: run `python -m http.server 5500` in the frontend folder and open http://localhost:5500.";
    if (answered) {
      return {
        kind: "cors",
        message: `The API at ${base} is running, but the browser blocked the response (CORS). ` +
          (isFile ? `This page was opened from ${origin}, which CORS allow-lists reject. ${serveHint}`
                  : `Add ${origin} to allow_origins in CORSMiddleware (see README).`),
      };
    }
    return {
      kind: "down",
      message: `Nothing answered at ${base}. Start the backend (uvicorn main:app --port 8000) or fix the API address.` +
        (isFile ? ` Also note this page was opened from file:// — ${serveHint}` : ""),
    };
  }

  /* ------------------------------------------------ /features (item 4) */
  function normalizeField(f, warn) {
    const enc = f.encoding;
    let options;
    if (Array.isArray(f.options) && f.options.length) options = f.options;
    else if (isPlainObject(f.options) && Object.keys(f.options).length) options = Object.keys(f.options);
    else if (Array.isArray(enc) && enc.length) options = enc;

    let type = f.type;
    let yesNo;
    if (options) {
      if (options.length === 2 && options.every((o) => YN_TOKEN.test(String(o)))) {
        // a Y/N pair keeps the segmented Yes/No widget and remembers the
        // backend's exact tokens/casing so normalizePayload can echo them.
        type = "yn";
        yesNo = [options.find((o) => /^y/i.test(String(o))), options.find((o) => /^n/i.test(String(o)))];
        options = undefined;
      } else {
        type = "select";                       // options present => select
      }
    } else if (typeof enc === "string" && enc.toLowerCase() === "yn") {
      type = "yn";
    } else {
      if (enc !== undefined && enc !== null) {
        warn(`field "${f.name}": unsupported encoding ${show(enc)} — cannot build a widget from it`);
      }
      if (!FIELD_TYPES.includes(type)) {
        const d = f.default !== undefined ? f.default : f.def;
        if (typeof d === "boolean") type = "bool";
        else if (typeof d === "string" && YN_TOKEN.test(d)) type = "yn";
        else type = "number";
      }
    }
    if (type === "select" && !options) {
      warn(`field "${f.name}": type "select" but no options were provided`);
    }
    return {
      name: f.name, label: f.label || f.name, type,
      min: f.min, max: f.max, unit: f.unit,
      options, yesNo,
      def: f.default !== undefined ? f.default : f.def,
    };
  }

  function normalizeFeaturesEndpoint(data, warn = (...a) => console.warn("[ccai]", ...a)) {
    const rawGroups = data && (data.groups || data);
    if (!Array.isArray(rawGroups)) return [];
    const out = [];
    for (const g of rawGroups) {
      if (!g) continue;
      const gname = g.group || g.name || g.title;
      const fields = g.fields || g.features || g.items;
      if (!gname || !Array.isArray(fields)) continue;
      const norm = [];
      for (const f of fields) {
        if (!f || !f.name) { warn("skipping a /features entry without a name", f); continue; }
        norm.push(normalizeField(f, warn));
      }
      if (norm.length) out.push({ group: gname, fields: norm });
    }
    return out;
  }

  /** Human-readable differences between two schemas (empty array = identical). */
  function diffSchemas(remote, local) {
    const diffs = [];
    const rg = remote.map((g) => g.group), lg = local.map((g) => g.group);
    if (JSON.stringify(rg) !== JSON.stringify(lg)) {
      diffs.push(`groups differ: remote [${rg.join(", ")}] vs fallback [${lg.join(", ")}]`);
    }
    const index = (schema) => {
      const m = new Map();
      for (const g of schema) for (const f of g.fields) m.set(f.name, { group: g.group, type: f.type });
      return m;
    };
    const rm = index(remote), lm = index(local);
    for (const [name, l] of lm) {
      const r = rm.get(name);
      if (!r) { diffs.push(`field "${name}" is missing from /features`); continue; }
      if (r.group !== l.group) diffs.push(`field "${name}": group "${r.group}" vs fallback "${l.group}"`);
      if (r.type !== l.type) diffs.push(`field "${name}": widget "${r.type}" vs fallback "${l.type}"`);
    }
    for (const name of rm.keys()) if (!lm.has(name)) diffs.push(`field "${name}" is not in the fallback schema`);
    return diffs;
  }

  /* -------------------------------------------- payload casing (item 10) */
  function normalizePayload(payload, schema) {
    const out = { ...payload };
    for (const g of schema) {
      for (const f of g.fields) {
        const v = out[f.name];
        if (v === undefined) continue;
        if (f.type === "yn" && typeof v === "string") {
          const yes = /^y/i.test(v);
          out[f.name] = f.yesNo ? f.yesNo[yes ? 0 : 1] : (yes ? "Y" : "N");
        } else if (f.type === "select" && Array.isArray(f.options)) {
          const hit = f.options.find((o) => String(o).toLowerCase() === String(v).toLowerCase());
          if (hit !== undefined) out[f.name] = hit;     // use the backend's string verbatim
        }
      }
    }
    return out;
  }

  /* ------------------------------------------- /predict contract (item 3) */
  /**
   * Validates a POST /predict response against the contract the UI renders.
   *  errors   -> blocking (UI refuses to render and shows an error toast)
   *  warnings -> renderable but suspicious
   *  data     -> copy with vessels/explanation keys upper-cased (item 5)
   * opts.explain       the request asked for explain=true
   * opts.strictExplain explanation problems become errors (test page)
   */
  function validatePredictResponse(out, opts = {}) {
    const errors = [], warnings = [];
    if (!isPlainObject(out)) {
      return { ok: false, errors: ["response is not a JSON object"], warnings, data: null };
    }
    const data = { ...out };

    const cad = out.cad;
    if (!isPlainObject(cad)) {
      errors.push("cad: missing");
    } else {
      if (!isProb(cad.cad_probability)) errors.push(`cad.cad_probability: expected a number in [0,1], got ${show(cad.cad_probability)}`);
      if (!nonEmptyStr(cad.predicted_status)) errors.push(`cad.predicted_status: expected a non-empty string, got ${show(cad.predicted_status)}`);
      if (!nonEmptyStr(cad.risk_band) || !RISK_BANDS.includes(cad.risk_band.toLowerCase())) {
        errors.push(`cad.risk_band: expected one of ${RISK_BANDS.join("|")}, got ${show(cad.risk_band)}`);
      }
    }

    const vessels = upperKeys(out.vessels);
    if (!vessels) {
      errors.push("vessels: missing");
    } else {
      for (const v of VESSELS) {
        const d = vessels[v];
        if (!isPlainObject(d)) { errors.push(`vessels.${v}: missing`); continue; }
        if (!isProb(d.stenosis_probability)) errors.push(`vessels.${v}.stenosis_probability: expected a number in [0,1], got ${show(d.stenosis_probability)}`);
        if (!nonEmptyStr(d.predicted_label)) errors.push(`vessels.${v}.predicted_label: expected a non-empty string, got ${show(d.predicted_label)}`);
        else if (!/^(sten|norm)/i.test(d.predicted_label)) warnings.push(`vessels.${v}.predicted_label: unexpected value ${show(d.predicted_label)} (expected "Sten…"/"Norm…")`);
      }
    }
    data.vessels = vessels || {};

    const expl = out.explanation === null || out.explanation === undefined ? null : upperKeys(out.explanation);
    const bucket = opts.strictExplain ? errors : warnings;
    if (opts.explain && !expl) bucket.push("explanation: missing although explain=true");
    if (expl) {
      if (opts.strictExplain && !Array.isArray(expl.CAD)) errors.push("explanation.CAD: missing");
      for (const [k, arr] of Object.entries(expl)) {
        if (!Array.isArray(arr)) { bucket.push(`explanation.${k}: expected an array`); continue; }
        let bad = 0;
        for (const it of arr) {
          const ok = isPlainObject(it) && nonEmptyStr(it.feature) &&
            typeof it.contribution === "number" && Number.isFinite(it.contribution) &&
            nonEmptyStr(it.direction) && it.value !== null && it.value !== undefined;
          if (!ok) bad++;
        }
        if (bad) bucket.push(`explanation.${k}: ${bad} of ${arr.length} entries lack feature/contribution/direction/value`);
      }
    }
    data.explanation = expl;

    return { ok: errors.length === 0, errors, warnings, data };
  }

  return {
    VESSELS, RISK_BANDS, FALLBACK_SCHEMA,
    upperKeys, truthy, isPlainObject,
    labelPolarity, formatDetail, diagnoseNetwork,
    normalizeFeaturesEndpoint, diffSchemas, normalizePayload,
    validatePredictResponse,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CCAI;
