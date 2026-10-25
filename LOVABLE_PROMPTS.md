# Lovable prompts for PreMortem

Send these **one at a time**, in order. Wait for each build to finish and glance at the preview before sending the next.
Before Prompt 1: start the backend (see README) and have `snapshot.json` ready to drop into the project's `public/` folder.

---

## PROMPT 1: shell, graph, playback

```
Build a single-page React + TypeScript + Tailwind app called "PreMortem" with the tagline
"See the crash before it happens. Break it yourself." Use framer-motion for animation and recharts for charts.
No auth, no database, no Supabase. All data comes from a REST API described below.

DESIGN: dark "mission control" look. Background #0A0E14, panels #11161F with 1px #1E2633 borders, rounded-xl.
Accent cyan #22D3EE. Status colors: healthy #34D399, degraded #FBBF24, failed #F87171, shed #64748B.
Monospace (JetBrains Mono) for numbers, logs and clock; Inter for text. Subtle glow on failed nodes. No lorem ipsum anywhere.

CONFIG: create src/config.ts exporting API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000".

LAYOUT (desktop first, stacks on mobile):
- Top bar: logo "PreMortem", a "SIMULATED ENVIRONMENT" badge, a live sim clock (HH:MM:SS), an API status pill
  ("Live engine" green / "Offline snapshot" amber), and a big Impact counter (cumulative impact so far, monospace).
- Left column (280px) "Break it" panel: three preset buttons (from /api/graph presets: title + blurb), then a divider "or click any
  service on the graph", then a fault-type segmented control (Memory leak = "leak", Crash = "crash", Overload = "overload"),
  and a seed input. 
- Center: the dependency graph (SVG, about 70% of the height) with a playback bar underneath.
- Right column (380px): empty placeholder card titled "AI Copilot" for now ("Inject a fault to wake it up").
- Bottom: a placeholder card "Live logs".

GRAPH: on load GET {API_BASE}/api/graph. Response:
{ nodes:[{id,tier,criticality,has_standby,stateful,x,y}], edges:[{source,target,coupling}],
  fault_kinds:[...], presets:[{id,title,root,kind,seed,blurb}], strategies:[{id,label}], tick_seconds }
x and y are 0..1 fixed positions: place nodes at x*width, y*height in a responsive SVG viewBox 1000x560. Do NOT use a force layout.
IMPORTANT edge semantics: edge {source,target} means "source DEPENDS ON target". Draw a thin curved line; draw arrowheads pointing
from source to target. Edge opacity ~0.25 by default, thickness proportional to coupling.
Nodes: rounded rectangles (130x44) with the service name, a small tier tag, and a status dot. Node color = status.
Clicking a node while idle opens a small popover: choose fault type -> "Inject fault here" (runs the scenario with root = that node).

RUNNING A SCENARIO: when the user clicks a preset, or injects a fault on a node, call
POST {API_BASE}/api/compare with JSON {root, kind, seed}. It returns (store all of it in state):
{
 plan: {...},                       // used in the next prompt
 without_ai: Timeline,              // the "let it burn" run
 with_ai: Timeline,                 // the run where the AI's recommendation is applied
 headline: {impact_without, impact_with, saved_pct, peak_failed_without, peak_failed_with}
}
Timeline = {
 scenario:{root,kind,seed,onset,ticks,strategy,act_tick,tick_seconds},
 services:[names],
 ticks:[ { t, clock, impact,
           services:{ [name]:{status:"healthy|degraded|failed|shed", err, lat, cpu, mem, p_fail} },
           logs:[{clock,level,svc,msg}],
           rca: null | {service, confidence, affected:[names], edges:[{source,target}]} } ],
 summary:{first_warning_tick, first_failure_tick, diagnosis_tick, warning_lead_seconds, peak_failed, total_impact, impact_cumulative:[...]}
}
There are 90 ticks per timeline; ticks 0..14 are healthy, a fault starts at tick 15.

PLAYBACK: a playback bar with Play/Pause, a scrubber (0..89), speed (1x/2x/4x) and a "Replay" button. Default playback = one tick per
350ms at 1x. Always render the graph from ticks[currentTick].services[name].status. While a scenario is loading show a skeleton +
"Simulating 90 ticks...". Put markers on the scrubber at summary.first_warning_tick (cyan "AI warning"), first_failure_tick (red "First failure")
and diagnosis_tick (violet "Diagnosis"). The Impact counter in the top bar = timeline.summary.impact_cumulative[currentTick], animated.

Start playing "without_ai" automatically when a scenario loads. Keep a state variable `activeTimeline` ("without_ai" | "with_ai") 
so the next prompt can switch it.
```

---

## PROMPT 2: AI Copilot (forecast, root cause, recovery lab, the reveal)

```
Now build the "AI Copilot" in the right column as a tabbed panel with 3 tabs: "Forecast", "Root cause", "Recovery lab".
All data is already in state from /api/compare. Use ticks[currentTick] of the active timeline.

1) GRAPH OVERLAYS (add to the existing graph):
- FORECAST HALO: for every node whose p_fail >= 0.3 and status is not "failed", draw a dashed ring around the node whose color goes
  amber->red with p_fail and whose thickness grows with p_fail; show a tiny label like "74% in 2 min". It must be clearly visible BEFORE the
  node turns red. This is the hero feature: the AI sees the failure coming.
- ROOT CAUSE MARKER: if rca != null, put a pulsing target icon on rca.service, and animate flowing dashed highlights along rca.edges.
  IMPORTANT edge semantics for rca.edges: {source,target} means failure flows FROM source TO target (source is the failing dependency, target is the
  service that depends on it). This is the opposite meaning from the /api/graph edges. Animate the flow in the direction source -> target, in red.

2) FORECAST TAB: top-6 services by p_fail right now as horizontal bars (service name, % bar, status dot). Above it a big callout:
"AI warned {summary.warning_lead_seconds}s before the first failure" (hide if null) and a small note
"Forecast = chance this service fails within the next 2 minutes".

3) ROOT CAUSE TAB: before rca exists show "No anomaly yet". Once rca exists show: the suspect service name large, a confidence ring
(rca.confidence), and "n of m anomalies explained" using affected.length. Below, a vertical list of plan.rca.ranking (top 3 suspects with
confidence bars) and plan.rca.evidence as a sentence. Under it, "Propagation paths": for each key in plan.rca.paths render a chip chain
like db-primary -> orders -> gateway. Only show plan.rca data once currentTick >= plan.tick (the diagnosis tick), otherwise blur it with "Diagnosing...".

4) AUTO-PAUSE AT DIAGNOSIS: when playback reaches tick === plan.tick on the "without_ai" timeline, pause, open the "Recovery lab" tab,
play a short "AI diagnosis complete" toast (root = plan.root, fault type = plan.fault_kind, confidence).

5) RECOVERY LAB TAB (the centerpiece):
- Header: "Simulated {futures_per_strategy} futures per strategy over the next {horizon_seconds/60} minutes" using plan.monte_carlo.
- A "Race" line chart (recharts): x = seconds into the future (index*10), y = cumulative impact, one line per available strategy
  from plan.strategies[i].curve (30 points). The recommended strategy (plan.recommended) is thick cyan; "do_nothing" is thick red; others thin grey.
  Animate the lines drawing in over 2 seconds.
- Below, a strategy list sorted by expected_impact: label, expected_impact, a bar, "p90 {p90_impact}", "saves {saved_vs_do_nothing_pct}%".
  Strategies with available=false are greyed with the tooltip "No standby replica for this service". Mark the recommended one with a "AI PICK" badge.
- A callout with plan.why verbatim.
- "Cost of delay" mini bar chart from plan.cost_of_delay (x = delay_seconds, y = expected_impact), titled "Every 30s of waiting costs more".
- Two big buttons: [ Let AI fix it ] (cyan) and [ Let it burn ] (ghost).
  * Let AI fix it: set activeTimeline = "with_ai" and continue playback from the SAME tick (ticks before plan.tick are identical).
    Log lines will show the orchestrator acting; nodes should visibly recover to green.
  * Let it burn: just resume the without_ai timeline.

6) THE REVEAL: when the active timeline reaches its last tick, or whenever the user presses a "Compare" button, show a full-width modal-card
"Without AI vs With AI" using `headline`: two columns. Left (red) "Without AI": impact_without, peak_failed_without services down.
Right (green) "With AI": impact_with, peak_failed_with. Center: huge animated number "{saved_pct}% less impact" with a count-up animation.
Add a small footnote: "Impact = criticality-weighted downtime, measured in the simulator." Also include a mini area chart overlaying
without_ai.summary.impact_cumulative (red) vs with_ai.summary.impact_cumulative (green).
```

---

## PROMPT 3: polish, logs, credibility, offline mode, guided demo

```
Polish pass. Keep everything that exists.

1) LIVE LOGS card (bottom): terminal style, monospace, newest at the bottom, auto-scroll. Show all logs from ticks 0..currentTick of the active timeline
as "{clock} {LEVEL} {msg}". Colors: INFO slate, WARN amber, ERROR red, FATAL bold red with a red left border. Clicking a log line selects that service.

2) NODE DETAIL drawer: clicking a node while a scenario is loaded selects it and shows a drawer with 4 recharts sparklines (error rate, latency ms, cpu, memory)
for ticks 0..currentTick, with a vertical line at the current tick, plus criticality, has_standby, stateful, and p_fail.

3) MODEL CREDIBILITY drawer (button "How good is the AI?" in the top bar). GET {API_BASE}/api/model. Show real numbers, nothing invented:
 - "Warning lead time": three horizontal bars comparing mean_warning_lead_seconds_ai (cyan) vs mean_warning_lead_seconds_threshold_alert
   (label "Alert at 30% errors") vs mean_warning_lead_seconds_threshold_alert_50 (label "Alert at 50% errors"), in seconds, title "How early do we know?".
 - "Graph-aware features matter": AUC auc_full vs auc_own_only as two big numbers with the label "with vs without dependency-graph features".
 - "False alarms": "{false_alarms_healthy} false alarms in {healthy_service_ticks} healthy service-ticks".
 - precision, recall, test_failures as small stats, and the model string.
 - Footnote: "Measured on held-out simulated incidents. The environment is a simulation."

4) OFFLINE MODE: if any API call fails (network error), load /snapshot.json from the public folder instead and set the status pill to "Offline snapshot".
 snapshot.json has the shape { graph: <same as /api/graph>, model: <same as /api/model>, presets: { "<preset id>": <same as the /api/compare response> } }.
 In offline mode only the 3 presets work: clicking a node shows a tooltip "Offline mode: pick a preset". Everything else behaves identically.

5) GUIDED DEMO button ("Run guided demo", prominent in the left panel): runs the first preset automatically with narrated captions in a
 bottom-center overlay that fade in/out, driven by the timeline:
 - at tick 15: "A fault begins in {root}. To a human, nothing looks wrong yet."
 - at summary.first_warning_tick: "AI forecast: {service with highest p_fail} will fail within 2 minutes."
 - at plan.tick (diagnosis): "Root cause found: {plan.root} ({Math.round(plan.diagnosis_confidence*100)}% confidence). Simulating futures..."
 - then auto-click the recommended action after 4 seconds: "Executing: {label of plan.recommended}".
 - at the end open the reveal card.
 A "Stop demo" button cancels it. Space bar toggles play/pause; "R" replays; keys 1/2/3 start presets.

6) Small details: loading skeletons, error toasts with a Retry button, tooltips on every badge, a footer line
 "PreMortem: failure forecasting, root-cause tracing and recovery planning on a simulated 14-service platform", favicon, page title,
 and make the layout work on a 1366x768 laptop without page scroll (panels scroll internally).
```

---

## If something looks wrong after a prompt

Paste a screenshot and one line, for example:
- "Edges point the wrong way for rca highlights. rca.edges flow from source to target (cause to dependent)."
- "The halo ring only shows for failed nodes; it must show when p_fail >= 0.3 and status is NOT failed."
- "Scrubber markers are not showing; read summary.first_warning_tick / first_failure_tick / diagnosis_tick."
