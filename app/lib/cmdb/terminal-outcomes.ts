import type { TimelineEvent } from "../../cmdb-data";
import type { WorkQueueItem, WorkQueueSummary } from "./work-queue";

export type TerminalOperation = "INSERT" | "UPDATE" | "NO_CHANGE";

export type CorrelatedVerifiedOutcome = {
  stagedCiId: string;
  operation: TerminalOperation;
  targetCiSysId: string;
  targetTable: string;
  executionCorrelation?: string;
  executionEventId?: string;
  verificationEventId: string;
  kind: "mutation" | "reconciliation";
};

export type ServiceNowDestinationSummary = {
  table: string;
  total: number;
  inserted: number;
  updated: number;
  reconciled: number;
};

export type LiveDemoReadinessReport = {
  ready: boolean;
  expectedTotal: number;
  stagedTotal: number;
  terminalTotal: number;
  mutationTotal: number;
  reconciliationTotal: number;
  operationCounts: Record<TerminalOperation, number>;
  lifecycleCounts: Record<string, number>;
  targetBindings: number;
  distinctInsertTargets: number;
  failures: string[];
  outcomes: CorrelatedVerifiedOutcome[];
};

type EvidenceDetail = {
  action?: string;
  staged_ci_id?: string;
  correlation_id?: string;
  operation?: string;
  target_ci_sys_id?: string;
  execution_correlation_id?: string;
  execution_event_id?: string;
  approval_event_id?: string;
  simulation_correlation_id?: string;
  simulation_fingerprint?: string;
  decision?: string;
  policy_approved?: boolean;
  simulation_matched_ci?: string;
  proposed_class?: string;
  class_policy_version?: string;
  evidence_version?: string;
};

export function deriveCorrelatedVerifiedOutcomes(
  queueItems: WorkQueueItem[],
  timeline: TimelineEvent[],
): CorrelatedVerifiedOutcome[] {
  const eventsByStagedId = new Map<string, Array<{ event: TimelineEvent; detail: EvidenceDetail }>>();
  for (const event of timeline) {
    const detail = evidenceDetail(event.reasoning);
    const stagedCiId = canonicalSysId(detail?.staged_ci_id);
    if (!detail || !stagedCiId) continue;
    const events = eventsByStagedId.get(stagedCiId) ?? [];
    events.push({ event, detail });
    eventsByStagedId.set(stagedCiId, events);
  }

  const outcomes: CorrelatedVerifiedOutcome[] = [];
  for (const item of queueItems) {
    const stagedCiId = canonicalSysId(item.stagedCiId);
    if (!stagedCiId) continue;
    const events = (eventsByStagedId.get(stagedCiId) ?? []).sort((left, right) =>
      eventFreshness(right.event) - eventFreshness(left.event) || right.event.seq - left.event.seq,
    );
    const terminals = events.filter(({ detail }) =>
      detail.action === "verification_passed" || detail.action === "reconciliation_passed",
    );
    if (terminals.length !== 1) continue;
    const terminal = terminals[0];
    if (!terminal) continue;
    const operation = terminalOperation(terminal.detail.operation);
    const targetCiSysId = canonicalSysId(terminal.detail.target_ci_sys_id);
    if (!operation || !targetCiSysId) continue;

    if (terminal.detail.action === "reconciliation_passed") {
      if (operation !== "NO_CHANGE") continue;
      const simulationCorrelation = token(terminal.detail.simulation_correlation_id);
      const simulationFingerprint = canonicalFingerprint(terminal.detail.simulation_fingerprint);
      const proposedClass = className(terminal.detail.proposed_class);
      if (
        !simulationCorrelation ||
        !simulationFingerprint ||
        !proposedClass ||
        proposedClass !== className(item.ci.className) ||
        terminal.detail.evidence_version !== "keystone.simulation.v2" ||
        terminal.detail.class_policy_version !== "servicenow-allowlisted-class-v1"
      ) continue;
      const simulation = events.find(({ detail }) =>
        detail.action === "ire_simulation_completed" &&
        terminalOperation(detail.operation) === "NO_CHANGE" &&
        canonicalSysId(detail.simulation_matched_ci) === targetCiSysId &&
        token(detail.simulation_correlation_id ?? detail.correlation_id) === simulationCorrelation &&
        canonicalFingerprint(detail.simulation_fingerprint) === simulationFingerprint &&
        className(detail.proposed_class) === proposedClass &&
        detail.evidence_version === terminal.detail.evidence_version &&
        detail.class_policy_version === terminal.detail.class_policy_version,
      );
      if (!simulation) continue;
      outcomes.push({
        stagedCiId,
        operation,
        targetCiSysId,
        targetTable: proposedClass,
        verificationEventId: terminal.event.id,
        kind: "reconciliation",
      });
      continue;
    }

    if (operation === "NO_CHANGE") continue;
    const executionCorrelation = token(terminal.detail.execution_correlation_id ?? terminal.detail.execution_event_id);
    const approvalEventId = canonicalSysId(terminal.detail.approval_event_id);
    const simulationCorrelation = token(terminal.detail.simulation_correlation_id);
    const simulationFingerprint = canonicalFingerprint(terminal.detail.simulation_fingerprint);
    if (!executionCorrelation || !approvalEventId || !simulationCorrelation || !simulationFingerprint) continue;
    const approval = events.find(({ event, detail }) =>
      canonicalSysId(event.id) === approvalEventId &&
      detail.action === "approval_recorded" &&
      detail.decision === "approved" &&
      detail.policy_approved === false &&
      token(detail.simulation_correlation_id) === simulationCorrelation &&
      canonicalFingerprint(detail.simulation_fingerprint) === simulationFingerprint,
    );
    if (!approval) continue;
    const execution = events.find(({ detail }) =>
      detail.action === "ire_execution_completed" &&
      canonicalSysId(detail.approval_event_id) === approvalEventId &&
      token(detail.simulation_correlation_id) === simulationCorrelation &&
      canonicalFingerprint(detail.simulation_fingerprint) === simulationFingerprint &&
      token(detail.execution_correlation_id ?? detail.execution_event_id) === executionCorrelation &&
      canonicalSysId(detail.target_ci_sys_id) === targetCiSysId &&
      terminalOperation(detail.operation) === operation,
    );
    if (!execution) continue;
    const simulation = events.find(({ detail }) =>
      detail.action === "ire_simulation_completed" &&
      token(detail.simulation_correlation_id ?? detail.correlation_id) === simulationCorrelation &&
      canonicalFingerprint(detail.simulation_fingerprint) === simulationFingerprint,
    );
    const targetTable = className(simulation?.detail.proposed_class) ??
      className(execution.detail.proposed_class) ??
      className(terminal.detail.proposed_class) ??
      className(execution.event.className) ??
      className(terminal.event.className) ??
      className(item.ci.className);
    if (!targetTable) continue;
    outcomes.push({
      stagedCiId,
      operation,
      targetCiSysId,
      targetTable,
      executionCorrelation,
      executionEventId: execution.event.id,
      verificationEventId: terminal.event.id,
      kind: "mutation",
    });
  }
  return outcomes.sort((left, right) => left.stagedCiId.localeCompare(right.stagedCiId));
}

export function summarizeServiceNowDestinations(outcomes: CorrelatedVerifiedOutcome[]): ServiceNowDestinationSummary[] {
  const destinations = new Map<string, ServiceNowDestinationSummary>();
  for (const outcome of outcomes) {
    const current = destinations.get(outcome.targetTable) ?? {
      table: outcome.targetTable,
      total: 0,
      inserted: 0,
      updated: 0,
      reconciled: 0,
    };
    current.total++;
    if (outcome.operation === "INSERT") current.inserted++;
    else if (outcome.operation === "UPDATE") current.updated++;
    else current.reconciled++;
    destinations.set(outcome.targetTable, current);
  }
  return [...destinations.values()].sort((left, right) => right.total - left.total || left.table.localeCompare(right.table));
}

export function evaluateLiveDemoReadiness(input: {
  queue: WorkQueueSummary;
  timeline: TimelineEvent[];
  expectedTotal: number;
  expectedOperations?: Partial<Record<TerminalOperation, number>>;
}): LiveDemoReadinessReport {
  const outcomes = deriveCorrelatedVerifiedOutcomes(input.queue.items, input.timeline);
  const operationCounts: Record<TerminalOperation, number> = { INSERT: 0, UPDATE: 0, NO_CHANGE: 0 };
  for (const outcome of outcomes) operationCounts[outcome.operation]++;
  const lifecycleCounts: Record<string, number> = {};
  for (const item of input.queue.items) lifecycleCounts[item.bucket] = (lifecycleCounts[item.bucket] ?? 0) + 1;
  const failures: string[] = [];
  const stagedTotal = input.queue.items.length;
  const mutationTotal = outcomes.filter(outcome => outcome.kind === "mutation").length;
  const reconciliationTotal = outcomes.filter(outcome => outcome.kind === "reconciliation").length;
  const insertTargets = outcomes.filter(outcome => outcome.operation === "INSERT").map(outcome => outcome.targetCiSysId);
  const distinctInsertTargets = new Set(insertTargets).size;
  if (stagedTotal !== input.expectedTotal) failures.push(`Expected ${input.expectedTotal} staged records; found ${stagedTotal}.`);
  if (outcomes.length !== input.expectedTotal) failures.push(`Expected ${input.expectedTotal} correlated terminal outcomes; found ${outcomes.length}.`);
  const nonterminal = input.queue.items.filter(item => item.bucket !== "verified");
  if (nonterminal.length) failures.push(`${nonterminal.length} record(s) still have nonterminal lifecycle work.`);
  if (distinctInsertTargets !== insertTargets.length) failures.push("INSERT outcomes do not have distinct target bindings.");
  for (const [operation, expected] of Object.entries(input.expectedOperations ?? {})) {
    if (expected === undefined) continue;
    const actual = operationCounts[operation as TerminalOperation];
    if (actual !== expected) failures.push(`Expected ${expected} ${operation} outcome(s); found ${actual}.`);
  }
  return {
    ready: failures.length === 0,
    expectedTotal: input.expectedTotal,
    stagedTotal,
    terminalTotal: outcomes.length,
    mutationTotal,
    reconciliationTotal,
    operationCounts,
    lifecycleCounts,
    targetBindings: outcomes.length,
    distinctInsertTargets,
    failures,
    outcomes,
  };
}

export function readinessSignature(report: LiveDemoReadinessReport) {
  return JSON.stringify({
    stagedTotal: report.stagedTotal,
    terminalTotal: report.terminalTotal,
    operationCounts: report.operationCounts,
    lifecycleCounts: report.lifecycleCounts,
    outcomes: report.outcomes.map(outcome => [outcome.stagedCiId, outcome.operation, outcome.targetCiSysId, outcome.targetTable, outcome.kind]),
  });
}

function evidenceDetail(value: string): EvidenceDetail | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as EvidenceDetail;
    return typeof parsed.action === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function terminalOperation(value: unknown): TerminalOperation | undefined {
  const operation = typeof value === "string" ? value.trim().toUpperCase() : "";
  return operation === "INSERT" || operation === "UPDATE" || operation === "NO_CHANGE" ? operation : undefined;
}

function canonicalSysId(value: unknown) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{32}$/.test(candidate) ? candidate : undefined;
}

function token(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9:._-]{1,180}$/.test(value.trim()) ? value.trim() : undefined;
}

function canonicalFingerprint(value: unknown) {
  const candidate = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[0-9A-F]{64}$/.test(candidate) ? candidate : undefined;
}

function className(value: unknown) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[a-z][a-z0-9_]{2,79}$/.test(candidate) ? candidate : undefined;
}

function eventFreshness(event: TimelineEvent) {
  const parsed = Date.parse((event.time || "").trim().replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : event.seq;
}
