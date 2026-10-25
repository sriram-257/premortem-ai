# PreMortem — See the Crash Before It Happens

**AI Incident Command Center | Track 01: Software & AI**

PreMortem is an AI-powered incident forecasting and recovery platform built around a simulated 14-service application. It helps teams anticipate cascading failures, identify likely root causes, compare recovery strategies, and simulate the impact of applying a recovery plan before an incident spreads.

**Live Demo:** https://premortem-ai-1-i3h9.onrender.com/  
**Backend API:** https://premortem-ai-h6je.onrender.com  
**API Documentation:** https://premortem-ai-h6je.onrender.com/docs  
**GitHub Repository:** https://github.com/sriram-257/premortem-ai

---

## The Problem

Modern applications depend on interconnected services. A database, cache, or payment-service failure can propagate through the dependency graph and cause a wider outage.

Traditional threshold-based monitoring often detects failures after service health has already deteriorated. Engineers then need to identify the source, understand downstream impact, and choose a safe recovery strategy under time pressure.

PreMortem explores a proactive approach: forecast risk from observable signals, trace likely root causes, and compare recovery options before applying a simulated intervention.

## How It Works

1. **Forecast service risk:** A pre-trained gradient-boosting model uses observable service metrics and dependency-graph features to estimate which services may fail within a two-minute forecast horizon.
2. **Trace the root cause:** Dependency-graph analysis helps identify the likely source of an incident and visualize how its effects propagate.
3. **Compare recovery strategies:** A Monte Carlo-style simulator evaluates seven recovery strategies, estimates their outcomes, and explains the trade-offs, including the cost of waiting.
4. **Apply a simulated recovery:** Compare incident progression with and without the selected intervention on the same timeline.
5. **Explore alternate incidents:** Trigger different faults and observe how the forecast and recommended recovery response change.

## Key Features

- Interactive 14-service dependency graph.
- Live incident and fault simulation.
- Two-minute service-risk forecasting.
- Root-cause analysis and downstream propagation visualization.
- Recovery Lab with seven candidate strategies.
- Simulated outcome comparison and cost-of-delay analysis.
- Before-and-after incident timelines.
- Pre-trained machine-learning model.
- Offline graph and preset fallback using `public/snapshot.json`.
- FastAPI backend and React dashboard.

## Architecture

```text
React + TypeScript + Vite
          |
          | REST API
          v
      FastAPI
          |
          +-- Service dependency graph
          +-- Incident simulation
          +-- ML risk forecasting
          +-- Root-cause analysis
          +-- Recovery strategy evaluation
          |
          +-- model.joblib
          +-- model_stats.json
```

### Technology Stack

| Layer | Technologies |
|---|---|
| Frontend | React, TypeScript, Vite |
| Backend | Python, FastAPI, Uvicorn |
| Machine learning | scikit-learn, HistGradientBoosting, NumPy |
| Model persistence | Joblib |
| Visualization | Recharts |
| Simulation | Dependency-graph propagation, Monte Carlo-style recovery evaluation |
| Development | GitHub, GitHub Codespaces, GitHub Copilot |
| Deployment | Render |

## Model and Evaluation

PreMortem ships with a pre-trained model in `model.joblib`. The accompanying `model_stats.json` contains model metadata and evaluation results used by the API.

The model uses observable metrics and dependency-graph features to estimate service-failure risk. The application then combines the forecast with graph-based diagnosis and simulated recovery evaluation.

The current model metadata reports approximately:

| Metric | Reported value |
|---|---:|
| AUC with dependency-graph features | 0.9155 |
| AUC without dependency-graph features | 0.9007 |
| Precision | 0.899 |
| Recall | 0.696 |
| Forecast horizon | 120 seconds |

These are evaluation metadata values, not a guarantee of real-world production performance. Results depend on the simulated dataset, evaluation setup, and model version.

### Understanding the Results

- The model's AUC indicates how well it separates positive and negative examples in the evaluated dataset.
- Precision and recall describe different aspects of prediction performance; they should be interpreted together.
- Recovery impact is a **simulated criticality-weighted downtime measure**, not a monetary loss estimate.
- Strategy outcomes depend on the simulator's assumptions and are not evidence that a recovery action will succeed at the same rate in a real production system.

## Run Locally

### Prerequisites

- Python installed
- Node.js and npm installed
- Git

### 1. Clone the repository

```bash
git clone https://github.com/sriram-257/premortem-ai.git
cd premortem-ai
```

### 2. Install backend dependencies

```bash
pip install -r requirements.txt
```

### 3. Start the backend

```bash
uvicorn api:app --host 0.0.0.0 --port 8000
```

Open the interactive API documentation at:

http://localhost:8000/docs

### 4. Start the frontend

Open a second terminal in the project directory:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, usually:

http://localhost:5173

The frontend uses `http://localhost:8000` as its local development API by default.

### Optional: Regenerate the offline snapshot

```bash
python export_snapshot.py
```

The repository already includes the offline fallback file. Regenerate it only when needed.

### Optional: Retrain the model

```bash
python -c "import engine; engine.train_model()"
```

Retraining may overwrite the existing model artifact. Preserve the submitted model unless you intend to validate and redeploy a new model version.

## API Endpoints

The FastAPI backend exposes the following endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Service health check |
| `GET` | `/api/graph` | Service graph and incident configuration |
| `GET` | `/api/model` | Model metadata and evaluation statistics |
| `POST` | `/api/simulate` | Simulate an incident |
| `POST` | `/api/plan` | Evaluate recovery strategies |
| `POST` | `/api/compare` | Compare incident outcomes with and without recovery |

### Example: Compare Recovery Outcomes

```bash
curl -X POST "http://localhost:8000/api/compare" \
  -H "Content-Type: application/json" \
  -d '{"root":"db-primary","kind":"leak","seed":7}'
```

The endpoint returns a comparison of simulated incident progression with and without the recovery intervention.

## Deployment

The project is deployed as two separate Render services.

**Frontend**

https://premortem-ai-1-i3h9.onrender.com/

**Backend**

https://premortem-ai-h6je.onrender.com

### Backend Configuration

Build command:

```bash
pip install -r requirements.txt
```

Start command:

```bash
uvicorn api:app --host 0.0.0.0 --port $PORT
```

Render supplies the `$PORT` environment variable. Do not hard-code port `8000` in the hosted service.

### Model Compatibility

The serialized model was created with scikit-learn 1.8.0. Keep the pinned `scikit-learn` and `joblib` versions in `requirements.txt` so the deployed artifact remains compatible.

Include both `model.joblib` and `model_stats.json` in the backend deployment. The API relies on the metadata file when serving `/api/model`.

### Frontend API Configuration

Production builds use the deployed backend URL by default. To configure another API origin, set:

```bash
VITE_API_BASE=https://your-api.example
```

For the current deployment, use:

```bash
VITE_API_BASE=https://premortem-ai-h6je.onrender.com
```

Configure the backend's `PREMORTEM_CORS_ORIGINS` environment variable with the exact frontend origin, without a trailing slash:

```bash
PREMORTEM_CORS_ORIGINS=https://premortem-ai-1-i3h9.onrender.com
```

For multiple approved origins, separate them with commas.

## Demo Walkthrough

A suggested 90-second demonstration:

1. **Start with a healthy platform.** Introduce the 14-service dependency graph.
2. **Trigger an incident.** Select a service fault or use the Database Meltdown preset.
3. **Show the forecast.** Highlight services predicted to become unhealthy before their simulated failure.
4. **Explain the root cause.** Trace how the incident propagates through dependent services.
5. **Open the Recovery Lab.** Compare the simulated futures of candidate strategies and the cost of delaying intervention.
6. **Apply the recommended recovery.** Show the incident timeline with and without the intervention.
7. **Try another fault.** Demonstrate that a different incident can produce a different recommended strategy.

## Important Limitations

PreMortem is a **simulation-based prototype**, not a production incident-response system.

- The service environment and incident data are simulated.
- Model evaluation results reflect the available simulated dataset and evaluation methodology.
- Recovery outcomes depend on modeled assumptions; they are not guaranteed in real systems.
- The forecast is most useful when observable signals provide warning. A failure that occurs instantly at the root service cannot be forecast in advance by this model.
- Real deployments would require integration with production telemetry, careful validation, security controls, and human approval for operational recovery actions.

## Future Work

- Integrate real service telemetry using OpenTelemetry.
- Validate forecasts against real incident traces.
- Learn dependency and propagation strengths from observed data.
- Add model monitoring, drift detection, and periodic evaluation.
- Integrate with incident-management and observability platforms.
- Add policy controls and human approval for real recovery workflows.

## Project Goal

PreMortem demonstrates how machine learning, dependency-graph analysis, and simulation-based planning can work together to help engineers understand potential incidents earlier and make better-informed recovery decisions.

**See the crash before it happens.**
