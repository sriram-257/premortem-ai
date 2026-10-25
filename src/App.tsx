import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { API_BASE } from "./config";
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";

type Status = "healthy" | "degraded" | "failed" | "shed";
type Kind = "leak" | "crash" | "overload";
type TimelineName = "without_ai" | "with_ai";
type CopilotTab = "forecast" | "root" | "recovery";
type Node = { id: string; tier: string; criticality: number; has_standby: boolean; stateful: boolean; x: number; y: number };
type Edge = { source: string; target: string; coupling: number };
type Preset = { id: string; title: string; root: string; kind: Kind; seed: number; blurb: string };
type Graph = { nodes: Node[]; edges: Edge[]; fault_kinds: string[]; presets: Preset[]; strategies: { id: string; label: string }[]; tick_seconds: number };
type ServiceTick = { status: Status; err: number; lat: number; cpu: number; mem: number; p_fail: number };
type Log = { level: string; svc: string; msg: string; clock: string };
type RcaTick = { service: string; confidence: number; affected: string[]; edges: { source: string; target: string }[] } | null;
type Tick = { t: number; clock: string; impact: number; services: Record<string, ServiceTick>; logs: Log[]; rca: RcaTick };
type Timeline = { scenario: { root: string | null; kind: string | null; tick_seconds: number }; services: string[]; ticks: Tick[]; summary: { first_warning_tick: number | null; first_failure_tick: number | null; diagnosis_tick: number | null; warning_lead_seconds: number | null; peak_failed: number; total_impact: number; impact_cumulative: number[] } };
type Strategy = { id: string; label: string; available: boolean; curve: number[]; expected_impact: number; p90_impact: number; services_down_at_end: number; saved_vs_do_nothing_pct: number };
type Plan = { ok: boolean; tick: number; root: string; fault_kind: string; diagnosis_confidence: number; recommended: string; runner_up: string | null; why: string; strategies: Strategy[]; cost_of_delay: { delay_seconds: number; expected_impact: number }[]; monte_carlo: { futures_per_strategy: number; horizon_seconds: number }; rca: { service: string; confidence: number; ranking: { service: string; score: number; confidence: number }[]; affected: { service: string; onset_tick: number }[]; anomalous: number; explained: number; paths: Record<string, string[]>; edges: { source: string; target: string }[]; evidence: string } };
type Compare = { plan: Plan; without_ai: Timeline; with_ai: Timeline; headline: { impact_without: number; impact_with: number; saved_pct: number; peak_failed_without: number; peak_failed_with: number } };
type ModelStats = { auc_full: number; auc_own_only: number; precision: number; recall: number; threshold: number; horizon_seconds: number; test_failures: number; mean_warning_lead_seconds_ai: number; mean_warning_lead_seconds_threshold_alert: number; mean_warning_lead_seconds_threshold_alert_50: number; healthy_service_ticks: number; false_alarms_healthy: number; model: string };
type Snapshot = { graph: Graph; model: ModelStats; presets: Record<string, Compare> };
type AlertKind = "warning" | "critical" | "diagnosis" | "recovery";
type AlertSeverity = AlertKind | "high";
type AlertFilter = "all" | "warning" | "critical" | "resolved";
type AlertItem = {
  id: string;
  severity: AlertSeverity;
  service: string;
  probability: number | null;
  tick: number;
  clock: string;
  message: string;
  offline: boolean;
  read: boolean;
};

const dotStyles: Record<Status, string> = { healthy: "bg-emerald-400", degraded: "bg-amber-400", failed: "bg-red-400", shed: "bg-slate-500" };
const statusColor: Record<Status, string> = { healthy: "#22c55e", degraded: "#fbbf24", failed: "#f87171", shed: "#94a3b8" };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function App() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [offline, setOffline] = useState(false);
  const [apiError, setApiError] = useState("");
  const [compare, setCompare] = useState<Compare | null>(null);
  const [loading, setLoading] = useState(false);
  const [kind, setKind] = useState<Kind>("leak");
  const [seed, setSeed] = useState("7");
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [currentTick, setCurrentTick] = useState(0);
  const [activeTimeline, setActiveTimeline] = useState<TimelineName>("without_ai");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [clock, setClock] = useState("09:00:00");
  const [tab, setTab] = useState<CopilotTab>("forecast");
  const [toast, setToast] = useState("");
  const [showReveal, setShowReveal] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [model, setModel] = useState<ModelStats | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(() => {
    try { return window.localStorage.getItem("premortem-sound-enabled") === "true"; }
    catch { return false; }
  });
  const [audioUnavailable, setAudioUnavailable] = useState(false);
  const [alertPulse, setAlertPulse] = useState(false);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertDrawerOpen, setAlertDrawerOpen] = useState(false);
  const [alertFilter, setAlertFilter] = useState<AlertFilter>("all");
  const [visualToasts, setVisualToasts] = useState(() => {
    try { return window.localStorage.getItem("premortem-visual-alerts") !== "false"; }
    catch { return true; }
  });
  const [demoRunning, setDemoRunning] = useState(false);
  const [demoCaption, setDemoCaption] = useState("");
  const logsRef = useRef<HTMLDivElement>(null);
  const demoActionTimer = useRef<number | null>(null);
  const diagnosisShown = useRef(false);
  const audioContext = useRef<AudioContext | null>(null);
  const previousTick = useRef<{ timeline: TimelineName; tick: Tick } | null>(null);
  const alertKeys = useRef(new Set<string>());
  const alertRunId = useRef(0);
  const toastTimer = useRef<number | null>(null);
  const pulseTimer = useRef<number | null>(null);

  const playTone = useCallback((kind: AlertKind, force = false) => {
    if (!soundEnabled && !force) return;
    const AudioContextClass = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) { setAudioUnavailable(true); return; }
    try {
      const context = audioContext.current ?? new AudioContextClass();
      audioContext.current = context;
      if (context.state === "suspended") void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const settings: Record<AlertKind, { frequency: number; duration: number; volume: number; type: OscillatorType }> = {
        warning: { frequency: 620, duration: .12, volume: .045, type: "sine" },
        critical: { frequency: 240, duration: .24, volume: .06, type: "square" },
        diagnosis: { frequency: 780, duration: .16, volume: .05, type: "sine" },
        recovery: { frequency: 520, duration: .2, volume: .05, type: "triangle" },
      };
      const { frequency, duration, volume, type } = settings[kind];
      const now = context.currentTime;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, now);
      if (kind === "recovery") oscillator.frequency.linearRampToValueAtTime(780, now + duration);
      gain.gain.setValueAtTime(.0001, now);
      gain.gain.exponentialRampToValueAtTime(volume, now + .01);
      gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + duration + .02);
      oscillator.addEventListener("ended", () => { oscillator.disconnect(); gain.disconnect(); }, { once: true });
    } catch { setAudioUnavailable(true); }
  }, [soundEnabled]);

  const announceAlert = useCallback((kind: AlertKind, service: string, message: string, showToast: boolean) => {
    playTone(kind);
    if (showToast && visualToasts) {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      setToast(`${message} · ${service}`);
      toastTimer.current = window.setTimeout(() => setToast(""), 4500);
    }
    if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    setAlertPulse(true);
    pulseTimer.current = window.setTimeout(() => setAlertPulse(false), 900);
  }, [playTone, visualToasts]);

  const addAlert = useCallback((severity: AlertSeverity, service: string, itemTick: Tick, probability: number | null, message: string) => {
    const kind: AlertKind = severity === "high" ? "warning" : severity;
    const key = `${alertRunId.current}:${activeTimeline}:${severity}:${service}:${itemTick.t}`;
    if (alertKeys.current.has(key)) return;
    alertKeys.current.add(key);
    const alert: AlertItem = {
      id: key,
      severity,
      service,
      probability,
      tick: itemTick.t,
      clock: itemTick.clock,
      message,
      offline,
      read: false,
    };
    setAlerts((current) => [alert, ...current].slice(0, 100));
    announceAlert(kind, service, message, severity === "high" || severity === "critical" || severity === "diagnosis" || severity === "recovery");
  }, [activeTimeline, announceAlert, offline]);

  const resetAlertTracking = useCallback(() => {
    alertKeys.current.clear();
    previousTick.current = null;
    alertRunId.current += 1;
    setAlertPulse(false);
  }, []);

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    try { window.localStorage.setItem("premortem-sound-enabled", String(next)); } catch { /* storage can be unavailable */ }
    if (next) {
      playTone("diagnosis", true);
      setAudioUnavailable(false);
    }
  };

  const testSound = () => {
    if (!soundEnabled) return;
    playTone("diagnosis");
    setToast("Sound test · alerts enabled");
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2500);
  };

  const toggleVisualToasts = () => {
    const next = !visualToasts;
    setVisualToasts(next);
    try { window.localStorage.setItem("premortem-visual-alerts", String(next)); } catch { /* storage can be unavailable */ }
  };

  const loadGraph = useCallback(async () => {
    try {
      setGraph(await getJson<Graph>("/api/graph")); setOffline(false); setApiError("");
    } catch {
      try {
        const snapshot = await fetch("/snapshot.json").then((r) => r.json() as Promise<Snapshot>);
        setGraph(snapshot.graph); setModel(snapshot.model); setOffline(true); setApiError("");
      } catch { setApiError("Engine unavailable and offline snapshot could not be loaded."); }
    }
  }, []);
  useEffect(() => { void loadGraph(); }, [loadGraph]);
  useEffect(() => {
    void getJson<ModelStats>("/api/model").then(setModel).catch(() => undefined);
  }, []);

  const timeline = compare?.[activeTimeline] ?? null;
  const tick = timeline?.ticks[Math.min(currentTick, (timeline?.ticks.length ?? 1) - 1)];
  const plan = compare?.plan;
  useEffect(() => { if (tick) setClock(tick.clock); }, [tick]);
  useEffect(() => {
    if (!playing || !timeline) return;
    const timer = window.setInterval(() => setCurrentTick((previous) => {
      if (previous >= timeline.ticks.length - 1) { setPlaying(false); return previous; }
      return previous + 1;
    }), 350 / speed);
    return () => window.clearInterval(timer);
  }, [playing, speed, timeline]);
  useEffect(() => {
    if (!compare || activeTimeline !== "without_ai" || !plan || currentTick !== plan.tick || diagnosisShown.current) return;
    diagnosisShown.current = true; setPlaying(false); setTab("recovery");
  }, [activeTimeline, compare, currentTick, plan]);
  useEffect(() => {
    if (!tick || !timeline) return;
    const prior = previousTick.current;
    if (!prior || prior.timeline !== activeTimeline || tick.t <= prior.tick.t) {
      previousTick.current = { timeline: activeTimeline, tick };
      return;
    }
    for (let index = prior.tick.t + 1; index <= tick.t; index += 1) {
      const previous = timeline.ticks[index - 1];
      const current = timeline.ticks[index];
      if (!previous || !current) continue;
      for (const service of Object.keys(current.services)) {
        const before = previous.services[service];
        const after = current.services[service];
        if (!before || !after) continue;
        if (before.p_fail < .3 && after.p_fail >= .3) {
          addAlert("warning", service, current, after.p_fail, "Forecast crossed the high-risk threshold");
        }
        if (before.p_fail < .7 && after.p_fail >= .7) {
          addAlert("high", service, current, after.p_fail, "Failure is now highly likely; prepare containment");
        }
        if (before.status !== "failed" && after.status === "failed") {
          addAlert("critical", service, current, after.p_fail, "Service transitioned to failed");
        }
      }
      if (!previous.rca && current.rca) {
        addAlert("diagnosis", current.rca.service, current, current.services[current.rca.service]?.p_fail ?? null, "Root cause identified; review the recommended recovery");
      }
      for (const log of current.logs) {
        if (log.level === "INFO" && (/restart complete, fault cleared/i.test(log.msg) || /standby promoted, traffic switched/i.test(log.msg))) {
          addAlert("recovery", log.svc, current, current.services[log.svc]?.p_fail ?? null, "Recovery confirmed by the simulation");
        }
      }
    }
    previousTick.current = { timeline: activeTimeline, tick };
  }, [activeTimeline, addAlert, tick, timeline]);
  useEffect(() => {
    if (compare && timeline && currentTick >= timeline.ticks.length - 1) setShowReveal(true);
  }, [compare, currentTick, timeline]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === "Space") { event.preventDefault(); setPlaying((value) => !value); }
      if (event.key.toLowerCase() === "r" && timeline) { resetAlertTracking(); setCurrentTick(0); diagnosisShown.current = false; setPlaying(true); }
      if (["1", "2", "3"].includes(event.key) && graph) selectPreset(graph.presets[Number(event.key) - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [graph, timeline, offline]);
  useEffect(() => {
    if (!logsRef.current) return;
    logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [tick?.logs.length, currentTick]);
  useEffect(() => {
    if (!demoRunning || !compare || !timeline || activeTimeline !== "without_ai") return;
    const warningService = Object.entries(timeline.ticks[timeline.summary.first_warning_tick ?? 0]?.services ?? {}).sort((a, b) => b[1].p_fail - a[1].p_fail)[0]?.[0];
    if (currentTick === 15) setDemoCaption(`A fault begins in ${plan?.root}. To a human, nothing looks wrong yet.`);
    else if (timeline.summary.first_warning_tick === currentTick) setDemoCaption(`AI forecast: ${warningService ?? "a downstream service"} will fail within 2 minutes.`);
    else if (plan && currentTick === plan.tick) {
      setPlaying(false);
      setDemoCaption(`Root cause found: ${plan.root} (${Math.round(plan.diagnosis_confidence * 100)}% confidence). Simulating futures...`);
      if (!demoActionTimer.current) {
        demoActionTimer.current = window.setTimeout(() => {
          demoActionTimer.current = null;
          setDemoCaption(`Executing: ${plan.strategies.find((s) => s.id === plan.recommended)?.label ?? plan.recommended}`);
          setActiveTimeline("with_ai");
          setCurrentTick(plan.tick);
          setPlaying(true);
        }, 4000);
      }
    }
    else if (currentTick >= timeline.ticks.length - 1) { setDemoCaption(`Executing: ${plan?.strategies.find((s) => s.id === plan.recommended)?.label ?? plan?.recommended}`); setDemoRunning(false); setShowReveal(true); }
  }, [activeTimeline, currentTick, demoRunning, compare, timeline, plan]);

  const runScenario = async (root: string, selectedKind: Kind, selectedSeed: number) => {
    setLoading(true); setPlaying(false); setCurrentTick(0); setActiveTimeline("without_ai"); setSelectedNode(null); setTab("forecast"); diagnosisShown.current = false; resetAlertTracking();
    try {
      let data: Compare;
      if (offline) {
        const snapshot = await fetch("/snapshot.json").then((r) => r.json() as Promise<Snapshot>);
        const preset = graph?.presets.find((p) => p.root === root && p.kind === selectedKind);
        data = preset ? snapshot.presets[preset.id] : (() => { throw new Error("preset"); })();
      } else {
        data = await fetch(`${API_BASE}/api/compare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, kind: selectedKind, seed: selectedSeed }) }).then((r) => r.json() as Promise<Compare>);
      }
      if (!data?.without_ai || !data.plan?.ok) throw new Error("The engine returned no plan.");
      setCompare(data); setKind(selectedKind); setSeed(String(selectedSeed)); setPlaying(true); setApiError("");
    } catch {
      try {
        const snapshot = await fetch("/snapshot.json").then((r) => r.json() as Promise<Snapshot>);
        const preset = graph?.presets.find((item) => item.root === root && item.kind === selectedKind);
        if (!preset) throw new Error("preset");
        setOffline(true);
        setModel(snapshot.model);
        setCompare(snapshot.presets[preset.id]);
        setKind(selectedKind);
        setSeed(String(selectedSeed));
        setPlaying(true);
        setApiError("Live engine unavailable. Using offline snapshot.");
      } catch {
        setApiError(offline ? "Offline mode supports the three supplied presets." : "Scenario failed to load. Check that the FastAPI engine is running.");
      }
    }
    finally { setLoading(false); }
  };
  const selectPreset = (preset: Preset) => void runScenario(preset.root, preset.kind, preset.seed);
  const startGuidedDemo = () => { if (!graph) return; if (demoActionTimer.current) window.clearTimeout(demoActionTimer.current); demoActionTimer.current = null; setDemoRunning(true); setDemoCaption("Loading the guided incident..."); selectPreset(graph.presets[0]); };
  const retry = () => { setApiError(""); void loadGraph(); };
  const openModel = async () => {
    setShowModel(true);
    if (!model) {
      try { setModel(await getJson<ModelStats>("/api/model")); }
      catch { try { setModel((await fetch("/snapshot.json").then((r) => r.json() as Promise<Snapshot>)).model); } catch { setApiError("Model metrics are unavailable."); } }
    }
  };
  const impact = tick?.impact ?? 0;
  const unreadAlerts = alerts.filter((alert) => !alert.read).length;
  const visibleAlerts = alerts.filter((alert) => {
    if (alertFilter === "all") return true;
    if (alertFilter === "warning") return alert.severity === "warning" || alert.severity === "high";
    if (alertFilter === "critical") return alert.severity === "critical" || alert.severity === "diagnosis";
    return alert.severity === "recovery";
  });
  const openAlert = (alert: AlertItem) => {
    setAlerts((current) => current.map((item) => item.id === alert.id ? { ...item, read: true } : item));
    setSelectedNode(alert.service);
    if (alert.severity === "diagnosis") setTab("root");
    if (alert.severity === "recovery") setTab("recovery");
    setAlertDrawerOpen(false);
  };

  return <main className="mission-shell min-h-screen text-slate-200">
    <header className="topbar">
      <div className="brand-lockup"><div className="mission-mark">P</div><div><div className="brand-name">PreMortem <span className="brand-kicker">/ SRE MISSION CONTROL</span></div><div className="brand-subtitle"><span className="live-dot" />SIMULATED ENVIRONMENT</div></div></div>
      <div className="topbar-readouts"><div className="readout"><span>SIM CLOCK</span><strong>{clock}</strong></div><div className={`api-readout ${offline ? "offline" : ""}`}><span className="live-dot" />{offline ? "OFFLINE SNAPSHOT" : "API CONNECTED"}</div><div className="impact-readout"><span>IMPACT</span><strong>{impact.toLocaleString()}</strong></div><button className={`alert-bell ${alertPulse ? "alert-pulse" : ""}`} onClick={() => setAlertDrawerOpen((value) => !value)} aria-label={`Risk alerts${unreadAlerts ? `, ${unreadAlerts} unread` : ""}`} aria-expanded={alertDrawerOpen} title="Open AI Risk Alert Center"><span aria-hidden="true">♢</span>{unreadAlerts > 0 && <b>{unreadAlerts > 99 ? "99+" : unreadAlerts}</b>}</button><div className="sound-controls"><button onClick={toggleSound} className={`sound-toggle ${soundEnabled ? "enabled" : ""} ${alertPulse ? "alert-pulse" : ""}`} aria-pressed={soundEnabled} aria-label={`Sound ${soundEnabled ? "on" : "off"}`} title={audioUnavailable ? "Web Audio is unavailable in this browser" : "Enable or disable alert sounds"}><span aria-hidden="true">{soundEnabled ? "🔊" : "🔇"}</span><span>Sound {soundEnabled ? "ON" : "OFF"}</span></button><button onClick={testSound} disabled={!soundEnabled || audioUnavailable} className="sound-test" aria-label="Test alert sound" title="Test alert sound">Test</button></div><button onClick={openModel} className="credibility-badge" title="View model credibility">MODEL v1 <b>●</b></button></div>
    </header>
    <div className="mission-grid">
      <aside className="incident-rail"><div className="rail-heading"><div className="eyebrow text-cyan-300">INCIDENT CONTROL</div><h1>Break it</h1><span className="rail-status">READY</span></div><button className="guided-demo" onClick={startGuidedDemo} disabled={!graph || loading}><span>▶</span><strong>Run Demo Incident</strong><small>Walk the cascade from fault to recovery</small></button><div className="rail-section"><div className="section-label">PRESET INCIDENTS</div><div className="preset-list">{graph?.presets.map((preset, index) => <button key={preset.id} onClick={() => selectPreset(preset)} className="preset-row"><span className="preset-index">0{index + 1}</span><span className="preset-copy"><strong>{preset.title}</strong><small>{preset.root} · {preset.kind}</small></span><span className="preset-arrow">↗</span></button>)}</div></div><div className="rail-section injection-section"><div className="section-label">INJECT ON GRAPH</div><div className="fault-toggle">{(["leak", "crash", "overload"] as Kind[]).map((value) => <button key={value} onClick={() => setKind(value)} className={kind === value ? "selected" : ""}>{value === "leak" ? "LEAK" : value === "crash" ? "CRASH" : "LOAD"}</button>)}</div><label className="compact-label">SEED<input value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ""))} className="input font-mono" /></label><p className="rail-hint">Select a service node to inject the selected fault.</p></div><div className="rail-footer"><span className="live-dot" />14 services monitored</div></aside>
      <section className="mission-center"><div className="graph-panel"><div className="graph-header"><div><div className="eyebrow text-cyan-300">DEPENDENCY TOPOLOGY / LIVE</div><h2>Service graph <span>14 services · fixed topology</span></h2></div><div className="graph-tools"><span className="graph-mode">2D TOPOLOGY</span><div className="legend">{(["healthy", "degraded", "failed", "shed"] as Status[]).map((s) => <span key={s}><i className={`status-dot ${s}`} />{s}</span>)}</div></div></div>{loading ? <div className="graph-loading"><div className="loading-spinner" /><span>Simulating 90 ticks...</span></div> : <GraphView graph={graph} tick={tick} rca={tick?.rca ?? null} selectedNode={selectedNode} onNodeClick={(id) => compare ? setSelectedNode(id) : void runScenario(id, kind, Number(seed) || 7)} />}</div></section>
      <Copilot compare={compare} tick={tick} currentTick={currentTick} tab={tab} setTab={setTab} setActiveTimeline={(value) => { setActiveTimeline(value); setCurrentTick(Math.min(currentTick, (compare?.[value].ticks.length ?? 1) - 1)); setPlaying(true); }} onFix={() => { setActiveTimeline("with_ai"); setPlaying(true); setTab("recovery"); }} onBurn={() => { setActiveTimeline("without_ai"); setPlaying(true); }} onCompare={() => setShowReveal(true)} />
      <div className="timeline-dock"><Playback timeline={timeline} currentTick={currentTick} playing={playing} speed={speed} onPlay={() => setPlaying((p) => !p)} onTick={setCurrentTick} onSpeed={setSpeed} onReplay={() => { resetAlertTracking(); setCurrentTick(0); diagnosisShown.current = false; setPlaying(true); }} /></div>
    </div>
    <div className="logs-strip"><div className="logs-head"><span className="eyebrow">LIVE LOGS</span><span className="logs-state">{tick?.logs.length ? `${tick.logs.length} events · ${tick.clock}` : "Awaiting scenario telemetry"}</span></div><div className="logs-list" ref={logsRef}>{timeline?.ticks.slice(0, currentTick + 1).flatMap((item) => item.logs).map((log, index) => <button key={`${log.clock}-${index}`} onClick={() => setSelectedNode(log.svc)} className={`log-line log-${log.level.toLowerCase()}`}><span>{log.clock}</span><b>{log.level}</b><strong>{log.svc}</strong><em>{log.msg}</em></button>)}</div></div>
    {demoRunning && <div className="demo-caption"><span>GUIDED DEMO</span>{demoCaption}<button onClick={() => { if (demoActionTimer.current) window.clearTimeout(demoActionTimer.current); demoActionTimer.current = null; setDemoRunning(false); setDemoCaption(""); setPlaying(false); }}>Stop demo</button></div>}
    {alertDrawerOpen && <AlertDrawer alerts={visibleAlerts} filter={alertFilter} visualToasts={visualToasts} onFilter={setAlertFilter} onToggleToasts={toggleVisualToasts} onOpen={openAlert} onReadAll={() => setAlerts((current) => current.map((alert) => ({ ...alert, read: true })))} onClear={() => setAlerts([])} onClose={() => setAlertDrawerOpen(false)} />}
    {toast && <div className="diagnosis-toast" role="status" aria-live="polite">✦ {toast}</div>}{apiError && <div className="error-toast">{apiError}<button onClick={retry}>Retry</button></div>}{showReveal && compare && <RevealModal compare={compare} onClose={() => setShowReveal(false)} />}{showModel && <ModelDrawer model={model} offline={offline} onClose={() => setShowModel(false)} />}{selectedNode && graph && <NodeDrawer node={graph.nodes.find((item) => item.id === selectedNode) ?? null} timeline={timeline} currentTick={currentTick} onClose={() => setSelectedNode(null)} />}
  </main>;
}

function AlertDrawer({ alerts, filter, visualToasts, onFilter, onToggleToasts, onOpen, onReadAll, onClear, onClose }: {
  alerts: AlertItem[];
  filter: AlertFilter;
  visualToasts: boolean;
  onFilter: (filter: AlertFilter) => void;
  onToggleToasts: () => void;
  onOpen: (alert: AlertItem) => void;
  onReadAll: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const labels: Record<AlertSeverity, string> = { warning: "Warning", high: "High risk", critical: "Critical", diagnosis: "Root cause", recovery: "Resolved" };
  return <aside className="alert-drawer" aria-label="AI Risk Alert Center">
    <div className="alert-drawer-head"><div><div className="eyebrow">AI RISK ALERT CENTER</div><h2>Risk feed</h2></div><button onClick={onClose} aria-label="Close risk alert center">×</button></div>
    <div className="alert-drawer-actions"><span>{alerts.length} shown</span><button onClick={onReadAll} disabled={!alerts.some((alert) => !alert.read)}>Mark read</button><button onClick={onClear} disabled={!alerts.length}>Clear</button></div>
    <div className="alert-filters" role="tablist" aria-label="Alert severity filters">{(["all", "warning", "critical", "resolved"] as AlertFilter[]).map((value) => <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? "selected" : ""} onClick={() => onFilter(value)}>{value === "all" ? "All" : value[0].toUpperCase() + value.slice(1)}</button>)}</div>
    <label className="alert-toast-setting"><input type="checkbox" checked={visualToasts} onChange={onToggleToasts} /> Visual alert toasts</label>
    <div className="alert-list">{alerts.length ? alerts.map((alert) => <button key={alert.id} onClick={() => onOpen(alert)} className={`alert-item alert-${alert.severity} ${alert.read ? "read" : ""}`}><span className="alert-item-top"><b>{labels[alert.severity]}</b><time>{alert.clock} · T+{alert.tick}</time></span><strong>{alert.service}{alert.probability != null ? ` · ${Math.round(alert.probability * 100)}% risk` : ""}</strong><span>{alert.message}</span><small>{alert.offline ? "OFFLINE SNAPSHOT" : "SIMULATION"} · {alert.read ? "read" : "unread"}</small></button>) : <div className="alert-empty">No risk transitions in this session yet.<br />Start a scenario to populate the feed.</div>}</div>
  </aside>;
}

function GraphView({ graph, tick, rca, selectedNode, onNodeClick }: { graph: Graph | null; tick?: Tick; rca: RcaTick; selectedNode: string | null; onNodeClick: (id: string) => void }) {
  if (!graph) return <div className="h-[480px] animate-pulse rounded-lg bg-[#0d121a]" />;
  const rcaEdges = rca?.edges ?? [];
  return <div className="graph-canvas"><svg viewBox="0 0 1000 560" role="img" aria-label="Service dependency graph" className="h-full w-full"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#64748b" /></marker><filter id="danger-glow"><feGaussianBlur stdDeviation="5" result="blur" /></filter></defs>
    {graph.edges.map((edge) => { const source = graph.nodes.find((n) => n.id === edge.source)!; const target = graph.nodes.find((n) => n.id === edge.target)!; const x1 = source.x * 1000, y1 = source.y * 560, x2 = target.x * 1000, y2 = target.y * 560, mid = (y1 + y2) / 2; return <path key={`${edge.source}-${edge.target}`} d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`} fill="none" stroke="#536174" strokeOpacity=".42" strokeWidth={1 + edge.coupling * 2} markerEnd="url(#arrow)" />; })}
    {rcaEdges.map((edge) => { const source = graph.nodes.find((n) => n.id === edge.source); const target = graph.nodes.find((n) => n.id === edge.target); if (!source || !target) return null; const x1 = source.x * 1000, y1 = source.y * 560, x2 = target.x * 1000, y2 = target.y * 560; return <path key={`rca-${edge.source}-${edge.target}`} className="rca-flow" d={`M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`} fill="none" stroke="#f87171" strokeWidth="3" strokeDasharray="7 6" opacity=".85" />; })}
    {graph.nodes.map((node) => { const service = tick?.services[node.id]; const status = service?.status ?? "healthy"; const x = node.x * 1000, y = node.y * 560, halo = service && service.p_fail >= .3 && status !== "failed"; const isRoot = rca?.service === node.id; return <g key={node.id} className="cursor-pointer" onClick={() => onNodeClick(node.id)}><title>{node.id} · {status}{service ? ` · ${Math.round(service.p_fail * 100)}% failure risk` : ""}</title>{halo && <circle cx={x} cy={y} r={31 + service.p_fail * 12} fill="none" stroke={service.p_fail > .7 ? "#f87171" : "#fbbf24"} strokeWidth={1.5 + service.p_fail * 3} strokeDasharray="4 4" opacity=".9" className="forecast-halo" />}{isRoot && <><circle cx={x} cy={y} r="36" fill="none" stroke="#f87171" strokeWidth="2" strokeDasharray="2 5" className="root-target" /><circle cx={x} cy={y} r="7" fill="none" stroke="#f87171" strokeWidth="2" /></>}<rect x={x - 65} y={y - 25} width="130" height="50" rx="10" fill={status === "failed" ? "#3a1820" : "#111923"} stroke={selectedNode === node.id ? "#22c55e" : status === "failed" ? "#f87171" : "#2b394b"} strokeWidth={selectedNode === node.id ? 2 : 1} /><circle cx={x - 51} cy={y - 7} r="4" fill={statusColor[status]} /><text x={x - 40} y={y - 5} fill="#e2e8f0" fontSize="13" fontWeight="600">{node.id}</text><text x={x - 51} y={y + 14} fill="#64748b" fontSize="9" letterSpacing="1">{node.tier.toUpperCase()} · {Math.round(node.criticality * 100)} CRIT</text>{halo && <text x={x + 48} y={y - 30} fill="#fbbf24" fontSize="9" textAnchor="middle">{Math.round(service.p_fail * 100)}% risk</text>}</g>; })}
  </svg>{!tick && <div className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-[11px] text-slate-600">Select a preset or click a service to start a simulation</div>}</div>;
}

function Playback({ timeline, currentTick, playing, speed, onPlay, onTick, onSpeed, onReplay }: { timeline: Timeline | null; currentTick: number; playing: boolean; speed: number; onPlay: () => void; onTick: (v: number) => void; onSpeed: (v: number) => void; onReplay: () => void }) {
  const summary = timeline?.summary;
  return <div className="panel playback"><div className="flex items-center gap-3"><button onClick={onPlay} disabled={!timeline} className="play-button">{playing ? "Ⅱ" : "▶"}</button><div className="min-w-0 flex-1"><div className="relative"><input type="range" min="0" max={Math.max((timeline?.ticks.length ?? 90) - 1, 1)} value={currentTick} disabled={!timeline} onChange={(e) => onTick(Number(e.target.value))} className="scrubber w-full" />{summary && <>{summary.first_warning_tick != null && <i className="marker cyan" style={{ left: `${summary.first_warning_tick / 89 * 100}%` }} />}{summary.first_failure_tick != null && <i className="marker red" style={{ left: `${summary.first_failure_tick / 89 * 100}%` }} />}{summary.diagnosis_tick != null && <i className="marker violet" style={{ left: `${summary.diagnosis_tick / 89 * 100}%` }} />}</>}</div><div className="mt-2 flex justify-between font-mono text-[10px] text-slate-600"><span>T+{String(currentTick).padStart(2, "0")} · {timeline ? `${currentTick * 10}s elapsed` : "READY"}</span><span>{timeline ? "T+89 · 15m" : "90 ticks"}</span></div></div><div className="flex shrink-0 items-center gap-1 rounded-md border border-[#263242] bg-[#0c1119] p-1">{[1, 2, 4].map((value) => <button key={value} onClick={() => onSpeed(value)} className={`rounded px-2 py-1 text-[10px] ${speed === value ? "bg-cyan-400/15 text-cyan-300" : "text-slate-500"}`}>{value}x</button>)}</div><button onClick={onReplay} disabled={!timeline} className="replay-button">↻ <span className="hidden sm:inline">Replay</span></button></div><div className="mt-3 flex justify-center gap-4 text-[9px] uppercase tracking-wider text-slate-600"><span><b className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-cyan-400" />AI warning</span><span><b className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-red-400" />First failure</span><span><b className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-violet-400" />Diagnosis</span></div></div>;
}

function Copilot({ compare, tick, currentTick, tab, setTab, setActiveTimeline, onFix, onBurn, onCompare }: { compare: Compare | null; tick?: Tick; currentTick: number; tab: CopilotTab; setTab: (tab: CopilotTab) => void; setActiveTimeline: (timeline: TimelineName) => void; onFix: () => void; onBurn: () => void; onCompare: () => void }) {
  const plan = compare?.plan;
  const forecast = tick ? Object.entries(tick.services).sort((a, b) => b[1].p_fail - a[1].p_fail).slice(0, 6) : [];
  return <aside className="panel copilot-panel"><div className="flex items-start justify-between"><div><div className="eyebrow text-violet-300">Intelligence layer</div><h2 className="mt-1 text-base font-medium text-white">AI Copilot</h2></div>{compare && <span className="rounded-full border border-violet-400/20 bg-violet-400/10 px-2 py-1 text-[9px] text-violet-300">ACTIVE</span>}</div><div className="mt-4 grid grid-cols-3 border-b border-[#263242]">{(["forecast", "root", "recovery"] as CopilotTab[]).map((value) => <button key={value} onClick={() => setTab(value)} className={`copilot-tab ${tab === value ? "active" : ""}`}>{value === "root" ? "Root cause" : value === "recovery" ? "Recovery lab" : "Forecast"}</button>)}</div>{!compare ? <div className="flex min-h-[350px] items-center justify-center text-center"><div><div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-violet-400/20 bg-violet-400/10 text-2xl text-violet-300">✦</div><div className="text-sm text-slate-400">Inject a fault to wake it up.</div></div></div> : tab === "forecast" ? <Forecast plan={plan} timeline={compare.without_ai} tick={tick} forecast={forecast} /> : tab === "root" ? <RootCause plan={plan} tick={tick} currentTick={currentTick} /> : <Recovery plan={plan} compare={compare} setActiveTimeline={setActiveTimeline} onFix={onFix} onBurn={onBurn} onCompare={onCompare} />}</aside>;
}

function Forecast({ plan, timeline, tick, forecast }: { plan?: Plan; timeline: Timeline; tick?: Tick; forecast: [string, ServiceTick][] }) {
  const lead = timeline.summary.warning_lead_seconds;
  return <div className="space-y-4 pt-4"><div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-3"><div className="text-2xl font-semibold text-cyan-300">{lead != null ? `AI warned ${lead}s` : "No warning yet"}</div><div className="mt-1 text-xs text-slate-400">{lead != null ? "before the first failure" : "Forecast = chance this service fails within the next 2 minutes."}</div></div>{plan && <div className="text-xs text-slate-500">Current forecast at <strong className="font-mono text-cyan-300">{tick?.clock ?? "—"}</strong></div>}<div><div className="eyebrow mb-3">Top services by failure probability</div><div className="space-y-3">{forecast.map(([service, data]) => <div key={service}><div className="mb-1 flex justify-between text-xs"><span className="flex items-center gap-2 text-slate-300"><i className={`h-1.5 w-1.5 rounded-full ${dotStyles[data.status]}`} />{service}</span><span className="font-mono text-slate-400">{Math.round(data.p_fail * 100)}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#202b39]"><div className={`h-full rounded-full ${data.p_fail >= .7 ? "bg-red-400" : data.p_fail >= .3 ? "bg-amber-400" : "bg-cyan-400"}`} style={{ width: `${Math.max(data.p_fail * 100, 1)}%` }} /></div></div>)}</div></div></div>;
}

function RootCause({ plan, tick, currentTick }: { plan?: Plan; tick?: Tick; currentTick: number }) {
  if (!plan) return null;
  const diagnosed = currentTick >= plan.tick;
  return <div className={`space-y-4 pt-4 ${!diagnosed ? "root-blur" : ""}`}><div className="rounded-lg border border-red-400/20 bg-red-400/5 p-3">{diagnosed ? <><div className="eyebrow text-red-300">Suspected root cause</div><div className="mt-1 text-xl font-semibold text-white">{plan.rca.service}</div><div className="mt-1 text-xs text-slate-400">{plan.rca.evidence}</div><div className="mt-3 flex items-center gap-3"><div className="confidence-ring" style={{ "--confidence": `${plan.rca.confidence * 100}%` } as CSSProperties}>{Math.round(plan.rca.confidence * 100)}%</div><span className="text-xs text-slate-400">{plan.rca.explained} of {plan.rca.anomalous} anomalies explained</span></div></> : <div className="text-sm text-violet-300">Diagnosing…</div>}</div><div><div className="eyebrow mb-3">Suspect ranking</div><div className="space-y-2">{plan.rca.ranking.slice(0, 3).map((item) => <div key={item.service} className="flex items-center gap-2 text-xs"><span className="w-28 truncate text-slate-300">{item.service}</span><div className="h-1.5 flex-1 rounded-full bg-[#202b39]"><div className="h-full rounded-full bg-violet-400" style={{ width: `${item.confidence * 100}%` }} /></div><span className="font-mono text-slate-500">{Math.round(item.confidence * 100)}%</span></div>)}</div></div><div><div className="eyebrow mb-2">Propagation paths</div>{Object.values(plan.rca.paths).length ? Object.values(plan.rca.paths).map((path, index) => <div key={index} className="path-chip">{path.join(" → ")}</div>) : <div className="text-xs text-slate-600">No downstream path isolated yet.</div>}</div></div>;
}

function Recovery({ plan, compare, setActiveTimeline, onFix, onBurn, onCompare }: { plan?: Plan; compare: Compare; setActiveTimeline: (timeline: TimelineName) => void; onFix: () => void; onBurn: () => void; onCompare: () => void }) {
  if (!plan) return null;
  const chartData = plan.strategies[0]?.curve.map((_, index) => { const point: Record<string, number> = { seconds: index * 10 }; plan.strategies.forEach((strategy) => { point[strategy.id] = strategy.curve[index]; }); return point; }) ?? [];
  const recommended = plan.strategies.find((s) => s.id === plan.recommended);
  const labelFor = (id: string) => plan.strategies.find((s) => s.id === id)?.label ?? id;
  const reveal = compare.without_ai.ticks.length > 0 && compare.headline;
  return <div className="space-y-4 pt-4"><div className="text-xs text-slate-400">Simulated <strong className="text-slate-200">{plan.monte_carlo.futures_per_strategy} futures</strong> per strategy over the next <strong className="text-slate-200">{plan.monte_carlo.horizon_seconds / 60} minutes</strong></div><div className="chart-box"><div className="eyebrow mb-2">Race · cumulative impact</div><ResponsiveContainer width="100%" height={145}><LineChart data={chartData}><CartesianGrid stroke="#263242" strokeDasharray="3 3" /><XAxis dataKey="seconds" tick={{ fill: "#64748b", fontSize: 9 }} /><YAxis tick={{ fill: "#64748b", fontSize: 9 }} width={32} /><Tooltip contentStyle={{ background: "#11161f", border: "1px solid #263242", fontSize: 11 }} /><Line dataKey="do_nothing" stroke="#f87171" strokeWidth={2} dot={false} /><Line dataKey={plan.recommended} stroke="#22d3ee" strokeWidth={3} dot={false} />{plan.strategies.filter((s) => s.id !== "do_nothing" && s.id !== plan.recommended).map((s) => <Line key={s.id} dataKey={s.id} stroke="#64748b" strokeWidth={1} dot={false} />)}</LineChart></ResponsiveContainer></div><div className="space-y-2">{[...plan.strategies].sort((a, b) => a.expected_impact - b.expected_impact).map((strategy) => <div key={strategy.id} className={`strategy-row ${!strategy.available ? "opacity-40" : ""}`}><div className="flex items-center justify-between text-xs"><span className="text-slate-300">{strategy.label}{strategy.id === plan.recommended && <b className="ml-2 rounded bg-cyan-400/15 px-1.5 py-0.5 text-[9px] text-cyan-300">AI PICK</b>}</span><span className="font-mono text-slate-400">{strategy.expected_impact.toLocaleString()}</span></div><div className="mt-1 h-1 rounded-full bg-[#202b39]"><div className={`h-full rounded-full ${strategy.id === plan.recommended ? "bg-cyan-400" : strategy.id === "do_nothing" ? "bg-red-400" : "bg-slate-500"}`} style={{ width: `${Math.max(2, strategy.expected_impact / Math.max(...plan.strategies.map((s) => s.expected_impact)) * 100)}%` }} /></div><div className="mt-1 flex justify-between text-[10px] text-slate-600"><span>p90 {strategy.p90_impact}</span><span>saves {strategy.saved_vs_do_nothing_pct}%</span></div></div>)}</div><div className="rounded-lg border border-cyan-400/15 bg-cyan-400/5 p-3 text-xs leading-relaxed text-slate-300">{plan.why}</div><div className="chart-box"><div className="eyebrow mb-2">Cost of delay</div><ResponsiveContainer width="100%" height={105}><LineChart data={plan.cost_of_delay}><CartesianGrid stroke="#263242" strokeDasharray="3 3" /><XAxis dataKey="delay_seconds" tick={{ fill: "#64748b", fontSize: 9 }} /><YAxis tick={{ fill: "#64748b", fontSize: 9 }} width={32} /><Tooltip contentStyle={{ background: "#11161f", border: "1px solid #263242", fontSize: 11 }} /><Line dataKey="expected_impact" stroke="#fbbf24" strokeWidth={2} dot={{ fill: "#fbbf24", r: 3 }} /></LineChart></ResponsiveContainer></div><div className="flex gap-2">  <button onClick={onFix} className="action-primary">Let AI fix it</button><button onClick={onBurn} className="action-secondary">Let it burn</button><button onClick={onCompare} className="action-secondary">Compare</button></div>{reveal && <Comparison compare={compare} labelFor={labelFor} recommended={recommended?.label ?? plan.recommended} setActiveTimeline={setActiveTimeline} />}</div>;
}

function Comparison({ compare, labelFor, recommended, setActiveTimeline }: { compare: Compare; labelFor: (id: string) => string; recommended: string; setActiveTimeline: (timeline: TimelineName) => void }) {
  const [show, setShow] = useState(false);
  const data = compare.without_ai.summary.impact_cumulative.map((value, index) => ({ tick: index, without: value, with: compare.with_ai.summary.impact_cumulative[index] ?? value }));
  return <div className="comparison-card"><button onClick={() => setShow((value) => !value)} className="mb-3 flex w-full items-center justify-between text-left"><span className="eyebrow text-emerald-300">Without AI vs With AI</span><span className="text-xs text-slate-500">{show ? "Hide" : "Reveal"} ↗</span></button>{show && <><div className="grid grid-cols-2 gap-2"><div><div className="text-[10px] text-slate-500">Without AI</div><div className="font-mono text-lg text-red-300">{compare.headline.impact_without.toLocaleString()}</div><div className="text-[10px] text-slate-600">{compare.headline.peak_failed_without} peak failed</div></div><div><div className="text-[10px] text-slate-500">With AI</div><div className="font-mono text-lg text-emerald-300">{compare.headline.impact_with.toLocaleString()}</div><div className="text-[10px] text-slate-600">{compare.headline.peak_failed_with} peak failed</div></div></div><div className="my-3 text-center text-3xl font-semibold text-cyan-300">{compare.headline.saved_pct}% less impact</div><ResponsiveContainer width="100%" height={115}><LineChart data={data}><XAxis dataKey="tick" hide /><YAxis hide /><Tooltip contentStyle={{ background: "#11161f", border: "1px solid #263242", fontSize: 11 }} /><Line dataKey="without" stroke="#f87171" strokeWidth={2} dot={false} /><Line dataKey="with" stroke="#34d399" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer><div className="text-[10px] text-slate-600">Recommended: {recommended}. Impact = criticality-weighted downtime, measured in the simulator.</div></>}</div>;
}

function RevealModal({ compare, onClose }: { compare: Compare; onClose: () => void }) {
  const data = compare.without_ai.summary.impact_cumulative.map((value, index) => ({ tick: index, without: value, with: compare.with_ai.summary.impact_cumulative[index] ?? value }));
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#05080dcc] p-4 backdrop-blur-sm"><div className="w-full max-w-2xl rounded-2xl border border-[#334155] bg-[#11161f] p-6 shadow-2xl"><div className="flex items-start justify-between"><div><div className="eyebrow text-cyan-300">Simulation complete</div><h2 className="mt-1 text-2xl font-semibold text-white">Without AI vs With AI</h2></div><button onClick={onClose} className="text-slate-500 hover:text-white">×</button></div><div className="mt-6 grid grid-cols-2 gap-4"><div className="rounded-xl border border-red-400/20 bg-red-400/5 p-4"><div className="text-xs text-slate-500">Without AI</div><div className="mt-1 font-mono text-2xl text-red-300">{compare.headline.impact_without.toLocaleString()}</div><div className="mt-1 text-xs text-slate-500">{compare.headline.peak_failed_without} peak failed</div></div><div className="rounded-xl border border-emerald-400/20 bg-emerald-400/5 p-4"><div className="text-xs text-slate-500">With AI</div><div className="mt-1 font-mono text-2xl text-emerald-300">{compare.headline.impact_with.toLocaleString()}</div><div className="mt-1 text-xs text-slate-500">{compare.headline.peak_failed_with} peak failed</div></div></div><div className="my-5 text-center"><div className="text-5xl font-semibold text-cyan-300">{compare.headline.saved_pct}%</div><div className="mt-1 text-sm text-slate-400">less impact with the recommended strategy</div></div><ResponsiveContainer width="100%" height={170}><LineChart data={data}><CartesianGrid stroke="#263242" strokeDasharray="3 3" /><XAxis dataKey="tick" tick={{ fill: "#64748b", fontSize: 9 }} /><YAxis tick={{ fill: "#64748b", fontSize: 9 }} /><Tooltip contentStyle={{ background: "#11161f", border: "1px solid #263242", fontSize: 11 }} /><Line dataKey="without" name="Without AI" stroke="#f87171" strokeWidth={2} dot={false} /><Line dataKey="with" name="With AI" stroke="#34d399" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer><div className="mt-4 text-center text-[10px] text-slate-600">Impact = criticality-weighted downtime, measured in the simulator.</div></div></div>;
}

function Drawer({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="drawer-backdrop" onClick={onClose}><aside className="side-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-title"><div><div className="eyebrow text-cyan-300">TELEMETRY DETAIL</div><h2>{title}</h2></div><button onClick={onClose} aria-label="Close drawer">×</button></div>{children}</aside></div>;
}

function NodeDrawer({ node, timeline, currentTick, onClose }: { node: Node | null; timeline: Timeline | null; currentTick: number; onClose: () => void }) {
  if (!node) return null;
  const points = timeline?.ticks.slice(0, currentTick + 1) ?? [];
  const metric = (key: "err" | "lat" | "cpu" | "mem") => points.map((item) => ({ t: item.t, value: item.services[node.id]?.[key] ?? 0 }));
  const current = points[points.length - 1]?.services[node.id];
  return <Drawer title={node.id} onClose={onClose}><div className="node-status"><span className={`status-dot ${current?.status ?? "healthy"}`} />{current?.status ?? "healthy"}<span className="node-risk">{current ? `${Math.round(current.p_fail * 100)}% failure risk` : "No active scenario"}</span></div><div className="spark-grid">{([["Error rate", "err"], ["Latency", "lat"], ["CPU", "cpu"], ["Memory", "mem"]] as const).map(([label, key]) => <div className="spark-card" key={key}><span>{label}</span><strong>{current ? current[key] : "—"}</strong><ResponsiveContainer width="100%" height={52}><LineChart data={metric(key)}><Line dataKey="value" stroke="#16a34a" strokeWidth={2} dot={false} /><XAxis dataKey="t" hide /><YAxis hide /></LineChart></ResponsiveContainer></div>)}</div><div className="node-facts"><div><span>CRITICALITY</span><strong>{Math.round(node.criticality * 100)}%</strong></div><div><span>STANDBY</span><strong>{node.has_standby ? "AVAILABLE" : "NONE"}</strong></div><div><span>STATEFUL</span><strong>{node.stateful ? "YES" : "NO"}</strong></div></div></Drawer>;
}

function ModelDrawer({ model, offline, onClose }: { model: ModelStats | null; offline: boolean; onClose: () => void }) {
  return <Drawer title="How good is the AI?" onClose={onClose}>{!model ? <div className="drawer-loading">Loading model metrics…</div> : <><div className="model-banner"><strong>Measured on held-out simulated incidents</strong><span>{offline ? "Offline snapshot metrics" : "Live model metrics"}</span></div><div className="model-section"><div className="eyebrow">HOW EARLY DO WE KNOW?</div>{[["AI forecast", model.mean_warning_lead_seconds_ai], ["Alert at 30% errors", model.mean_warning_lead_seconds_threshold_alert], ["Alert at 50% errors", model.mean_warning_lead_seconds_threshold_alert_50]].map(([label, value]) => <div className="metric-bar" key={String(label)}><div><span>{label}</span><b>{Number(value).toFixed(1)}s</b></div><i><em style={{ width: `${Math.min(Number(value) / model.mean_warning_lead_seconds_ai * 100, 100)}%` }} /></i></div>)}</div><div className="model-kpis"><div><strong>{model.auc_full.toFixed(3)}</strong><span>AUC with graph features</span></div><div><strong>{model.auc_own_only.toFixed(3)}</strong><span>AUC without graph features</span></div></div><div className="model-facts"><div><span>FALSE ALARMS</span><strong>{model.false_alarms_healthy} / {model.healthy_service_ticks.toLocaleString()}</strong></div><div><span>PRECISION / RECALL</span><strong>{Math.round(model.precision * 100)}% / {Math.round(model.recall * 100)}%</strong></div><div><span>HELD-OUT FAILURES</span><strong>{model.test_failures}</strong></div></div><p className="model-footnote">{model.model}. The environment is a simulation.</p></>}</Drawer>;
}

export default App;
