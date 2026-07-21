// Single source of truth for the Agent Workspace UI.
//
// Every phase card, Mara message, governance panel, and Approvals label reads
// from the same derived shape so the surfaces cannot disagree ("Mara says
// approval required" vs "Approvals says zero", etc.).

import type { ConfigurationItem, HealthData, Relationship, TimelineEvent } from "../../cmdb-data";
import {
  deriveAgentWorkspaceSnapshot,
  type AgentWorkspaceSnapshot,
  type CprPhaseId,
} from "./agent-workspace";
import type { RemediationFinding, RemediationReview } from "./comprehend-adapter";
import { isDraftRunState, isTerminalRunState } from "./run-lifecycle";
import { deriveRemediationWorkQueue, type WorkQueueSummary } from "./work-queue";

export type WorkspacePhaseId = CprPhaseId | "verify";

export type PhaseStatus = "waiting" | "working" | "complete" | "blocked" | "approval_required" | "unknown";

export type MaraViewState =
  | "sleeping"
  | "inspecting"
  | "warning"
  | "awaiting_approval"
  | "blooming"
  | "error";

export type MaraActionKey =
  | "start_rescue"
  | "watch_agents"
  | "open_team"
  | "review_findings"
  | "open_approvals"
  | "open_evidence"
  | "open_ai_usage"
  | "inspect_run";

export type ApiState = "connecting" | "live" | "partial" | "demo" | "error";

export type WorkspaceViewInput = {
  runLabel: string;
  runId?: string;
  runState: string;
  apiState: ApiState;
  analysisState?: "idle" | "starting" | "started" | "error";
  cis: ConfigurationItem[];
  timeline: TimelineEvent[];
  relationships: Relationship[];
  findings: RemediationFinding[];
  reviews: RemediationReview[];
  health: HealthData;
};

export type WorkspaceHealthView = {
  baseline: number | null;
  verified: number | null;
  projected: number | null;
  realizedLift: number | null;
  remainingLift: number | null;
};

export type ActivityCard = {
  id: string;
  seq: number;
  phase: CprPhaseId;
  actor: string;
  tool?: string;
  status: TimelineEvent["status"];
  headline: string;
  summary: string;
  technical: string;
};

export type WorkspaceViewState = {
  runLabel: string;
  runId: string;
  runState: string;
  hasRun: boolean;
  snapshot: AgentWorkspaceSnapshot;
  queue: WorkQueueSummary;

  activePhase: WorkspacePhaseId;
  comprehendStatus: PhaseStatus;
  prioritizeStatus: PhaseStatus;
  remediateStatus: PhaseStatus;
  verifyStatus: PhaseStatus;

  approvalCount: number;
  heldCount: number;
  readyToSimulateCount: number;
  workGroupCount: number;
  requiresApproval: boolean;
  requiresReview: boolean;
  approvalPacketPrepared: boolean;

  currentAgent: string;
  currentTool?: string;
  currentAction: string;
  nextAction: string;
  nextPhase?: WorkspacePhaseId;
  latestResult: string;
  activityCards: ActivityCard[];

  mara: {
    state: MaraViewState;
    primary: string;
    secondary?: string;
    actions: MaraActionKey[];
  };

  governance: {
    title: string;
    message: string;
    tone: "clear" | "attention" | "blocked";
  };

  health: WorkspaceHealthView;
  liveHealthAvailable: boolean;
};

export function deriveWorkspaceViewState(input: WorkspaceViewInput): WorkspaceViewState {
  const queue = deriveRemediationWorkQueue({
    cis: input.cis,
    timeline: input.timeline,
    healthFixes: input.health.fixes,
    findings: input.findings,
    reviews: input.reviews,
    demoFallback: !input.runLabel && input.apiState === "demo",
  });

  const snapshot = deriveAgentWorkspaceSnapshot({
    runLabel: input.runLabel,
    runState: input.runState,
    cis: input.cis,
    timeline: input.timeline,
    relationships: input.relationships,
    findings: input.findings,
    reviews: input.reviews,
    health: input.health,
    queue,
  });

  const hasRun = Boolean(input.runId || input.runLabel);
  const runStateLower = (input.runState || "").toLowerCase();

  const heldCiCount = input.cis.filter(ci => ci.status !== "live").length;
  const openReviewCount = input.reviews.filter(r => {
    const decision = (r.decision || "").toLowerCase();
    return !decision || decision === "pending" || decision === "open" || decision === "deferred";
  }).length;
  const unresolvedFindingCount = input.findings.length;
  const heldCount = Math.max(heldCiCount, openReviewCount, unresolvedFindingCount, input.health.reviewCount || 0);

  const readyToSimulateCount = queue.items.filter(item => item.bucket === "ready_to_simulate").length;
  const workGroupCount = snapshot.groups.length;
  const queueApprovalCount = snapshot.approvals.length;
  const approvalPacketPrepared = timelineHasApprovalPacket(input.timeline);
  const criticalUnresolvedFindings = input.findings.filter(f => (f.severity || "").toLowerCase() === "critical").length;

  const requiresApproval =
    queueApprovalCount > 0
    || runStateLower === "awaiting_approval"
    || approvalPacketPrepared
    || (criticalUnresolvedFindings > 0 && openReviewCount === 0 && queueApprovalCount === 0 && heldCount > 0);
  const approvalCount = Math.max(queueApprovalCount, requiresApproval ? Math.max(1, heldCount) : 0);

  const requiresReview = requiresApproval || heldCount > 0;

  const comprehendStatus = deriveComprehendStatus(input, snapshot);
  const prioritizeStatus = derivePrioritizeStatus(input, snapshot, workGroupCount);
  const remediateStatus = deriveRemediateStatus({
    queue,
    requiresApproval,
    verifiedCount: queue.items.filter(i => i.bucket === "verified").length,
    executingCount: queue.items.filter(i => i.bucket === "needs_verification").length,
    prioritizeStatus,
  });
  const verifyStatus = deriveVerifyStatus(queue, runStateLower);

  const activePhase = pickActivePhase({
    comprehendStatus,
    prioritizeStatus,
    remediateStatus,
    verifyStatus,
    requiresApproval,
    hasRun,
  });

  const activityCards = buildActivityCards(input.timeline).slice(-14);
  const currentEvent = pickCurrentEvent(activityCards, activePhase, requiresApproval, approvalPacketPrepared);
  const currentAgent = requiresApproval
    ? "Mara"
    : currentEvent?.actor ?? snapshot.activeAgent ?? "Mara";
  const currentTool = requiresApproval
    ? "prepare_approval_packet"
    : currentEvent?.tool;
  const currentAction = requiresApproval
    ? approvalCount === 1
      ? "Prepared an approval packet for 1 unresolved critical finding."
      : `Prepared an approval packet for ${approvalCount} unresolved critical findings.`
    : currentEvent?.summary ?? snapshot.activeAction ?? "Waiting for the next signal";
  const nextPhase = deriveNextPhase(activePhase, {
    comprehendStatus, prioritizeStatus, remediateStatus, verifyStatus, requiresApproval,
  });
  const nextAction = deriveNextAction({ requiresApproval, verifyStatus, remediateStatus, readyToSimulateCount });
  const latestResult = deriveLatestResult(activityCards, prioritizeStatus, workGroupCount);

  const mara = deriveMaraView({
    hasRun, runStateLower, analysisState: input.analysisState, apiState: input.apiState,
    requiresApproval, approvalCount, heldCount, verifyStatus, snapshot, activityCards,
  });

  const governance = deriveGovernance({
    requiresApproval, requiresReview, approvalCount, heldCount, hasRun, approvalPacketPrepared,
  });

  const liveHealthAvailable = Boolean(
    input.health.baselineScore !== undefined
    || input.health.verifiedScore !== undefined
    || input.health.projectedScore !== undefined,
  );
  const health = liveHealthAvailable
    ? {
        baseline: input.health.baselineScore ?? null,
        verified: input.health.verifiedScore ?? null,
        projected: input.health.projectedScore ?? null,
        realizedLift: input.health.verifiedScore !== undefined && input.health.baselineScore !== undefined
          ? round(input.health.verifiedScore - input.health.baselineScore)
          : null,
        remainingLift: input.health.projectedScore !== undefined && input.health.verifiedScore !== undefined
          ? round(input.health.projectedScore - input.health.verifiedScore)
          : null,
      }
    : { baseline: null, verified: null, projected: null, realizedLift: null, remainingLift: null };

  return {
    runLabel: input.runLabel,
    runId: input.runId ?? "",
    runState: input.runState,
    hasRun,
    snapshot,
    queue,
    activePhase,
    comprehendStatus,
    prioritizeStatus,
    remediateStatus,
    verifyStatus,
    approvalCount,
    heldCount,
    readyToSimulateCount,
    workGroupCount,
    requiresApproval,
    requiresReview,
    approvalPacketPrepared,
    currentAgent,
    currentTool,
    currentAction,
    nextAction,
    nextPhase,
    latestResult,
    activityCards,
    mara,
    governance,
    health,
    liveHealthAvailable,
  };
}

function timelineHasApprovalPacket(timeline: TimelineEvent[]) {
  return timeline.some(event => {
    const text = `${event.name} ${event.reasoning}`.toLowerCase();
    return text.includes("prepare_approval_packet")
      || text.includes("approval packet prepared")
      || text.includes("approval packet");
  });
}

function deriveComprehendStatus(input: WorkspaceViewInput, snapshot: AgentWorkspaceSnapshot): PhaseStatus {
  const state = snapshot.phases.find(p => p.id === "comprehend")?.state;
  if (state === "complete" || state === "working" || state === "waiting" || state === "blocked" || state === "approval_required") return state;
  // Fallback: any ledger evidence of a Comprehend step means it happened.
  const hasComprehend = input.timeline.some(event => event.step >= 3);
  return hasComprehend ? "complete" : "waiting";
}

function derivePrioritizeStatus(input: WorkspaceViewInput, snapshot: AgentWorkspaceSnapshot, workGroupCount: number): PhaseStatus {
  const snapshotState = snapshot.phases.find(p => p.id === "prioritize")?.state;
  if (snapshotState === "complete") return "complete";
  // Ranked work groups are the definition of "prioritize complete".
  if (workGroupCount > 0) return "complete";
  const priorityEvent = input.timeline.find(event => /priorit|ranked|group_|work group|scoring/i.test(`${event.name} ${event.reasoning}`));
  if (priorityEvent) return priorityEvent.status === "active" ? "working" : "complete";
  const comprehendDone = input.timeline.some(event => event.step >= 3);
  return comprehendDone ? "working" : "waiting";
}

function deriveRemediateStatus(input: {
  queue: WorkQueueSummary;
  requiresApproval: boolean;
  verifiedCount: number;
  executingCount: number;
  prioritizeStatus: PhaseStatus;
}): PhaseStatus {
  // Approval takes precedence over any "ready" queue items — Mara is paused.
  if (input.requiresApproval) return "approval_required";
  if (input.executingCount > 0) return "working";
  if (input.verifiedCount > 0) return "complete";
  const blocked = input.queue.items.filter(item => item.bucket === "blocked" || item.bucket === "simulation_failed").length;
  if (blocked > 0) return "blocked";
  // No approvals, no executions, no verifications, no blockers: Remediation
  // has not started. That is "waiting", never "working", until backend
  // evidence of an execution appears.
  return "waiting";
}

function deriveVerifyStatus(queue: WorkQueueSummary, runStateLower: string): PhaseStatus {
  const verified = queue.items.filter(item => item.bucket === "verified").length;
  const needsVerification = queue.items.filter(item => item.bucket === "needs_verification").length;
  if (verified > 0 && needsVerification === 0) return "complete";
  if (needsVerification > 0) return "working";
  // Do NOT infer completion from ledger substrings — verification only counts
  // when the queue reports a verified read-back or the run reports committed.
  if (runStateLower === "committed" && verified > 0) return "complete";
  return "waiting";
}

function pickActivePhase(input: {
  comprehendStatus: PhaseStatus;
  prioritizeStatus: PhaseStatus;
  remediateStatus: PhaseStatus;
  verifyStatus: PhaseStatus;
  requiresApproval: boolean;
  hasRun: boolean;
}): WorkspacePhaseId {
  if (!input.hasRun) return "comprehend";
  if (input.requiresApproval || input.remediateStatus === "approval_required") return "remediate";
  if (input.verifyStatus === "working") return "verify";
  if (input.remediateStatus === "working" || input.remediateStatus === "blocked") return "remediate";
  if (input.prioritizeStatus === "working") return "prioritize";
  if (input.comprehendStatus === "working") return "comprehend";
  if (input.verifyStatus === "complete") return "verify";
  if (input.remediateStatus === "complete") return "verify";
  if (input.prioritizeStatus === "complete") return "remediate";
  if (input.comprehendStatus === "complete") return "prioritize";
  return "comprehend";
}

function deriveNextPhase(active: WorkspacePhaseId, statuses: {
  comprehendStatus: PhaseStatus;
  prioritizeStatus: PhaseStatus;
  remediateStatus: PhaseStatus;
  verifyStatus: PhaseStatus;
  requiresApproval: boolean;
}): WorkspacePhaseId | undefined {
  const order: WorkspacePhaseId[] = ["comprehend", "prioritize", "remediate", "verify"];
  const startIndex = order.indexOf(active);
  if (startIndex < 0) return undefined;
  for (let i = startIndex + 1; i < order.length; i++) {
    const phase = order[i];
    const status = phase === "comprehend" ? statuses.comprehendStatus
      : phase === "prioritize" ? statuses.prioritizeStatus
      : phase === "remediate" ? statuses.remediateStatus
      : statuses.verifyStatus;
    if (status !== "complete") return phase;
  }
  return undefined;
}

function deriveNextAction(input: {
  requiresApproval: boolean;
  verifyStatus: PhaseStatus;
  remediateStatus: PhaseStatus;
  readyToSimulateCount: number;
}) {
  if (input.requiresApproval) return "Human review and approval";
  if (input.remediateStatus === "working") return "Verify executed records";
  if (input.verifyStatus === "complete") return "Run complete";
  if (input.readyToSimulateCount > 0) return `Simulate ${input.readyToSimulateCount} eligible records`;
  return "Awaiting next backend signal";
}

function deriveLatestResult(cards: ActivityCard[], prioritizeStatus: PhaseStatus, workGroupCount: number): string {
  const lastComplete = [...cards].reverse().find(c => c.status === "complete");
  if (lastComplete) return lastComplete.headline;
  if (prioritizeStatus === "complete" && workGroupCount > 0) return `Prioritization ranked ${workGroupCount} work groups.`;
  return "—";
}

function pickCurrentEvent(cards: ActivityCard[], activePhase: WorkspacePhaseId, requiresApproval: boolean, approvalPacketPrepared: boolean) {
  if (requiresApproval || approvalPacketPrepared) {
    const packet = [...cards].reverse().find(c => (c.tool ?? "").includes("approval") || c.headline.toLowerCase().includes("approval"));
    if (packet) return packet;
  }
  const phasePhaseId: CprPhaseId = activePhase === "verify" ? "remediate" : activePhase;
  const inPhase = [...cards].reverse().find(c => c.phase === phasePhaseId);
  return inPhase ?? cards.at(-1);
}

function buildActivityCards(timeline: TimelineEvent[]): ActivityCard[] {
  return [...timeline].sort((a, b) => a.seq - b.seq).map(event => {
    const parsed = extractStructuredEvent(event.reasoning);
    const phase = phaseForEvent(event);
    const actor = parsed.actor ?? event.source ?? "ServiceNow";
    const tool = parsed.tool;
    const structuredSummary = summarizeStructured(parsed, event, tool);
    const summary = sanitizeUserSummary(structuredSummary ?? event.reasoning);
    return {
      id: event.id,
      seq: event.seq,
      phase,
      actor,
      tool,
      status: event.status,
      headline: sanitizeUserSummary(event.name),
      summary,
      technical: buildTechnicalDetail(event, parsed),
    };
  });
}

type StructuredEvent = {
  actor?: string;
  tool?: string;
  action?: string;
  thought?: string;
  observation?: string;
  status?: string;
  error?: string;
  summary?: string;
  raw?: unknown;
};

function extractStructuredEvent(reasoning: string): StructuredEvent {
  const trimmed = (reasoning || "").trim();
  const result: StructuredEvent = {};
  // Try full-JSON first (keystone.agent.v1 or generic).
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      result.raw = parsed;
      const summary = parsed.summary ?? parsed.message;
      if (typeof summary === "string") result.summary = summary;
      const actor = parsed.actor ?? parsed.agent;
      if (typeof actor === "string") result.actor = actor;
      const tool = parsed.tool ?? parsed.action;
      if (typeof tool === "string") result.tool = tool;
      const observation = parsed.observation;
      if (typeof observation === "string") result.observation = observation;
      const status = parsed.status;
      if (typeof status === "string") result.status = status;
      const error = parsed.error;
      if (typeof error === "string") result.error = error;
      return result;
    } catch {
      // fall through — treat as freeform text
    }
  }
  // Parse "Thought: ... | Action: ... | Observation: ..." pipe format.
  const parts = trimmed.split(/\s*\|\s*/);
  for (const part of parts) {
    const match = part.match(/^(Thought|Action|Observation|Tool|Actor|Agent|Error|Status)\s*:\s*(.+)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "thought") result.thought = value;
    else if (key === "action" || key === "tool") result.tool = result.tool ?? value;
    else if (key === "observation") result.observation = value;
    else if (key === "actor" || key === "agent") result.actor = value;
    else if (key === "error") result.error = value;
    else if (key === "status") result.status = value;
  }
  return result;
}

function summarizeStructured(parsed: StructuredEvent, event: TimelineEvent, tool?: string): string | undefined {
  if (tool) {
    if (tool === "prepare_approval_packet") {
      return "Mara prepared an approval packet for unresolved critical findings.";
    }
    if (tool === "rank_findings" || tool === "score_findings") {
      return "Prioritization ranked findings by health impact.";
    }
    if (tool === "simulate") return "Requested a non-mutating IRE simulation for one staged CI.";
    if (tool === "execute") return "Executed one approved staged CI through IRE.";
    if (tool === "verify") return "Verified the executed CI via correlation-tied read-back.";
  }
  const observation = parsed.observation;
  const summary = parsed.summary;
  const error = parsed.error;
  if (summary) return summary;
  if (observation && !observation.trim().startsWith("{")) return observation;
  if (error && /unterminated|parse|invalid json|syntax/i.test(error) && event.reasoning.toLowerCase().includes("priorit")) {
    return "Prioritization completed using deterministic scoring. The optional AI explanation failed, so rule-based explanations were preserved.";
  }
  return undefined;
}

function sanitizeUserSummary(value: string): string {
  if (!value) return "—";
  let cleaned = value.replace(/\r?\n/g, " ").trim();
  // Strip leading "Thought: ..." and any Action pipe segment — those are agent
  // internals, not user-facing evidence.
  cleaned = cleaned.replace(/^Thought\s*:\s*[^|]+\|\s*/i, "");
  cleaned = cleaned.replace(/^Thought\s*:\s*.+$/i, "");
  cleaned = cleaned.replace(/\bAction\s*:\s*([A-Za-z0-9_.-]+)\b/g, (_all, name) => `used ${name}`);
  cleaned = cleaned.replace(/\bObservation\s*:\s*\{[\s\S]*$/i, "").trim();
  cleaned = cleaned.replace(/\{[\s\S]*\}/g, "").trim();
  if (!cleaned || cleaned === "used") return "—";
  return cleaned.length > 220 ? cleaned.slice(0, 217) + "…" : cleaned;
}

function buildTechnicalDetail(event: TimelineEvent, parsed: StructuredEvent): string {
  const parts: string[] = [];
  parts.push(`event_id=${event.id}`);
  parts.push(`seq=${event.seq}`);
  parts.push(`step=${event.step}`);
  if (event.operation) parts.push(`operation=${event.operation}`);
  if (parsed.tool) parts.push(`tool=${parsed.tool}`);
  if (parsed.error) parts.push(`error=${parsed.error}`);
  if (parsed.observation) parts.push(`observation=${parsed.observation}`);
  if (parsed.raw && typeof parsed.raw === "object") {
    try { parts.push("raw=" + JSON.stringify(parsed.raw)); } catch { /* ignore */ }
  } else if (event.reasoning) {
    parts.push("reasoning=" + event.reasoning);
  }
  return parts.join("\n");
}

function phaseForEvent(event: TimelineEvent): CprPhaseId {
  const text = `${event.source} ${event.name} ${event.reasoning}`.toLowerCase();
  if (/simulat|execut|verif|remediat|approval packet|prepare_approval/.test(text)) return "remediate";
  if (/priorit|rank|group_|health impact|score/.test(text)) return "prioritize";
  return "comprehend";
}

function deriveMaraView(input: {
  hasRun: boolean;
  runStateLower: string;
  analysisState?: string;
  apiState: ApiState;
  requiresApproval: boolean;
  approvalCount: number;
  heldCount: number;
  verifyStatus: PhaseStatus;
  snapshot: AgentWorkspaceSnapshot;
  activityCards: ActivityCard[];
}): WorkspaceViewState["mara"] {
  if (!input.hasRun) return {
    state: "sleeping",
    primary: "Bring me an estate when you're ready.",
    actions: ["start_rescue"],
  };

  const errored = input.analysisState === "error"
    || input.runStateLower === "failed" || input.runStateLower === "error"
    || (input.apiState === "error" && !isDraftRunState(input.runStateLower));
  if (errored) return {
    state: "error",
    primary: "Something interrupted the run. The existing evidence is still available.",
    actions: ["inspect_run", "open_evidence"],
  };

  if (input.requiresApproval) {
    const count = Math.max(input.approvalCount, input.heldCount);
    const primary = count === 1
      ? "The investigation is complete. 1 record requires your review before I can continue."
      : `The investigation is complete. ${countWord(count)} records require your review before I can continue.`;
    return {
      state: "awaiting_approval",
      primary,
      secondary: "Each approval is scoped to one staged CI and one simulation fingerprint.",
      actions: ["review_findings", "open_approvals"],
    };
  }

  if (input.heldCount > 0 && (isTerminalRunState(input.runStateLower) || !isDraftRunState(input.runStateLower))) {
    return {
      state: "warning",
      primary: input.heldCount === 1
        ? "1 record needs human attention."
        : `${input.heldCount} records need human attention.`,
      actions: ["review_findings", "open_approvals"],
    };
  }

  if (input.runStateLower === "complete" || input.runStateLower === "completed" || input.runStateLower === "committed" || input.verifyStatus === "complete") {
    return {
      state: "blooming",
      primary: input.verifyStatus === "complete"
        ? "The repair was verified through IRE."
        : "The run is complete and the evidence is preserved.",
      actions: ["open_evidence", "open_ai_usage"],
    };
  }

  // Active run without approval, held records, or terminal success — the
  // agents are working. Never fall through to "sleeping" while a run exists.
  return {
    state: "inspecting",
    primary: input.snapshot.activeAction || "The agents are inspecting this migration run.",
    actions: ["watch_agents", "open_team"],
  };
}

function countWord(count: number) {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return count >= 0 && count <= 10 ? cap(words[count]) : String(count);
}
function cap(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }

function deriveGovernance(input: {
  requiresApproval: boolean;
  requiresReview: boolean;
  approvalCount: number;
  heldCount: number;
  hasRun: boolean;
  approvalPacketPrepared: boolean;
}): WorkspaceViewState["governance"] {
  if (!input.hasRun) return {
    title: "Governance idle",
    message: "Open a run to see whether Mara is waiting for authorization.",
    tone: "clear",
  };
  if (input.requiresApproval) {
    const count = Math.max(input.approvalCount, input.heldCount);
    return {
      title: count === 1 ? "Approval required" : `${count} approvals required`,
      message: input.approvalPacketPrepared
        ? "Mara prepared an approval packet. Authorize one IRE execution per staged CI before Mara can continue."
        : "Authorize one IRE execution per staged CI. ServiceNow then executes and verifies automatically.",
      tone: "attention",
    };
  }
  if (input.heldCount > 0) return {
    title: input.heldCount === 1 ? "1 record held for review" : `${input.heldCount} records held for review`,
    message: "Mara is holding these records until human review or a stronger identity signal arrives.",
    tone: "attention",
  };
  if (input.requiresReview) return {
    title: "Review queue open",
    message: "Findings are waiting for a review decision before Mara can advance them.",
    tone: "attention",
  };
  return {
    title: "No human action needed",
    message: "Mara can continue bounded, non-mutating work until the next policy boundary.",
    tone: "clear",
  };
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
