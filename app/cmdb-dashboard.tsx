"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ConfigurationItem,
  HealthData,
  HealthFix,
  Operation,
  Relationship,
  TimelineEvent,
  mockCis,
  mockHealth,
  mockRelationships,
  mockTimeline,
} from "./cmdb-data";

type ApiState = "connecting" | "live" | "demo";
type Section = "comprehend" | "prioritize" | "remediate";
type IconName = "grid" | "pulse" | "tool" | "shield" | "play" | "pause" | "search" | "arrow" | "check" | "database" | "spark" | "clock" | "graph" | "refresh" | "x" | "filter" | "chevron";

const steps = ["Intake", "Staging", "AI read", "Confidence gate", "IRE", "CMDB", "Event log"];

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    pulse: <path d="M3 12h4l2.2-6 4.1 12 2.1-6H21"/>,
    tool: <path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 8.6 7 6.3 4.7a4 4 0 0 0 5 5L4 17.4V20h2.6l7.7-7.7a4 4 0 0 0 5-5L17 9.6 13.6 6.2 16 4z"/>,
    shield: <path d="M12 3 20 6v5c0 5.2-3.4 8.7-8 10-4.6-1.3-8-4.8-8-10V6l8-3Z"/>,
    play: <path d="m9 7 8 5-8 5V7Z" fill="currentColor"/>,
    pause: <><path d="M9 7v10"/><path d="M15 7v10"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    arrow: <><path d="M5 12h14"/><path d="m14 7 5 5-5 5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
    spark: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z"/><path d="m18 14 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></>,
    graph: <><circle cx="5" cy="16" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="19" cy="14" r="2"/><path d="m6.5 14.5 4-6.5M13.7 7.2l3.7 5.5M7 16h10"/></>,
    refresh: <><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 11M5.5 15A7 7 0 0 0 18 17.5l2-4.5"/></>,
    x: <><path d="m7 7 10 10"/><path d="M17 7 7 17"/></>,
    filter: <path d="M4 6h16M7 12h10M10 18h4"/>,
    chevron: <path d="m9 7 5 5-5 5"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function arrayFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const value = payload as Record<string, unknown>;
  for (const key of ["result", "data", "items", "records", "cis", "events", "relationships"]) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
    if (value[key] && typeof value[key] === "object") {
      const nested = arrayFromPayload(value[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function str(value: unknown, fallback = "—") { return value === undefined || value === null || value === "" ? fallback : String(value); }
function num(value: unknown, fallback = 0) { const result = Number(value); return Number.isFinite(result) ? result : fallback; }
function confidence(value: unknown, fallback = 0) { const parsed = num(value, fallback); return parsed > 1 ? parsed / 100 : parsed; }
function operation(value: unknown): Operation {
  const normalized = str(value, "NO_CHANGE").toUpperCase().replaceAll(" ", "_") as Operation;
  return ["INSERT", "UPDATE", "NO_CHANGE", "INSERT_AS_INCOMPLETE", "REVIEW", "ERROR"].includes(normalized) ? normalized : "NO_CHANGE";
}

function normalizeCis(payload: unknown): ConfigurationItem[] {
  return arrayFromPayload(payload).map((item, index) => {
    const row = item as Record<string, unknown>;
    const conf = confidence(row.confidence ?? row.mapping_confidence, 0.9);
    const op = operation(row.operation ?? row.ire_operation);
    const status = op === "REVIEW" ? "review" : op === "INSERT_AS_INCOMPLETE" ? "incomplete" : "live";
    return {
      id: str(row.id ?? row.sys_id ?? row.ci_id, `CI-${index + 1}`),
      name: str(row.name ?? row.ci_name ?? row.host_name, `Unnamed CI ${index + 1}`),
      className: str(row.className ?? row.class ?? row.sys_class_name, "Unclassified"),
      ip: str(row.ip ?? row.ip_address), source: str(row.source ?? row.discovery_source, "Migration Pipeline"),
      operation: op, confidence: conf, health: num(row.health ?? row.health_score, Math.round(conf * 100)),
      updatedAt: str(row.updatedAt ?? row.updated_at ?? row.sys_updated_on, "Just now"), status,
      provenance: Array.isArray(row.provenance) ? (row.provenance as ConfigurationItem["provenance"]) : [
        { label: "Source", value: str(row.source ?? row.discovery_source, "Migration Pipeline") },
        { label: "AI classification", value: str(row.className ?? row.class ?? row.sys_class_name, "Unclassified") },
        { label: "Confidence gate", value: `${Math.round(conf * 100)}%` },
        { label: "IRE result", value: op },
      ],
    };
  });
}

function normalizeTimeline(payload: unknown): TimelineEvent[] {
  return arrayFromPayload(payload).map((item, index) => {
    const row = item as Record<string, unknown>; const conf = confidence(row.confidence, 0);
    return {
      id: str(row.id ?? row.sys_id, `EV-${index + 1}`), seq: num(row.seq ?? row.sequence, index + 1),
      step: Math.min(7, Math.max(1, num(row.step, (index % 7) + 1))), name: str(row.name ?? row.event_name, steps[index % 7]),
      recordName: str(row.recordName ?? row.record_name ?? row.ci_name, "Record"), className: str(row.className ?? row.class ?? row.ci_class, "Unclassified"),
      operation: operation(row.operation), source: str(row.source, "Migration Pipeline"), confidence: conf,
      time: str(row.time ?? row.created_at ?? row.sys_created_on, "Just now"), status: (str(row.status, "complete") as TimelineEvent["status"]),
      reasoning: str(row.reasoning ?? row.detail ?? row.message, "Event recorded by the migration pipeline."),
    };
  }).sort((a, b) => a.seq - b.seq);
}

function normalizeRelationships(payload: unknown): Relationship[] {
  return arrayFromPayload(payload).map((item, index) => {
    const row = item as Record<string, unknown>;
    return { id: str(row.id ?? row.sys_id, `REL-${index + 1}`), source: str(row.source ?? row.parent ?? row.from), target: str(row.target ?? row.child ?? row.to), type: str(row.type ?? row.relationship_type, "Depends on"), confidence: confidence(row.confidence, 0.9) };
  });
}

function normalizeHealth(payload: unknown): HealthData {
  const outer = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const raw = ((outer.result ?? outer.data ?? outer.health ?? outer) || {}) as Record<string, unknown>;
  const fixesRaw = (raw.fixes ?? raw.recommendations ?? raw.priorities) as unknown;
  const fixes = arrayFromPayload(fixesRaw).map((item, index) => {
    const row = item as Record<string, unknown>;
    return { id: str(row.id, `FIX-${index + 1}`), rank: num(row.rank, index + 1), title: str(row.title ?? row.name, "Recommended fix"), description: str(row.description ?? row.reason), impact: num(row.impact ?? row.score_impact, 1), affected: num(row.affected ?? row.count, 0), tool: str(row.tool ?? row.agent, "IRE advisor"), severity: str(row.severity, "medium") as HealthFix["severity"] };
  });
  return {
    score: num(raw.score ?? raw.health_score, mockHealth.score), grade: str(raw.grade, mockHealth.grade),
    ciCount: num(raw.ciCount ?? raw.ci_count ?? raw.total_cis, mockHealth.ciCount),
    duplicatesMerged: num(raw.duplicatesMerged ?? raw.duplicates_merged ?? raw.duplicates_avoided, mockHealth.duplicatesMerged),
    reviewCount: num(raw.reviewCount ?? raw.review_count ?? raw.pending_review, mockHealth.reviewCount),
    relationshipCount: num(raw.relationshipCount ?? raw.relationship_count ?? raw.relationships, mockHealth.relationshipCount),
    completeness: num(raw.completeness, mockHealth.completeness), correctness: num(raw.correctness, mockHealth.correctness),
    compliance: num(raw.compliance, mockHealth.compliance), duplicateRate: num(raw.duplicateRate ?? raw.duplicate_rate, mockHealth.duplicateRate),
    staleRecords: num(raw.staleRecords ?? raw.stale_records, mockHealth.staleRecords), fixes: fixes.length ? fixes : mockHealth.fixes,
  };
}

async function readEndpoint(resource: string) {
  const response = await fetch(`/api/cmdb/${resource}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${resource}: ${response.status}`);
  return response.json();
}

function OperationPill({ value }: { value: Operation }) {
  return <span className={`operation operation-${value.toLowerCase()}`}>{value.replaceAll("_", " ")}</span>;
}

function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100); const tone = pct >= 95 ? "good" : pct >= 75 ? "warn" : "bad";
  return <div className="confidence"><span className={`confidence-dot ${tone}`} /><span>{pct}%</span></div>;
}

export function CmdbDashboard() {
  const [section, setSection] = useState<Section>("comprehend");
  const [apiState, setApiState] = useState<ApiState>("connecting");
  const [cis, setCis] = useState(mockCis);
  const [timeline, setTimeline] = useState(mockTimeline);
  const [relationships, setRelationships] = useState(mockRelationships);
  const [health, setHealth] = useState(mockHealth);
  const [selectedCi, setSelectedCi] = useState<ConfigurationItem | null>(null);
  const [playing, setPlaying] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "review">("all");
  const [lastSync, setLastSync] = useState("—");
  const [queuedFix, setQueuedFix] = useState<HealthFix | null>(null);
  const [actionMessage, setActionMessage] = useState("");

  async function loadData() {
    setApiState("connecting");
    const results = await Promise.allSettled([readEndpoint("cis"), readEndpoint("timeline"), readEndpoint("relationships"), readEndpoint("health")]);
    let liveCount = 0;
    if (results[0].status === "fulfilled") { const rows = normalizeCis(results[0].value); if (rows.length) { setCis(rows); liveCount++; } }
    if (results[1].status === "fulfilled") { const rows = normalizeTimeline(results[1].value); if (rows.length) { setTimeline(rows); liveCount++; } }
    if (results[2].status === "fulfilled") { const rows = normalizeRelationships(results[2].value); if (rows.length) { setRelationships(rows); liveCount++; } }
    if (results[3].status === "fulfilled") { setHealth(normalizeHealth(results[3].value)); liveCount++; }
    setApiState(liveCount === 4 ? "live" : "demo");
    setLastSync(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadData(); }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [section]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setActiveStep(current => {
      if (current >= 6) { setPlaying(false); return 6; }
      return current + 1;
    }), 900);
    return () => window.clearInterval(timer);
  }, [playing]);

  const filteredCis = useMemo(() => cis.filter(ci => {
    const matches = `${ci.name} ${ci.className} ${ci.source} ${ci.ip}`.toLowerCase().includes(search.toLowerCase());
    return matches && (filter === "all" || ci.status !== "live");
  }), [cis, search, filter]);

  function startPlayback() {
    if (activeStep === 6) setActiveStep(0);
    setPlaying(value => !value);
  }

  async function submitRemediation(fix: HealthFix) {
    setQueuedFix(fix); setActionMessage("Preparing governed proposal…");
    try {
      const response = await fetch("/api/cmdb/remediate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fixId: fix.id, tool: fix.tool, route: "IRE", mode: "proposal" }) });
      if (!response.ok) throw new Error("not configured");
      setActionMessage("Proposal accepted. IRE validation is now queued.");
    } catch {
      setActionMessage("Demo proposal ready. Connect the remediation endpoint to queue it through IRE.");
    }
  }

  const nav: { id: Section; label: string; detail: string; icon: IconName }[] = [
    { id: "comprehend", label: "Comprehend", detail: "See the run", icon: "grid" },
    { id: "prioritize", label: "Prioritize", detail: "Rank what matters", icon: "pulse" },
    { id: "remediate", label: "Remediate", detail: "Close the loop", icon: "tool" },
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><span /></span><div><strong>CMDB</strong><small>MODERNIZATION CONTROL</small></div></div>
      <nav className="main-nav" aria-label="Main navigation">
        {nav.map(item => <button key={item.id} aria-label={`${item.label}: ${item.detail}`} title={item.label} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}>
          <span className="nav-icon"><Icon name={item.icon} /></span><span><strong>{item.label}</strong><small>{item.detail}</small></span><Icon name="chevron" size={14} />
        </button>)}
      </nav>
      <div className="sidebar-rule" />
      <div className="governance-card"><span className="shield"><Icon name="shield" size={17} /></span><div><small>GOVERNANCE LOCK</small><strong>IRE is the only write path</strong><p>Every CMDB mutation is reconciled, attributed, and logged.</p></div></div>
      <div className="sidebar-bottom"><div className={`api-dot ${apiState}`} /><div><strong>{apiState === "live" ? "Live API" : apiState === "connecting" ? "Connecting" : "Demo snapshot"}</strong><small>Last sync {lastSync}</small></div><button onClick={() => void loadData()} aria-label="Refresh data"><Icon name="refresh" size={16} /></button></div>
    </aside>

    <main className="main-content">
      <header className="topbar">
        <div><span className="eyebrow">MODERNIZATION RUN</span><strong>CMDB-BATCH-019</strong></div>
        <div className="top-actions"><span className="instance"><span className="live-dot" /> dev48291.service-now.com</span><button className="ghost-button"><Icon name="clock" size={15} /> Event ledger</button><div className="avatar">NS</div></div>
      </header>

      {section === "comprehend" && <ComprehendView health={health} timeline={timeline} relationships={relationships} cis={filteredCis} allCis={cis} selectedCi={selectedCi} setSelectedCi={setSelectedCi} search={search} setSearch={setSearch} filter={filter} setFilter={setFilter} playing={playing} activeStep={activeStep} startPlayback={startPlayback} setActiveStep={setActiveStep} apiState={apiState} />}
      {section === "prioritize" && <PrioritizeView health={health} onFix={(fix) => { setQueuedFix(fix); setSection("remediate"); }} />}
      {section === "remediate" && <RemediateView health={health} queuedFix={queuedFix} actionMessage={actionMessage} onSubmit={submitRemediation} />}
    </main>

    {selectedCi && <ProvenancePanel ci={selectedCi} onClose={() => setSelectedCi(null)} />}
  </div>;
}

function ComprehendView(props: {
  health: HealthData; timeline: TimelineEvent[]; relationships: Relationship[]; cis: ConfigurationItem[]; allCis: ConfigurationItem[];
  selectedCi: ConfigurationItem | null; setSelectedCi: (ci: ConfigurationItem) => void; search: string; setSearch: (value: string) => void;
  filter: "all" | "review"; setFilter: (value: "all" | "review") => void; playing: boolean; activeStep: number;
  startPlayback: () => void; setActiveStep: (value: number) => void; apiState: ApiState;
}) {
  const { health, timeline, relationships, cis, allCis, setSelectedCi, search, setSearch, filter, setFilter, playing, activeStep, startPlayback, setActiveStep, apiState } = props;
  return <div className="page">
    <section className="page-heading"><div><span className="eyebrow accent">COMPREHEND</span><h1>What happened to your data?</h1><p>Follow every record from raw intake to governed CMDB outcome.</p></div><div className="run-state"><span className="run-pulse" /><div><small>RUN STATUS</small><strong>Reconciliation complete</strong></div><span className="run-time">06m 09s</span></div></section>

    <section className="kpi-grid">
      <Kpi label="CIs published" value={health.ciCount.toLocaleString()} delta="+118 inserted" tone="lime" icon="database" />
      <Kpi label="Duplicates merged" value={health.duplicatesMerged.toLocaleString()} delta="17.3% avoided" tone="green" icon="graph" />
      <Kpi label="Need review" value={health.reviewCount.toLocaleString()} delta="1.4% of intake" tone="amber" icon="clock" />
      <Kpi label="Relationships" value={health.relationshipCount.toLocaleString()} delta="58 inferred" tone="coral" icon="spark" />
    </section>

    <section className="panel playback-panel">
      <div className="panel-heading"><div><span className="section-index">01</span><div><h2>Run playback</h2><p>Replay how one record moved through every governed decision.</p></div></div><div className="playback-controls"><span>{playing ? "PLAYING" : `STEP ${activeStep + 1} / 7`}</span><button className="play-button" onClick={startPlayback}><Icon name={playing ? "pause" : "play"} size={16} />{playing ? "Pause" : activeStep === 6 ? "Replay" : "Play run"}</button></div></div>
      <div className="stepper">
        {steps.map((step, index) => <button key={step} className={`${index < activeStep ? "done" : ""} ${index === activeStep ? "current" : ""}`} onClick={() => setActiveStep(index)}>
          <span className="step-node">{index < activeStep ? <Icon name="check" size={13} /> : index + 1}</span><span className="step-label">{step}</span>{index < 6 && <span className="step-line"><i /></span>}
        </button>)}
      </div>
      <div className="event-detail">
        <div className="event-number">{String(activeStep + 1).padStart(2, "0")}</div><div className="event-copy"><span>{timeline[activeStep]?.time || "—"} · {timeline[activeStep]?.source || "Migration Pipeline"}</span><h3>{timeline[activeStep]?.name || steps[activeStep]}</h3><p>{timeline[activeStep]?.reasoning || "Event detail is loading."}</p></div>
        <div className="event-meta"><div><small>CLASS</small><strong>{timeline[activeStep]?.className || "—"}</strong></div><div><small>CONFIDENCE</small><strong className="lime-text">{timeline[activeStep]?.confidence ? `${Math.round(timeline[activeStep].confidence * 100)}%` : "N/A"}</strong></div><div><small>IRE OUTCOME</small><OperationPill value={timeline[activeStep]?.operation || "NO_CHANGE"} /></div></div>
      </div>
    </section>

    <section className="visual-grid">
      <div className="panel sankey-panel"><div className="panel-heading compact"><div><span className="section-index">02</span><div><h2>Record flow</h2><p>Source to class to outcome</p></div></div><span className="panel-stat">1,248 RECORDS</span></div><SankeyVisual /></div>
      <div className="panel graph-panel"><div className="panel-heading compact"><div><span className="section-index">03</span><div><h2>Relationship graph</h2><p>CIs appear as evidence lands</p></div></div><span className="panel-stat"><i className="live-dot" /> LIVE</span></div><RelationshipGraph cis={allCis} relationships={relationships} /></div>
    </section>

    <section className="panel table-panel">
      <div className="panel-heading"><div><span className="section-index">04</span><div><h2>Configuration items</h2><p>Click any CI to inspect its complete provenance.</p></div></div><div className="table-actions"><label className="search-box"><Icon name="search" size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search CIs" /></label><button className={filter === "review" ? "filter-button active" : "filter-button"} onClick={() => setFilter(filter === "all" ? "review" : "all")}><Icon name="filter" size={15} /> Review queue</button></div></div>
      <div className="table-wrap"><table><thead><tr><th>Configuration item</th><th>Class</th><th>Source</th><th>IRE operation</th><th>Confidence</th><th>Health</th><th /></tr></thead><tbody>
        {cis.map(ci => <tr key={ci.id} onClick={() => setSelectedCi(ci)}><td><div className="ci-cell"><span className={`ci-icon status-${ci.status}`}><Icon name="database" size={15} /></span><div><strong>{ci.name}</strong><small>{ci.id} · {ci.ip}</small></div></div></td><td>{ci.className}</td><td><span className="source-name">{ci.source}</span></td><td><OperationPill value={ci.operation} /></td><td><Confidence value={ci.confidence} /></td><td><div className="health-cell"><span>{ci.health}</span><i><b style={{ width: `${ci.health}%` }} /></i></div></td><td><button className="row-arrow" aria-label={`Inspect ${ci.name}`}><Icon name="arrow" size={16} /></button></td></tr>)}
        {!cis.length && <tr><td colSpan={7} className="empty-state">No configuration items match this view.</td></tr>}
      </tbody></table></div>
      <div className="table-footer"><span>{cis.length} shown · {apiState === "live" ? "Live API" : "Demo snapshot"}</span><span>All mutations routed through <strong>IRE</strong></span></div>
    </section>
  </div>;
}

function Kpi({ label, value, delta, tone, icon }: { label: string; value: string; delta: string; tone: string; icon: IconName }) {
  return <div className={`kpi-card ${tone}`}><div className="kpi-top"><span>{label}</span><span className="kpi-icon"><Icon name={icon} size={17} /></span></div><strong>{value}</strong><div className="kpi-foot"><span>{delta}</span><i /></div></div>;
}

function SankeyVisual() {
  const paths = [
    ["M88 48 C180 48 202 44 292 55", 18, "var(--coral)"], ["M88 57 C180 62 210 92 292 98", 13, "var(--amber)"],
    ["M88 124 C175 122 207 77 292 70", 15, "#55b98a"], ["M88 134 C180 142 215 142 292 141", 10, "#799bbd"],
    ["M88 198 C180 188 208 116 292 112", 12, "#b17fa4"], ["M88 207 C180 214 217 183 292 176", 8, "#d78a6c"],
    ["M310 55 C390 55 415 50 506 48", 18, "var(--lime)"], ["M310 70 C400 78 430 95 506 104", 12, "#50b58a"],
    ["M310 98 C390 93 426 64 506 62", 15, "var(--lime)"], ["M310 112 C400 116 428 117 506 118", 12, "#50b58a"],
    ["M310 141 C398 141 430 167 506 168", 10, "var(--amber)"], ["M310 176 C398 180 424 211 506 213", 8, "var(--coral)"],
  ] as const;
  return <div className="sankey"><div className="sankey-head"><span>SOURCE</span><span>AI CLASS</span><span>IRE OUTCOME</span></div><svg viewBox="0 0 590 250" role="img" aria-label="Records flowing from source systems to AI classes and IRE outcomes">
    {paths.map((path, i) => <path key={i} d={path[0]} stroke={path[2]} strokeWidth={path[1]} opacity=".42" fill="none" />)}
    <g className="sankey-nodes source"><rect x="70" y="38" width="18" height="30"/><rect x="70" y="114" width="18" height="30"/><rect x="70" y="190" width="18" height="28"/><text x="64" y="50" textAnchor="end">Baxter</text><text x="64" y="126" textAnchor="end">Legacy</text><text x="64" y="202" textAnchor="end">Other</text></g>
    <g className="sankey-nodes classes"><rect x="292" y="40" width="18" height="42"/><rect x="292" y="91" width="18" height="34"/><rect x="292" y="135" width="18" height="22"/><rect x="292" y="169" width="18" height="18"/><text x="286" y="55" textAnchor="end">Linux</text><text x="286" y="103" textAnchor="end">Windows</text><text x="286" y="147" textAnchor="end">Database</text><text x="286" y="181" textAnchor="end">Other</text></g>
    <g className="sankey-nodes outcomes"><rect x="506" y="35" width="18" height="42" className="lime-node"/><rect x="506" y="96" width="18" height="30" className="green-node"/><rect x="506" y="158" width="18" height="22" className="amber-node"/><rect x="506" y="205" width="18" height="18" className="coral-node"/><text x="530" y="50">Published</text><text x="530" y="108">Merged</text><text x="530" y="170">Review</text><text x="530" y="217">Error</text></g>
  </svg><div className="sankey-legend"><span><i className="lime-bg" /> Published 842</span><span><i className="green-bg" /> Merged 216</span><span><i className="amber-bg" /> Review 17</span><span><i className="coral-bg" /> Error 4</span></div></div>;
}

function RelationshipGraph({ cis, relationships }: { cis: ConfigurationItem[]; relationships: Relationship[] }) {
  const graphCis = cis.slice(0, 7);
  const positions = graphCis.reduce<Record<string, { x: number; y: number; ci: ConfigurationItem }>>((acc, ci, index) => {
    const angle = (index / Math.max(graphCis.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = index === 0 ? 0 : 112;
    acc[ci.name] = { x: 250 + Math.cos(angle) * radius, y: 145 + Math.sin(angle) * radius, ci };
    return acc;
  }, {});
  if (graphCis[0]) positions[graphCis[0].name] = { x: 250, y: 145, ci: graphCis[0] };
  return <div className="relationship-graph"><svg viewBox="0 0 500 300" role="img" aria-label="CI relationship graph">
    <defs><filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    {relationships.map(rel => { const from = positions[rel.source]; const to = positions[rel.target]; return from && to ? <line key={rel.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#747970" strokeDasharray="3 5" opacity={rel.confidence} /> : null; })}
    {Object.values(positions).map(({ x, y, ci }, index) => <g key={ci.id} className={`graph-node ${index === 0 ? "central" : ""}`} transform={`translate(${x} ${y})`}><circle r={index === 0 ? 27 : 18} className="node-halo"/><circle r={index === 0 ? 16 : 10} className={ci.status === "live" ? "node-live" : "node-review"} filter={index === 0 ? "url(#glow)" : undefined}/><text y={index === 0 ? 39 : 31}>{ci.name}</text><text y={index === 0 ? 51 : 43} className="node-class">{ci.className}</text></g>)}
  </svg><div className="graph-caption"><span><i className="node-key live" /> Published CI</span><span><i className="node-key review" /> Needs review</span><span>{relationships.length} visible relationships</span></div></div>;
}

function PrioritizeView({ health, onFix }: { health: HealthData; onFix: (fix: HealthFix) => void }) {
  return <div className="page">
    <section className="page-heading"><div><span className="eyebrow accent">PRIORITIZE</span><h1>Fix what moves health fastest.</h1><p>Issues are ranked by data impact, risk, and remediation effort.</p></div><button className="primary-button"><Icon name="refresh" size={16} /> Recalculate health</button></section>
    <section className="health-hero panel">
      <div className="score-ring" style={{ "--score": `${health.score * 3.6}deg` } as React.CSSProperties}><div><span>{health.grade}</span><strong>{health.score}</strong><small>CMDB HEALTH</small></div></div>
      <div className="health-copy"><span className="eyebrow">ESTATE ASSESSMENT</span><h2>Your CMDB is healthy, with four concentrated gaps.</h2><p>Resolve the top two recommendations to move the estate from <strong>{health.score}</strong> to a projected <strong>{Math.min(100, health.score + 10)}</strong>.</p><div className="score-scale"><i /><i /><i /><i className="active" /><i /><span style={{ left: `${health.score}%` }}>{health.score}</span></div></div>
      <div className="health-dimensions"><Metric label="Completeness" value={health.completeness} /><Metric label="Correctness" value={health.correctness} /><Metric label="Compliance" value={health.compliance} /><Metric label="Duplicate free" value={Math.round(100 - health.duplicateRate)} /></div>
    </section>
    <section className="priority-layout"><div className="panel priority-list"><div className="panel-heading"><div><span className="section-index">01</span><div><h2>Ranked fix list</h2><p>Ordered by projected health lift.</p></div></div><span className="panel-stat">+{health.fixes.reduce((sum, fix) => sum + fix.impact, 0)}% AVAILABLE</span></div>
      {health.fixes.map(fix => <article className="fix-row" key={fix.id}><span className="fix-rank">{String(fix.rank).padStart(2, "0")}</span><span className={`severity ${fix.severity}`} /> <div className="fix-main"><div><strong>{fix.title}</strong><span>{fix.tool}</span></div><p>{fix.description}</p><small>{fix.affected} records affected</small></div><div className="fix-impact"><small>HEALTH LIFT</small><strong>+{fix.impact}%</strong></div><button onClick={() => onFix(fix)}>Inspect <Icon name="arrow" size={15} /></button></article>)}
    </div><aside className="panel opportunity-card"><span className="eyebrow accent">BEST NEXT MOVE</span><h3>{health.fixes[0]?.title}</h3><p>{health.fixes[0]?.description}</p><div className="opportunity-number"><span>+{health.fixes[0]?.impact}%</span><small>projected health</small></div><div className="governed-note"><Icon name="shield" size={17} /><span>Agent proposes. IRE validates. CMDB receives only governed changes.</span></div><button className="primary-button" onClick={() => health.fixes[0] && onFix(health.fixes[0])}>Open remediation <Icon name="arrow" size={16} /></button></aside></section>
  </div>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="metric"><div><span>{label}</span><strong>{value}%</strong></div><i><b style={{ width: `${value}%` }} /></i></div>; }

function RemediateView({ health, queuedFix, actionMessage, onSubmit }: { health: HealthData; queuedFix: HealthFix | null; actionMessage: string; onSubmit: (fix: HealthFix) => void }) {
  const selected = queuedFix || health.fixes[0];
  return <div className="page">
    <section className="page-heading"><div><span className="eyebrow accent">REMEDIATE</span><h1>Close the loop, through IRE.</h1><p>Agent tools assemble evidence and propose corrections. IRE remains the sole write path.</p></div><div className="ire-lock"><Icon name="shield" size={18} /><span><small>WRITE CONTROL</small><strong>IRE enforced</strong></span></div></section>
    <section className="remediation-flow panel"><div className="flow-item active"><span><Icon name="spark" /></span><div><small>1 · ANALYZE</small><strong>Agent gathers evidence</strong></div></div><Icon name="arrow" /><div className="flow-item"><span><Icon name="tool" /></span><div><small>2 · PROPOSE</small><strong>Change set is reviewed</strong></div></div><Icon name="arrow" /><div className="flow-item locked"><span><Icon name="shield" /></span><div><small>3 · RECONCILE</small><strong>IRE validates identity</strong></div></div><Icon name="arrow" /><div className="flow-item"><span><Icon name="database" /></span><div><small>4 · PUBLISH</small><strong>CMDB + ledger update</strong></div></div></section>
    <section className="remediate-layout"><div className="agent-tools"><div className="section-title"><span className="section-index">01</span><div><h2>Agent tools</h2><p>Purpose-built analysis. Governed execution.</p></div></div><div className="tool-grid">
      {health.fixes.map((fix, index) => <button className={`tool-card ${selected?.id === fix.id ? "selected" : ""}`} key={fix.id} onClick={() => onSubmit(fix)}><span className="tool-icon"><Icon name={index === 0 ? "graph" : index === 1 ? "search" : index === 2 ? "shield" : "clock"} /></span><span className="tool-copy"><small>{fix.tool.toUpperCase()}</small><strong>{fix.title}</strong><span>{fix.affected} candidate records</span></span><span className="tool-impact">+{fix.impact}%</span></button>)}
    </div></div><aside className="proposal-panel panel"><div className="proposal-heading"><span className="eyebrow accent">CHANGE PROPOSAL</span><span className="draft-pill">DRAFT</span></div><h2>{selected?.title}</h2><p>{selected?.description}</p><div className="proposal-summary"><div><span>Candidate records</span><strong>{selected?.affected}</strong></div><div><span>Projected health</span><strong>+{selected?.impact}%</strong></div><div><span>Execution route</span><strong>IRE</strong></div></div><div className="evidence-box"><div><Icon name="spark" size={16} /><strong>Agent evidence</strong></div><ul><li>Identifier signals compared across all source systems</li><li>Current CMDB values retained as a reversible baseline</li><li>Every proposed merge receives a confidence score and reason</li></ul></div>{actionMessage && <div className="action-message"><Icon name="check" size={16} />{actionMessage}</div>}<button className="primary-button full" onClick={() => selected && onSubmit(selected)}><Icon name="shield" size={16} /> Send proposal to IRE</button><small className="no-direct-write">No browser action can write directly to a CMDB table.</small></aside></section>
  </div>;
}

function ProvenancePanel({ ci, onClose }: { ci: ConfigurationItem; onClose: () => void }) {
  return <div className="drawer-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><aside className="provenance-drawer"><div className="drawer-top"><div><span className="eyebrow accent">PROVENANCE</span><h2>{ci.name}</h2><p>{ci.id} · {ci.className}</p></div><button onClick={onClose} aria-label="Close provenance"><Icon name="x" /></button></div><div className="drawer-score"><div><small>CONFIDENCE</small><strong>{Math.round(ci.confidence * 100)}%</strong></div><div><small>HEALTH</small><strong>{ci.health}</strong></div><div><small>IRE OUTCOME</small><OperationPill value={ci.operation} /></div></div><div className="provenance-path"><span className="path-line" />{ci.provenance.map((item, index) => <div className="provenance-item" key={`${item.label}-${index}`}><span className={index === ci.provenance.length - 1 ? "path-node current" : "path-node"}>{index + 1}</span><div><small>{item.label}</small><strong>{item.value}</strong>{item.detail && <p>{item.detail}</p>}</div></div>)}</div><div className="drawer-governance"><Icon name="shield" /><div><strong>Governed by IRE</strong><p>No direct CMDB write occurred anywhere in this record’s journey.</p></div></div><button className="ghost-button full"><Icon name="clock" size={16} /> Open full ledger trail</button></aside></div>;
}
