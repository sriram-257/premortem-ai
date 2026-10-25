# PreMortem — see the crash before it happens

Track 01 (Software & AI). A simulated 14-service platform that you can break live. The AI:
1. **Forecasts** which services will fail in the next 2 minutes (gradient-boosted model on observable metrics + dependency-graph features),
2. **Traces the root cause** through the dependency graph and shows how the failure propagates,
3. **Simulates the futures** of 7 recovery strategies (Monte Carlo) and picks the best one, with its reasoning and the cost of waiting,
4. Lets the judge **apply it and watch the cascade stop** (same timeline, with vs without AI).

## Run it (3 commands)
```bash
pip install -r requirements.txt
python export_snapshot.py          # optional: offline fallback file (already included)
uvicorn api:app --host 0.0.0.0 --port 8000
```
Model is pre-trained (`model.joblib`). To retrain: `python -c "import engine; engine.train_model()"` (~10 s).

The deployed model metadata file `model_stats.json` must be included with
`model.joblib`; `/api/model` reads it at startup/runtime. The model artifact
is serialized with scikit-learn 1.8.0. Keep the pinned
versions in `requirements.txt`; newer scikit-learn releases can fail during
startup while loading the artifact because they move private loss modules.
Render can continue using Python 3.14 with these dependency pins.

For Render, use `pip install -r requirements.txt` as the build command and
`uvicorn api:app --host 0.0.0.0 --port $PORT` as the start command. Render
provides `$PORT`; do not hard-code port 8000 in the hosted service.

Check it: open http://localhost:8000/docs  → try `POST /api/compare` with `{"root":"db-primary","kind":"leak","seed":7}`.

## Run the frontend

Install the frontend dependencies and start the Vite development server in a second terminal:

```bash
npm install
npm run dev
```

The dashboard uses `http://localhost:8000` during local development. Production
builds default to the deployed API at
`https://premortem-ai-h6je.onrender.com`. Set `VITE_API_BASE` explicitly when
the API is hosted elsewhere:

```bash
VITE_API_BASE=https://your-api.example npm run dev
```

For a production build, create a `.env.production` file (or configure the
variable in your frontend hosting provider) with:

```bash
VITE_API_BASE=https://premortem-ai-h6je.onrender.com
```

`public/snapshot.json` is used as the offline graph and preset fallback when the API cannot be reached.

### CORS configuration

The API allows local Vite origins by default. When deploying the frontend,
set `PREMORTEM_CORS_ORIGINS` on the Render backend to the exact frontend origin
(including `https://` and excluding a trailing slash). Multiple origins may be
comma-separated:

```bash
PREMORTEM_CORS_ORIGINS=https://your-frontend.example,https://preview.example
```

Keep `https://premortem-ai-h6je.onrender.com` as the `VITE_API_BASE` value; it
is the API origin, not the frontend CORS origin.

## Connect Lovable
- Backend on the same laptop you demo on: Lovable preview calls `http://localhost:8000` from your browser (the local Vite origins are allowed by default).
  If Chrome blocks it / asks for local-network permission, allow it, or tunnel: `npx cloudflared tunnel --url http://localhost:8000`
  (or `ngrok http 8000`) and set `VITE_API_BASE` to the https URL.
- Put `snapshot.json` in the Lovable project's `public/` folder = automatic offline fallback.

## 90-second demo script
1. "This is a 14-service platform. Everything is green." (Point at the AI model drawer: lead time, 0 false alarms.)
2. **Hand the mouse to a judge**: "Click any service, pick a fault." (Or press the *Database meltdown* preset.)
3. Halo rings appear on services that are still green: "These haven't failed yet. The AI forecasts they will, ~2 minutes ahead."
4. Playback auto-pauses at diagnosis: "Root cause: db-primary. It was the first to deviate, and N of M anomalies sit downstream of it."
5. Recovery lab: race chart. "It simulated 40 futures for each of 7 strategies. Doing nothing costs X. Restart + circuit-break costs Y."
   Point at cost-of-delay: "Every 30 seconds of waiting makes it worse."
6. **Let AI fix it** → cascade stops. Reveal card: impact 3,307 → 104.
7. Judge breaks something different (e.g. payments crash) → AI picks a *different* strategy (failover). "It's reasoning, not a script."

## What is measured (numbers come from `model_stats.json`, not hand-typed)
| Claim | Value |
|---|---|
| Forecast window | 2 minutes (12 ticks x 10 s) |
| Mean warning before a service fails | **94 s** (AI) vs 50 s (alert at 30% errors) vs 26 s (alert at 50% errors) |
| Held-out AUC | 0.917 with dependency-graph features vs 0.905 without |
| False alarms | 0 in 25,200 healthy service-ticks |
| Failures with no warning | 0 of 83 held-out failures |
| Applied-strategy outcome (sim) | DB leak 3,307 → 104 impact; payments crash 1,615 → 83; cache overload 1,721 → 7 |

## Be honest with judges (it protects you from tough questions)
- Everything runs on a **simulator we built**; the training data is simulated incidents. Say "simulated" out loud.
- The graph-feature gain is modest (+0.012 AUC). The *bigger* AI value is lead time and the planner.
- A crash at the root service can't be forecast (it happens instantly); the AI's value there is **containing the cascade**.
- "Impact" = criticality-weighted downtime, not dollars. Strategy effects (e.g. restart fixes a leak 95% of the time) are modelled assumptions.
- The planner sees only observable metrics + its own root-cause diagnosis, never the hidden fault.
- Next steps if asked: replace the simulator with real traces (OpenTelemetry), learn coupling weights from data.

## Files
- `engine.py`  simulator, features, model training, forecasting, root-cause tracing, Monte-Carlo planner
- `api.py`  FastAPI: `/api/graph`, `/api/simulate`, `/api/plan`, `/api/compare`, `/api/model`
- `LOVABLE_PROMPTS.md`  three prompts with the exact API contract
- `snapshot.json`  precomputed demo data for offline mode
