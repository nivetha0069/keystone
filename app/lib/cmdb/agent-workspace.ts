import type { ConfigurationItem, HealthData, HealthFix, Relationship, TimelineEvent } from "../../cmdb-data";
import type { RemediationFinding, RemediationReview } from "./comprehend-adapter";
import type { WorkQueueItem, WorkQueueSummary } from "./work-queue";

export type AgentDecisionSource = "model" | "deterministic" | "deterministic_fallback";
export type CprPhaseId = "comprehend" | "prioritize" | "remediate";
export type AgentPhaseState = "waiting" | "working" | "complete" | "blocked" | "approval_required";
export type FailureCategory =
  | "class_alias"
  | "missing_identifier"
  | "duplicate_identity"
  | "stale_simulation"
  | "authorization"
  | "invalid_payload"
  | "verification"
  | "unknown";

export type AgentEventDetailV1 = {
  schema: "keystone.agent.v1";
  phase: CprPhaseId;
  actor: string;
  decision_source: AgentDecisionSource;
  action: string;
  status: "started" | "completed" | "failed" | "blocked" | "approval_required";
  summary: string;
  staged_ci_id?: string;
  finding_id?: string;
  strategy_id?: string;
  correlation_id?: string;
  simulation_correlation_id?: string;
  execution_correlation_id?: string;
  simulation_fingerprint?: string;
  health_impact?: number;
};

export type AgentWorkGroup = {
  id: string;
  signature: string;
  title: string;
  category: FailureCategory;
  targetClass: string;
  field?: string;
  findingIds: string[];
  stagedCiIds: string[];
  affected: number;
  priority: number;
  projectedLift: number;
  realizedLift: number;
  lifecycleCounts: Partial<Record<WorkQueueItem["bucket"], number>>;
  strategy?: "normalize_known_class_alias";
  blocker?: string;
};

export type AgentWorkspaceSnapshot = {
  objective: string;
  activeAgent: string;
  activeAction: string;
  decisionSource: AgentDecisionSource;
  status: AgentPhaseState;
  phases: Array<{ id: CprPhaseId; label: string; state: AgentPhaseState; summary: string }>;
  groups: AgentWorkGroup[];
  approvals: WorkQueueItem[];
  blocked: WorkQueueItem[];
  health: {
    baseline: number;
    verified: number;
    projected: number;
    realizedLift: number;
    remainingLift: number;
  };
  relationships: { total: number; ready: number; blocked: number };
  recentActivity: Array<{
    id: string;
    seq: number;
    actor: string;
    phase: CprPhaseId;
    title: string;
    summary: string;
    status: TimelineEvent["status"];
    decisionSource: AgentDecisionSource;
  }>;
};

export function deriveAgentWorkspaceSnapshot(input: {
  runLabel?: string;
  runState?: string;
  cis: ConfigurationItem[];
  timeline: TimelineEvent[];
  relationships: Relationship[];
  findings: RemediationFinding[];
  reviews: RemediationReview[];
  health: HealthData;
  queue: WorkQueueSummary;
}): AgentWorkspaceSnapshot {
  const groups = deriveAgentWorkGroups(input);
  const recentActivity = [...input.timeline]
    .sort((a, b) => a.seq - b.seq)
    .slice(-12)
    .map(event => {
      const detail = parseAgentEventDetail(event.reasoning);
      return {
        id: event.id,
        seq: event.seq,
        actor: detail?.actor || event.source || "ServiceNow",
        phase: detail?.phase || phaseForEvent(event),
        title: event.name,
        summary: detail?.summary || compact(event.reasoning),
        status: event.status,
        decisionSource: detail?.decision_source || inferDecisionSource(event.reasoning),
      };
    });
  const latest = recentActivity.at(-1);
  const approvals = input.queue.items.filter(item => item.bucket === "needs_approval" || item.bucket === "ready_to_execute");
  const blocked = input.queue.items.filter(item => item.bucket === "blocked" || item.bucket === "simulation_failed");
  const explicitBaseline = firstMetric(input.timeline, "baseline_score") ?? input.health.baselineScore;
  const explicitVerified = lastMetric(input.timeline, "verified_score") ?? input.health.verifiedScore;
  const explicitProjected = lastMetric(input.timeline, "projected_score") ?? input.health.projectedScore;
  const realizedLift = groups.reduce((sum, group) => sum + group.realizedLift, 0);
  const remainingLift = groups.reduce((sum, group) => sum + Math.max(0, group.projectedLift - group.realizedLift), 0);
  const baseline = clamp(explicitBaseline ?? input.health.score - realizedLift);
  const verified = clamp(explicitVerified ?? Math.max(input.health.score, baseline + realizedLift));
  const projected = clamp(explicitProjected ?? verified + remainingLift);
  const relationshipReadiness = deriveRelationshipReadiness(input.relationships, input.queue.items);
  const phases = derivePhases(input.timeline, input.queue, input.runState);
  const activePhase = phases.find(phase => phase.state === "working" || phase.state === "approval_required" || phase.state === "blocked") ?? phases.at(-1)!;

  return {
    objective: input.runLabel ? `Improve and verify CMDB health for ${input.runLabel}` : "Prepare the active migration run for governed CMDB migration",
    activeAgent: latest?.actor || (input.runState === "analyzing" ? "Comprehend" : "Mara"),
    activeAction: latest?.summary || (input.cis.length ? "Evaluating the next safe action" : "Waiting for staged data"),
    decisionSource: latest?.decisionSource || "deterministic",
    status: activePhase.state,
    phases,
    groups,
    approvals,
    blocked,
    health: { baseline, verified, projected, realizedLift: Math.max(0, verified - baseline), remainingLift: Math.max(0, projected - verified) },
    relationships: relationshipReadiness,
    recentActivity,
  };
}

export function deriveAgentWorkGroups(input: {
  cis: ConfigurationItem[];
  findings: RemediationFinding[];
  health: HealthData;
  queue: WorkQueueSummary;
}): AgentWorkGroup[] {
  const grouped = new Map<string, { findingIds: Set<string>; items: WorkQueueItem[]; fix?: HealthFix; recommendation: string }>();
  const itemsByStagedId = new Map(input.queue.items.flatMap(item => [[item.stagedCiId, item], [item.ci.id, item]]));

  for (const finding of input.findings) {
    const item = finding.stagedCiId ? itemsByStagedId.get(finding.stagedCiId) : undefined;
    const evidence = `${finding.type ?? ""} ${finding.severity ?? ""} ${finding.recommendation} ${item?.reason ?? ""}`;
    const category = failureCategory(evidence);
    const targetClass = item?.ci.className || "unclassified";
    const field = failureField(evidence);
    const signature = `${category}:${targetClass.toLowerCase()}:${field || "general"}`;
    const current = grouped.get(signature) ?? { findingIds: new Set<string>(), items: [], recommendation: finding.recommendation };
    current.findingIds.add(finding.id);
    if (item && !current.items.some(candidate => candidate.id === item.id)) current.items.push(item);
    current.fix ??= findHealthFix(category, input.health.fixes);
    grouped.set(signature, current);
  }

  for (const item of input.queue.items.filter(candidate => candidate.bucket === "simulation_failed" || candidate.bucket === "blocked")) {
    if (input.findings.some(finding => finding.stagedCiId === item.stagedCiId)) continue;
    const category = failureCategory(`${item.reason} ${item.latestEvent?.reasoning ?? ""}`);
    const field = failureField(item.reason);
    const signature = `${category}:${item.ci.className.toLowerCase()}:${field || "general"}`;
    const current = grouped.get(signature) ?? { findingIds: new Set<string>(), items: [], recommendation: item.reason };
    current.items.push(item);
    current.fix ??= findHealthFix(category, input.health.fixes);
    grouped.set(signature, current);
  }

  for (const fix of input.health.fixes) {
    if ([...grouped.values()].some(group => group.fix?.id === fix.id)) continue;
    const category = failureCategory(fix.title + " " + fix.description + " " + fix.tool);
    const signature = category + ":estate:general";
    grouped.set(signature, { findingIds: new Set<string>(), items: [], fix, recommendation: fix.description });
  }

  return [...grouped.entries()].map(([signature, group], index) => {
    const category = signature.split(":", 1)[0] as FailureCategory;
    const reportedImpact = input.health.workGroupImpacts?.find(impact => impact.signature === signature);
    const projectedLift = Math.max(1, reportedImpact?.projected ?? group.fix?.impact ?? severityImpact(group.items[0]?.finding?.severity));
    const verified = group.items.filter(item => item.bucket === "verified").length;
    const affected = Math.max(group.items.length, group.fix?.affected ?? 0, group.findingIds.size);
    const realizedLift = reportedImpact?.realized ?? (affected ? round(projectedLift * (verified / affected)) : 0);
    const lifecycleCounts: AgentWorkGroup["lifecycleCounts"] = {};
    for (const item of group.items) lifecycleCounts[item.bucket] = (lifecycleCounts[item.bucket] ?? 0) + 1;
    const strategy: AgentWorkGroup["strategy"] = category === "class_alias" ? "normalize_known_class_alias" : undefined;
    const blocker = strategy ? undefined : blockerFor(category, group.items);
    return {
      id: `group-${slug(signature)}`,
      signature,
      title: groupTitle(category, group.recommendation),
      category,
      targetClass: group.items[0]?.ci.className || signature.split(":")[1] || "unclassified",
      field: signature.split(":")[2] === "general" ? undefined : signature.split(":")[2],
      findingIds: [...group.findingIds],
      stagedCiIds: group.items.map(item => item.stagedCiId),
      affected,
      priority: priorityFor(category, group.items, index),
      projectedLift,
      realizedLift,
      lifecycleCounts,
      strategy,
      blocker,
    };
  }).sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title));
}

export function parseAgentEventDetail(value: string): AgentEventDetailV1 | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<AgentEventDetailV1>;
    if (parsed.schema !== "keystone.agent.v1" || !parsed.phase || !parsed.action || !parsed.summary) return null;
    return parsed as AgentEventDetailV1;
  } catch {
    return null;
  }
}

function derivePhases(timeline: TimelineEvent[], queue: WorkQueueSummary, runState?: string): AgentWorkspaceSnapshot["phases"] {
  const hasAnalysis = timeline.some(event => event.step >= 3 || /comprehend|atlas|scout|weaver|sentry/i.test(`${event.source} ${event.name}`));
  const hasPriority = timeline.some(event => /priorit|group_|health impact/i.test(`${event.name} ${event.reasoning}`));
  const hasRemediation = timeline.some(event => event.step >= 4 || /simulat|approv|execut|verif/i.test(`${event.name} ${event.reasoning}`));
  const pending = queue.items.some(item => item.bucket === "ready_to_simulate" || item.bucket === "needs_verification");
  const approvals = queue.items.filter(item => item.bucket === "needs_approval" || item.bucket === "ready_to_execute").length;
  const blocked = queue.items.filter(item => item.bucket === "blocked" || item.bucket === "simulation_failed").length;
  const verified = queue.items.filter(item => item.bucket === "verified").length;
  return [
    { id: "comprehend", label: "Comprehend", state: runState === "analyzing" ? "working" : hasAnalysis ? "complete" : "waiting", summary: hasAnalysis ? "Staged evidence analyzed" : "Waiting for analysis evidence" },
    { id: "prioritize", label: "Prioritize", state: hasPriority ? "complete" : hasAnalysis ? "working" : "waiting", summary: hasPriority ? "Finding groups ranked" : "Waiting for ranked groups" },
    { id: "remediate", label: "Remediate", state: approvals ? "approval_required" : pending ? "working" : blocked && !verified ? "blocked" : verified ? "complete" : hasRemediation ? "working" : "waiting", summary: approvals ? `${approvals} awaiting approval` : verified ? `${verified} verified` : blocked ? `${blocked} blocked` : "Waiting for eligible work" },
  ];
}

function deriveRelationshipReadiness(relationships: Relationship[], items: WorkQueueItem[]) {
  const verified = new Set(items.filter(item => item.bucket === "verified").flatMap(item => [item.id, item.stagedCiId, item.ci.name]));
  const ready = relationships.filter(relationship =>
    (verified.has(relationship.source) || Boolean(relationship.sourceLabel && verified.has(relationship.sourceLabel)))
    && (verified.has(relationship.target) || Boolean(relationship.targetLabel && verified.has(relationship.targetLabel))),
  ).length;
  return { total: relationships.length, ready, blocked: Math.max(0, relationships.length - ready) };
}

function phaseForEvent(event: TimelineEvent): CprPhaseId {
  const text = `${event.source} ${event.name} ${event.reasoning}`.toLowerCase();
  if (/simulat|approv|execut|verif|remediat/.test(text)) return "remediate";
  if (/priorit|rank|group|health impact/.test(text)) return "prioritize";
  return "comprehend";
}

function inferDecisionSource(value: string): AgentDecisionSource {
  const normalized = value.toLowerCase();
  if (/fallback|model unavailable/.test(normalized)) return "deterministic_fallback";
  if (/model|llm|mara decided|thought:/.test(normalized)) return "model";
  return "deterministic";
}

function failureCategory(value: string): FailureCategory {
  const normalized = value.toLowerCase();
  if (/class[_ -]?alias|unsupported class|invalid proposed.*class|class mismatch|linux srv/.test(normalized)) return "class_alias";
  if (/missing.*(?:serial|identifier|name|fqdn)|no identifier/.test(normalized)) return "missing_identifier";
  if (/duplicate|multiple candidate|hostname collision|ambiguous identity/.test(normalized)) return "duplicate_identity";
  if (/stale|fingerprint/.test(normalized)) return "stale_simulation";
  if (/forbidden|unauthori|role|ownership/.test(normalized)) return "authorization";
  if (/payload|malformed|invalid attribute|invalid request/.test(normalized)) return "invalid_payload";
  if (/verification|read-back|mismatch/.test(normalized)) return "verification";
  return "unknown";
}

function failureField(value: string) {
  return value.toLowerCase().match(/\b(serial_number|serial|fqdn|host_name|hostname|ip_address|class)\b/)?.[1];
}

function findHealthFix(category: FailureCategory, fixes: HealthFix[]) {
  const patterns: Partial<Record<FailureCategory, RegExp>> = {
    class_alias: /class|alias|mapping/i,
    missing_identifier: /missing|identifier|incomplete/i,
    duplicate_identity: /duplicate|collision|identity/i,
    stale_simulation: /stale|simulation/i,
    verification: /verify|correctness/i,
  };
  const pattern = patterns[category];
  return pattern ? fixes.find(fix => pattern.test(`${fix.title} ${fix.description} ${fix.tool}`)) : undefined;
}

function groupTitle(category: FailureCategory, fallback: string) {
  const labels: Record<FailureCategory, string> = {
    class_alias: "Normalize known class aliases",
    missing_identifier: "Complete missing identity evidence",
    duplicate_identity: "Resolve ambiguous identity candidates",
    stale_simulation: "Refresh stale simulations",
    authorization: "Resolve authorization blockers",
    invalid_payload: "Correct invalid staged payloads",
    verification: "Investigate verification mismatches",
    unknown: "Investigate unclassified failures",
  };
  return labels[category] || compact(fallback);
}

function blockerFor(category: FailureCategory, items: WorkQueueItem[]) {
  if (category === "class_alias") return undefined;
  if (category === "missing_identifier") return "Source data correction or stronger identity evidence is required.";
  if (category === "duplicate_identity") return "Multiple identity candidates require human review.";
  if (category === "stale_simulation") return "ServiceNow must rebuild a fresh simulation before execution.";
  if (category === "authorization") return "The authenticated ServiceNow user lacks required authority or ownership.";
  return items[0]?.reason || "No allowlisted retry strategy is available.";
}

function priorityFor(category: FailureCategory, items: WorkQueueItem[], index: number) {
  const base: Record<FailureCategory, number> = { authorization: 98, verification: 96, stale_simulation: 92, duplicate_identity: 88, missing_identifier: 84, class_alias: 78, invalid_payload: 74, unknown: 60 };
  return Math.min(100, base[category] + Math.min(5, items.length) - Math.min(4, index));
}

function severityImpact(value?: string) {
  const normalized = value?.toLowerCase();
  return normalized === "critical" ? 6 : normalized === "high" ? 4 : normalized === "medium" ? 2 : 1;
}

function firstMetric(events: TimelineEvent[], key: string) {
  for (const event of events) {
    const value = metric(event.reasoning, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function lastMetric(events: TimelineEvent[], key: string) {
  for (const event of [...events].reverse()) {
    const value = metric(event.reasoning, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function metric(value: string, key: string) {
  const match = value.match(new RegExp(`(?:\\"${key}\\"\\s*:\\s*|\\b${key}=)(-?\\d+(?:\\.\\d+)?)`, "i"));
  return match ? Number(match[1]) : undefined;
}

function compact(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, round(value)));
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
