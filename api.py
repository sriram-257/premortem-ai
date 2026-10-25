"""PreMortem API.   Run:  uvicorn api:app --host 0.0.0.0 --port 8000"""
from __future__ import annotations

import os
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import engine as E

app = FastAPI(title="PreMortem API", version="1.0")
configured_origins = os.getenv("PREMORTEM_CORS_ORIGINS", "")
cors_origins = [
    origin.strip().rstrip("/")
    for origin in configured_origins.split(",")
    if origin.strip()
]
if not cors_origins:
    cors_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
app.add_middleware(CORSMiddleware, allow_origins=cors_origins, allow_methods=["*"], allow_headers=["*"])
E.get_model()  # load (or train) once at startup

PRESETS = [
    dict(id="db-meltdown", title="Database meltdown", root="db-primary", kind="leak", seed=7,
         blurb="Slow memory leak in the primary database. Watch it take the platform down."),
    dict(id="payments-crash", title="Payments crash", root="payments", kind="crash", seed=7,
         blurb="Payments dies instantly. Can't be predicted, but the cascade can be contained."),
    dict(id="cache-storm", title="Cache storm", root="cache", kind="overload", seed=7,
         blurb="Cache is overloaded. Soft dependencies degrade across half the system."),
]


def clock(t: int) -> str:
    s = 9 * 3600 + t * E.TICK_SECONDS
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


class ScenarioReq(BaseModel):
    root: Optional[str] = "db-primary"      # a service name, or null for a healthy system
    kind: Optional[str] = "leak"            # leak | crash | overload
    seed: int = 7
    onset: int = 15
    ticks: int = 90
    strategy: Optional[str] = None          # applied from act_tick onward
    act_tick: Optional[int] = None


class PlanReq(BaseModel):
    root: Optional[str] = "db-primary"
    kind: Optional[str] = "leak"
    seed: int = 7
    onset: int = 15
    tick: Optional[int] = None              # default: first tick a root cause exists


def _validate(r):
    if r.root is not None and r.root not in E.IDX:
        raise HTTPException(400, f"unknown service '{r.root}'. Valid: {E.NAMES}")
    if r.root is not None and r.kind not in E.FAULT_KINDS:
        raise HTTPException(400, f"kind must be one of {E.FAULT_KINDS}")
    if getattr(r, "strategy", None) and r.strategy not in E.STRATEGIES:
        raise HTTPException(400, f"strategy must be one of {list(E.STRATEGIES)}")


def diagnosis_tick(err) -> Optional[int]:
    for t in range(1, err.shape[0]):
        if E.root_cause(err, t):
            return t
    return None


def timeline(req: ScenarioReq) -> dict:
    _validate(req)
    kind = req.kind if req.root else None
    sim = E.run_scenario(req.root, kind, req.seed, req.ticks, req.onset, req.strategy, req.act_tick)
    P = E.forecast(sim)
    H, SHED = sim["H"], sim["SHED"]
    status = np.where(SHED, "shed", np.where(H < E.FAIL_T, "failed", np.where(H < E.DEGRADED_T, "degraded", "healthy")))
    out_ticks = []
    for t in range(req.ticks):
        svc = {n: dict(status=str(status[t, i]), err=round(float(sim["ERR"][t, i]), 3), lat=int(sim["LAT"][t, i]),
                       cpu=round(float(sim["CPU"][t, i]), 2), mem=round(float(sim["MEM"][t, i]), 2),
                       p_fail=round(float(P[t, i]), 3))
               for i, n in enumerate(E.NAMES)}
        rc = E.root_cause(sim["ERR"], t)
        out_ticks.append(dict(
            t=t, clock=clock(t), impact=round(float(sim["LOSS"][t]), 1), services=svc,
            logs=[dict(clock=clock(t), **l) for l in sim["logs"][t]],
            rca=None if rc is None else dict(service=rc["service"], confidence=rc["confidence"],
                                              affected=[a["service"] for a in rc["affected"]], edges=rc["edges"])))
    failed_any = (status == "failed").any(axis=1)
    warn = np.where(((P >= 0.5) & (status != "failed")).any(axis=1))[0]
    ff = np.where(failed_any)[0]
    dt = diagnosis_tick(sim["ERR"])
    first_warn = int(warn[0]) if len(warn) else None
    first_fail = int(ff[0]) if len(ff) else None
    cum = np.cumsum(sim["LOSS"])
    return dict(
        scenario=dict(root=req.root, kind=kind, seed=req.seed, onset=req.onset, ticks=req.ticks,
                      strategy=req.strategy, act_tick=req.act_tick, tick_seconds=E.TICK_SECONDS),
        services=E.NAMES, ticks=out_ticks,
        summary=dict(
            first_warning_tick=first_warn, first_failure_tick=first_fail, diagnosis_tick=dt,
            warning_lead_seconds=(None if first_warn is None or first_fail is None or first_warn > first_fail
                                  else (first_fail - first_warn) * E.TICK_SECONDS),
            peak_failed=int((status == "failed").sum(axis=1).max()),
            total_impact=round(float(cum[-1]), 1), impact_cumulative=[round(float(x), 1) for x in cum]))


@app.get("/api/health")
def health():
    return dict(ok=True, services=E.N)


@app.get("/api/graph")
def graph():
    nodes = [dict(id=n, tier=v["tier"], criticality=v["crit"], has_standby=v["standby"], stateful=v["stateful"],
                  x=v["x"], y=v["y"]) for n, v in E.SERVICES.items()]
    edges = [dict(source=s, target=d, coupling=w) for s, lst in E.DEPS.items() for d, w in lst]  # source depends on target
    return dict(nodes=nodes, edges=edges, fault_kinds=E.FAULT_KINDS, presets=PRESETS,
                strategies=[dict(id=k, label=v) for k, v in E.STRATEGIES.items()],
                tick_seconds=E.TICK_SECONDS,
                note="An edge source->target means 'source depends on target': failures flow from target to source.")


@app.get("/api/model")
def model():
    return E.model_stats()


@app.post("/api/simulate")
def simulate(req: ScenarioReq):
    return timeline(req)


@app.post("/api/plan")
def plan(req: PlanReq):
    _validate(req)
    kind = req.kind if req.root else None
    full = E.run_scenario(req.root, kind, req.seed, 90, req.onset, want_logs=False)
    t = req.tick if req.tick is not None else diagnosis_tick(full["ERR"])
    if t is None:
        return dict(ok=False, reason="No anomaly detected yet, nothing to plan for.")
    sim = E.run_scenario(req.root, kind, req.seed, t + 1, req.onset, want_logs=False)
    res = E.plan(sim, t)
    if res.get("ok"):
        res["clock"] = clock(t)
    return res


@app.post("/api/compare")
def compare(req: PlanReq):
    """One call for the 'without AI vs with AI' reveal: plan, apply the recommendation, return both timelines."""
    pl = plan(req)
    if not pl.get("ok"):
        return dict(plan=pl)
    base = timeline(ScenarioReq(root=req.root, kind=req.kind, seed=req.seed, onset=req.onset))
    fixed = timeline(ScenarioReq(root=req.root, kind=req.kind, seed=req.seed, onset=req.onset,
                                 strategy=pl["recommended"], act_tick=pl["tick"]))
    b, f = base["summary"]["total_impact"], fixed["summary"]["total_impact"]
    return dict(plan=pl, without_ai=base, with_ai=fixed,
                headline=dict(impact_without=b, impact_with=f, saved_pct=round(100 * (1 - f / max(b, 1e-9))),
                              peak_failed_without=base["summary"]["peak_failed"],
                              peak_failed_with=fixed["summary"]["peak_failed"]))
