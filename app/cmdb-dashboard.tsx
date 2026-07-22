"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConfigurationItem,
  HealthData,
  HealthFix,
  Operation,
  Relationship,
  TimelineEvent,
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
  isMaraObservationEvent,
  sortTimelineByFreshness,
  type WorkQueueBucket,
  type WorkQueueItem,
  type WorkQueueItemSource,
  type WorkQueueSummary,
} from "./lib/cmdb/work-queue";

import { normalizeMaraRun, type MaraRunRecord } from "./lib/cmdb/mara-audit";
import {
  buildPlaybackTimeline,
  derivePlaybackNodeStates,
  playbackNodeLabel,
  PLAYBACK_NODES,
  type PlaybackFrame,
} from "./lib/cmdb/playback";
import { isDraftRunState, isTerminalRunState, TERMINAL_RUN_STATES } from "./lib/cmdb/run-lifecycle";
import { rememberRun, resolveActiveRun } from "./lib/cmdb/run-context";
import { forgetRunEntry, isRunTerminal as isRegistryRunTerminal, readRegistry, rememberRunEntry, type RegistryEntry } from "./lib/cmdb/run-registry";
import { Icon, type IconName } from "./icons";
import { LiveOpsView } from "./live-view";
import { AgentHrView } from "./hr-view";
import { ImportGatewayView, type ImportedRun } from "./import-view";
import { MaraCompanion } from "./mara-companion";
import { AgentWorkspaceView } from "./agent-workspace";
import { deriveWorkspaceViewState } from "./lib/cmdb/workspace-view-state";
import { PageNavigation } from "./components/PageNavigation";
import { formatTechnicalSource, parseMaraObservation } from "./lib/cmdb/mara-observation";
import {
  EndpointError,
  classifyEndpointStatus,
  extractComprehendError,
  friendlyIreError,
} from "./lib/cmdb/frontend-errors";
import {
  CI_EVIDENCE_EMPTY_STATE,
  STRATEGY_FAILURE_CARD,
  buildRunSummaryChips,
  classifySimulationFailure,
  hasCiSpecificIreResponse,
  type RunSummaryChip,
  type SimulationFailureClassification,
} from "./lib/cmdb/selected-ci-evidence";
import {
  externalHrefFor,
  navigationItems,
  type NavSectionId,
} from "./lib/nav/navigation";

type ApiState = "connecting" | "live" | "partial" | "demo" | "error";
type AnalysisState = "idle" | "starting" | "started" | "error";
type ResourceName = "cis" | "timeline" | "relationships" | "health" | "findings" | "reviews";
type ResourceStatus = "connecting" | "live" | "unavailable" | "error";
type ResourceState = Record<ResourceName, ResourceStatus>;
type Section = "import" | "runs" | "workspace" | "approvals" | "evidence" | "comprehend" | "live" | "hr" | "prioritize" | "remediate";
type IreWorkbenchRecord = {
  simulation?: IreActionResponse;
  approval?: IreActionResponse;
  execution?: IreActionResponse;
  verification?: IreActionResponse;
};

const resourceNames: ResourceName[] = ["cis", "timeline", "relationships", "health", "findings", "reviews"];
const connectingResources: ResourceState = { cis: "connecting", timeline: "connecting", relationships: "connecting", health: "connecting", findings: "connecting", reviews: "connecting" };
const emptyHealth: HealthData = {
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
  const hasRun = Boolean(runId);
  const query = hasRun ? `?run=${encodeURIComponent(runId)}` : "";
  let response: Response;
  try {
    response = await fetch(`/api/cmdb/${resource}${query}`, { cache: "no-store" });
  } catch (error) {
    throw new EndpointError(resource, 0, "backend", error instanceof Error ? error.message : "network error");
  }
  if (!response.ok) {
    let detail: string | undefined;
    try {
      const body = await response.clone().json() as Record<string, unknown>;
      const nested = body.result && typeof body.result === "object" && !Array.isArray(body.result)
        ? body.result as Record<string, unknown>
        : undefined;
      detail = typeof body.error === "string" ? body.error
        : typeof body.message === "string" ? body.message
        : nested && typeof nested.error === "string" ? nested.error
        : nested && typeof nested.message === "string" ? nested.message
        : undefined;
    } catch { /* body not JSON, ignore */ }
    throw new EndpointError(resource, response.status, classifyEndpointStatus(response.status, hasRun), detail);
  }
  return response.json();
}

/** Map an EndpointError to a ResourceStatus. Unknown errors default to "error". */
function endpointErrorToStatus(error: unknown): ResourceStatus {
  if (error instanceof EndpointError) {
    if (error.kind === "unavailable") return "unavailable";
    if (error.kind === "client") return "error";
    return "error";
  }
  return "error";
}

// Sections that reflect backend pipeline progress and therefore poll while a run works.
const polledSections: Section[] = ["workspace", "approvals", "evidence", "comprehend", "hr", "prioritize", "remediate"];

const terminalRunStates = new Set<string>(TERMINAL_RUN_STATES);

async function readRunStatus(runId: string): Promise<MaraRunRecord | null> {
  if (!runId) return null;
  const response = await fetch(`/api/cmdb/run?run=${encodeURIComponent(runId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`run: ${response.status}`);
  return normalizeMaraRun(await response.json());
}

// Resolve on mount from the shared run-context module so AI Usage and the
// dashboard share exactly the same priority: URL first, then localStorage.
function currentRunFromLocation() {
  const resolved = resolveActiveRun();
  if (resolved) rememberRun(resolved);
  return resolved;
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
  const [cis, setCis] = useState<ConfigurationItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [health, setHealth] = useState<HealthData>(emptyHealth);
  const [findings, setFindings] = useState<RemediationFinding[]>([]);
  const [reviews, setReviews] = useState<RemediationReview[]>([]);
  const [selectedCi, setSelectedCi] = useState<ConfigurationItem | null>(null);
  const [playing, setPlaying] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "review">("all");
  const [lastSync, setLastSync] = useState("—");
  const [queuedFix, setQueuedFix] = useState<HealthFix | null>(null);
  const [remediationTargetId, setRemediationTargetId] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [instanceHost, setInstanceHost] = useState<string | null>(null);
  const [runRecord, setRunRecord] = useState<MaraRunRecord | null>(null);
  const [analysisState, setAnalysisState] = useState<AnalysisState>("idle");
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [activeRunId, setActiveRunId] = useState("");
  const [activeRunLabel, setActiveRunLabel] = useState("");
  const [runDraft, setRunDraft] = useState("");
  const [livePaused, setLivePaused] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      if (typeof window === "undefined") return false;
      return window.localStorage.getItem("keystone.sidebar.collapsed") === "1";
    } catch { return false; }
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [liveRefreshing, setLiveRefreshing] = useState(false);
  const [liveRefreshCount, setLiveRefreshCount] = useState(0);
  const liveRefreshInFlight = useRef(false);
  // Runs whose Comprehend pipeline this session already launched. Marked before
  // the request resolves so rerenders and retries cannot start it twice.
  const comprehendStarted = useRef(new Set<string>());
  const pollInFlight = useRef(false);

  // Persist collapse preference. Ignored if localStorage is blocked.
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      if (sidebarCollapsed) window.localStorage.setItem("keystone.sidebar.collapsed", "1");
      else window.localStorage.removeItem("keystone.sidebar.collapsed");
    } catch { /* ignore */ }
  }, [sidebarCollapsed]);

  useEffect(() => {
    const restoredRun = currentRunFromLocation();
    if (!restoredRun) return;
    const timer = window.setTimeout(() => {
      setCis([]);
      setTimeline([]);
      setRelationships([]);
      setHealth(emptyHealth);
      setFindings([]);
      setReviews([]);
      setActiveRunId(restoredRun);
      setActiveRunLabel("RUN-" + restoredRun.slice(0, 8).toUpperCase());
      setRunDraft(restoredRun);
      setSection("workspace");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const loadData = useCallback(async (runId: string) => {
    // Cold state (no active run): skip every read endpoint. Unscoped calls
    // return globally-scoped data that is misleading to render as if it
    // belonged to a run, and run-scoped calls will 400 with "Missing run
    // parameter". Leave every resource as idle/unavailable — the UI shows an
    // empty state until the user selects or imports a run.
    if (!runId) {
      setCis([]);
      setTimeline([]);
      setRelationships([]);
      setHealth(emptyHealth);
      setFindings([]);
      setReviews([]);
      setActiveStep(0);
      setPlaying(false);
      setResourceState({
        cis: "unavailable", timeline: "unavailable", relationships: "unavailable",
        health: "unavailable", findings: "unavailable", reviews: "unavailable",
      });
      setApiState("demo");
      setRunRecord(null);
      setLastSync(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      return;
    }

    setApiState("connecting");
    setResourceState(connectingResources);
    setCis([]);
    setTimeline([]);
    setRelationships([]);
    setHealth(emptyHealth);
    setFindings([]);
    setReviews([]);

    const results = await Promise.allSettled(resourceNames.map(resource => readEndpoint(resource, runId)));
    const nextResourceState = { ...connectingResources };
    let nextCis: ConfigurationItem[] = [];
    let nextTimeline: TimelineEvent[] = [];
    let nextRelationships: Relationship[] = [];
    let nextHealth: HealthData = emptyHealth;
    let nextFindings: RemediationFinding[] = [];
    let nextReviews: RemediationReview[] = [];
    let liveCount = 0;
    let backendErrorCount = 0;
    if (results[0].status === "fulfilled") {
      nextCis = normalizeComprehendCis(results[0].value);
      nextResourceState.cis = "live"; liveCount++;
    } else {
      nextResourceState.cis = endpointErrorToStatus(results[0].reason);
      if (nextResourceState.cis === "error") backendErrorCount++;
    }
    if (results[1].status === "fulfilled") {
      nextTimeline = normalizeComprehendTimeline(results[1].value);
      nextResourceState.timeline = "live"; liveCount++;
    } else {
      nextResourceState.timeline = endpointErrorToStatus(results[1].reason);
      if (nextResourceState.timeline === "error") backendErrorCount++;
    }
    if (results[2].status === "fulfilled") {
      nextRelationships = normalizeComprehendRelationships(results[2].value);
      nextResourceState.relationships = "live"; liveCount++;
    } else {
      nextResourceState.relationships = endpointErrorToStatus(results[2].reason);
      if (nextResourceState.relationships === "error") backendErrorCount++;
    }
    if (results[3].status === "fulfilled") {
      nextHealth = normalizeComprehendHealth(results[3].value);
      nextResourceState.health = "live"; liveCount++;
    } else {
      nextResourceState.health = endpointErrorToStatus(results[3].reason);
      if (nextResourceState.health === "error") backendErrorCount++;
    }
    if (results[4].status === "fulfilled") {
      nextFindings = normalizeRemediationFindings(results[4].value);
      nextResourceState.findings = "live"; liveCount++;
    } else {
      nextResourceState.findings = endpointErrorToStatus(results[4].reason);
      if (nextResourceState.findings === "error") backendErrorCount++;
    }
    if (results[5].status === "fulfilled") {
      nextReviews = normalizeRemediationReviews(results[5].value);
      nextResourceState.reviews = "live"; liveCount++;
    } else {
      nextResourceState.reviews = endpointErrorToStatus(results[5].reason);
      if (nextResourceState.reviews === "error") backendErrorCount++;
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
    // Only escalate to "error" when at least one resource actually failed with a
    // 5xx or network failure. An all-"unavailable" state (e.g. every resource
    // returned 400 for a stale run) reads as "demo" rather than API failure.
    const nextApiState: ApiState = liveCount === resourceNames.length
      ? "live"
      : liveCount > 0
        ? "partial"
        : backendErrorCount > 0
          ? "error"
          : "demo";
    setApiState(nextApiState);
    setLastSync(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));

    // Backend run state drives polling lifetime; failures leave it unknown rather than assumed.
    setRunRecord(await readRunStatus(runId).catch(() => null));
  }, []);

  /**
   * Quiet refresh used while the backend pipeline is working: refetches the run
   * resources and the run state without clearing the view or flashing
   * "connecting", so polling does not make the UI flicker.
   */
  const refreshRunResources = useCallback(async (runId: string) => {
    if (!runId || pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const [results, run] = await Promise.all([
        Promise.allSettled(resourceNames.map(resource => readEndpoint(resource, runId))),
        readRunStatus(runId).catch(() => null),
      ]);

      // Only successful resources overwrite state; a failed poll keeps the last good data.
      if (results[0].status === "fulfilled") setCis(normalizeComprehendCis(results[0].value));
      if (results[1].status === "fulfilled") setTimeline(normalizeComprehendTimeline(results[1].value));
      if (results[2].status === "fulfilled") setRelationships(normalizeComprehendRelationships(results[2].value));
      if (results[3].status === "fulfilled") setHealth(normalizeComprehendHealth(results[3].value));
      if (results[4].status === "fulfilled") setFindings(normalizeRemediationFindings(results[4].value));
      if (results[5].status === "fulfilled") setReviews(normalizeRemediationReviews(results[5].value));

      setResourceState(current => {
        const next = { ...current };
        resourceNames.forEach((resource, index) => {
          const outcome = results[index];
          next[resource] = outcome.status === "fulfilled"
            ? "live"
            : endpointErrorToStatus(outcome.reason);
        });
        return next;
      });
      if (run) setRunRecord(run);
      setLastSync(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } finally {
      pollInFlight.current = false;
    }
  }, []);

  /**
   * Ask ServiceNow to start DotwalkersComprehendAgent for this run. Comprehend
   * queues Mara and Mara queues Prioritize, so this is the only trigger sent.
   */
  const startComprehend = useCallback(async (runId: string) => {
    if (!runId || comprehendStarted.current.has(runId)) return;
    comprehendStarted.current.add(runId);
    setAnalysisState("starting");
    setAnalysisMessage("Starting Comprehend analysis…");
    try {
      const response = await fetch("/api/cmdb/comprehend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ migration_run_id: runId }),
      });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      // ServiceNow wraps the payload in a `result` envelope; unwrap known layers.
      let payload = body;
      for (let depth = 0; depth < 3; depth++) {
        const next = payload.result;
        if (next && typeof next === "object" && !Array.isArray(next)) payload = next as Record<string, unknown>;
        else break;
      }
      // ServiceNow may queue Comprehend during import itself; its 409 with
      // already_running means the pipeline is active, not that the start failed.
      const alreadyRunning = payload.already_running === true || payload.alreadyRunning === true;
      const alreadyCompleted = payload.already_completed === true || payload.alreadyCompleted === true;
      if (!response.ok && !alreadyRunning && !alreadyCompleted) {
        throw new Error(extractComprehendError(body, payload, response.status));
      }
      setAnalysisState("started");
      setAnalysisMessage(
        alreadyCompleted
          ? "Analysis already completed for this run — displaying existing results."
          : alreadyRunning
            ? "Analysis is already running for this run."
            : "Analysis started. ServiceNow is processing this run.",
      );
      void refreshRunResources(runId);
    } catch (error) {
      // Allow a deliberate retry after a genuine failure.
      comprehendStarted.current.delete(runId);
      setAnalysisState("error");
      setAnalysisMessage(error instanceof Error ? error.message : "Could not start Comprehend analysis.");
    }
  }, [refreshRunResources]);

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
  // Live Ops keeps its dedicated high-frequency timeline refresh.
  useEffect(() => {
    if (section !== "live" || livePaused || !activeRunId) return;
    const timer = window.setInterval(() => { void refreshLiveTimeline(); }, 8000);
    return () => window.clearInterval(timer);
  }, [activeRunId, livePaused, refreshLiveTimeline, section]);

  // Pipeline-progress polling: refresh every run resource plus run state while the
  // backend is still working, and stop once it reaches a terminal state.
  useEffect(() => {
    if (!activeRunId || !polledSections.includes(section) || livePaused) return;
    if (isTerminalRunState(runRecord?.state)) return;
    const timer = window.setInterval(() => { void refreshRunResources(activeRunId); }, 8000);
    return () => window.clearInterval(timer);
  }, [activeRunId, section, livePaused, runRecord?.state, refreshRunResources]);
  useEffect(() => {
    fetch("/api/cmdb/instance", { cache: "no-store" })
      .then(response => (response.ok ? response.json() : null))
      .then(data => { if (data && typeof data.host === "string" && data.host) setInstanceHost(data.host); })
      .catch(() => {});
  }, []);
  // Enrich the persisted registry entry once the /run response lands so the
  // Runs queue page can show real names + source system + run numbers.
  useEffect(() => {
    if (!activeRunId || !runRecord) return;
    rememberRunEntry({
      id: activeRunId,
      label: activeRunLabel,
      summary: runRecord.summary,
      sourceSystem: runRecord.sourceSystem,
      runNumber: runRecord.number,
    });
  }, [activeRunId, activeRunLabel, runRecord]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [section]);

  // One deterministic playback timeline built from real run evidence. Rebuilds
  // when the ledger or staged-record count changes; a newly polled event simply
  // appends without disturbing the current frame (activeStep is untouched here).
  const playbackFrames = useMemo(
    () => buildPlaybackTimeline({ timeline, stagedCiCount: cis.length }),
    [timeline, cis.length],
  );
  const frameCount = playbackFrames.length;
  const lastFrameIndex = Math.max(0, frameCount - 1);
  // Ref keeps the interval's frame bound fresh without re-subscribing on every
  // poll, so exactly one interval runs and stale-closure indexes are avoided.
  const frameCountRef = useRef(frameCount);
  useEffect(() => { frameCountRef.current = frameCount; }, [frameCount]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setActiveStep(current => {
      const last = Math.max(0, frameCountRef.current - 1);
      if (current >= last) { setPlaying(false); return last; }
      return current + 1;
    }), 900);
    return () => window.clearInterval(timer);
  }, [playing]);

  // Keep the frame index inside the current timeline whenever it shrinks.
  const clampedActiveStep = Math.min(activeStep, lastFrameIndex);

  function stepFrame(delta: number) {
    setPlaying(false);
    setActiveStep(current => Math.min(Math.max(Math.min(current, lastFrameIndex) + delta, 0), lastFrameIndex));
  }
  function restartPlayback() {
    setPlaying(false);
    setActiveStep(0);
  }

  const workspaceView = useMemo(() => deriveWorkspaceViewState({
    runLabel: activeRunLabel,
    runId: activeRunId,
    runState: runRecord?.state ?? "",
    apiState,
    analysisState,
    cis,
    timeline,
    relationships,
    findings,
    reviews,
    health,
  }), [activeRunLabel, activeRunId, runRecord?.state, apiState, analysisState, cis, timeline, relationships, findings, reviews, health]);

  const filteredCis = useMemo(() => cis.filter(ci => {
    const matches = `${ci.name} ${ci.className} ${ci.source} ${ci.ip}`.toLowerCase().includes(search.toLowerCase());
    return matches && (filter === "all" || ci.status !== "live");
  }), [cis, search, filter]);

  // Opens a run and starts polling. Never triggers Comprehend — ServiceNow
  // `/import` already queues it. Manual `draft` recovery uses the explicit
  // "Start analysis" button in ComprehendView, which calls `startComprehend`.
  function openRun(run?: ImportedRun) {
    const runId = run ? run.id.trim() : activeRunId;
    const label = run?.label?.trim() || (runId ? `RUN-${runId.slice(0, 8).toUpperCase()}` : "");
    const changed = runId !== activeRunId;
    if (changed) {
      setRunRecord(null);
      if (!comprehendStarted.current.has(runId)) {
        setAnalysisState("idle");
        setAnalysisMessage("");
      }
    }
    setActiveRunId(runId);
    setActiveRunLabel(label);
    setRunDraft(runId);
    setActiveStep(0);
    setLivePaused(false);
    setLiveRefreshCount(0);
    setSection("workspace");
    rememberRun(runId);
    // Persist to the client-side runs registry so the Runs queue page can
    // switch between recent runs even after a browser reload.
    if (runId) {
      rememberRunEntry({
        id: runId,
        label,
        imported: Boolean(run && run.id && run.id === runId && run.label),
      });
    }
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
    if (!frameCount) return;
    // Replaying from a finished run rewinds to the opening (staging) frame.
    if (!playing && clampedActiveStep >= lastFrameIndex) setActiveStep(0);
    setPlaying(value => !value);
  }

  function openEventLedger() {
    setSelectedCi(null);
    setSection("evidence");
  }

  async function submitRemediation(
    fix: HealthFix,
    ci?: ConfigurationItem,
    finding?: RemediationFinding,
    simulation?: { correlation?: string; fingerprint?: string },
  ) {
    setQueuedFix(fix); setActionMessage("Preparing governed proposal…");
    try {
      const stagedCiId = ci?.stagedCiId || ci?.id || "";
      const findingId = finding?.id || "";
      if (!/^[0-9a-f]{32}$/i.test(activeRunId) || !/^[0-9a-f]{32}$/i.test(stagedCiId) ||
          !/^[0-9a-f]{32}$/i.test(findingId) || !simulation?.correlation ||
          !/^[0-9a-f]{64}$/i.test(simulation.fingerprint ?? "")) {
        throw new Error("Current simulation binding is incomplete");
      }
      const correlationId = `ks-proposal:${simulation.correlation}`;
      const identifierBody = {
        migration_run_id: activeRunId,
        staged_ci_id: stagedCiId,
        finding_id: findingId,
        correlation_id: correlationId,
        idempotency_key: `keystone:proposal:${activeRunId}:${stagedCiId}:${simulation.correlation}`,
        simulation_correlation_id: simulation.correlation,
        simulation_fingerprint: simulation.fingerprint,
      };
      const response = await fetch("/api/cmdb/remediate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(identifierBody) });
      if (!response.ok) throw new Error("not configured");
      await loadData(activeRunId);
      setActionMessage("Proposal recorded. The exact simulation is awaiting approval.");
    } catch {
      setActionMessage("Demo proposal ready. Connect the remediation endpoint to queue it through IRE.");
    }
  }

  // Sections that appear in the shared nav config map 1:1 to internal Section
  // ids except "verify" — the durable-evidence view for this app is the
  // existing evidence section.
  const sectionToNavId = (input: Section): NavSectionId | undefined => {
    if (input === "evidence" || input === "live") return "verify";
    if (input === "hr") return undefined;
    return input as NavSectionId;
  };
  const navToSection = (input: NavSectionId): Section => (input === "verify" ? "evidence" : input as Section);
  const currentNavId: NavSectionId = sectionToNavId(section) ?? "workspace";
  const openNavId = (id: NavSectionId) => {
    if (id === "ai-usage") {
      const href = externalHrefFor(id, activeRunId);
      if (href) window.location.assign(href);
      return;
    }
    setSection(navToSection(id));
    setMobileNavOpen(false);
  };

  return <div className={"app-shell"
      + (sidebarCollapsed ? " sidebar-collapsed" : "")
      + (mobileNavOpen ? " mobile-nav-open" : "")}>
    {mobileNavOpen && <div className="mobile-nav-backdrop" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />}
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M3.6 15.4 L6 9.6 L10 6.8 L14.4 7.2 L18.6 10 L20.4 14.8 L18.8 18.4 L5.2 18.4 Z" fill="rgba(199, 243, 77, .13)" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M10 6.8 L11.6 12.4 L18.6 10" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" strokeLinecap="round" opacity=".55" />
            <path d="M11.6 12.4 L8.6 18.4 M11.6 12.4 L15.2 18.4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".38" />
          </svg>
        </span>
        <div className="brand-copy"><strong>CMDB</strong><small>MODERNIZATION CONTROL</small></div>
        <button
          type="button"
          className="sidebar-collapse"
          aria-label={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
          onClick={() => setSidebarCollapsed(current => !current)}
        >
          <Icon name="chevron" size={14} />
        </button>
      </div>
      <nav className="main-nav" aria-label="Main navigation">
        {navigationItems.map(item => {
          const disabled = item.requiresRun && !activeRunId && !item.external;
          const active = !item.external && item.id === currentNavId;
          const labelText = item.label + ": " + item.detail;
          const commonProps = {
            "aria-label": labelText,
            title: sidebarCollapsed ? item.label : labelText,
            className: (active ? "active" : "") + (disabled ? " disabled" : ""),
          } as const;
          if (item.external) {
            const href = externalHrefFor(item.id, activeRunId) ?? "#";
            return <a key={item.id} className={"nav-link " + commonProps.className} aria-label={commonProps["aria-label"]} title={commonProps.title} href={href} onClick={() => setMobileNavOpen(false)}>
              <span className="nav-icon"><Icon name={item.icon} /></span>
              <span className="nav-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
              <Icon name="chevron" size={14} />
            </a>;
          }
          return <button
            key={item.id}
            {...commonProps}
            disabled={disabled}
            onClick={() => openNavId(item.id)}
          >
            <span className="nav-icon"><Icon name={item.icon} /></span>
            <span className="nav-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
            <Icon name="chevron" size={14} />
          </button>;
        })}
      </nav>
      <div className="sidebar-rule" />
      <div className="governance-card"><span className="shield"><Icon name="shield" size={17} /></span><div><small>GOVERNANCE LOCK</small><strong>IRE is the only write path</strong><p>Every CMDB mutation is reconciled, attributed, and logged.</p></div></div>
      <div className="sidebar-bottom">
        <div className={`api-dot ${apiState}`} />
        <div>
          <strong>{apiState === "live" ? "Live API" : apiState === "partial" ? "Partial API" : apiState === "connecting" ? "Connecting" : apiState === "error" ? "API error" : "No active run"}</strong>
          <small>{activeRunId
            ? `${runRecord?.summary?.trim() || activeRunLabel || "Dataset"} · ${(runRecord?.sourceSystem || "?").toLowerCase()}`
            : `Last sync ${lastSync}`}</small>
        </div>
        <button onClick={() => void loadData(activeRunId)} aria-label="Refresh data" title="Refresh data"><Icon name="refresh" size={16} /></button>
      </div>
    </aside>

    <main className="main-content">
      <header className="topbar">
        <div className="topbar-lead">
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={mobileNavOpen ? "Close navigation" : sidebarCollapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={mobileNavOpen || !sidebarCollapsed}
            onClick={() => {
              // On narrow viewports the topbar button opens the mobile drawer;
              // on wider viewports it toggles the persistent collapse state.
              if (typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches) {
                setMobileNavOpen(current => !current);
              } else {
                setSidebarCollapsed(current => !current);
              }
            }}
          >
            <Icon name="menu" size={18} />
          </button>
          <DatasetIdentity
            section={section}
            activeRunLabel={activeRunLabel}
            activeRunId={activeRunId}
            runRecord={runRecord}
          />
        </div>
        <div className="top-actions"><span className="instance"><span className={instanceHost ? "live-dot" : "live-dot demo"} /> {instanceHost ?? "demo mode"}</span><a className="ghost-button" href={activeRunId ? `/ai-usage?run=${encodeURIComponent(activeRunId)}` : "/ai-usage"}><Icon name="spark" size={15} /> AI Usage</a><button className="ghost-button" onClick={openEventLedger}><Icon name="clock" size={15} /> Event ledger</button><div className="avatar">NS</div></div>
      </header>

      {section === "import" && <ImportGatewayView onOpenRun={openRun} />}
      {section === "runs" && <RunsQueueView
        activeRunId={activeRunId}
        onOpenRun={(entry) => openRun({ id: entry.id, label: entry.label })}
        onNewImport={() => setSection("import")}
      />}
      {(section === "workspace" || section === "approvals") && <AgentWorkspaceView runLabel={activeRunLabel} runId={activeRunId} runState={runRecord?.state ?? ""} apiState={apiState} analysisState={analysisState} cis={cis} timeline={timeline} relationships={relationships} findings={findings} reviews={reviews} health={health} focus={section === "approvals" ? "approvals" : "overview"} onOpenPhase={phase => setSection(phase)} onOpenVerify={() => setSection("evidence")} onOpenRemediation={stagedCiId => { setRemediationTargetId(stagedCiId ?? ""); setSection("remediate"); }} onOpenEvidence={() => setSection("evidence")} onOpenRun={(entry) => openRun({ id: entry.id, label: entry.label })} onRefresh={() => void loadData(activeRunId)} />}
      {section === "evidence" && <LiveOpsView timeline={timeline} activeRunId={activeRunId} apiState={apiState} resourceStatus={resourceState.timeline} paused={livePaused} refreshing={liveRefreshing} refreshCount={liveRefreshCount} onPausedChange={setLivePaused} onRefresh={() => void refreshLiveTimeline()} />}
      {section === "comprehend" && <ComprehendView health={health} timeline={timeline} frames={playbackFrames} relationships={relationships} cis={filteredCis} allCis={cis} selectedCi={selectedCi} setSelectedCi={setSelectedCi} search={search} setSearch={setSearch} filter={filter} setFilter={setFilter} playing={playing} activeStep={clampedActiveStep} startPlayback={startPlayback} setActiveStep={setActiveStep} onStepFrame={stepFrame} onRestartPlayback={restartPlayback} apiState={apiState} resourceState={resourceState} activeRunId={activeRunId} runDraft={runDraft} setRunDraft={setRunDraft} loadRun={loadRunFromDraft} clearRun={() => { setRunDraft(""); openRun({ id: "", label: "" }); }} analysisState={analysisState} analysisMessage={analysisMessage} runState={runRecord?.state ?? ""} onStartAnalysis={() => activeRunId && void startComprehend(activeRunId)} />}
      {section === "live" && <LiveOpsView timeline={timeline} activeRunId={activeRunId} apiState={apiState} resourceStatus={resourceState.timeline} paused={livePaused} refreshing={liveRefreshing} refreshCount={liveRefreshCount} onPausedChange={setLivePaused} onRefresh={() => void refreshLiveTimeline()} />}
      {section === "hr" && <AgentHrView timeline={timeline} timelineLive={resourceState.timeline === "live"} cis={resourceState.cis === "live" ? cis : null} activeRunId={activeRunId} />}
      {section === "prioritize" && <PrioritizeView health={health} recalculating={apiState === "connecting"} onRecalculate={() => void loadData(activeRunId)} onFix={(fix) => { setQueuedFix(fix); setActionMessage(""); setSection("remediate"); }} />}
      {section === "remediate" && <RemediateView health={health} cis={cis} timeline={timeline} findings={findings} reviews={reviews} activeRunId={activeRunId} apiState={apiState} queuedFix={queuedFix} initialStagedCiId={remediationTargetId} actionMessage={actionMessage} onSelect={(fix) => { setQueuedFix(fix); setActionMessage(""); }} onSubmit={submitRemediation} />}

      <PageNavigation
        currentSection={currentNavId}
        activeRunId={activeRunId}
        onNavigate={openNavId}
      />
    </main>

    {selectedCi && <ProvenancePanel ci={selectedCi} onClose={() => setSelectedCi(null)} onOpenLedger={openEventLedger} />}

    <MaraCompanion
      activeRunId={activeRunId}
      activeRunLabel={activeRunLabel}
      view={workspaceView}
      onNavigate={next => setSection(next)}
      onOpenLedger={openEventLedger}
      onOpenApprovals={() => setSection("approvals")}
      onOpenRemediation={() => setSection("remediate")}
      onShowReviewQueue={() => { setFilter("review"); setSection("comprehend"); }}
    />
  </div>;
}

function ComprehendView(props: {
  health: HealthData; timeline: TimelineEvent[]; frames: PlaybackFrame[]; relationships: Relationship[]; cis: ConfigurationItem[]; allCis: ConfigurationItem[];
  selectedCi: ConfigurationItem | null; setSelectedCi: (ci: ConfigurationItem) => void; search: string; setSearch: (value: string) => void;
  filter: "all" | "review"; setFilter: (value: "all" | "review") => void; playing: boolean; activeStep: number;
  startPlayback: () => void; setActiveStep: (value: number) => void; onStepFrame: (delta: number) => void; onRestartPlayback: () => void;
  apiState: ApiState; resourceState: ResourceState;
  activeRunId: string; runDraft: string; setRunDraft: (value: string) => void; loadRun: () => void; clearRun: () => void;
  analysisState: AnalysisState; analysisMessage: string; runState: string; onStartAnalysis: () => void;
}) {
  const { health, timeline, frames, relationships, cis, allCis, setSelectedCi, search, setSearch, filter, setFilter, playing, activeStep, startPlayback, setActiveStep, onStepFrame, onRestartPlayback, apiState, resourceState, activeRunId, runDraft, setRunDraft, loadRun, clearRun, analysisState, analysisMessage, runState, onStartAnalysis } = props;
  const cisLive = resourceState.cis === "live";
  const cleared = cisLive
    ? allCis.filter(ci => ci.status === "live").length
    : Math.max(0, health.ciCount - health.reviewCount);
  const review = allCis.filter(ci => ci.status !== "live").length;
  const reviewRate = allCis.length ? ((review / allCis.length) * 100).toFixed(1) : "0.0";
  const totalFrames = frames.length;
  const frameIndex = Math.min(Math.max(activeStep, 0), Math.max(0, totalFrames - 1));
  const activeFrame = frames[frameIndex];
  const nodeStates = derivePlaybackNodeStates(frames, frameIndex);
  const totalEvents = timeline.length;
  // Prefer real backend signals: a failed start, then the ServiceNow run state,
  // then the transport state. Nothing here invents progress.
  const runStatus =
    analysisState === "error" ? analysisMessage
    : analysisState === "starting" ? "Starting analysis"
    : runState ? runState.replaceAll("_", " ").replace(/^./, char => char.toUpperCase())
    : analysisState === "started" ? "Analysis started"
    : apiState === "connecting" ? "Loading ServiceNow run"
    : apiState === "live" ? "Live backend connected"
    : apiState === "partial" ? "Partial backend data"
    : apiState === "error" ? "ServiceNow run unavailable"
    : "Demo snapshot";
  const analysisWorking = analysisState === "starting"
    || (Boolean(runState) && !terminalRunStates.has(runState) && !isDraftRunState(runState));
  const canManuallyStart = isDraftRunState(runState) && Boolean(activeRunId) && analysisState !== "starting";
  const startButtonLabel = analysisState === "error" ? "Retry analysis" : "Start analysis";
  const demoFallback = !activeRunId && apiState === "demo";
  const proposedEdgeLabel = `${relationships.length.toLocaleString()} PROPOSED ${relationships.length === 1 ? "EDGE" : "EDGES"}`;
  const proposedEdgeDelta = `${relationships.length.toLocaleString()} proposed ${relationships.length === 1 ? "edge" : "edges"}`;
  return <div className="page">
    <section className="page-heading"><div><span className="eyebrow accent">COMPREHEND</span><h1>What happened to your data?</h1><p>Follow every staged record from quarantine through deterministic analysis and the confidence gate.</p></div><div className="run-state"><span className={`run-pulse ${analysisWorking ? "" : apiState === "partial" || apiState === "demo" || apiState === "error" ? "paused" : ""}`} /><div><small>RUN STATUS</small><strong>{runStatus}</strong></div><span className="run-time">{activeRunId ? activeRunId.slice(0, 8) : "ALL RUNS"}</span></div></section>

    <section className="run-context panel">
      <div className="run-context-copy"><span className="section-index">00</span><div><h2>Backend run context</h2><p>All four Comprehend resources use the same ServiceNow migration-run sys_id.</p></div></div>
      <label className="run-id-field"><span>RUN SYS_ID</span><input value={runDraft} onChange={event => setRunDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") loadRun(); }} placeholder="Paste migration_run sys_id" /></label>
      <div className="run-context-actions">
        <button className="primary-button" onClick={loadRun}><Icon name="refresh" size={15} /> Load run</button>
        {canManuallyStart && <button className="primary-button" onClick={onStartAnalysis} title="This run is in draft — ServiceNow has not queued Comprehend yet."><Icon name="spark" size={15} /> {startButtonLabel}</button>}
        {activeRunId && <button className="ghost-button" onClick={clearRun}>All runs</button>}
      </div>
      {(analysisMessage || (canManuallyStart && analysisState === "idle")) && (
        <div className={`run-analysis-status status-${analysisState}`}>
          <Icon name={analysisState === "error" ? "alert" : analysisState === "starting" ? "refresh" : "check"} size={14} />
          <span>{analysisMessage || "This run is in draft. Comprehend has not been queued — click Start analysis to run it."}</span>
        </div>
      )}
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

    <WorkerRoster timeline={timeline} />

    <section className="panel playback-panel" id="event-ledger">
      <div className="panel-heading"><div><span className="section-index">01</span><div><h2>Event Ledger playback</h2><p>Replay the ordered ServiceNow audit trail without collapsing agent actions.</p></div></div><div className="playback-controls">
        <span>{playing ? "PLAYING" : totalFrames ? `FRAME ${frameIndex + 1} / ${totalFrames}` : "NO EVENTS"}</span>
        <button className="ghost-button playback-step playback-prev" disabled={!totalFrames || frameIndex <= 0} onClick={() => onStepFrame(-1)} aria-label="Previous frame" title="Previous frame"><Icon name="chevron" size={15} /></button>
        <button className="play-button" disabled={!totalFrames} aria-label={playing ? "Pause playback" : "Play playback"} onClick={startPlayback}><Icon name={playing ? "pause" : "play"} size={16} />{playing ? "Pause" : frameIndex >= totalFrames - 1 && totalFrames ? "Replay" : "Play run"}</button>
        <button className="ghost-button playback-step" disabled={!totalFrames || frameIndex >= totalFrames - 1} onClick={() => onStepFrame(1)} aria-label="Next frame" title="Next frame"><Icon name="chevron" size={15} /></button>
        <button className="ghost-button playback-step" disabled={!totalFrames || (frameIndex === 0 && !playing)} onClick={onRestartPlayback} aria-label="Restart playback" title="Restart"><Icon name="refresh" size={15} /></button>
      </div></div>
      <div className="stepper">
        {PLAYBACK_NODES.map((node, index) => {
          const status = nodeStates.states[node.id];
          const seekTo = nodeStates.firstFrameForNode[node.id];
          const disabled = status === "untouched" || seekTo === undefined;
          const cls = status === "active" ? "current"
            : status === "done" ? "done"
            : status === "untouched" ? "pending"
            : "";
          // Fill the connector only between two consecutive reached stages, so a
          // skipped stage never draws a completed track through it.
          const next = PLAYBACK_NODES[index + 1];
          const connectorFilled = status === "done" && next
            && (nodeStates.states[next.id] === "done" || nodeStates.states[next.id] === "active");
          return <button key={node.id} disabled={disabled} title={disabled ? `${node.label} has not occurred in this run` : node.label} className={cls} onClick={() => { if (seekTo !== undefined) setActiveStep(seekTo); }}>
            <span className="step-top"><span className="step-node">{status === "done" ? <Icon name="check" size={13} /> : index + 1}</span>{index < PLAYBACK_NODES.length - 1 && <span className="step-line"><i className={connectorFilled ? "filled" : ""} /></span>}</span><span className="step-label">{node.label}</span>
          </button>;
        })}
      </div>
      <div className="event-detail">
        <div className="event-number">{String(activeFrame?.seq ?? frameIndex + 1).padStart(2, "0")}</div><div className="event-copy"><span>{activeFrame?.time || "—"} · {activeFrame?.actor || "Comprehend"}{activeFrame?.derived && <em className="event-derived-badge">DERIVED UI EVIDENCE</em>}</span><h3>{activeFrame?.title || "No ledger event recorded"}</h3><p>{activeFrame?.detail || "ServiceNow returned no Event Ledger entries for this run."}</p></div>
        <div className="event-meta"><div><small>ACTOR</small><strong>{activeFrame?.actor || "—"}</strong></div><div><small>STAGE</small><strong className="lime-text">{playbackNodeLabel(nodeStates.activeNodeId)}</strong></div><div><small>STATUS</small><strong>{(activeFrame?.status ?? "pending").replaceAll("_", " ").toUpperCase()}</strong></div></div>
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
  initialStagedCiId?: string;
  actionMessage: string;
  onSelect: (fix: HealthFix) => void;
  onSubmit: (
    fix: HealthFix,
    ci?: ConfigurationItem,
    finding?: RemediationFinding,
    simulation?: { correlation?: string; fingerprint?: string },
  ) => void;
}) {
  const { health, cis, timeline, findings, reviews, activeRunId, apiState, queuedFix, initialStagedCiId, actionMessage, onSelect, onSubmit } = props;
  const selected = queuedFix || health.fixes[0];
  const stagedCis = cis.filter(ci => ci.id || ci.stagedCiId);
  const [selectedCiId, setSelectedCiId] = useState(() => stagedCis.find(ci => ci.id === initialStagedCiId || ci.stagedCiId === initialStagedCiId)?.id ?? stagedCis[0]?.id ?? "");
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
  const approvable = lifecycle === "simulated_pending_approval" && Boolean(
    simulationCorrelation &&
    selectedQueueItem?.simulationFingerprint &&
    selectedQueueItem.finding?.id &&
    selectedQueueItem.review?.id
  );
  const selectedActivity = selectedCi ? sortTimelineByFreshness(timeline
    .filter(event => {
      const haystack = `${event.recordName} ${event.reasoning} ${event.name}`.toLowerCase();
      return haystack.includes(selectedCi.name.toLowerCase()) || haystack.includes(selectedCi.id.toLowerCase());
    }))
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
    if (decision !== "approved" || !selectedQueueItem?.finding?.id || !selectedQueueItem.review?.id ||
        !simulationCorrelation || !selectedQueueItem.simulationFingerprint) return;
    void runIreAction("approve", {
      finding_id: selectedQueueItem.finding.id,
      review_decision_id: selectedQueueItem.review.id,
      simulation_correlation_id: simulationCorrelation,
      simulation_fingerprint: selectedQueueItem.simulationFingerprint,
    });
  }

  return <div className="page">
    <section className="page-heading"><div><span className="eyebrow accent">ADVANCED REMEDIATION DETAIL</span><h1>Single-record IRE workbench.</h1><p>Recovery and validation controls for one staged CI. The normal agent journey resumes automatically after approval.</p></div><div className="ire-lock"><Icon name="shield" size={18} /><span><small>WRITE CONTROL</small><strong>IRE enforced</strong></span></div></section>
    <section className="remediation-flow panel"><div className="flow-item active"><span><Icon name="spark" /></span><div><small>1 - SIMULATE</small><strong>ServiceNow rebuilds</strong></div></div><Icon name="arrow" /><div className="flow-item active"><span><Icon name="check" /></span><div><small>2 - APPROVE</small><strong>One decision updates</strong></div></div><Icon name="arrow" /><div className="flow-item locked"><span><Icon name="shield" /></span><div><small>3 - EXECUTE</small><strong>Identifier-only request</strong></div></div><Icon name="arrow" /><div className="flow-item"><span><Icon name="database" /></span><div><small>4 - VERIFY</small><strong>Correlation tied</strong></div></div></section>
    <section className="panel work-queue-panel">
      <div className="panel-heading"><div><span className="section-index">01</span><div><h2>Derived agent work queue</h2><p>Queue state is reconstructed from staged CIs, IRE responses, health findings, and Event Ledger playback.</p></div></div><span className={`source-pill ${queue.liveBackedCount ? "live" : demoFallback ? "demo" : ""}`}>{queue.liveBackedCount ? `${queue.liveBackedCount} live-backed` : demoFallback ? "demo fallback" : "derived staging"}</span></div>
      <div className="queue-buckets">
        {queue.buckets.map(bucket => <WorkQueueBucketCard key={bucket.id} bucket={bucket} selectedId={selectedCi?.id} onSelect={setSelectedCiId} />)}
      </div>
    </section>
    <section className="remediate-layout"><div className="agent-tools"><div className="section-title"><span className="section-index">02</span><div><h2>Ranked remediation focus</h2><p>Choose the finding group, then work one staged CI at a time.</p></div></div><div className="tool-grid">
      {health.fixes.map((fix, index) => <button className={`tool-card ${selected?.id === fix.id ? "selected" : ""}`} key={fix.id} onClick={() => onSelect(fix)}><span className="tool-icon"><Icon name={index === 0 ? "graph" : index === 1 ? "search" : index === 2 ? "shield" : "clock"} /></span><span className="tool-copy"><small>{fix.tool.toUpperCase()}</small><strong>{fix.title}</strong><span>{fix.affected} candidate records</span></span><span className="tool-impact">+{fix.impact}%</span></button>)}
    </div></div><aside className="proposal-panel panel"><div className="proposal-heading"><span className="eyebrow accent">ACTIVE FINDING</span><span className="draft-pill">SINGLE CI</span></div><h2>{selected?.title}</h2><p>{selected?.description}</p><div className="proposal-summary"><div><span>Candidate records</span><strong>{selected?.affected}</strong></div><div><span>Projected health</span><strong>+{selected?.impact}%</strong></div><div><span>Execution route</span><strong>IRE</strong></div></div>{actionMessage && <div className="action-message"><Icon name="check" size={16} />{actionMessage}</div>}<button className="primary-button full" onClick={() => selected && onSubmit(selected, selectedCi, selectedQueueItem?.finding, { correlation: simulationCorrelation, fingerprint: selectedQueueItem?.simulationFingerprint })}><Icon name="shield" size={16} /> Record proposal</button><small className="no-direct-write">Execution below sends identifiers only. ServiceNow owns payload rebuild, approval, freshness, locks, and verification.</small></aside></section>
    <section className="workbench-layout">
      <div className="panel staged-queue-panel">
        <div className="panel-heading compact sticky">
          <div><span className="section-index">03</span><div><h2>Staged CIs</h2><p>Ordered by lifecycle bucket.</p></div></div>
          <span className="panel-stat">{stagedCis.length}</span>
        </div>
        <div className="staged-queue">
          {queue.items.map(item => <button key={item.id} className={selectedCi?.id === item.id ? "staged-row selected" : "staged-row"} onClick={() => setSelectedCiId(item.id)}>
            <span className={`ci-icon status-${item.ci.status}`}><Icon name="database" size={14} /></span>
            <span><strong>{item.ci.name}</strong><small>{item.stagedCiId} / {ireLifecycleLabel(item.lifecycle)}</small></span>
            <OperationPill value={item.ci.operation} />
          </button>)}
          {!stagedCis.length && <div className="workbench-empty"><Icon name="database" size={22} /><strong>No staged CIs loaded</strong><p>Load an active migration run before using IRE actions.</p></div>}
        </div>
      </div>

      <div className="panel ire-console-panel">
        <div className="panel-heading compact sticky">
          <div><span className="section-index">04</span><div><h2>IRE lifecycle</h2><p>One staged record at a time.</p></div></div>
          <span className={`lifecycle-pill ${lifecycleTone(lifecycle)}`}>{ireLifecycleLabel(lifecycle)}</span>
        </div>
        <div className="ire-console">
          <div className="selected-ci-card">
            <div className="selected-ci-copy">
              <span className="eyebrow accent">SELECTED STAGED CI</span>
              <h3>{selectedCi?.name ?? "No record selected"}</h3>
              <p>{selectedCi ? `${selectedCi.className} · ${selectedCi.source} · ${selectedCi.ip}` : "Choose a staged CI to start simulation."}</p>
            </div>
            <div className="selected-ci-meta">
              <div><small>RUN</small><strong title={activeRunId}>{activeRunId ? activeRunId.slice(0, 8) : "none"}</strong></div>
              <div><small>STAGED CI</small><strong title={selectedCi?.stagedCiId || selectedCi?.id}>{selectedCi ? (selectedCi.stagedCiId || selectedCi.id).slice(0, 8) : "none"}</strong></div>
              <div><small>CONFIDENCE</small><strong>{selectedCi ? `${Math.round(selectedCi.confidence * 100)}%` : "none"}</strong></div>
            </div>
          </div>

          <WorkbenchCountsRow queue={queue} lifecycle={lifecycle} />

          <SelectedCiIreEvidence
            selectedCi={selectedCi}
            selectedQueueItem={selectedQueueItem}
            workbench={workbench}
          />

          <RunSummarySection timeline={timeline} queue={queue} />

          {!liveRunReady && <div className="ire-error"><Icon name="shield" size={15} />Load a live ServiceNow migration run before sending IRE requests. Demo snapshots cannot execute governed actions.</div>}
          <label className="approval-rationale"><span>APPROVAL RATIONALE</span><textarea value={rationale} onChange={event => setRationale(event.target.value)} /></label>
          <IreResultPanel workbench={workbench} lifecycle={lifecycle} playback={selectedQueueItem} />
        </div>
        <div className="ire-action-footer">
          <div className="ire-action-grid">
            <button className="primary-button" disabled={!liveRunReady || Boolean(pendingAction)} onClick={() => void runIreAction("simulate")}><Icon name="spark" size={15} /> {pendingAction === "simulate" ? "Simulating…" : "Simulate"}</button>
            <button className="ghost-button" title="Authorizes one IRE execution for this staged CI and simulation fingerprint." disabled={!liveRunReady || !approvable || Boolean(pendingAction)} onClick={() => approve("approved")}><Icon name="check" size={15} /> {pendingAction === "approve" ? "Saving…" : "Approve"}</button>
            <button className="ghost-button danger" disabled={!liveRunReady || !approvable || Boolean(pendingAction)} onClick={() => approve("rejected")}><Icon name="x" size={15} /> Reject</button>
            <button className="primary-button" title="Advanced recovery control" disabled={!liveRunReady || !approved || rejected || !simulationCorrelation || lifecycle !== "approved_for_execution" || Boolean(pendingAction)} onClick={() => void runIreAction("execute", { simulation_correlation_id: simulationCorrelation ?? "" })}><Icon name="shield" size={15} /> {pendingAction === "execute" ? "Executing…" : "Execute"}</button>
            <button className="ghost-button" disabled={!liveRunReady || !executionCorrelation || lifecycle !== "executed_pending_verification" || Boolean(pendingAction)} onClick={() => void runIreAction("verify", { execution_correlation_id: executionCorrelation ?? "" })}><Icon name="check" size={15} /> {pendingAction === "verify" ? "Verifying…" : "Verify"}</button>
          </div>
        </div>
      </div>

      <aside className="panel activity-panel">
        <div className="panel-heading compact sticky">
          <div><span className="section-index">05</span><div><h2>Lifecycle activity</h2><p>Derived from action results and Event Ledger playback.</p></div></div>
        </div>
        <div className="activity-feed">
          {activityRows(workbench, selectedActivity).map(row => <ActivityFeedRow key={row.id} row={row} />)}
        </div>
      </aside>
    </section>
  </div>;
}

function SelectedCiIreEvidence(props: {
  selectedCi: ConfigurationItem | null;
  selectedQueueItem?: WorkQueueItem;
  workbench: IreWorkbenchRecord;
}) {
  const { selectedCi, selectedQueueItem, workbench } = props;
  if (!selectedCi) return null;

  // Precedence: classify simulation failures FIRST so a strategy/config
  // error surfaces the dedicated card even though the workbench still
  // holds a failure response. Then real successful CI-scoped response,
  // then legitimate non-live source, then empty state. A run-level Mara
  // observation is never eligible here.
  const failure = classifySimulationFailure(workbench, selectedCi);
  if (failure.kind === "strategy") {
    return <StrategyFailureCard failure={failure} selectedCi={selectedCi} />;
  }
  if (failure.kind === "ineligible") {
    return <IneligibleCiCard failure={failure} selectedCi={selectedCi} />;
  }

  const hasResponse = hasCiSpecificIreResponse(workbench);
  if (hasResponse) {
    // Preserve the exact backend message when the simulation failed but
    // wasn't a strategy failure — classify as an execution failure and
    // paint the card red rather than pretending it succeeded.
    const isExecutionFailure = failure.kind === "execution";
    return <div className={`ci-evidence-card ${isExecutionFailure ? "ci-scope-execution-error" : "ci-scope-live"}`}>
      <div className="ci-evidence-head">
        <span className="ci-evidence-scope">
          {isExecutionFailure ? "CI-SPECIFIC · IRE EXECUTION FAILURE" : "CI-SPECIFIC · SELECTED STAGED CI"}
        </span>
        <strong>{isExecutionFailure ? "Simulation failed" : "Live IRE response"}</strong>
      </div>
      <p className="ci-evidence-message">
        {isExecutionFailure
          ? failure.message
          : selectedQueueItem?.reason || "ServiceNow returned an IRE response for this staged CI."}
      </p>
      <div className="ci-evidence-chips">
        {selectedQueueItem?.evidence.slice(0, 6).map((item, index) => <code key={`${item}-${index}`}>{item}</code>)}
      </div>
    </div>;
  }

  // Non-Mara ledger evidence (real per-CI event that isn't a live workbench
  // response) still gets its own card, but never labelled "Live IRE
  // response" — that label is reserved for actual /ire/* responses.
  if (
    selectedQueueItem &&
    selectedQueueItem.source !== "live_action" &&
    selectedQueueItem.latestEvent &&
    !isMaraObservationEvent(selectedQueueItem.latestEvent)
  ) {
    return <div className={`ci-evidence-card ci-scope-${selectedQueueItem.source}`}>
      <div className="ci-evidence-head">
        <span className="ci-evidence-scope">CI-SPECIFIC · SELECTED STAGED CI</span>
        <strong>{sourceLabel(selectedQueueItem.source)}</strong>
      </div>
      <p className="ci-evidence-message">{selectedQueueItem.reason}</p>
      <div className="ci-evidence-chips">
        {selectedQueueItem.evidence.slice(0, 6).map((item, index) => <code key={`${item}-${index}`}>{item}</code>)}
      </div>
    </div>;
  }

  return <div className="ci-evidence-card ci-scope-empty">
    <div className="ci-evidence-head">
      <span className="ci-evidence-scope">CI-SPECIFIC · SELECTED STAGED CI</span>
      <strong>No live response yet</strong>
    </div>
    <p className="ci-evidence-message">{CI_EVIDENCE_EMPTY_STATE}</p>
  </div>;
}

function IneligibleCiCard({ failure, selectedCi }: { failure: SimulationFailureClassification; selectedCi: ConfigurationItem }) {
  const confidence = typeof failure.confidence === "number"
    ? failure.confidence
    : Math.round((selectedCi.confidence ?? 0) * 100);
  const missing = failure.missingIdentifiers ?? [];
  return <div className="ci-evidence-card ci-scope-ineligible">
    <div className="ci-evidence-head">
      <span className="ci-evidence-scope">CI-SPECIFIC · IRE ELIGIBILITY BLOCK</span>
      <strong>Staged CI is not eligible for IRE simulation</strong>
    </div>
    <p className="ci-evidence-message">{failure.message || "IRE refused to simulate this staged CI."}</p>
    <div className="ci-explainer">
      <strong>What this means:</strong>
      <p>IRE needs enough deterministic evidence — a stable identifier plus a confidence score above the gate — before it will safely reconcile the CI against the CMDB. This record didn&apos;t clear the check.</p>
    </div>
    <dl className="ci-evidence-details">
      <div><dt>Confidence</dt><dd>{confidence}% <span className="dim">(gate threshold typically 60%)</span></dd></div>
      <div><dt>Class</dt><dd>{selectedCi.className || "—"}</dd></div>
      <div><dt>IP</dt><dd>{selectedCi.ip || <span className="dim">not supplied</span>}</dd></div>
      <div><dt>Name</dt><dd>{selectedCi.name || <span className="dim">not supplied</span>}</dd></div>
      {missing.length > 0 && <div className="ci-evidence-details-wide"><dt>Missing identifiers</dt><dd>{missing.join(" · ")}</dd></div>}
    </dl>
    <div className="ci-explainer">
      <strong>How to unblock:</strong>
      <ul>
        <li>Enrich the source data with a stable identifier (IP, hostname, serial number, or MAC).</li>
        <li>Re-import the dataset; Sentry re-scores after fresh evidence lands.</li>
        <li>Or approve the finding manually if a reviewer has out-of-band confirmation of identity.</li>
      </ul>
    </div>
  </div>;
}

function StrategyFailureCard({ failure, selectedCi }: { failure: SimulationFailureClassification; selectedCi: ConfigurationItem }) {
  const { title, defaultMessage, labels, defaults } = STRATEGY_FAILURE_CARD;
  const shown = failure.message || defaultMessage;
  const rows: Array<{ label: string; value: string }> = [
    { label: labels.class, value: failure.className || selectedCi.className || "unknown" },
    { label: labels.strategy, value: failure.strategy || defaults.strategy },
    { label: labels.fingerprint, value: defaults.fingerprint },
    { label: labels.approval, value: defaults.approval },
    { label: labels.execution, value: defaults.execution },
    { label: labels.verification, value: defaults.verification },
  ];
  return <div className="ci-evidence-card ci-scope-strategy-error">
    <div className="ci-evidence-head">
      <span className="ci-evidence-scope">CI-SPECIFIC · STRATEGY / CONFIGURATION FAILURE</span>
      <strong>{title}</strong>
    </div>
    <p className="ci-evidence-message">{shown}</p>
    <dl className="ci-evidence-details">
      {rows.map(row => <div key={row.label}>
        <dt>{row.label}</dt>
        <dd>{row.value}</dd>
      </div>)}
    </dl>
  </div>;
}

function RunSummarySection({ timeline, queue }: { timeline: TimelineEvent[]; queue: WorkQueueSummary }) {
  const latestObservation = [...timeline].reverse().find(isMaraObservationEvent);
  const parsed = latestObservation ? buildRunSummaryChips(latestObservation.reasoning) : { chips: [] as RunSummaryChip[] };
  const queueChipCandidates: RunSummaryChip[] = [
    { label: "queued", value: String(queue.items.length) },
    { label: "ready", value: String(queue.items.filter(i => i.bucket === "ready_to_simulate").length), tone: "good" as const },
    { label: "approval", value: String(queue.items.filter(i => i.bucket === "needs_approval").length), tone: "warn" as const },
    { label: "verify", value: String(queue.items.filter(i => i.bucket === "needs_verification").length) },
    { label: "verified", value: String(queue.items.filter(i => i.bucket === "verified").length), tone: "good" as const },
    { label: "blocked", value: String(queue.items.filter(i => i.bucket === "blocked" || i.bucket === "simulation_failed").length), tone: "warn" as const },
  ];
  const queueChips: RunSummaryChip[] = queueChipCandidates.filter(chip => Number(chip.value) > 0);
  const chips = parsed.chips.length ? parsed.chips : queueChips;
  const rawJson = parsed.raw;
  return <div className="run-summary-section">
    <div className="run-summary-head">
      <span className="run-summary-scope">RUN-WIDE · MARA SUMMARY</span>
      <strong>Run summary</strong>
    </div>
    {chips.length > 0
      ? <ul className="run-summary-chips">
          {chips.map((chip, index) => <li key={`${chip.label}-${index}`} className={chip.tone ? `run-summary-chip ${chip.tone}` : "run-summary-chip"}>
            <strong>{chip.value}</strong>
            <span>{chip.label}</span>
          </li>)}
        </ul>
      : <p className="run-summary-empty">No run-level observation recorded yet.</p>}
    {rawJson && <details className="run-summary-technical">
      <summary>Technical evidence</summary>
      <pre>{rawJson}</pre>
    </details>}
  </div>;
}

/**
 * Runs queue — lists every run the current user has imported or opened,
 * hydrated with the backend's live state. ServiceNow does not expose a
 * runs-list endpoint, so the registry is client-side (localStorage) and
 * every entry is re-fetched via /run to confirm current state before it
 * is rendered as active/complete/blocked.
 */
function RunsQueueView(props: {
  activeRunId: string;
  onOpenRun: (entry: RegistryEntry) => void;
  onNewImport: () => void;
}) {
  const { activeRunId, onOpenRun, onNewImport } = props;
  const [entries, setEntries] = useState<RegistryEntry[]>(() => (typeof window === "undefined" ? [] : readRegistry()));
  const [liveState, setLiveState] = useState<Record<string, { state: string; refreshedAt: string }>>({});
  const [refreshing, setRefreshing] = useState(false);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    const current = readRegistry();
    setEntries(current);
    // Fetch each run's current state in parallel; failures leave the entry
    // in its previous state rather than falsely marking it dead.
    const results = await Promise.allSettled(
      current.map(async entry => {
        const response = await fetch(`/api/cmdb/run?run=${encodeURIComponent(entry.id)}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`${entry.id} → ${response.status}`);
        const body = await response.json();
        const state = body?.result?.result?.state || body?.result?.state || body?.state || "unknown";
        return { id: entry.id, state: String(state) };
      }),
    );
    const next: Record<string, { state: string; refreshedAt: string }> = {};
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === "fulfilled") {
        next[result.value.id] = { state: result.value.state, refreshedAt: stamp };
      }
    }
    setLiveState(next);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    // Fire-and-forget initial refresh — refreshAll dispatches setState
    // asynchronously after the /run responses land, which is exactly what
    // this effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAll();
  }, [refreshAll]);

  function drop(id: string) {
    setEntries(forgetRunEntry(id));
    setLiveState(current => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  const inFlight = entries.filter(entry => {
    const state = liveState[entry.id]?.state ?? "unknown";
    return !isRegistryRunTerminal(state) && state !== "unknown";
  });
  const completed = entries.filter(entry => isRegistryRunTerminal(liveState[entry.id]?.state ?? ""));
  const pending = entries.filter(entry => !inFlight.includes(entry) && !completed.includes(entry));

  return <div className="page runs-page">
    <section className="page-heading">
      <div>
        <span className="eyebrow accent">RUNS QUEUE</span>
        <h1>All the datasets you&apos;ve opened.</h1>
        <p>Switch between runs, or start a new import. State is re-fetched from ServiceNow on load.</p>
      </div>
      <div className="runs-page-actions">
        <button className="ghost-button" disabled={refreshing} onClick={() => void refreshAll()}>
          <Icon name="refresh" size={15} /> {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <button className="primary-button" onClick={onNewImport}>
          <Icon name="upload" size={15} /> New import
        </button>
      </div>
    </section>

    <RunsQueueBucket title="In flight" description="Backend is still working — analyzing, awaiting approval, executing, or verifying." entries={inFlight} liveState={liveState} activeRunId={activeRunId} onOpenRun={onOpenRun} onForget={drop} emptyLine="Nothing is running right now." />
    <RunsQueueBucket title="Pending state check" description="Registered but not yet re-confirmed against ServiceNow." entries={pending} liveState={liveState} activeRunId={activeRunId} onOpenRun={onOpenRun} onForget={drop} emptyLine="All runs have been re-confirmed." />
    <RunsQueueBucket title="Completed" description="Reached a terminal state. Kept for evidence — click to re-open." entries={completed} liveState={liveState} activeRunId={activeRunId} onOpenRun={onOpenRun} onForget={drop} emptyLine="No completed runs yet." />

    {entries.length === 0 && <div className="runs-empty">
      <Icon name="clock" size={22} />
      <strong>The registry is empty.</strong>
      <p>Import a dataset or paste a run sys_id in Comprehend to add one.</p>
    </div>}
  </div>;
}

function RunsQueueBucket(props: {
  title: string;
  description: string;
  entries: RegistryEntry[];
  liveState: Record<string, { state: string; refreshedAt: string }>;
  activeRunId: string;
  onOpenRun: (entry: RegistryEntry) => void;
  onForget: (id: string) => void;
  emptyLine: string;
}) {
  const { title, description, entries, liveState, activeRunId, onOpenRun, onForget, emptyLine } = props;
  return <section className="panel runs-bucket">
    <div className="panel-heading compact">
      <div>
        <span className="section-index">{title === "In flight" ? "01" : title === "Pending state check" ? "02" : "03"}</span>
        <div><h2>{title}</h2><p>{description}</p></div>
      </div>
      <span className="panel-stat">{entries.length}</span>
    </div>
    {entries.length === 0
      ? <p className="runs-empty-line">{emptyLine}</p>
      : <ul className="runs-list">
          {entries.map(entry => <RunsQueueRow key={entry.id} entry={entry} live={liveState[entry.id]} isActive={entry.id === activeRunId} onOpen={() => onOpenRun(entry)} onForget={() => onForget(entry.id)} />)}
        </ul>}
  </section>;
}

function RunsQueueRow(props: {
  entry: RegistryEntry;
  live?: { state: string; refreshedAt: string };
  isActive: boolean;
  onOpen: () => void;
  onForget: () => void;
}) {
  const { entry, live, isActive, onOpen, onForget } = props;
  const state = live?.state ?? "checking…";
  const tone = live ? (isRegistryRunTerminal(state) ? "done" : "active") : "muted";
  const source = entry.sourceSystem?.toLowerCase() || "?";
  return <li className={`runs-row runs-row-${tone}${isActive ? " runs-row-current" : ""}`}>
    <button className="runs-row-open" onClick={onOpen}>
      <div className="runs-row-lead">
        <span className="runs-row-glyph" aria-hidden="true">{sourceSystemGlyph(source)}</span>
        <div>
          <strong>{entry.summary || entry.label}</strong>
          <small>{sourceSystemLabel(source)}{entry.runNumber ? ` · ${entry.runNumber}` : ""} · {entry.id.slice(0, 8).toUpperCase()}</small>
        </div>
      </div>
      <div className="runs-row-state">
        <span className={`runs-state-pill runs-state-${tone}`}>{state.replaceAll("_", " ")}</span>
        {live && <small>synced {live.refreshedAt}</small>}
      </div>
      {isActive && <span className="runs-row-current-tag">CURRENT</span>}
    </button>
    <button className="runs-row-forget" onClick={onForget} title="Remove from this browser's registry (does not delete the ServiceNow run)">
      <Icon name="x" size={14} />
    </button>
  </li>;
}

/**
 * Dataset identity chip that lives in the top bar. Answers the "which
 * dataset am I looking at?" question in a single glance — source system,
 * user's run name, ServiceNow run number, and short sys_id. Everything
 * except the eyebrow label is pulled from the real /run response; no
 * invented text.
 */
function DatasetIdentity(props: {
  section: Section;
  activeRunLabel: string;
  activeRunId: string;
  runRecord: MaraRunRecord | null;
}) {
  const { section, activeRunLabel, activeRunId, runRecord } = props;
  if (section === "import") {
    return <div className="dataset-identity dataset-import">
      <span className="eyebrow">DATA INTAKE</span>
      <strong>NEW MIGRATION RUN</strong>
    </div>;
  }
  if (!activeRunId) {
    return <div className="dataset-identity dataset-none">
      <span className="eyebrow">MODERNIZATION RUN</span>
      <strong>ALL MIGRATION RUNS</strong>
    </div>;
  }
  const displayName = runRecord?.summary?.trim() || activeRunLabel || "Untitled dataset";
  const sourceSystem = runRecord?.sourceSystem?.trim() || "unknown";
  const runNumber = runRecord?.number?.trim() || "";
  const shortId = activeRunId.slice(0, 8).toUpperCase();
  const sourceGlyph = sourceSystemGlyph(sourceSystem);
  return <div className="dataset-identity dataset-active">
    <span className="dataset-source-badge" title={`Source system: ${sourceSystem}`}>
      <span className="dataset-source-glyph" aria-hidden="true">{sourceGlyph}</span>
      <span className="dataset-source-name">{sourceSystemLabel(sourceSystem)}</span>
    </span>
    <div className="dataset-identity-copy">
      <span className="eyebrow">DATASET · {sourceSystem.toUpperCase()}</span>
      <strong title={displayName}>{displayName}</strong>
    </div>
    <div className="dataset-identity-meta">
      {runNumber && <span className="dataset-number" title="ServiceNow run number">{runNumber}</span>}
      <span className="dataset-sys-id" title={activeRunId}>{shortId}</span>
    </div>
  </div>;
}

function sourceSystemGlyph(source: string) {
  switch (source.toLowerCase()) {
    case "file": return "📁";
    case "url": return "🌐";
    case "paste": return "✎";
    case "api": return "⇄";
    default: return "◈";
  }
}

function sourceSystemLabel(source: string) {
  switch (source.toLowerCase()) {
    case "file": return "File upload";
    case "url": return "URL fetch";
    case "paste": return "Pasted payload";
    case "api": return "API push";
    default: return source || "Unknown source";
  }
}

// The named agents that operate on staged records. Order controls how they
// render in the roster — foreman first, then the specialist workers, then
// the machinist. Non-listed actors are still shown but at the tail.
const KNOWN_WORKERS: Array<{
  name: string;
  role: string;
  station: string;
  glyph: string;
}> = [
  { name: "Mara",   role: "Foreman",     station: "Run oversight",       glyph: "M" },
  { name: "Router", role: "Intake",      station: "Import staging",      glyph: "R" },
  { name: "Atlas",  role: "Classifier",  station: "Class proposal",      glyph: "A" },
  { name: "Scout",  role: "Duplicates",  station: "Duplicate scan",      glyph: "S" },
  { name: "Weaver", role: "Relations",   station: "Relationship weave",  glyph: "W" },
  { name: "Sentry", role: "Gatekeeper",  station: "Confidence gate",     glyph: "G" },
  { name: "Ledger", role: "Recorder",    station: "Event ledger",        glyph: "L" },
  { name: "IRE",    role: "Machinist",   station: "Reconcile + execute", glyph: "I" },
];

/**
 * Roster strip: one card per agent that actually contributed to this run.
 * Attribution is real — an agent only appears if timeline events cite it.
 * Each card carries the worker's role, station, latest observed tool call,
 * and event count. Sourced purely from the ServiceNow event ledger.
 */
function WorkerRoster({ timeline }: { timeline: TimelineEvent[] }) {
  const byActor = new Map<string, { count: number; latest?: TimelineEvent }>();
  for (const event of timeline) {
    const actor = (event.source || "").trim();
    if (!actor) continue;
    const entry = byActor.get(actor) ?? { count: 0, latest: undefined };
    entry.count++;
    if (!entry.latest || event.seq >= entry.latest.seq) entry.latest = event;
    byActor.set(actor, entry);
  }
  if (byActor.size === 0) {
    return <section className="worker-roster empty">
      <div className="worker-roster-head">
        <span className="section-index">02</span>
        <div><h2>Agent roster</h2><p>Named workers appear here when their tool calls hit the Event Ledger.</p></div>
      </div>
      <p className="worker-roster-empty">No agents have signed in for this run yet.</p>
    </section>;
  }
  const cards: Array<{ name: string; role: string; station: string; glyph: string; count: number; latest?: TimelineEvent; unknown?: boolean }> = [];
  const seen = new Set<string>();
  for (const worker of KNOWN_WORKERS) {
    const entry = [...byActor.entries()].find(([actor]) => actor.toLowerCase() === worker.name.toLowerCase());
    if (entry) {
      cards.push({ ...worker, count: entry[1].count, latest: entry[1].latest });
      seen.add(entry[0].toLowerCase());
    }
  }
  for (const [actor, entry] of byActor) {
    if (seen.has(actor.toLowerCase())) continue;
    cards.push({
      name: actor,
      role: "External",
      station: "Ad-hoc contributor",
      glyph: actor[0]?.toUpperCase() || "?",
      count: entry.count,
      latest: entry.latest,
      unknown: true,
    });
  }
  return <section className="worker-roster">
    <div className="worker-roster-head">
      <span className="section-index">02</span>
      <div><h2>Agent roster</h2><p>Named workers on the floor for this run. Only agents that emitted ledger events appear.</p></div>
    </div>
    <ul className="worker-roster-grid">
      {cards.map(card => <WorkerCard key={card.name} card={card} />)}
    </ul>
  </section>;
}

function WorkerCard({ card }: { card: { name: string; role: string; station: string; glyph: string; count: number; latest?: TimelineEvent; unknown?: boolean } }) {
  const latest = card.latest;
  const toneClass = latest?.status === "error" ? "warn"
    : latest?.status === "active" ? "active"
    : latest?.status === "complete" ? "good"
    : "muted";
  const rawDetail = (latest?.reasoning || "").trim();
  // Never leak Mara observation JSON blobs; show a stock line for those.
  const looksStructured = /^\s*[{[]|Observation\s*:/i.test(rawDetail);
  const cleanDetail = looksStructured
    ? "Structured observation recorded — open the ledger for source."
    : rawDetail.replace(/\s+/g, " ").slice(0, 140) || "No tool call recorded.";
  return <li className={`worker-card worker-${toneClass}${card.unknown ? " worker-unknown" : ""}`}>
    <div className="worker-avatar" aria-hidden="true">{card.glyph}</div>
    <div className="worker-body">
      <div className="worker-name-row">
        <strong>{card.name}</strong>
        <span className="worker-role">{card.role}</span>
      </div>
      <small className="worker-station">STATION · {card.station}</small>
      <p className="worker-tool">{cleanDetail}</p>
      <div className="worker-meta">
        <span className={`worker-pilot worker-pilot-${toneClass}`} aria-hidden="true" />
        <span>{card.count} tool call{card.count === 1 ? "" : "s"}</span>
        {latest && <span className="worker-latest">last: {latest.name}</span>}
      </div>
    </div>
  </li>;
}

function WorkbenchCountsRow({ queue, lifecycle }: { queue: WorkQueueSummary; lifecycle: IreLifecycleState }) {
  const counts = {
    ready: queue.items.filter(item => item.bucket === "ready_to_simulate").length,
    approval: queue.items.filter(item => item.bucket === "needs_approval").length,
    verify: queue.items.filter(item => item.bucket === "needs_verification").length,
    verified: queue.items.filter(item => item.bucket === "verified").length,
    blocked: queue.items.filter(item => item.bucket === "blocked" || item.bucket === "simulation_failed").length,
  };
  return <div className="workbench-counts">
    <div><small>READY</small><strong>{counts.ready}</strong></div>
    <div><small>APPROVAL</small><strong>{counts.approval}</strong></div>
    <div><small>VERIFY</small><strong>{counts.verify}</strong></div>
    <div><small>VERIFIED</small><strong>{counts.verified}</strong></div>
    <div><small>BLOCKED</small><strong>{counts.blocked}</strong></div>
    <div className="workbench-counts-latest"><small>LATEST</small><strong>{ireLifecycleLabel(lifecycle)}</strong></div>
  </div>;
}

function ActivityFeedRow({ row }: { row: ActivityRow }) {
  const isMara = /mara/i.test(row.actor || "");
  if (isMara) return <MaraObservationBubble row={row} />;

  // Non-Mara agents: never render raw JSON in the card body. If the detail
  // looks structured, show a stock line and hide the source in Technical
  // evidence.
  const detail = row.detail || "";
  const looksStructured = /^\s*[{[]|Observation\s*:/i.test(detail);
  const readable = looksStructured
    ? "Structured evidence recorded. Open technical evidence to inspect the source data."
    : (detail.replace(/\s+/g, " ").trim() || "—");
  return <article className={row.tone}>
    <small>{row.label}{row.actor ? ` · ${row.actor}` : ""}</small>
    <strong>{row.title}</strong>
    <p>{readable}</p>
    {looksStructured && <details className="activity-technical">
      <summary>Technical evidence</summary>
      <pre>{formatTechnicalSource(detail)}</pre>
    </details>}
  </article>;
}

function MaraObservationBubble({ row }: { row: ActivityRow }) {
  const [showAll, setShowAll] = useState(false);
  const observation = parseMaraObservation(row.detail || "");
  const previewCount = 3;
  const shownRecords = showAll ? observation.records : observation.records.slice(0, previewCount);
  const moreCount = Math.max(0, observation.records.length - shownRecords.length);

  return <article className={"mara-observation " + row.tone}>
    <div className="mara-observation-top">
      <span className="mara-observation-avatar" aria-hidden="true">M</span>
      <div className="mara-observation-header">
        <small>{row.label} · Mara</small>
        <strong>{row.title}</strong>
      </div>
    </div>
    <div className="mara-observation-bubble">
      <p>{observation.summaryText}</p>
      {observation.chips.length > 0 && <ul className="mara-observation-chips">
        {observation.chips.map(chip => <li key={chip}>{chip}</li>)}
      </ul>}
    </div>
    {shownRecords.length > 0 && <ul className="mara-observation-records">
      {shownRecords.map((record, index) => <li key={record.id ?? index}>
        <strong>{[record.id, record.name].filter(Boolean).join(" · ") || "record"}</strong>
        <span>
          {record.proposedClass ? record.proposedClass : ""}
          {record.confidence !== undefined ? ` · ${record.confidence}%` : ""}
          {record.status ? ` · ${record.status}` : ""}
        </span>
      </li>)}
      {moreCount > 0 && <li>
        <button type="button" className="mara-observation-more" onClick={() => setShowAll(true)}>
          +{moreCount} more record{moreCount === 1 ? "" : "s"}
        </button>
      </li>}
    </ul>}
    <details className="activity-technical">
      <summary>Technical evidence</summary>
      <pre>{observation.technicalRaw}</pre>
    </details>
  </article>;
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
  const evidenceItems = humanizeStringList(workbench.simulation?.evidence);
  const errorItems = humanizeStringList(latestErrorDetails);
  const summarySource = workbench.verification?.verification_summary ?? (lifecycle === "verification_failed" ? playback?.reason : undefined);
  const summary = summarySource ? humanizeText(summarySource) : undefined;
  const errorMessage = latestError ? humanizeText(latestError.message) : undefined;
  return <div className="ire-results">
    {latestError && <div className="ire-error"><Icon name="x" size={15} />{friendlyIreError(latestError.code, errorMessage?.readable ?? latestError.message)}</div>}
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
    {evidenceItems.readable.length > 0 && <ul className="ire-evidence">
      {evidenceItems.readable.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
    </ul>}
    {errorItems.readable.length > 0 && <ul className="ire-evidence error-details">
      {errorItems.readable.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
    </ul>}
    {summary && <p className="verification-summary">{summary.readable}</p>}
    {(evidenceItems.raw || errorItems.raw || summary?.raw || (errorMessage && errorMessage.raw)) && <details className="activity-technical ire-technical">
      <summary>Technical evidence</summary>
      <pre>{[
        evidenceItems.raw && `evidence:\n${evidenceItems.raw}`,
        errorItems.raw && `error details:\n${errorItems.raw}`,
        errorMessage?.raw && `error message:\n${errorMessage.raw}`,
        summary?.raw && `summary:\n${summary.raw}`,
      ].filter(Boolean).join("\n\n")}</pre>
    </details>}
  </div>;
}

function humanizeText(value: string): { readable: string; raw?: string } {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return { readable: "—" };
  if (looksStructuredPayload(trimmed)) {
    return {
      readable: "Structured payload received. Open technical evidence to inspect the source data.",
      raw: prettifyPayload(trimmed),
    };
  }
  return { readable: trimmed.replace(/\s+/g, " ") };
}

function humanizeStringList(values?: string[]): { readable: string[]; raw?: string } {
  if (!values?.length) return { readable: [] };
  const readable: string[] = [];
  const rawParts: string[] = [];
  for (const value of values) {
    const trimmed = (value ?? "").toString().trim();
    if (!trimmed) continue;
    if (looksStructuredPayload(trimmed)) {
      rawParts.push(prettifyPayload(trimmed));
    } else {
      readable.push(trimmed.replace(/\s+/g, " "));
    }
  }
  if (readable.length === 0 && rawParts.length > 0) {
    readable.push("Structured payload received. Open technical evidence to inspect the source data.");
  }
  return { readable, raw: rawParts.length ? rawParts.join("\n") : undefined };
}

function looksStructuredPayload(value: string): boolean {
  return /^\s*[{[]/.test(value) || value.length > 240;
}

function prettifyPayload(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
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

type ActivityRow = { id: string; label: string; title: string; detail: string; tone: string; actor?: string };

function activityRows(workbench: IreWorkbenchRecord, events: TimelineEvent[]): ActivityRow[] {
  const rows: ActivityRow[] = [
    workbench.simulation && { id: "simulation", label: "SIMULATION", title: workbench.simulation.success ? "Simulation recorded" : "Simulation failed", detail: workbench.simulation.error?.message ?? workbench.simulation.evidence?.[0] ?? "ServiceNow returned simulation metadata.", tone: workbench.simulation.success ? "complete" : "error", actor: "IRE" },
    workbench.approval && { id: "approval", label: "APPROVAL", title: `${workbench.approval.status ?? "decision"} recorded`, detail: workbench.approval.error?.message ?? "Review decision was submitted for the single actionable finding.", tone: workbench.approval.success ? "review" : "error", actor: "Reviewer" },
    workbench.execution && { id: "execution", label: "EXECUTION", title: workbench.execution.success ? "Execution accepted" : "Execution rejected", detail: workbench.execution.error?.message ?? "ServiceNow rebuilt and handled the IRE execution request.", tone: workbench.execution.success ? "complete" : "error", actor: "IRE" },
    workbench.verification && { id: "verification", label: "VERIFY", title: workbench.verification.success ? "Verification complete" : "Verification failed", detail: workbench.verification.error?.message ?? workbench.verification.verification_summary ?? "Read-back was tied to the execution correlation ID.", tone: workbench.verification.success ? "complete" : "error", actor: "IRE" },
  ].filter(Boolean) as ActivityRow[];
  const ledgerRows: ActivityRow[] = events.map(event => ({ id: event.id, label: `LEDGER ${event.seq}`, title: event.name, detail: event.reasoning, tone: event.status, actor: event.source }));
  return [...rows, ...ledgerRows].slice(-7).reverse();
}

function ProvenancePanel({ ci, onClose, onOpenLedger }: { ci: ConfigurationItem; onClose: () => void; onOpenLedger: () => void }) {
  return <div className="drawer-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><aside className="provenance-drawer"><div className="drawer-top"><div><span className="eyebrow accent">COMPREHEND PROVENANCE</span><h2>{ci.name}</h2><p>{ci.id} · {ci.className}</p></div><button onClick={onClose} aria-label="Close provenance"><Icon name="x" /></button></div><div className="drawer-score"><div><small>CONFIDENCE</small><strong>{Math.round(ci.confidence * 100)}%</strong></div><div><small>HEALTH</small><strong>{ci.health}</strong></div><div><small>GATE OUTCOME</small><OperationPill value={ci.operation} /></div></div><div className="provenance-path"><span className="path-line" />{ci.provenance.map((item, index) => <div className="provenance-item" key={`${item.label}-${index}`}><span className={index === ci.provenance.length - 1 ? "path-node current" : "path-node"}>{index + 1}</span><div><small>{item.label}</small><strong>{item.value}</strong>{item.detail && <p>{item.detail}</p>}</div></div>)}</div><div className="drawer-governance"><Icon name="shield" /><div><strong>IRE remains the only future write path</strong><p>Comprehend analyzed this staged record without writing to the CMDB.</p></div></div><button className="ghost-button full" onClick={onOpenLedger}><Icon name="clock" size={16} /> Open full ledger trail</button></aside></div>;
}
