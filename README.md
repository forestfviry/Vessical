# CoronaryCare AI — Frontend

Professional single-page dashboard for the Z-Alizadeh Sani CAD prediction API
(FastAPI backend). No build step, no framework, no external JS dependencies.

## Files
| File | Purpose |
|---|---|
| `index.html` | Page structure (form panel, CAD gauge, vessel schematic, XAI panel, metrics) |
| `styles.css` | Clinical dark-theme design system |
| `contract.js` | DOM-free logic shared by the app and the tests: offline form schema, `/features` normalizer, `/predict` response validator, label vocabulary, payload casing, 422 error formatting |
| `app.js` | API client, auto-generated form, rendering logic (vanilla JS) |
| `test.html` + `test.js` | Integration test page — run before every demo (see “Integration test”) |
| `patient.json` | Example `POST /predict` payload (mirrors `PatientInput`) |
| `backend_fixes.py` | Corrected preprocessor + LIME + `add_cors()` (see “Backend bugs fixed” below) |
| `test_lime.py` | Unit test: every LIME `value` equals the input value of the named feature |

## Run it

```bash
# 1. Start the FastAPI backend (models must be trained + joblib files present)
cd app
uvicorn main:app --reload --port 8000

# 2. Serve the frontend (any static server works)
cd frontend
python -m http.server 5500
# → open http://localhost:5500      (loads index.html, no directory listing)
# → open http://localhost:5500/test.html   to run the integration checks
```

The API address defaults to `http://localhost:8000` and is editable in the
header (persisted to `localStorage`).

Handy URL parameter: `http://localhost:5500/?patient=12` loads dataset record
#12 into the form on start-up (the “Load demo patient” toast shows the index
it picked, so a demo can be repeated exactly).

## Required backend addition — CORS

Browsers block cross-origin calls, so add `CORSMiddleware` to `app/main.py`
(this is the only backend change needed). Either paste this:

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:8000",   # if frontend is served by FastAPI itself
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

…or call the helper shipped in `backend_fixes.py`: `add_cors(app)`.

**Verify:** DevTools → Network → `GET /` returns 200 with an
`access-control-allow-origin` response header. If the header is missing, CORS is
not configured (the UI will show “API unreachable”).

Alternative (zero CORS): mount the frontend inside FastAPI —

```python
from fastapi.staticfiles import StaticFiles
app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")
```

(`html=True` serves `index.html` for `/`, which is why the file is named exactly
that.) Mount it **after** all API routes, otherwise it shadows them.

## Endpoint contract the frontend expects

| Endpoint | Used for | Graceful fallback if missing |
|---|---|---|
| `GET /` | Connection status pill | Shows “API unreachable” |
| `POST /predict?explain=true` | CAD prob + vessel probs + LIME | Error toast (response contract is validated, see below) |
| `GET /dataset/patient/{i}` | “Load demo patient” + ground truth | Error toast |
| `GET /dataset/size` *(optional)* | Row count for the random demo patient — number, or `{size\|n\|count\|rows}` | Constant `DATASET_SIZE = 303` |
| `GET /features` | Auto-build form groups/ranges/encodings | Embedded offline schema in `contract.js` (all `PatientInput` fields) + a toast saying so |
| `GET /metrics` | Validation cards + permutation importance table | Empty state |

### `POST /predict` response

```json
{
  "cad": {"cad_probability": 0.91, "predicted_status": "CAD", "risk_band": "high"},
  "vessels": {"LAD": {"stenosis_probability": 0.83, "predicted_label": "Stenotic"}},
  "explanation": {"CAD": [{"feature": "Typical Chest Pain", "contribution": 0.14,
                           "direction": "increases risk", "value": 1}]},
  "disclaimer": "..."
}
```

`CCAI.validatePredictResponse` (contract.js) checks this on every call. The
dashboard **refuses to render** a response that breaks it and shows which field
is wrong, instead of drawing a misleading `0.0%`:

- `cad.cad_probability` number in [0, 1]; `cad.predicted_status` non-empty string
- `cad.risk_band` ∈ `low | moderate | medium | high` (drives the gauge colour)
- `vessels.LAD|LCX|RCA` each with `stenosis_probability` in [0, 1] and a
  `predicted_label` starting with `Sten…` / `Norm…`
- `explanation.<TARGET>[]` entries with `feature`, `contribution`, `direction`,
  `value` (problems here are warnings in the UI, failures on the test page)

`vessels` / `explanation` keys are matched case-insensitively (`cad` == `CAD`).

### `GET /features`

Parsed flexibly: `groups[].fields[]` with
`{name, label, type, min, max, unit, options, default}`. Rules (item 4):

- `options` present → `select` (a two-value Y/N list stays the segmented Yes/No
  widget and its exact tokens/casing are echoed back in the payload)
- `encoding: "yn"` → Yes/No widget; any other `encoding` is logged with
  `console.warn` (it cannot be turned into a widget)
- a `select` without options is not rendered as a free-text box: it shows an
  error hint and is reported as missing when you press Run

If the shape is unrecognised the offline schema is kept **and** a toast says
so; the raw response is logged with `console.warn`. Differences from the
offline schema (groups, names, widget types) are logged to the console.

### `GET /metrics`

The dashboard renders exactly this shape and dumps anything else verbatim in a
“Unrendered fields” `<pre>` block, so nothing is silently dropped:

```jsonc
{
  "<metric>": 0.93,                           // optional overall metrics (numbers)
  "CAD": {                                    // optional per-target objects
    "auc": 0.95, "accuracy": 0.91,            //   numbers  -> metric cards
    "permutation_importance": [               //   [{feature, importance}] -> table
      {"feature": "Age", "importance": 0.031}
    ]
  },
  "permutation_importance": [ ... ]           // optional top-level list
}
```

## Integration test

Open `http://localhost:5500/test.html` (it reuses the API address saved in the
dashboard). It calls `/`, `/features`, `/metrics`, `/dataset/patient/0`,
`/predict?explain=true` (with `patient.json`) and `POST /predict {}`, asserts
the shapes above and prints a PASS / FAIL / WARN table. It also checks that
every LIME `value` equals the request field it names, that `ground_truth`
keys/labels are in the vocabulary the ✓/✗ chips understand, and that 422 errors
are human-readable.

Backend unit test (no server needed):

```bash
pip install scikit-learn pandas numpy
python test_lime.py
```

## Notes
- The coronary schematic is a self-contained interactive SVG (LAD/LCX/RCA
  selectable, colored by stenosis probability) — no external assets required.
- BMI auto-computes from weight/height until manually edited; clearing the
  field or pressing **Reset** switches auto-calc back on, and loading a demo
  patient without a BMI value derives it.
- Demo-patient ground truth chips show ✓/✗ agreement with the model. Labels are
  compared through an explicit vocabulary (`Normal`/`No CAD` = negative,
  `CAD`/`Stenotic`/`Mild`/`Moderate`/`Severe` = positive); unknown labels give a
  neutral chip with `?` instead of a guess.
- The last prediction (inputs + result) is kept in `localStorage` (`ccai_last`)
  and re-rendered after a refresh. **Clear last result** in the header removes it.
- Layout: on wide screens the form is a sticky left rail that scrolls
  internally; below 1180 px each form group is a collapsed `<details>`.
- Accessibility: results are `aria-live`, Yes/No controls are radio groups,
  explanation tabs follow the tab/tabpanel pattern (arrow keys work), and every
  interactive element has a visible `:focus-visible` style.
- **Copy payload JSON** (next to Run) puts the current form on the clipboard as
  a `POST /predict` body — paste it into `/docs` to reproduce a failure.
- To upgrade to a real 3D heart later: drop a `.glb` (e.g., NIH 3D Print
  Exchange / Sketchfab coronary models) into `assets/` and load it with
  Three.js `GLTFLoader`, driving material emissive color per-vessel from
  `stenosis_probability` (the three vessel IDs already exist as constants).

## Backend bugs fixed (backend_fixes.py)

The original snippets had these defects that break real inference/explanations:

1. **BBB column** — the raw dataset contains `LBBB`/`RBBB`, not Y/N, so the
   `YN_MAP` produced NaN for those rows. Now mapped explicitly.
2. **NaN leak** — any unmapped categorical value (typo, unexpected token)
   silently became NaN and was fed to the model. Mapped columns are filled
   with the negative class after mapping.
3. **LIME crash on every input** — `contributions` had shape `(1, n)` (one-row
   `x_encoded`), so `np.argsort` returned 2-D indices and `float(x_encoded.iloc[i])`
   raised `TypeError`. Fixed with `.ravel()` and `iloc[0, i]`.
4. **Wrong explanation signs** — the regression's intercept column was appended
   unweighted after the data was multiplied by `sqrt(w)`, biasing the weighted
   least-squares fit. Now the intercept is weighted too.
5. **Index-axis invariant locked in** — `x_encoded` may now be a Series, a
   one-row DataFrame or a NumPy row; it is normalised to a one-row DataFrame
   whose columns are re-ordered to match `background`, so
   `contributions[i]`, `background.columns[i]` and `x_encoded.iloc[0, i]` always
   refer to the same feature (asserted in code, covered by `test_lime.py`,
   and by the “LIME `value` equals the request field” check on `test.html`).

Drop these two functions/classes into `app/main.py` (replacing the originals)
— the public signatures are unchanged.
