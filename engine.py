"""PreMortem engine.

Dependency-graph failure simulator + failure forecaster (ML) + root-cause
tracer + Monte-Carlo recovery planner. No web code here (see api.py).

Time: 1 tick = 10 simulated seconds.
Health h in [0,1] per service (hidden). Observable metrics (error rate,
latency, cpu, memory) are derived from h + noise. The ML model, the root-cause
tracer and the planner only ever see the observable metrics.
"""
from __future__ import annotations

import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
TICK_SECONDS = 10
FAIL_T = 0.30        # health below this  -> service FAILED
DEGRADED_T = 0.70    # health below this  -> DEGRADED
HORIZON = 12         # forecast window (ticks): "will it fail within 2 minutes?"
LAG = 2              # propagation delay (ticks): retries/timeouts before a dependent feels an upstream problem
ALPHA = 0.40         # how fast health follows its target (gives cascade lag)
CB_FACTOR = 0.35     # circuit breaker keeps only 35% of upstream pressure
DATA_LOSS = 15.0     # one-off cost of failing over a stateful service

# ------------------------------------------------------------------ topology
SERVICES = {
    "gateway":         dict(tier="edge",  crit=10, standby=True,  stateful=False, lat=40,  x=.50, y=.06),
    "auth":            dict(tier="api",   crit=8,  standby=True,  stateful=False, lat=25,  x=.10, y=.27),
    "users":           dict(tier="api",   crit=5,  standby=True,  stateful=False, lat=30,  x=.30, y=.27),
    "orders":          dict(tier="api",   crit=9,  standby=True,  stateful=False, lat=60,  x=.52, y=.27),
    "search":          dict(tier="api",   crit=4,  standby=False, stateful=False, lat=70,  x=.74, y=.27),
    "recommendations": dict(tier="api",   crit=2,  standby=False, stateful=False, lat=90,  x=.92, y=.27),
    "payments":        dict(tier="core",  crit=10, standby=True,  stateful=False, lat=80,  x=.22, y=.52),
    "inventory":       dict(tier="core",  crit=5,  standby=True,  stateful=False, lat=45,  x=.44, y=.52),
    "notifications":   dict(tier="core",  crit=2,  standby=False, stateful=False, lat=50,  x=.68, y=.52),
    "analytics":       dict(tier="core",  crit=1,  standby=False, stateful=False, lat=120, x=.90, y=.52),
    "cache":           dict(tier="infra", crit=3,  standby=False, stateful=False, lat=2,   x=.12, y=.76),
    "queue":           dict(tier="infra", crit=4,  standby=False, stateful=False, lat=8,   x=.50, y=.76),
    "db-replica":      dict(tier="infra", crit=3,  standby=False, stateful=True,  lat=12,  x=.80, y=.76),
    "db-primary":      dict(tier="infra", crit=10, standby=True,  stateful=True,  lat=10,  x=.30, y=.94),
}
NAMES = list(SERVICES)
IDX = {n: i for i, n in enumerate(NAMES)}
N = len(NAMES)

DEPS = {  # service -> [(dependency, coupling strength)]
    "gateway": [("auth", .65), ("orders", .6), ("users", .4), ("search", .3), ("recommendations", .15)],
    "auth": [("users", .7), ("cache", .5)],
    "users": [("db-primary", .8), ("cache", .4)],
    "orders": [("payments", .8), ("inventory", .6), ("queue", .5), ("db-primary", .8)],
    "payments": [("db-primary", .9), ("auth", .4)],
    "inventory": [("db-primary", .75), ("cache", .5)],
    "search": [("cache", .4), ("db-replica", .7)],
    "recommendations": [("db-replica", .6), ("cache", .5)],
    "notifications": [("queue", .8)],
    "analytics": [("queue", .5), ("db-replica", .6)],
    "db-replica": [("db-primary", .6)],
}
W = np.zeros((N, N))                      # W[s, d] = how much s depends on d
for _s, _lst in DEPS.items():
    for _d, _w in _lst:
        W[IDX[_s], IDX[_d]] = _w
MASK = (W > 0).astype(float)
W2 = W @ W
CRIT = np.array([SERVICES[n]["crit"] for n in NAMES], float)
BASE_LAT = np.array([SERVICES[n]["lat"] for n in NAMES], float)
SHEDDABLE = [IDX[n] for n in ("search", "recommendations", "notifications", "analytics")]

DEPENDENTS = {n: [] for n in NAMES}       # dependency -> services that depend on it
for _s, _lst in DEPS.items():
    for _d, _w in _lst:
        DEPENDENTS[_d].append(_s)


def _closure(start, graph):
    seen, stack = set(), list(graph.get(start, []))
    while stack:
        x = stack.pop()
        if x not in seen:
            seen.add(x)
            stack.extend(graph.get(x, []))
    return seen


DOWNSTREAM = {n: _closure(n, DEPENDENTS) for n in NAMES}                       # who breaks if n breaks
UPSTREAM = {n: _closure(n, {k: [d for d, _ in v] for k, v in DEPS.items()}) for n in NAMES}


def _depth(n):
    return 0 if n not in DEPS else 1 + max(_depth(d) for d, _ in DEPS[n])


STATIC = np.array([[SERVICES[n]["crit"], len(DEPS.get(n, [])), len(DEPENDENTS[n]),
                    _depth(n), sum(w for _, w in DEPS.get(n, []))] for n in NAMES], float)

FAULT_KINDS = ["leak", "crash", "overload"]
STRATEGIES = {
    "do_nothing":            "Do nothing",
    "restart":               "Restart root service",
    "failover":              "Fail over to standby",
    "load_shed":             "Shed non-critical load",
    "circuit_break":         "Circuit-break dependents",
    "restart+circuit_break": "Restart + circuit-break",
    "load_shed+restart":     "Shed load + restart",
}
P_FIX = {  # probability the action actually removes the fault, by fault kind
    "restart":  {"leak": .95, "crash": .70, "overload": .25},
    "failover": {"leak": .92, "crash": .92, "overload": .85},
}


# ------------------------------------------------------------------- world
class World:
    """Hidden-state simulator. One root fault; health propagates along DEPS."""

    def __init__(self, root=None, kind=None, onset=15, rate=0.055, level=0.82, h0=None, f0=0.0):
        self.root = IDX[root] if root else None
        self.kind, self.onset, self.rate, self.level = kind, onset, rate, level
        self.h = np.ones(N) if h0 is None else np.array(h0, float)
        self.f = float(f0)
        self.resolved = False
        self.cap = np.ones(N)
        self.shed = np.zeros(N, bool)
        self.cb = np.zeros(N, bool)
        self.cb_autolift = False
        self.leak_mult = 1.0
        self.over_scale = 1.0
        self.down_until = -1
        self.sched = []
        self.pending_cost = 0.0
        self.events = []
        self.hist = [self.h.copy() for _ in range(LAG + 1)]

    # --- actions -------------------------------------------------------
    def apply(self, strategy, t):
        for p in strategy.split("+"):
            r = NAMES[self.root]
            if p == "restart":
                self.down_until = t + 2
                self.sched.append((t + 2, "restart_done"))
                self.events.append((t, "INFO", r, f"orchestrator: restart issued for {r}"))
            elif p == "failover":
                if SERVICES[r]["standby"]:
                    self.sched.append((t + 3, "failover_done"))
                    self.events.append((t, "INFO", r, f"orchestrator: failover to standby started for {r}"))
            elif p == "load_shed":
                self.shed[SHEDDABLE] = True
                self.leak_mult, self.over_scale = 0.5, 0.5
                self.events.append((t, "INFO", "orchestrator", "load shedding ON: search, recommendations, notifications, analytics paused"))
            elif p == "circuit_break":
                self.sched.append((t + 1, "cb_on"))
                self.events.append((t, "INFO", r, f"orchestrator: circuit breakers opening on calls to {r}"))

    def _fire(self, ev, t, act_rng):
        r = NAMES[self.root]
        if ev == "cb_on":
            self.cb[self.root] = True
            self.cb_autolift = True
        elif ev == "restart_done":
            if act_rng.random() < P_FIX["restart"][self.kind]:
                self.resolved = True
                self.events.append((t, "INFO", r, f"{r}: restart complete, fault cleared"))
            else:
                self.events.append((t, "WARN", r, f"{r}: restarted but fault persists"))
        elif ev == "failover_done":
            if act_rng.random() < P_FIX["failover"][self.kind]:
                self.resolved = True
                self.cap[self.root] = 0.85
                if SERVICES[r]["stateful"]:
                    self.pending_cost += DATA_LOSS
                self.events.append((t, "INFO", r, f"{r}: standby promoted, traffic switched (running at reduced capacity)"))
            else:
                self.events.append((t, "WARN", r, f"{r}: failover failed, standby unhealthy"))

    # --- dynamics ------------------------------------------------------
    def _advance_fault(self, t):
        if self.root is None or self.kind is None:
            return
        if self.resolved:
            self.f = max(0.0, self.f - 0.5)
            return
        if t < self.onset:
            return
        if self.kind == "leak":
            self.f = min(1.0, self.f + self.rate * self.leak_mult)
        elif self.kind == "crash":
            self.f = 1.0
        elif self.kind == "overload":
            tgt = self.level * self.over_scale
            self.f += float(np.clip(tgt - self.f, -0.15, 0.15))

    def step(self, t, rng, act_rng):
        for ev in [e for e in self.sched if e[0] == t]:
            self._fire(ev[1], t, act_rng)
        self.sched = [e for e in self.sched if e[0] > t]
        self._advance_fault(t)
        dh = 1.0 - self.hist[-(LAG + 1)]      # dependents react to dependency health LAG ticks ago
        dh = np.where(self.shed, 0.0, dh)
        dh = np.where(self.cb, dh * CB_FACTOR, dh)
        pressure = W @ dh
        own = np.zeros(N)
        if self.root is not None:
            own[self.root] = 1.0 if self.down_until > t else self.f
        target = np.minimum(np.clip(1.0 - own - pressure, 0.0, 1.0), self.cap)
        self.h = np.clip(self.h + ALPHA * (target - self.h) + rng.normal(0, 0.012, N), 0.0, 1.0)
        self.hist.append(self.h.copy())
        if len(self.hist) > LAG + 2:
            self.hist.pop(0)
        if self.cb_autolift and self.resolved and self.root is not None and self.h[self.root] > 0.7:
            self.cb[self.root] = False

    def observe(self, rng):
        h = self.h
        err = np.clip((1 - h) ** 1.5 + rng.normal(0, 0.01, N), 0, 1)
        lat = np.minimum(BASE_LAT / np.maximum(h, 0.08) ** 0.7 * (1 + rng.normal(0, 0.04, N)), 30000)
        cpu = np.clip(0.28 + 0.55 * (1 - h) + rng.normal(0, 0.03, N), 0, 1)
        mem = np.clip(0.35 + 0.10 * (1 - h) + rng.normal(0, 0.01, N), 0, 1)
        if self.root is not None and self.kind == "leak":
            mem[self.root] = np.clip(0.35 + 0.60 * self.f + rng.normal(0, 0.01), 0, 1)
        if self.shed.any():
            err[self.shed], lat[self.shed], cpu[self.shed], mem[self.shed] = 0.0, 0.0, 0.02, 0.10
        return err, lat, cpu, mem

    def status(self):
        out = []
        for i in range(N):
            if self.shed[i]:
                out.append("shed")
            elif self.h[i] < FAIL_T:
                out.append("failed")
            elif self.h[i] < DEGRADED_T:
                out.append("degraded")
            else:
                out.append("healthy")
        return out

    def tick_loss(self):
        failed = (self.h < FAIL_T) & ~self.shed
        degr = (self.h >= FAIL_T) & (self.h < DEGRADED_T) & ~self.shed
        loss = float((CRIT * failed).sum() + 0.4 * (CRIT * degr).sum() + 0.5 * CRIT[self.shed].sum())
        loss += self.pending_cost
        self.pending_cost = 0.0
        return loss


# --------------------------------------------------------------- scenarios
def scenario_params(seed):
    r = np.random.default_rng([seed, 999])
    return float(r.uniform(0.045, 0.065)), float(r.uniform(0.75, 0.90))


def run_scenario(root, kind, seed=7, ticks=90, onset=15, strategy=None, act_tick=None, want_logs=True):
    """Simulate the 'real' system. Deterministic for a given seed; a strategy only
    changes what happens from act_tick onward."""
    rate, level = scenario_params(seed)
    w = World(root, kind, onset, rate=rate, level=level)
    act_rng = np.random.default_rng([seed, 777])
    H, ERR, LAT, CPU, MEM = (np.zeros((ticks, N)) for _ in range(5))
    SHED = np.zeros((ticks, N), bool)
    LOSS = np.zeros(ticks)
    logs = [[] for _ in range(ticks)]
    prev = ["healthy"] * N
    n_ev = 0
    for t in range(ticks):
        if strategy and strategy != "do_nothing" and act_tick is not None and t == act_tick:
            w.apply(strategy, t)
        rng = np.random.default_rng([seed, t])
        w.step(t, rng, act_rng)
        err, lat, cpu, mem = w.observe(rng)
        H[t], ERR[t], LAT[t], CPU[t], MEM[t], SHED[t] = w.h, err, lat, cpu, mem, w.shed
        LOSS[t] = w.tick_loss()
        if want_logs:
            for (_, lvl, svc, msg) in w.events[n_ev:]:
                logs[t].append(dict(level=lvl, svc=svc, msg=msg))
            n_ev = len(w.events)
            st = w.status()
            for i, s in enumerate(NAMES):
                if st[i] == prev[i]:
                    continue
                logs[t].extend(_transition_logs(w, i, prev[i], st[i], lat, mem, t))
            prev = st
    return dict(H=H, ERR=ERR, LAT=LAT, CPU=CPU, MEM=MEM, SHED=SHED, LOSS=LOSS, logs=logs,
                root=root, kind=kind, seed=seed, onset=onset)


def _worst_dep(w, i):
    best, bw = None, 0
    for d, c in DEPS.get(NAMES[i], []):
        v = c * (1 - w.h[IDX[d]])
        if v > bw:
            best, bw = d, v
    return best


def _transition_logs(w, i, old, new, lat, mem, t=0):
    s = NAMES[i]
    is_root = (w.root == i)
    out = []
    if new == "degraded" and old == "healthy":
        if is_root:
            msg = {"leak": f"{s}: heap usage {int(mem[i]*100)}% and climbing, GC pauses {int(300+mem[i]*400)}ms",
                   "crash": f"{s}: worker pool unresponsive, error rate spiking",
                   "overload": f"{s}: request queue depth {int(800+lat[i])}, p99 latency {int(lat[i])}ms"}[w.kind]
            out.append(dict(level="WARN", svc=s, msg=msg))
        else:
            d = _worst_dep(w, i) or "upstream"
            out.append(dict(level="WARN", svc=s, msg=f"{s}: upstream {d} timeout after 3000ms, retrying (2/3)"))
    elif new == "failed":
        if is_root and w.down_until >= t:
            out.append(dict(level="INFO", svc=s, msg=f"{s}: stopped for planned restart"))
        elif is_root:
            msg = {"leak": f"{s}: OOMKilled (exit 137), container restart loop",
                   "crash": f"{s}: FATAL unhandled exception, process exited (code 1)",
                   "overload": f"{s}: thread pool exhausted, rejecting all requests (503)"}[w.kind]
            out.append(dict(level="FATAL", svc=s, msg=msg))
        else:
            d = _worst_dep(w, i) or "upstream"
            out.append(dict(level="ERROR", svc=s, msg=f"{s}: dependency {d} unavailable, health check failed 3x, removed from load balancer"))
    elif new == "shed":
        out.append(dict(level="INFO", svc=s, msg=f"{s}: paused by load shedding"))
    elif old in ("failed", "degraded", "shed") and new == "healthy":
        out.append(dict(level="INFO", svc=s, msg=f"{s}: recovered, health checks passing"))
    return out


# ---------------------------------------------------------------- features
def _lag(a, k):
    out = np.empty_like(a)
    out[:k] = a[0]
    out[k:] = a[:-k]
    return out


def build_features(err, lat, cpu, mem):
    """Per (tick, service) features from OBSERVABLE metrics + static graph info."""
    T = err.shape[0]
    d_err = err - _lag(err, 3)
    d_mem = mem - _lag(mem, 3)
    lat_ratio = np.log1p(lat / BASE_LAT[None, :])
    dep_err = err @ W.T
    dep_max = (err[:, None, :] * MASK[None, :, :]).max(axis=2)
    d_dep = dep_err - _lag(dep_err, 3)
    dep_failed = ((err[:, None, :] > 0.5) * MASK[None, :, :]).sum(axis=2)
    dep2 = err @ W2.T
    dyn = np.stack([err, d_err, lat_ratio, cpu, mem, d_mem, dep_err, dep_max, d_dep, dep_failed, dep2], axis=2)
    return np.concatenate([dyn, np.broadcast_to(STATIC[None], (T, N, 5))], axis=2)


OWN_ONLY = [0, 1, 2, 3, 4, 5, 11, 12, 13, 14, 15]   # no dependency-derived features


def make_labels(H):
    T = H.shape[0]
    failed = H < FAIL_T
    y = np.zeros_like(failed)
    for k in range(1, HORIZON + 1):
        sh = np.zeros_like(failed)
        sh[:T - k] = failed[k:]
        y |= sh
    mask = ~failed
    return y & mask, mask


def _gen_training_run(seed):
    r = np.random.default_rng([seed, 4242])
    if r.random() < 0.15:
        root, kind = None, None
    else:
        root, kind = NAMES[r.integers(N)], FAULT_KINDS[r.integers(3)]
    sim = run_scenario(root, kind, seed=seed, ticks=70, onset=int(r.integers(5, 20)), want_logs=False)
    return sim


def train_model(n_train=260, n_test=60, verbose=True):
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.metrics import roc_auc_score
    import joblib

    def dataset(seeds):
        X, Y, runs = [], [], []
        for s in seeds:
            sim = _gen_training_run(s)
            f = build_features(sim["ERR"], sim["LAT"], sim["CPU"], sim["MEM"])
            y, m = make_labels(sim["H"])
            X.append(f[m]); Y.append(y[m]); runs.append((sim, f))
        return np.concatenate(X), np.concatenate(Y), runs

    Xtr, ytr, _ = dataset(range(1000, 1000 + n_train))
    Xte, yte, test_runs = dataset(range(5000, 5000 + n_test))
    if verbose:
        print(f"train rows {len(ytr):,} (pos {ytr.mean():.3%}) | test rows {len(yte):,}")

    full = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.08, max_depth=6, random_state=0).fit(Xtr, ytr)
    own = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.08, max_depth=6, random_state=0).fit(Xtr[:, OWN_ONLY], ytr)
    p_full = full.predict_proba(Xte)[:, 1]
    p_own = own.predict_proba(Xte[:, OWN_ONLY])[:, 1]
    auc_full, auc_own = roc_auc_score(yte, p_full), roc_auc_score(yte, p_own)

    thr = 0.5
    pred = p_full >= thr
    tp = int((pred & yte).sum()); fp = int((pred & ~yte).sum()); fn = int((~pred & yte).sum())
    precision = tp / max(1, tp + fp); recall = tp / max(1, tp + fn)

    # ---- warning lead time vs a classic static alert (error rate > 30%)
    lead_ai, lead_base, lead_base50, n_fail, miss_ai, miss_base = [], [], [], 0, 0, 0
    for sim, f in test_runs:
        p = full.predict_proba(f.reshape(-1, f.shape[2]))[:, 1].reshape(f.shape[0], N)
        for s in range(N):
            fail_t = np.where(sim["H"][:, s] < FAIL_T)[0]
            if not len(fail_t) or fail_t[0] < 3:
                continue
            ft = int(fail_t[0]); n_fail += 1
            a = np.where(p[:ft, s] >= thr)[0]
            b = np.where(sim["ERR"][:ft, s] > 0.30)[0]
            b5 = np.where(sim["ERR"][:ft, s] > 0.50)[0]
            lead_base50.append(ft - int(b5[0]) if len(b5) else 0)
            lead_ai.append(ft - int(a[0]) if len(a) else 0); miss_ai += 0 if len(a) else 1
            lead_base.append(ft - int(b[0]) if len(b) else 0); miss_base += 0 if len(b) else 1
    stats = dict(
        auc_full=round(float(auc_full), 4), auc_own_only=round(float(auc_own), 4),
        precision=round(precision, 3), recall=round(recall, 3), threshold=thr,
        horizon_seconds=HORIZON * TICK_SECONDS, test_failures=n_fail,
        mean_warning_lead_seconds_ai=round(float(np.mean(lead_ai)) * TICK_SECONDS, 1) if n_fail else 0,
        mean_warning_lead_seconds_threshold_alert=round(float(np.mean(lead_base)) * TICK_SECONDS, 1) if n_fail else 0,
        mean_warning_lead_seconds_threshold_alert_50=round(float(np.mean(lead_base50)) * TICK_SECONDS, 1) if n_fail else 0,
        missed_ai=miss_ai, missed_threshold_alert=miss_base,
        train_rows=int(len(ytr)), test_rows=int(len(yte)),
        model="HistGradientBoosting on observable metrics + dependency-graph features")
    fa = 0
    for sd in range(20):                      # false alarms on 20 healthy (no-fault) runs
        sim = run_scenario(None, None, seed=100 + sd, ticks=90, want_logs=False)
        f = build_features(sim["ERR"], sim["LAT"], sim["CPU"], sim["MEM"])
        fa += int((full.predict_proba(f.reshape(-1, f.shape[2]))[:, 1] >= thr).sum())
    stats.update(healthy_runs=20, healthy_service_ticks=20 * 90 * N, false_alarms_healthy=fa)
    joblib.dump(full, os.path.join(HERE, "model.joblib"))
    with open(os.path.join(HERE, "model_stats.json"), "w") as fh:
        json.dump(stats, fh, indent=2)
    if verbose:
        print(json.dumps(stats, indent=2))
    return full, stats


_MODEL = None


def get_model():
    global _MODEL
    if _MODEL is None:
        import joblib
        path = os.path.join(HERE, "model.joblib")
        _MODEL = joblib.load(path) if os.path.exists(path) else train_model()[0]
    return _MODEL


def model_stats():
    path = os.path.join(HERE, "model_stats.json")
    if not os.path.exists(path):
        get_model()
    with open(path) as fh:
        return json.load(fh)


def forecast(sim):
    """P(service fails within HORIZON ticks) for every (tick, service)."""
    f = build_features(sim["ERR"], sim["LAT"], sim["CPU"], sim["MEM"])
    p = get_model().predict_proba(f.reshape(-1, f.shape[2]))[:, 1].reshape(f.shape[0], N)
    p = np.where(sim["H"] < FAIL_T, 1.0, p)
    return np.where(sim["SHED"], 0.0, p)


# ---------------------------------------------------------- root-cause trace
def root_cause(err, t, onset_thr=0.10):
    """Rank root-cause candidates from observed error rates up to tick t."""
    on = {}
    for s in range(N):
        a = err[:t + 1, s] > onset_thr
        if t < 1 or not (a[-1] and a[-2]):      # must be anomalous NOW (so recovered services drop out)
            continue
        j = t
        while j >= 0 and a[j]:
            j -= 1
        on[NAMES[s]] = j + 1                    # start of the current anomaly episode
    if not on:
        return None
    A = set(on)
    scores = {}
    for c in A:
        expl = ({c} | DOWNSTREAM[c]) & A
        coverage = len(expl) / len(A)
        later = [on[s] >= on[c] for s in expl if s != c]
        temporal = float(np.mean(later)) if later else 1.0
        clean = 0.0 if any((d in A and on[d] <= on[c]) for d in UPSTREAM[c]) else 1.0
        scores[c] = 0.5 * coverage + 0.3 * temporal + 0.2 * clean
    names = sorted(scores, key=scores.get, reverse=True)
    e = np.exp(8 * np.array([scores[n] for n in names]))
    conf = e / e.sum()
    top = names[0]
    affected = sorted(({top} | DOWNSTREAM[top]) & A, key=lambda s: on[s])
    paths, edges = {}, set()
    for s in affected:
        if s == top:
            continue
        parent, queue = {top: None}, [top]            # BFS root -> s along dependents
        while queue:
            x = queue.pop(0)
            for y in DEPENDENTS[x]:
                if y not in parent:
                    parent[y] = x; queue.append(y)
        path, cur = [], s
        while cur is not None:
            path.append(cur); cur = parent.get(cur)
        paths[s] = path[::-1]
        for a, b in zip(paths[s][:-1], paths[s][1:]):
            edges.add((a, b))
    return dict(
        service=top, confidence=round(float(conf[0]), 3),
        ranking=[dict(service=n, score=round(scores[n], 3), confidence=round(float(c), 3)) for n, c in list(zip(names, conf))[:3]],
        affected=[dict(service=s, onset_tick=on[s]) for s in affected],
        anomalous=len(A), explained=len(affected),
        paths=paths, edges=[dict(source=a, target=b) for a, b in sorted(edges)],
        evidence=f"{top} was the first to deviate (tick {on[top]}); {len(affected)-1} of the other {len(A)-1} anomalous services sit downstream of it.")


def classify_fault(err, mem, root, t):
    r = IDX[root]
    a = max(0, t - 5)
    mem_slope = (mem[t, r] - mem[a, r]) / max(1, t - a)
    if mem_slope > 0.012 or mem[t, r] > 0.72:
        return "leak"
    above = np.where(err[:t + 1, r] > 0.10)[0]
    on = int(above[0]) if len(above) else t
    return "crash" if err[min(t, on + 2), r] > 0.35 else "overload"


# --------------------------------------------------------------- the planner
def _rollout(root, kind, est_h, f0, strategy, delay, horizon, seed, r):
    pr = np.random.default_rng([seed, r, 3])
    rate, level = float(pr.uniform(0.04, 0.07)), float(pr.uniform(0.70, 0.90))
    w = World(root, kind, onset=-1, rate=rate, level=level, h0=est_h, f0=f0)
    rng = np.random.default_rng([seed, r, 1])
    act = np.random.default_rng([seed, r, 2])
    loss, curve, failed_n = 0.0, [], 0
    for t in range(horizon):
        if strategy != "do_nothing" and t == delay:
            w.apply(strategy, t)
        w.step(t, rng, act)
        loss += w.tick_loss()
        curve.append(loss)
    failed_n = int(((w.h < FAIL_T) & ~w.shed).sum())
    return loss, curve, failed_n


def plan(sim_obs, t, rca=None, n_runs=40, horizon=30, seed=11):
    """Monte-Carlo comparison of recovery strategies from the observed state at tick t."""
    err, mem = sim_obs["ERR"], sim_obs["MEM"]
    rca = rca or root_cause(err, t)
    if rca is None:
        return dict(ok=False, reason="No anomalies detected; nothing to recover from.")
    root = rca["service"]
    kind = classify_fault(err, mem, root, t)
    est_h = np.clip(1 - err[t] ** (2 / 3), 0, 1)
    r = IDX[root]
    f0 = float(np.clip(1 - est_h[r] - (W @ (1 - est_h))[r], 0, 1))
    standby = SERVICES[root]["standby"]

    results = {}
    for sid, label in STRATEGIES.items():
        avail = not ("failover" in sid and not standby)
        if not avail:
            results[sid] = dict(id=sid, label=label, available=False)
            continue
        losses, curves, fails = [], [], []
        for k in range(n_runs):
            l, c, fn = _rollout(root, kind, est_h, f0, sid, 0, horizon, seed, k)
            losses.append(l); curves.append(c); fails.append(fn)
        results[sid] = dict(id=sid, label=label, available=True, _l=np.array(losses),
                            curve=[round(float(x), 1) for x in np.mean(curves, axis=0)],
                            expected_impact=round(float(np.mean(losses)), 1),
                            p90_impact=round(float(np.percentile(losses, 90)), 1),
                            services_down_at_end=round(float(np.mean(fails)), 1))
    base = results["do_nothing"]["_l"]
    avail_ids = [s for s in results if results[s]["available"]]
    for s in avail_ids:
        results[s]["beats_do_nothing_pct"] = round(float((results[s]["_l"] < base).mean()) * 100) if s != "do_nothing" else None
        results[s]["saved_vs_do_nothing_pct"] = round(100 * (1 - results[s]["expected_impact"] / max(1e-9, results["do_nothing"]["expected_impact"])))
    ranked = sorted(avail_ids, key=lambda s: results[s]["expected_impact"])
    best, second = ranked[0], (ranked[1] if len(ranked) > 1 else None)
    win2 = round(float((results[best]["_l"] < results[second]["_l"]).mean()) * 100) if second else None
    run_wins = round(float((results[second]["_l"] < results[best]["_l"]).mean()) * 100) if second else None

    delay_curve = []
    if best != "do_nothing":
        for d in (0, 3, 6, 12):
            ls = [_rollout(root, kind, est_h, f0, best, d, horizon, seed, k)[0] for k in range(25)]
            delay_curve.append(dict(delay_seconds=d * TICK_SECONDS, expected_impact=round(float(np.mean(ls)), 1)))

    for s in results:
        results[s].pop("_l", None)
    bi, di = results[best], results["do_nothing"]
    why = (f"{STRATEGIES[best]} is expected to cut impact by {bi.get('saved_vs_do_nothing_pct', 0)}% "
           f"({bi['expected_impact']} vs {di['expected_impact']} for doing nothing).")
    if second:
        si = results[second]
        if win2 >= 50:
            why += f" It beats the runner-up ({STRATEGIES[second]}) in {win2}% of simulated futures."
        elif si["p90_impact"] > bi["p90_impact"]:
            why += (f" {STRATEGIES[second]} wins {run_wins}% of futures but has a worse bad-case "
                    f"(p90 {si['p90_impact']} vs {bi['p90_impact']}), so the safer option is recommended.")
        else:
            why += f" It has the lowest expected impact of all options; {STRATEGIES[second]} is a close second."
    return dict(ok=True, tick=t, root=root, fault_kind=kind, diagnosis_confidence=rca["confidence"],
                recommended=best, runner_up=second, win_rate_vs_runner_up_pct=win2, why=why,
                strategies=[results[s] for s in STRATEGIES], cost_of_delay=delay_curve,
                monte_carlo=dict(futures_per_strategy=n_runs, horizon_seconds=horizon * TICK_SECONDS),
                rca=rca)
