"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

import {
  normalizeComprehendCis,
  normalizeComprehendHealth,
  normalizeComprehendRelationships,
  normalizeComprehendTimeline,
  normalizeRemediationFindings,
  normalizeRemediationReviews,
  type RemediationFinding,
  type RemediationReview,
} from "./lib/cmdb/comprehend-adapter";
import {
  createIreCorrelationId,
  deriveIreLifecycleState,
  ireLifecycleLabel,
  normalizeIreActionResponse,
  type IreAction,
  type IreActionError,
  type IreActionResponse,
  type IreLifecycleState,
} from "./lib/cmdb/ire";
import {
  deriveRemediationWorkQueue,
  type WorkQueueBucket,
  type WorkQueueItem,
  type WorkQueueItemSource,
} from "./lib/cmdb/work-queue";

import { Icon, type IconName } from "./icons";
import { LiveOpsView } from "./live-view";
import { AgentHrView } from "./hr-view";
import { ImportGatewayView, type ImportedRun } from "./import-view";

type ApiState = "connecting" | "live" | "partial" | "demo" | "error";
type ResourceName = "cis" | "timeline" | "relationships" | "health" | "findings" | "reviews";
type ResourceStatus = "connecting" | "live" | "error";
type ResourceState = Record<ResourceName, ResourceStatus>;
type Section = "import" | "comprehend" | "live" | "hr" | "prioritize" | "remediate";
type IreWorkbenchRecord = {
  simulation?: IreActionResponse;
  approval?: IreActionResponse;
  execution?: IreActionResponse;
  verification?: IreActionResponse;
};

const steps = ["Intake", "Staging", "AI read", "Confidence gate", "IRE", "CMDB", "Event log"];
const resourceNames: ResourceName[] = ["cis", "timeline", "relationships", "health", "findings", "reviews"];
const connectingResources: ResourceState = { cis: "connecting", timeline: "connecting", relationships: "connecting", health: "connecting", findings: "connecting", reviews: "connecting" };
const activeRunStorageKey = "cmdb-modernization:last-run-id";
const emptyHealth: HealthData = {
  ...mockHealth,
  score: 0,
  grade: "—",
  ciCount: 0,
  duplicateCandidates: 0,
  reviewCount: 0,
  relationshipCount: 0,
  completeness: 0,
  correctness: 0,
  compliance: 0,
  duplicateRate: 0,
  staleRecords: 0,
  fixes: [],
};

async function readEndpoint(resource: ResourceName, runId = "") {
  const query = runId ? `?run=${encodeURIComponent(runId)}` : "";
  const response = await fetch(`/api/cmdb/${resource}${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${resource}: ${response.status}`);
  return response.json();
}

function currentRunFromLocation() {
  if (typeof window === "undefined") return "";
  const runFromUrl = new URLSearchParams(window.location.search).get("run")?.trim() || "";
  if (runFromUrl) {
    try { window.localStorage.setItem(activeRunStorageKey, runFromUrl); } catch {}
    return runFromUrl;
  }
  try { return window.localStorage.getItem(activeRunStorageKey)?.trim() || ""; } catch { return ""; }
}

function rememberRun(runId: string) {
  try {
    if (runId) window.localStorage.setItem(activeRunStorageKey, runId);
    else window.localStorage.removeItem(activeRunStorageKey);
  } catch {}
}

function OperationPill({ value }: { value: Operation }) {
  const labels: Record<Operation, string> = {
    INSERT: "IRE-ELIGIBLE · NEW",
    UPDATE: "IRE-ELIGIBLE · MATCH",
    NO_CHANGE: "NO CHANGE",
    INSERT_AS_INCOMPLETE: "INCOMPLETE",
    REVIEW: "HELD",
    ERROR: "ERROR",
  };
  return <span className={`operation operation-${value.toLowerCase()}`}>{labels[value]}</span>;
}

function Confidence({ value }: { value: number }) {
  if (value <= 0) return <div className="confidence"><span className="confidence-dot warn" /><span>Pending</span></div>;
  const pct = Math.round(value * 100); const tone = pct >= 95 ? "good" : pct >= 75 ? "warn" : "bad";
  return <div className="confidence"><span className={`confidence-dot ${tone}`} /><span>{pct}%</span></div>;
}

export function CmdbDashboard() {
  const [section, setSection] = useState<Section>("import");
  const [apiState, setApiState] = useState<ApiState>("connecting");
  const [resourceState, setResourceState] = useState<ResourceState>(connectingResources);
  const [cis, setCis] = useState(mockCis);
  const [timeline, setTimeline] = useState(mockTimeline);
  const [relationships, setRelationships] = useState(mockRelationships);
  const [health, setHealth] = useState(mockHealth);
  const [findings, setFindings] = useState<RemediationFinding[]>([]);
  const [reviews, setReviews] = useState<RemediationReview[]>([]);
  const [selectedCi, setSelectedCi] = useState<ConfigurationItem | null>(null);
  const [playing, setPlaying] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "review">("all");
  const [lastSync, setLastSync] = useState("—");
  const [queuedFix, setQueuedFix] = useState<HealthFix | null>(null);
  const [actionMessage, setActionMessage] = useState("");
  const [instanceHost, setInstanceHost] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState(currentRunFromLocation);
  const [activeRunLabel, setActiveRunLabel] = useState(() => activeRunId ? `RUN-${activeRunId.slice(0, 8).toUpperCase()}` : "");
  const [runDraft, setRunDraft] = useState(activeRunId);
  const [livePaused, setLivePaused] = useState(false);
  const [liveRefreshing, setLiveRefreshing] = useState(false);
  const [liveRefreshCount, setLiveRefreshCount] = useState(0);
  const liveRefreshInFlight = useRef(false);

  const loadData = useCallback(async (runId: string) => {
    setApiState("connecting");
    setResourceState(connectingResources);
    if (runId) {
      setCis([]);
      setTimeline([]);
      setRelationships([]);
      setHealth(emptyHealth);
      setFindings([]);
      setReviews([]);
    }

    const results = await Promise.allSettled(resourceNames.map(resource => readEndpoint(resource, runId)));
    const nextResourceState = { ...connectingResources };
    let nextCis = runId ? [] : mockCis;
    let nextTimeline = runId ? [] : mockTimeline;
    let nextRelationships = runId ? [] : mockRelationships;
    let nextHealth = runId ? emptyHealth : mockHealth;
    let nextFindings: RemediationFinding[] = [];
    let nextReviews: RemediationReview[] = [];
    let liveCount = 0;
    if (results[0].status === "fulfilled") {
      nextCis = normalizeComprehendCis(results[0].value);
      nextResourceState.cis = "live";
      liveCount++;
    } else {
      nextResourceState.cis = "error";
    }
    if (results[1].status === "fulfilled") {
      nextTimeline = normalizeComprehendTimeline(results[1].value);
      nextResourceState.timeline = "live";
      liveCount++;
    } else {
      nextResourceState.timeline = "error";
    }
    if (results[2].status === "fulfilled") {
      nextRelationships = normalizeComprehendRelationships(results[2].value);
      nextResourceState.relationships = "live";
      liveCount++;
    } else {
      nextResourceState.relationships = "error";
    }
    if (results[3].status === "fulfilled") {
      nextHealth = normalizeComprehendHealth(results[3].value);
      nextResourceState.health = "live";
      liveCount++;
    } else {
      nextResourceState.health = "error";
    }
    if (results[4].status === "fulfilled") {
      nextFindings = normalizeRemediationFindings(results[4].value);
      nextResourceState.findings = "live";
      liveCount++;
    } else {
      nextResourceState.findings = "error";
    }
    if (results[5].status === "fulfilled") {
      nextReviews = normalizeRemediationReviews(results[5].value);
      nextResourceState.reviews = "live";
      liveCount++;
    } else {
      nextResourceState.reviews = "error";
    }
    setCis(nextCis);
    setTimeline(nextTimeline);
    setRelationships(nextRelationships);
    setHealth(nextHealth);
    setFindings(nextFindings);
    setReviews(nextReviews);
    setActiveStep(0);
    setPlaying(false);
    setResourceState(nextResourceState);
    setApiState(liveCount === resourceNames.length ? "live" : liveCount > 0 ? "partial" : runId ? "error" : "demo");
    setLastSync(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  }, []);

  const refreshLiveTimeline = useCallback(async () => {
    if (!activeRunId || liveRefreshInFlight.current) return;
    liveRefreshInFlight.current = true;
    setLiveRefreshing(true);
    try {
      const payload = await readEndpoint("timeline", activeRunId);
      setTimeline(normalizeComprehendTimeline(payload));
      setResourceState(current => ({ ...current, timeline: "live" }));
      setApiState(current => current === "demo" || current === "error" ? "partial" : current);
      setLiveRefreshCount(current => current + 1);
      setLastSync(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } catch {
      setTimeline([]);
      setResourceState(current => ({ ...current, timeline: "error" }));
      setApiState(current => current === "live" ? "partial" : current);
    } finally {
      liveRefreshInFlight.current = false;
      setLiveRefreshing(false);
    }
  }, [activeRunId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadData(activeRunId); }, 0);
    return () => window.clearTimeout(timer);
  }, [activeRunId, loadData]);
  useEffect(() => {
    if (!activeRunId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("run") === activeRunId) return;
    url.searchParams.set("run", activeRunId);
    window.history.replaceState({}, "", url);
  }, [activeRunId]);
  useEffect(() => {
    if ((section !== "live" && section !== "hr") || livePaused || !activeRunId) return;
    const timer = window.setInterval(() => { void refreshLiveTimeline(); }, 8000);
    return () => window.clearInterval(timer);
  }, [activeRunId, livePaused, refreshLiveTimeline, section]);
  useEffect(() => {
    fetch("/api/cmdb/instance", { cache: "no-store" })
      .then(response => (response.ok ? response.json() : null))
      .then(data => { if (data && typeof data.host === "string" && data.host) setInstanceHost(data.host); })
      .catch(() => {});
  }, []);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [section]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setActiveStep(current => {
      const lastEvent = Math.max(0, timeline.length - 1);
      if (current >= lastEvent) { setPlaying(false); return lastEvent; }
      return current + 1;
    }), 900);
    return () => window.clearInterval(timer);
  }, [playing, timeline.length]);

  const filteredCis = useMemo(() => cis.filter(ci => {
    const matches = `${ci.name} ${ci.className} ${ci.source} ${ci.ip}`.toLowerCase().includes(search.toLowerCase());
    return matches && (filter === "all" || ci.status !== "live");
  }), [cis, search, filter]);

  function openRun(run?: ImportedRun) {
    const runId = run ? run.id.trim() : activeRunId;
    const label = run?.label?.trim() || (runId ? `RUN-${runId.slice(0, 8).toUpperCase()}` : "");
    const changed = runId !== activeRunId;
    setActiveRunId(runId);
    setActiveRunLabel(label);
    setRunDraft(runId);
    setActiveStep(0);
    setLivePaused(false);
    setLiveRefreshCount(0);
    setSection("comprehend");
    rememberRun(runId);
    const url = new URL(window.location.href);
    if (runId) url.searchParams.set("run", runId);
    else url.searchParams.delete("run");
    window.history.replaceState({}, "", url);
    if (!changed) void loadData(runId);
  }

  function loadRunFromDraft() {
    openRun({ id: runDraft.trim(), label: runDraft.trim() ? `RUN-${runDraft.trim().slice(0, 8).toUpperCase()}` : "" });
  }

  function startPlayback() {
    if (!timeline.length) return;
    if (activeStep >= timeline.length - 1) setActiveStep(0);
    setPlaying(value => !value);
  }

  function openEventLedger() {
    setSelectedCi(null);
    setSection("comprehend");
    window.setTimeout(() => {
      document.getElementById("event-ledger")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
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
    { id: "import", label: "Import", detail: "Bring data in", icon: "upload" },
    { id: "comprehend", label: "Comprehend", detail: "See the run", icon: "grid" },
    { id: "live", label: "Live Ops", detail: "Watch agents work", icon: "bolt" },
    { id: "hr", label: "Agent HR", detail: "LLM supervisor & audit", icon: "users" },
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
      <div className="sidebar-bottom"><div className={`api-dot ${apiState}`} /><div><strong>{apiState === "live" ? "Live API" : apiState === "partial" ? "Partial API" : apiState === "connecting" ? "Connecting" : apiState === "error" ? "API error" : "Demo snapshot"}</strong><small>Last sync {lastSync}</small></div><button onClick={() => void loadData(activeRunId)} aria-label="Refresh data"><Icon name="refresh" size={16} /></button></div>
    </aside>

    <main className="main-content">
      <header className="topbar">
        <div><span className="eyebrow">{section === "import" ? "DATA INTAKE" : "MODERNIZATION RUN"}</span><strong>{section === "import" ? "NEW MIGRATION RUN" : activeRunLabel || "ALL MIGRATION RUNS"}</strong></div>
        <div className="top-actions"><span className="instance"><span className={instanceHost ? "live-dot" : "live-dot demo"} /> {instanceHost ?? "demo mode"}</span><a className="ghost-button" href={activeRunId ? `/ai-usage?run=${encodeURIComponent(activeRunId)}` : "/ai-usage"}><Icon name="spark" size={15} /> AI Usage</a><button className="ghost-button" onClick={openEventLedger}><Icon name="clock" size={15} /> Event ledger</button><div className="avatar">NS</div></div>
      </header>

      {section === "import" && <ImportGatewayView onOpenRun={openRun} />}
      {section === "comprehend" && <ComprehendView health={health} timeline={timeline} relationships={relationships} cis={filteredCis} allCis={cis} selectedCi={selectedCi} setSelectedCi={setSelectedCi} search={search} setSearch={setSearch} filter={filter} setFilter={setFilter} playing={playing} activeStep={activeStep} startPlayback={startPlayback} setActiveStep={setActiveStep} apiState={apiState} resourceState={resourceState} activeRunId={activeRunId} runDraft={runDraft} setRunDraft={setRunDraft} loadRun={loadRunFromDraft} clearRun={() => { setRunDraft(""); openRun({ id: "", label: "" }); }} />}
      {section === "live" && <LiveOpsView timeline={timeline} activeRunId={activeRunId} apiState={apiState} resourceStatus={resourceState.timeline} paused={livePaused} refreshing={liveRefreshing} refreshCount={liveRefreshCount} onPausedChange={setLivePaused} onRefresh={() => void refreshLiveTimeline()} />}
      {section === "hr" && <AgentHrView timeline={timeline} timelineLive={resourceState.timeline === "live"} cis={resourceState.cis === "live" ? cis : null} activeRunId={activeRunId} />}
      {section === "prioritize" && <PrioritizeView health={health} recalculating={apiState === "connecting"} onRecalculate={() => void loadData(activeRunId)} onFix={(fix) => { setQueuedFix(fix); setActionMessage(""); setSection("remediate"); }} />}
      {section === "remediate" && <RemediateView health={health} cis={cis} timeline={timeline} findings={findings} reviews={reviews} activeRunId={activeRunId} apiState={apiState} queuedFix={queuedFix} actionMessage={actionMessage} onSelect={(fix) => { setQueuedFix(fix); setActionMessage(""); }} onSubmit={submitRemediation} />}
    </main>

    {selectedCi && <ProvenancePanel ci={selectedCi} onClose={() => setSelectedCi(null)} onOpenLedger={openEventLedger} />}
  </div>;
}

function ComprehendView(props: {
  health: HealthData; timeline: TimelineEvent[]; relationships: Relationship[]; cis: ConfigurationItem[]; allCis: ConfigurationItem[];
  selectedCi: ConfigurationItem | null; setSelectedCi: (ci: ConfigurationItem) => void; search: string; setSearch: (value: string) => void;
  filter: "all" | "review"; setFilter: (value: "all" | "review") => void; playing: boolean; activeStep: number;
  startPlayback: () => void; setActiveStep: (value: number) => void; apiState: ApiState; resourceState: ResourceState;
  activeRunId: string; runDraft: string; setRunDraft: (value: string) => void; loadRun: () => void; clearRun: () => void;
}) {
  const { health, timeline, relationships, cis, allCis, setSelectedCi, search, setSearch, filter, setFilter, playing, activeStep, startPlayback, setActiveStep, apiState, resourceState, activeRunId, runDraft, setRunDraft, loadRun, clearRun } = props;
  const cisLive = resourceState.cis === "live";
  const timelineLive = resourceState.timeline === "live";
  const cleared = cisLive
    ? allCis.filter(ci => ci.status === "live").length
    : Math.max(0, health.ciCount - health.reviewCount);
  const review = allCis.filter(ci => ci.status !== "live").length;
  const reviewRate = allCis.length ? ((review / allCis.length) * 100).toFixed(1) : "0.0";
  const activeEvent = timeline[Math.min(activeStep, Math.max(0, timeline.length - 1))];
  const activePhase = activeEvent?.step ?? 1;
  const totalEvents = timeline.length;
  const runStatus = apiState === "connecting" ? "Loading ServiceNow run" : apiState === "live" ? "Live backend connected" : apiState === "partial" ? "Partial backend data" : apiState === "error" ? "ServiceNow run unavailable" : "Demo snapshot";
  const demoFallback = !activeRunId && apiState === "demo";
  const proposedEdgeLabel = `${relationships.length.toLocaleString()} PROPOSED ${relationships.length === 1 ? "EDGE" : "EDGES"}`;
  const proposedEdgeDelta = `${relationships.length.toLocaleString()} proposed ${relationships.length === 1 ? "edge" : "edges"}`;
  return <div className="page">
    <section className="page-heading"><div><span className="eyebrow accent">COMPREHEND</span><h1>What happened to your data?</h1><p>Follow every staged record from quarantine through deterministic analysis and the confidence gate.</p></div><div className="run-state"><span className={`run-pulse ${apiState === "partial" || apiState === "demo" || apiState === "error" ? "paused" : ""}`} /><div><small>RUN STATUS</small><strong>{runStatus}</strong></div><span className="run-time">{activeRunId ? activeRunId.slice(0, 8) : "ALL RUNS"}</span></div></section>

    <section className="run-context panel">
      <div className="run-context-copy"><span className="section-index">00</span><div><h2>Backend run context</h2><p>All four Comprehend resources use the same ServiceNow migration-run sys_id.</p></div></div>
      <label className="run-id-field"><span>RUN SYS_ID</span><input value={runDraft} onChange={event => setRunDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") loadRun(); }} placeholder="Paste migration_run sys_id" /></label>
      <div className="run-context-actions"><button className="primary-button" onClick={loadRun}><Icon name="refresh" size={15} /> Load run</button>{activeRunId && <button className="ghost-button" onClick={clearRun}>All runs</button>}</div>
      <div className="resource-statuses">
        {resourceNames.map(resource => <span key={resource} title={`${resource}: ${resourceState[resource]}`} className={`resource-status status-${resourceState[resource]}`}><i />{resource}</span>)}
      </div>
    </section>

    <section className="kpi-grid">
      <Kpi label="Staged CIs" value={(cisLive ? allCis.length : health.ciCount).toLocaleString()} delta={`${totalEvents} ledger events loaded`} tone="lime" icon="database" />
      <Kpi label="Gate cleared" value={cleared.toLocaleString()} delta="Eligible for future IRE simulation" tone="green" icon="shield" />
      <Kpi label="Held for review" value={(cisLive ? review : health.reviewCount).toLocaleString()} delta={`${reviewRate}% of loaded records`} tone="amber" icon="clock" />
      <Kpi label="Staged relationships" value={(resourceState.relationships === "live" ? relationships.length : health.relationshipCount).toLocaleString()} delta={proposedEdgeDelta} tone="coral" icon="spark" />
    </section>

    <section className="panel playback-panel" id="event-ledger">
      <div className="panel-heading"><div><span className="section-index">01</span><div><h2>Event Ledger playback</h2><p>Replay the ordered ServiceNow audit trail without collapsing agent actions.</p></div></div><div className="playback-controls"><span>{playing ? "PLAYING" : totalEvents ? `EVENT ${activeStep + 1} / ${totalEvents}` : "NO EVENTS"}</span><button className="play-button" disabled={!totalEvents} onClick={startPlayback}><Icon name={playing ? "pause" : "play"} size={16} />{playing ? "Pause" : activeStep >= totalEvents - 1 && totalEvents ? "Replay" : "Play run"}</button></div></div>
      <div className="stepper">
        {steps.map((step, index) => {
          const eventIndex = timeline.findIndex(event => event.step === index + 1);
          const unavailable = timelineLive && eventIndex < 0;
          const completed = eventIndex >= 0 && index < activePhase - 1;
          return <button key={step} disabled={unavailable} title={unavailable ? `${step} has not occurred in this run` : step} className={`${completed ? "done" : ""} ${index === activePhase - 1 ? "current" : ""} ${unavailable ? "pending" : ""}`} onClick={() => { if (eventIndex >= 0) setActiveStep(eventIndex); }}>
            <span className="step-node">{completed ? <Icon name="check" size={13} /> : index + 1}</span><span className="step-label">{step}</span>{index < 6 && <span className="step-line"><i /></span>}
          </button>;
        })}
      </div>
      <div className="event-detail">
        <div className="event-number">{String(activeEvent?.seq ?? activeStep + 1).padStart(2, "0")}</div><div className="event-copy"><span>{activeEvent?.time || "—"} · {activeEvent?.source || "Comprehend"}</span><h3>{activeEvent?.name || "No ledger event recorded"}</h3><p>{activeEvent?.reasoning || "ServiceNow returned no Event Ledger entries for this run."}</p></div>
        <div className="event-meta"><div><small>ACTOR</small><strong>{activeEvent?.source || "—"}</strong></div><div><small>PHASE</small><strong className="lime-text">{steps[(activeEvent?.step ?? 1) - 1]}</strong></div><div><small>STATUS</small><strong>{activeEvent?.status?.replaceAll("_", " ").toUpperCase() || "PENDING"}</strong></div></div>
      </div>
    </section>

    <section className="visual-grid">
      <div className="panel sankey-panel"><div className="panel-heading compact"><div><span className="section-index">02</span><div><h2>Record flow</h2><p>Source to proposed class to Comprehend outcome</p></div></div><span className="panel-stat">{cisLive ? `${allCis.length.toLocaleString()} STAGED RECORDS` : demoFallback ? "DEMO FLOW" : "DATA UNAVAILABLE"}</span></div><SankeyVisual cis={allCis} live={cisLive} demo={demoFallback} /></div>
      <div className="panel graph-panel"><div className="panel-heading compact"><div><span className="section-index">03</span><div><h2>Relationship graph</h2><p>Proposed staged-CI relationships</p></div></div><span className="panel-stat"><i className={resourceState.relationships === "live" ? "live-dot" : "live-dot demo"} /> {resourceState.relationships === "live" ? proposedEdgeLabel : demoFallback ? "DEMO" : "DATA UNAVAILABLE"}</span></div><RelationshipGraph cis={allCis} relationships={relationships} /></div>
    </section>

    <section className="panel table-panel">
      <div className="panel-heading"><div><span className="section-index">04</span><div><h2>Staged CI records</h2><p>Click any quarantined record to inspect its Comprehend provenance.</p></div></div><div className="table-actions"><label className="search-box"><Icon name="search" size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search CIs" /></label><button className={filter === "review" ? "filter-button active" : "filter-button"} onClick={() => setFilter(filter === "all" ? "review" : "all")}><Icon name="filter" size={15} /> Review queue</button></div></div>
      <div className="table-wrap"><table><thead><tr><th>Staged record</th><th>Proposed class</th><th>Source</th><th>Comprehend outcome</th><th>Confidence</th><th>Health</th><th /></tr></thead><tbody>
        {cis.map(ci => <tr key={ci.id} onClick={() => setSelectedCi(ci)}><td><div className="ci-cell"><span className={`ci-icon status-${ci.status}`}><Icon name="database" size={15} /></span><div><strong>{ci.name}</strong><small>{ci.id} · {ci.ip}</small></div></div></td><td>{ci.className}</td><td><span className="source-name">{ci.source}</span></td><td><OperationPill value={ci.operation} /></td><td><Confidence value={ci.confidence} /></td><td><div className="health-cell"><span>{ci.health}</span><i><b style={{ width: `${ci.health}%` }} /></i></div></td><td><button className="row-arrow" aria-label={`Inspect ${ci.name}`} onClick={() => setSelectedCi(ci)}><Icon name="arrow" size={16} /></button></td></tr>)}
        {!cis.length && <tr><td colSpan={7} className="empty-state">No configuration items match this view.</td></tr>}
      </tbody></table></div>
      <div className="table-footer"><span>{cis.length} shown · {cisLive ? "Live ServiceNow staged data" : demoFallback ? "Demo snapshot" : "ServiceNow staged data unavailable"}</span><span>No CMDB write occurs before <strong>IRE</strong></span></div>
    </section>
  </div>;
}

function Kpi({ label, value, delta, tone, icon }: { label: string; value: string; delta: string; tone: string; icon: IconName }) {
  return <div className={`kpi-card ${tone}`}><div className="kpi-top"><span>{label}</span><span className="kpi-icon"><Icon name={icon} size={17} /></span></div><strong>{value}</strong><div className="kpi-foot"><span>{delta}</span><i /></div></div>;
}

const sankeyOutcomeMeta = [
  { label: "IRE-eligible new", ops: ["INSERT"] as Operation[], node: "lime-node", bg: "lime-bg", color: "var(--lime)" },
  { label: "IRE-eligible match", ops: ["UPDATE", "NO_CHANGE"] as Operation[], node: "green-node", bg: "green-bg", color: "var(--green)" },
  { label: "Held", ops: ["REVIEW"] as Operation[], node: "amber-node", bg: "amber-bg", color: "var(--amber)" },
  { label: "Incomplete", ops: ["INSERT_AS_INCOMPLETE"] as Operation[], node: "amber-node", bg: "amber-bg", color: "var(--amber)" },
  { label: "Error", ops: ["ERROR"] as Operation[], node: "coral-node", bg: "coral-bg", color: "var(--coral)" },
];
const sankeySourceColors = ["#55b98a", "#799bbd", "#b17fa4", "#d78a6c"];
const sankeyMetaFor = (label: string) => sankeyOutcomeMeta.find(meta => meta.label === label) ?? sankeyOutcomeMeta[0];
const trimSankeyLabel = (value: string) => value.length > 15 ? `${value.slice(0, 14)}…` : value;

type SankeyNode = { label: string; count: number; y: number; h: number; out: number; in: number };

function rankSankeyEntries(labels: string[], keep: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const entries = ranked.slice(0, keep);
  const rest = ranked.slice(keep).reduce((sum, [, count]) => sum + count, 0);
  if (rest) entries.push(["Other", rest]);
  return entries;
}

function layoutSankeyNodes(entries: [string, number][], total: number): SankeyNode[] {
  let y = 36;
  return entries.map(([label, count]) => {
    const h = Math.max(10, (count / total) * 170);
    const node: SankeyNode = { label, count, y, h, out: 0, in: 0 };
    y += h + 10;
    return node;
  });
}

function sankeyRibbons(from: SankeyNode[], to: SankeyNode[], pairs: [string, string][], total: number, x1: number, x2: number, color: (src: SankeyNode, dst: SankeyNode) => string) {
  const counts = new Map<string, number>();
  for (const [a, b] of pairs) counts.set(`${a}|${b}`, (counts.get(`${a}|${b}`) || 0) + 1);
  const mid = (x2 - x1) * 0.45;
  const ribbons: { d: string; w: number; c: string }[] = [];
  for (const src of from) for (const dst of to) {
    const count = counts.get(`${src.label}|${dst.label}`);
    if (!count) continue;
    const w = Math.max(2, (count / total) * 170);
    const y1 = src.y + src.out + w / 2; src.out += w;
    const y2 = dst.y + dst.in + w / 2; dst.in += w;
    ribbons.push({ d: `M${x1} ${y1} C${x1 + mid} ${y1} ${x2 - mid} ${y2} ${x2} ${y2}`, w, c: color(src, dst) });
  }
  return ribbons;
}

function LiveSankey({ cis }: { cis: ConfigurationItem[] }) {
  const total = cis.length;
  const sourceNodes = layoutSankeyNodes(rankSankeyEntries(cis.map(ci => ci.source), 3), total);
  const classNodes = layoutSankeyNodes(rankSankeyEntries(cis.map(ci => ci.className), 3), total);
  const keptSources = new Set(sourceNodes.map(node => node.label));
  const keptClasses = new Set(classNodes.map(node => node.label));
  const sourceLabel = (ci: ConfigurationItem) => keptSources.has(ci.source) ? ci.source : "Other";
  const classLabel = (ci: ConfigurationItem) => keptClasses.has(ci.className) ? ci.className : "Other";
  const outcomeLabel = (ci: ConfigurationItem) => (sankeyOutcomeMeta.find(meta => meta.ops.includes(ci.operation)) ?? sankeyOutcomeMeta[0]).label;
  const outcomeNodes = layoutSankeyNodes(
    sankeyOutcomeMeta.map(meta => [meta.label, cis.filter(ci => outcomeLabel(ci) === meta.label).length] as [string, number]).filter(([, count]) => count > 0),
    total,
  );
  const stage1 = sankeyRibbons(sourceNodes, classNodes, cis.map(ci => [sourceLabel(ci), classLabel(ci)]), total, 88, 292, src => sankeySourceColors[sourceNodes.indexOf(src) % sankeySourceColors.length]);
  const stage2 = sankeyRibbons(classNodes, outcomeNodes, cis.map(ci => [classLabel(ci), outcomeLabel(ci)]), total, 310, 506, (_src, dst) => sankeyMetaFor(dst.label).color);

  return <div className="sankey"><div className="sankey-head"><span>SOURCE</span><span>PROPOSED CLASS</span><span>COMPREHEND GATE</span></div><svg viewBox="0 0 590 250" role="img" aria-label="Staged records flowing from source systems to proposed classes and Comprehend outcomes">
    {stage1.map((ribbon, i) => <path key={`s1-${i}`} d={ribbon.d} stroke={ribbon.c} strokeWidth={ribbon.w} opacity=".42" fill="none" />)}
    {stage2.map((ribbon, i) => <path key={`s2-${i}`} d={ribbon.d} stroke={ribbon.c} strokeWidth={ribbon.w} opacity=".42" fill="none" />)}
    <g className="sankey-nodes source">{sourceNodes.map(node => <g key={node.label}><rect x="70" y={node.y} width="18" height={node.h} /><text x="64" y={node.y + 12} textAnchor="end">{trimSankeyLabel(node.label)}</text></g>)}</g>
    <g className="sankey-nodes classes">{classNodes.map(node => <g key={node.label}><rect x="292" y={node.y} width="18" height={node.h} /><text x="286" y={node.y + 12} textAnchor="end">{trimSankeyLabel(node.label)}</text></g>)}</g>
    <g className="sankey-nodes outcomes">{outcomeNodes.map(node => <g key={node.label}><rect x="506" y={node.y} width="18" height={node.h} className={sankeyMetaFor(node.label).node} /><text x="530" y={node.y + 12}>{node.label}</text></g>)}</g>
  </svg><div className="sankey-legend">{outcomeNodes.map(node => <span key={node.label}><i className={sankeyMetaFor(node.label).bg} /> {node.label} {node.count.toLocaleString()}</span>)}</div></div>;
}

function SankeyVisual({ cis, live, demo }: { cis: ConfigurationItem[]; live: boolean; demo: boolean }) {
  if (live && cis.length) return <LiveSankey cis={cis} />;
  if (live) return <div className="sankey-empty"><Icon name="graph" size={24} /><strong>No CI records for this run</strong><p>The Sankey is synchronized; ServiceNow returned an empty CI collection.</p></div>;
  if (!demo) return <div className="sankey-empty"><Icon name="graph" size={24} /><strong>CI data unavailable</strong><p>No demo records are substituted for a selected ServiceNow run.</p></div>;
  const paths = [
    ["M88 48 C180 48 202 44 292 55", 18, "var(--coral)"], ["M88 57 C180 62 210 92 292 98", 13, "var(--amber)"],
    ["M88 124 C175 122 207 77 292 70", 15, "#55b98a"], ["M88 134 C180 142 215 142 292 141", 10, "#799bbd"],
    ["M88 198 C180 188 208 116 292 112", 12, "#b17fa4"], ["M88 207 C180 214 217 183 292 176", 8, "#d78a6c"],
    ["M310 55 C390 55 415 50 506 48", 18, "var(--lime)"], ["M310 70 C400 78 430 95 506 104", 12, "#50b58a"],
    ["M310 98 C390 93 426 64 506 62", 15, "var(--lime)"], ["M310 112 C400 116 428 117 506 118", 12, "#50b58a"],
    ["M310 141 C398 141 430 167 506 168", 10, "var(--amber)"], ["M310 176 C398 180 424 211 506 213", 8, "var(--coral)"],
  ] as const;
  return <div className="sankey"><div className="sankey-head"><span>SOURCE</span><span>PROPOSED CLASS</span><span>COMPREHEND GATE</span></div><svg viewBox="0 0 590 250" role="img" aria-label="Staged records flowing from source systems to proposed classes and Comprehend outcomes">
    {paths.map((path, i) => <path key={i} d={path[0]} stroke={path[2]} strokeWidth={path[1]} opacity=".42" fill="none" />)}
    <g className="sankey-nodes source"><rect x="70" y="38" width="18" height="30"/><rect x="70" y="114" width="18" height="30"/><rect x="70" y="190" width="18" height="28"/><text x="64" y="50" textAnchor="end">Baxter</text><text x="64" y="126" textAnchor="end">Legacy</text><text x="64" y="202" textAnchor="end">Other</text></g>
    <g className="sankey-nodes classes"><rect x="292" y="40" width="18" height="42"/><rect x="292" y="91" width="18" height="34"/><rect x="292" y="135" width="18" height="22"/><rect x="292" y="169" width="18" height="18"/><text x="286" y="55" textAnchor="end">Linux</text><text x="286" y="103" textAnchor="end">Windows</text><text x="286" y="147" textAnchor="end">Database</text><text x="286" y="181" textAnchor="end">Other</text></g>
    <g className="sankey-nodes outcomes"><rect x="506" y="35" width="18" height="42" className="lime-node"/><rect x="506" y="96" width="18" height="30" className="green-node"/><rect x="506" y="158" width="18" height="22" className="amber-node"/><rect x="506" y="205" width="18" height="18" className="coral-node"/><text x="530" y="50">Cleared</text><text x="530" y="108">Matched</text><text x="530" y="170">Held</text><text x="530" y="217">Error</text></g>
  </svg><div className="sankey-legend"><span><i className="lime-bg" /> Cleared 842</span><span><i className="green-bg" /> Matched 216</span><span><i className="amber-bg" /> Held 17</span><span><i className="coral-bg" /> Error 4</span></div></div>;
}

function RelationshipGraph({ cis, relationships }: { cis: ConfigurationItem[]; relationships: Relationship[] }) {
  const graphCis = cis.slice(0, 7);
  const positions = new Map<string, { x: number; y: number; ci: ConfigurationItem }>();
  graphCis.forEach((ci, index) => {
    const angle = (index / Math.max(graphCis.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const radius = index === 0 ? 0 : 112;
    positions.set(ci.id, { x: 250 + Math.cos(angle) * radius, y: 145 + Math.sin(angle) * radius, ci });
  });
  if (graphCis[0]) positions.set(graphCis[0].id, { x: 250, y: 145, ci: graphCis[0] });
  const graphPositions = [...positions.values()];
  const nameCounts = graphCis.reduce<Map<string, number>>((counts, ci) => counts.set(ci.name, (counts.get(ci.name) || 0) + 1), new Map());
  const positionFor = (endpoint: string, label?: string) => {
    const byId = positions.get(endpoint);
    if (byId) return byId;
    const uniqueName = label || endpoint;
    if (nameCounts.get(uniqueName) !== 1) return undefined;
    return graphPositions.find(position => position.ci.name === uniqueName);
  };
  return <div className="relationship-graph"><svg viewBox="0 0 500 300" role="img" aria-label="CI relationship graph">
    <defs><filter id="glow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    {relationships.map(rel => { const from = positionFor(rel.source, rel.sourceLabel); const to = positionFor(rel.target, rel.targetLabel); return from && to ? <line key={rel.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#747970" strokeDasharray="3 5" opacity={rel.confidence} /> : null; })}
    {graphPositions.map(({ x, y, ci }, index) => <g key={ci.id} className={`graph-node ${index === 0 ? "central" : ""}`} transform={`translate(${x} ${y})`}><circle r={index === 0 ? 27 : 18} className="node-halo"/><circle r={index === 0 ? 16 : 10} className={ci.status === "live" ? "node-live" : "node-review"} filter={index === 0 ? "url(#glow)" : undefined}/><text y={index === 0 ? 39 : 31}>{ci.name}</text><text y={index === 0 ? 51 : 43} className="node-class">{ci.className}</text></g>)}
  </svg><div className="graph-caption"><span><i className="node-key live" /> Gate cleared</span><span><i className="node-key review" /> Held for review</span><span>{relationships.length} proposed {relationships.length === 1 ? "relationship" : "relationships"}</span></div></div>;
}

function PrioritizeView({ health, recalculating, onRecalculate, onFix }: { health: HealthData; recalculating: boolean; onRecalculate: () => void; onFix: (fix: HealthFix) => void }) {
  return <div className="page">
    <section className="page-heading"><div><span className="eyebrow accent">PRIORITIZE</span><h1>Fix what moves health fastest.</h1><p>Issues are ranked by data impact, risk, and remediation effort.</p></div><button className="primary-button" disabled={recalculating} onClick={onRecalculate}><Icon name="refresh" size={16} /> {recalculating ? "Recalculating…" : "Recalculate health"}</button></section>
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

function RemediateView(props: {
  health: HealthData;
  cis: ConfigurationItem[];
  timeline: TimelineEvent[];
  findings: RemediationFinding[];
  reviews: RemediationReview[];
  activeRunId: string;
  apiState: ApiState;
  queuedFix: HealthFix | null;
  actionMessage: string;
  onSelect: (fix: HealthFix) => void;
  onSubmit: (fix: HealthFix) => void;
}) {
  const { health, cis, timeline, findings, reviews, activeRunId, apiState, queuedFix, actionMessage, onSelect, onSubmit } = props;
  const selected = queuedFix || health.fixes[0];
  const stagedCis = cis.filter(ci => ci.id || ci.stagedCiId);
  const [selectedCiId, setSelectedCiId] = useState(() => stagedCis[0]?.id ?? "");
  const [ireRecords, setIreRecords] = useState<Record<string, IreWorkbenchRecord>>({});
  const [pendingAction, setPendingAction] = useState<IreAction | null>(null);
  const [rationale, setRationale] = useState("Reviewed simulation evidence and source identity for a single staged CI.");
  const demoFallback = !activeRunId && apiState === "demo";

  const selectedCi = stagedCis.find(ci => ci.id === selectedCiId) ?? stagedCis[0];
  const workbench = selectedCi ? ireRecords[selectedCi.id] ?? {} : {};
  const queue = useMemo(() => deriveRemediationWorkQueue({
    cis: stagedCis,
    timeline,
    healthFixes: health.fixes,
    findings,
    reviews,
    ireRecords,
    pending: { ciId: selectedCi?.id, action: pendingAction },
    demoFallback,
  }), [demoFallback, findings, health.fixes, ireRecords, pendingAction, reviews, selectedCi?.id, stagedCis, timeline]);
  const selectedQueueItem = queue.items.find(item => item.id === selectedCi?.id);
  const lifecycle = pendingAction === "execute" ? "executing" : selectedQueueItem?.lifecycle ?? deriveIreLifecycleState(workbench);
  const simulationCorrelation = workbench.simulation?.simulation_correlation_id ?? workbench.simulation?.correlation_id ?? selectedQueueItem?.simulationCorrelation;
  const executionCorrelation = workbench.execution
    ? workbench.execution.success
      ? workbench.execution.execution_correlation_id
      : undefined
    : selectedQueueItem?.executionCorrelation;
  const approved = Boolean((workbench.approval?.success && workbench.approval.status === "approved") || selectedQueueItem?.review?.decision === "approved");
  const rejected = Boolean((workbench.approval?.success && workbench.approval.status === "rejected") || selectedQueueItem?.review?.decision === "rejected");
  const liveRunReady = Boolean(activeRunId && selectedCi && apiState !== "demo");
  const selectedActivity = selectedCi ? timeline
    .filter(event => {
      const haystack = `${event.recordName} ${event.reasoning} ${event.name}`.toLowerCase();
      return haystack.includes(selectedCi.name.toLowerCase()) || haystack.includes(selectedCi.id.toLowerCase());
    })
    .slice(-5)
    : [];

  async function runIreAction(action: IreAction, extra: Record<string, string> = {}) {
    if (!selectedCi) return;
    const stagedCiId = selectedCi.stagedCiId || selectedCi.id;
    const migrationRunId = activeRunId || selectedCi.migrationRunId || "";
    const correlationId = createIreCorrelationId(action);
    const body = {
      migration_run_id: migrationRunId,
      staged_ci_id: stagedCiId,
      correlation_id: correlationId,
      idempotency_key: `keystone:${action}:${migrationRunId}:${stagedCiId}:${correlationId}`,
      ...extra,
    };

    setPendingAction(action);
    try {
      const response = await fetch(`/api/cmdb/ire/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({ error: response.statusText }));
      const upstream = normalizeIreActionResponse(action, payload);
      const normalized: IreActionResponse = response.ok
        ? upstream
        : {
            ...upstream,
            success: false,
            action,
            correlation_id: upstream.correlation_id ?? correlationId,
            error: upstream.error ?? errorFromIreHttp(response.status, payload),
          };
      setIreRecords(current => ({
        ...current,
        [selectedCi.id]: {
          ...(current[selectedCi.id] ?? {}),
          [recordSlot(action)]: normalized,
        },
      }));
    } finally {
      setPendingAction(null);
    }
  }

  function approve(decision: "approved" | "rejected") {
    void runIreAction("approve", {
      decision,
      rationale: rationale.trim() || `${decision === "approved" ? "Approved" : "Rejected"} after reviewing the simulation evidence.`,
      ...(simulationCorrelation ? { simulation_correlation_id: simulationCorrelation } : {}),
    });
  }

  return <div className="page">
    <section className="page-heading"><div><span className="eyebrow accent">REMEDIATE</span><h1>Single-record remediation workbench.</h1><p>Simulate, approve, execute, and verify one staged CI through ServiceNow IRE.</p></div><div className="ire-lock"><Icon name="shield" size={18} /><span><small>WRITE CONTROL</small><strong>IRE enforced</strong></span></div></section>
    <section className="remediation-flow panel"><div className="flow-item active"><span><Icon name="spark" /></span><div><small>1 - SIMULATE</small><strong>ServiceNow rebuilds</strong></div></div><Icon name="arrow" /><div className="flow-item active"><span><Icon name="check" /></span><div><small>2 - APPROVE</small><strong>One decision updates</strong></div></div><Icon name="arrow" /><div className="flow-item locked"><span><Icon name="shield" /></span><div><small>3 - EXECUTE</small><strong>Identifier-only request</strong></div></div><Icon name="arrow" /><div className="flow-item"><span><Icon name="database" /></span><div><small>4 - VERIFY</small><strong>Correlation tied</strong></div></div></section>
    <section className="panel work-queue-panel">
      <div className="panel-heading"><div><span className="section-index">01</span><div><h2>Derived agent work queue</h2><p>Queue state is reconstructed from staged CIs, IRE responses, health findings, and Event Ledger playback.</p></div></div><span className={`source-pill ${queue.liveBackedCount ? "live" : demoFallback ? "demo" : ""}`}>{queue.liveBackedCount ? `${queue.liveBackedCount} live-backed` : demoFallback ? "demo fallback" : "derived staging"}</span></div>
      <div className="queue-buckets">
        {queue.buckets.map(bucket => <WorkQueueBucketCard key={bucket.id} bucket={bucket} selectedId={selectedCi?.id} onSelect={setSelectedCiId} />)}
      </div>
    </section>
    <section className="remediate-layout"><div className="agent-tools"><div className="section-title"><span className="section-index">02</span><div><h2>Ranked remediation focus</h2><p>Choose the finding group, then work one staged CI at a time.</p></div></div><div className="tool-grid">
      {health.fixes.map((fix, index) => <button className={`tool-card ${selected?.id === fix.id ? "selected" : ""}`} key={fix.id} onClick={() => onSelect(fix)}><span className="tool-icon"><Icon name={index === 0 ? "graph" : index === 1 ? "search" : index === 2 ? "shield" : "clock"} /></span><span className="tool-copy"><small>{fix.tool.toUpperCase()}</small><strong>{fix.title}</strong><span>{fix.affected} candidate records</span></span><span className="tool-impact">+{fix.impact}%</span></button>)}
    </div></div><aside className="proposal-panel panel"><div className="proposal-heading"><span className="eyebrow accent">ACTIVE FINDING</span><span className="draft-pill">SINGLE CI</span></div><h2>{selected?.title}</h2><p>{selected?.description}</p><div className="proposal-summary"><div><span>Candidate records</span><strong>{selected?.affected}</strong></div><div><span>Projected health</span><strong>+{selected?.impact}%</strong></div><div><span>Execution route</span><strong>IRE</strong></div></div>{actionMessage && <div className="action-message"><Icon name="check" size={16} />{actionMessage}</div>}<button className="primary-button full" onClick={() => selected && onSubmit(selected)}><Icon name="shield" size={16} /> Record proposal</button><small className="no-direct-write">Execution below sends identifiers only. ServiceNow owns payload rebuild, approval, freshness, locks, and verification.</small></aside></section>
    <section className="workbench-layout">
      <div className="panel staged-workbench">
        <div className="panel-heading"><div><span className="section-index">03</span><div><h2>IRE lifecycle</h2><p>Browser requests contain only staged record identifiers and correlation metadata.</p></div></div><span className={`lifecycle-pill ${lifecycleTone(lifecycle)}`}>{ireLifecycleLabel(lifecycle)}</span></div>
        <div className="workbench-body">
          <div className="staged-queue">
            {queue.items.map(item => <button key={item.id} className={selectedCi?.id === item.id ? "staged-row selected" : "staged-row"} onClick={() => setSelectedCiId(item.id)}><span className={`ci-icon status-${item.ci.status}`}><Icon name="database" size={14} /></span><span><strong>{item.ci.name}</strong><small>{item.stagedCiId} / {ireLifecycleLabel(item.lifecycle)}</small></span><OperationPill value={item.ci.operation} /></button>)}
            {!stagedCis.length && <div className="workbench-empty"><Icon name="database" size={22} /><strong>No staged CIs loaded</strong><p>Load an active migration run before using IRE actions.</p></div>}
          </div>
          <div className="ire-console">
            <div className="selected-ci-card"><div><span className="eyebrow accent">SELECTED STAGED CI</span><h3>{selectedCi?.name ?? "No record selected"}</h3><p>{selectedCi ? `${selectedCi.className} / ${selectedCi.source} / ${selectedCi.ip}` : "Choose a staged CI to start simulation."}</p></div><div className="selected-ci-meta"><div><small>RUN</small><strong>{activeRunId ? activeRunId.slice(0, 8) : "none"}</strong></div><div><small>STAGED CI</small><strong>{selectedCi ? (selectedCi.stagedCiId || selectedCi.id).slice(0, 8) : "none"}</strong></div><div><small>CONFIDENCE</small><strong>{selectedCi ? `${Math.round(selectedCi.confidence * 100)}%` : "none"}</strong></div></div></div>
            {selectedQueueItem && <div className="queue-evidence"><div><span className={`source-dot ${selectedQueueItem.source}`} /><strong>{sourceLabel(selectedQueueItem.source)}</strong><p>{selectedQueueItem.reason}</p></div><div>{selectedQueueItem.evidence.map(item => <code key={item}>{item}</code>)}</div></div>}
            <div className="ire-action-grid">
              <button className="primary-button" disabled={!liveRunReady || Boolean(pendingAction)} onClick={() => void runIreAction("simulate")}><Icon name="spark" size={15} /> {pendingAction === "simulate" ? "Simulating..." : "Simulate"}</button>
              <button className="ghost-button" disabled={!liveRunReady || !simulationCorrelation || Boolean(pendingAction)} onClick={() => approve("approved")}><Icon name="check" size={15} /> {pendingAction === "approve" ? "Saving..." : "Approve"}</button>
              <button className="ghost-button danger" disabled={!liveRunReady || !simulationCorrelation || Boolean(pendingAction)} onClick={() => approve("rejected")}><Icon name="x" size={15} /> Reject</button>
              <button className="primary-button" disabled={!liveRunReady || !approved || rejected || !simulationCorrelation || lifecycle !== "approved_for_execution" || Boolean(pendingAction)} onClick={() => void runIreAction("execute", { simulation_correlation_id: simulationCorrelation ?? "" })}><Icon name="shield" size={15} /> {pendingAction === "execute" ? "Executing..." : "Execute"}</button>
              <button className="ghost-button" disabled={!liveRunReady || !executionCorrelation || lifecycle !== "executed_pending_verification" || Boolean(pendingAction)} onClick={() => void runIreAction("verify", { execution_correlation_id: executionCorrelation ?? "" })}><Icon name="check" size={15} /> {pendingAction === "verify" ? "Verifying..." : "Verify"}</button>
            </div>
            {!liveRunReady && <div className="ire-error"><Icon name="shield" size={15} />Load a live ServiceNow migration run before sending IRE requests. Demo snapshots cannot execute governed actions.</div>}
            <label className="approval-rationale"><span>APPROVAL RATIONALE</span><textarea value={rationale} onChange={event => setRationale(event.target.value)} /></label>
            <IreResultPanel workbench={workbench} lifecycle={lifecycle} playback={selectedQueueItem} />
          </div>
        </div>
      </div>
      <aside className="panel activity-panel"><div className="panel-heading compact"><div><span className="section-index">04</span><div><h2>Lifecycle activity</h2><p>Derived from action results and Event Ledger playback.</p></div></div></div><div className="activity-feed">{activityRows(workbench, selectedActivity).map(row => <article key={row.id} className={row.tone}><small>{row.label}</small><strong>{row.title}</strong><p>{row.detail}</p></article>)}</div></aside>
    </section>
  </div>;
}

function WorkQueueBucketCard({ bucket, selectedId, onSelect }: { bucket: WorkQueueBucket; selectedId?: string; onSelect: (id: string) => void }) {
  const preview = bucket.items.slice(0, 3);
  return <article className={`queue-bucket ${bucket.id}`}>
    <button className="queue-bucket-top" disabled={!bucket.items.length} onClick={() => bucket.items[0] && onSelect(bucket.items[0].id)}>
      <span>{bucket.label}</span><strong>{bucket.items.length}</strong>
    </button>
    <p>{bucket.description}</p>
    <div className="queue-preview">
      {preview.map(item => <button key={item.id} className={selectedId === item.id ? "selected" : ""} onClick={() => onSelect(item.id)}><span className={`source-dot ${item.source}`} /><strong>{item.ci.name}</strong><small>{ireLifecycleLabel(item.lifecycle)}</small></button>)}
      {!preview.length && <span className="queue-empty">No records in this bucket</span>}
    </div>
  </article>;
}

function sourceLabel(source: WorkQueueItemSource) {
  const labels: Record<WorkQueueItemSource, string> = {
    servicenow_ledger: "ServiceNow Event Ledger",
    servicenow_records: "ServiceNow findings and reviews",
    live_action: "Live IRE response",
    derived_staging: "Derived from staged CI",
    demo_fallback: "Demo fallback state",
  };
  return labels[source];
}

export function LegacyRemediateView({ health, queuedFix, actionMessage, onSelect, onSubmit }: { health: HealthData; queuedFix: HealthFix | null; actionMessage: string; onSelect: (fix: HealthFix) => void; onSubmit: (fix: HealthFix) => void }) {
  const selected = queuedFix || health.fixes[0];
  return <div className="page">
    <section className="page-heading"><div><span className="eyebrow accent">REMEDIATE</span><h1>Close the loop, through IRE.</h1><p>Agent tools assemble evidence and propose corrections. IRE remains the sole write path.</p></div><div className="ire-lock"><Icon name="shield" size={18} /><span><small>WRITE CONTROL</small><strong>IRE enforced</strong></span></div></section>
    <section className="remediation-flow panel"><div className="flow-item active"><span><Icon name="spark" /></span><div><small>1 · ANALYZE</small><strong>Agent gathers evidence</strong></div></div><Icon name="arrow" /><div className="flow-item"><span><Icon name="tool" /></span><div><small>2 · PROPOSE</small><strong>Change set is reviewed</strong></div></div><Icon name="arrow" /><div className="flow-item locked"><span><Icon name="shield" /></span><div><small>3 · RECONCILE</small><strong>IRE validates identity</strong></div></div><Icon name="arrow" /><div className="flow-item"><span><Icon name="database" /></span><div><small>4 · PUBLISH</small><strong>CMDB + ledger update</strong></div></div></section>
    <section className="remediate-layout"><div className="agent-tools"><div className="section-title"><span className="section-index">01</span><div><h2>Agent tools</h2><p>Purpose-built analysis. Governed execution.</p></div></div><div className="tool-grid">
      {health.fixes.map((fix, index) => <button className={`tool-card ${selected?.id === fix.id ? "selected" : ""}`} key={fix.id} onClick={() => onSelect(fix)}><span className="tool-icon"><Icon name={index === 0 ? "graph" : index === 1 ? "search" : index === 2 ? "shield" : "clock"} /></span><span className="tool-copy"><small>{fix.tool.toUpperCase()}</small><strong>{fix.title}</strong><span>{fix.affected} candidate records</span></span><span className="tool-impact">+{fix.impact}%</span></button>)}
    </div></div><aside className="proposal-panel panel"><div className="proposal-heading"><span className="eyebrow accent">CHANGE PROPOSAL</span><span className="draft-pill">DRAFT</span></div><h2>{selected?.title}</h2><p>{selected?.description}</p><div className="proposal-summary"><div><span>Candidate records</span><strong>{selected?.affected}</strong></div><div><span>Projected health</span><strong>+{selected?.impact}%</strong></div><div><span>Execution route</span><strong>IRE</strong></div></div><div className="evidence-box"><div><Icon name="spark" size={16} /><strong>Agent evidence</strong></div><ul><li>Identifier signals compared across all source systems</li><li>Current CMDB values retained as a reversible baseline</li><li>Every proposed merge receives a confidence score and reason</li></ul></div>{actionMessage && <div className="action-message"><Icon name="check" size={16} />{actionMessage}</div>}<button className="primary-button full" onClick={() => selected && onSubmit(selected)}><Icon name="shield" size={16} /> Send proposal to IRE</button><small className="no-direct-write">No browser action can write directly to a CMDB table.</small></aside></section>
  </div>;
}

function IreResultPanel({ workbench, lifecycle, playback }: { workbench: IreWorkbenchRecord; lifecycle: IreLifecycleState; playback?: WorkQueueItem }) {
  const latestError = workbench.verification?.error ?? workbench.execution?.error ?? workbench.approval?.error ?? workbench.simulation?.error;
  const latestErrorDetails = ireErrorDetails(latestError?.details);
  const targetCi = workbench.execution?.target_ci;
  const targetLabel = targetCi?.display_value ?? playback?.targetCiName ?? shortId(targetCi?.sys_id ?? playback?.targetCiSysId);
  return <div className="ire-results">
    {latestError && <div className="ire-error"><Icon name="x" size={15} />{friendlyIreError(latestError.code, latestError.message)}</div>}
    <div className="ire-result-grid">
      <ResultMetric label="State" value={ireLifecycleLabel(lifecycle)} />
      <ResultMetric label="Simulation" value={workbench.simulation?.status ?? (playback?.simulationCorrelation ? "recorded" : "not run")} />
      <ResultMetric label="Fingerprint" value={shortId(workbench.simulation?.simulation_fingerprint ?? playback?.simulationFingerprint)} />
      <ResultMetric label="Approval" value={workbench.approval?.status ?? playback?.review?.decision ?? "pending"} />
      <ResultMetric label="Execution" value={workbench.execution?.status ?? (lifecycle === "executed_pending_verification" || lifecycle === "verified" || lifecycle === "verification_failed" ? "committed" : "pending")} />
      <ResultMetric label="Verification" value={workbench.verification?.status ?? (lifecycle === "verified" ? "verified" : lifecycle === "verification_failed" ? "mismatch" : "pending")} />
    </div>
    <div className="correlation-list">
      <code>simulation {shortId(workbench.simulation?.simulation_correlation_id ?? workbench.simulation?.correlation_id ?? playback?.simulationCorrelation)}</code>
      <code>execution {shortId(workbench.execution?.success ? workbench.execution.execution_correlation_id : playback?.executionCorrelation)}</code>
      <code>target {targetLabel}</code>
    </div>
    {workbench.simulation?.evidence?.length ? <ul className="ire-evidence">{workbench.simulation.evidence.map(item => <li key={item}>{item}</li>)}</ul> : null}
    {latestErrorDetails.length ? <ul className="ire-evidence error-details">{latestErrorDetails.map(item => <li key={item}>{item}</li>)}</ul> : null}
    {(workbench.verification?.verification_summary || (lifecycle === "verification_failed" ? playback?.reason : undefined)) && <p className="verification-summary">{workbench.verification?.verification_summary ?? playback?.reason}</p>}
  </div>;
}

function ResultMetric({ label, value }: { label: string; value: string | undefined }) {
  return <div><span>{label}</span><strong>{value || "pending"}</strong></div>;
}

function recordSlot(action: IreAction): keyof IreWorkbenchRecord {
  if (action === "simulate") return "simulation";
  if (action === "approve") return "approval";
  if (action === "execute") return "execution";
  return "verification";
}

function errorFromIreHttp(status: number, payload: unknown): IreActionError {
  const row = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const message = typeof row.error === "string" ? row.error : typeof row.message === "string" ? row.message : `IRE request failed with HTTP ${status}.`;
  const code: IreActionError["code"] = status === 503 ? "NOT_CONFIGURED" : status === 400 ? "INVALID_REQUEST" : status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? inferConflictCode(message) : "IRE_FAILED";
  return { code, message, details: row.missing ?? row.detail ?? row.details };
}

function ireErrorDetails(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function inferConflictCode(message: string): IreActionError["code"] {
  const normalized = message.toLowerCase();
  if (normalized.includes("approval")) return "APPROVAL_REQUIRED";
  if (normalized.includes("stale") || normalized.includes("fingerprint")) return "STALE_SIMULATION";
  if (normalized.includes("duplicate") || normalized.includes("idempot")) return "DUPLICATE_EXECUTION";
  if (normalized.includes("correlation") || normalized.includes("verify")) return "VERIFY_MISMATCH";
  return "IRE_FAILED";
}

function friendlyIreError(code: string, message: string) {
  const labels: Record<string, string> = {
    NOT_CONFIGURED: "Missing ServiceNow IRE configuration.",
    APPROVAL_REQUIRED: "Execution is blocked until ServiceNow records approval.",
    STALE_SIMULATION: "Execution was rejected because the approved simulation is stale.",
    DUPLICATE_EXECUTION: "ServiceNow detected a duplicate idempotency key or prior execution.",
    VERIFY_MISMATCH: "Verification must use the specific execution correlation ID.",
    IRE_FAILED: "ServiceNow rejected the IRE action.",
  };
  return `${labels[code] ?? message} ${message}`;
}

function lifecycleTone(state: IreLifecycleState) {
  if (state === "verified") return "good";
  if (state.includes("failed") || state.includes("rejected")) return "bad";
  if (state.includes("approval") || state.includes("pending") || state === "executing") return "warn";
  return "";
}

function shortId(value?: string) {
  if (!value) return "pending";
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function activityRows(workbench: IreWorkbenchRecord, events: TimelineEvent[]) {
  const rows = [
    workbench.simulation && { id: "simulation", label: "SIMULATION", title: workbench.simulation.success ? "Simulation recorded" : "Simulation failed", detail: workbench.simulation.error?.message ?? workbench.simulation.evidence?.[0] ?? "ServiceNow returned simulation metadata.", tone: workbench.simulation.success ? "complete" : "error" },
    workbench.approval && { id: "approval", label: "APPROVAL", title: `${workbench.approval.status ?? "decision"} recorded`, detail: workbench.approval.error?.message ?? "Review decision was submitted for the single actionable finding.", tone: workbench.approval.success ? "review" : "error" },
    workbench.execution && { id: "execution", label: "EXECUTION", title: workbench.execution.success ? "Execution accepted" : "Execution rejected", detail: workbench.execution.error?.message ?? "ServiceNow rebuilt and handled the IRE execution request.", tone: workbench.execution.success ? "complete" : "error" },
    workbench.verification && { id: "verification", label: "VERIFY", title: workbench.verification.success ? "Verification complete" : "Verification failed", detail: workbench.verification.error?.message ?? workbench.verification.verification_summary ?? "Read-back was tied to the execution correlation ID.", tone: workbench.verification.success ? "complete" : "error" },
  ].filter(Boolean) as { id: string; label: string; title: string; detail: string; tone: string }[];
  const ledgerRows = events.map(event => ({ id: event.id, label: `LEDGER ${event.seq}`, title: event.name, detail: event.reasoning, tone: event.status }));
  return [...rows, ...ledgerRows].slice(-7).reverse();
}

function ProvenancePanel({ ci, onClose, onOpenLedger }: { ci: ConfigurationItem; onClose: () => void; onOpenLedger: () => void }) {
  return <div className="drawer-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><aside className="provenance-drawer"><div className="drawer-top"><div><span className="eyebrow accent">COMPREHEND PROVENANCE</span><h2>{ci.name}</h2><p>{ci.id} · {ci.className}</p></div><button onClick={onClose} aria-label="Close provenance"><Icon name="x" /></button></div><div className="drawer-score"><div><small>CONFIDENCE</small><strong>{Math.round(ci.confidence * 100)}%</strong></div><div><small>HEALTH</small><strong>{ci.health}</strong></div><div><small>GATE OUTCOME</small><OperationPill value={ci.operation} /></div></div><div className="provenance-path"><span className="path-line" />{ci.provenance.map((item, index) => <div className="provenance-item" key={`${item.label}-${index}`}><span className={index === ci.provenance.length - 1 ? "path-node current" : "path-node"}>{index + 1}</span><div><small>{item.label}</small><strong>{item.value}</strong>{item.detail && <p>{item.detail}</p>}</div></div>)}</div><div className="drawer-governance"><Icon name="shield" /><div><strong>IRE remains the only future write path</strong><p>Comprehend analyzed this staged record without writing to the CMDB.</p></div></div><button className="ghost-button full" onClick={onOpenLedger}><Icon name="clock" size={16} /> Open full ledger trail</button></aside></div>;
}
