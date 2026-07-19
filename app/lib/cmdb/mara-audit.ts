import type { ConfigurationItem, TimelineEvent } from "../../cmdb-data";
import {
  arrayFromPayload,
  objectFromPayload,
  record,
  referenceId,
  referenceLabel,
  text,
} from "./comprehend-adapter";

export type MaraCheckStatus = "pass" | "warn" | "fail" | "unverifiable";

export type MaraCheck = {
  id: string;
  title: string;
  status: MaraCheckStatus;
  summary: string;
  evidence: string[];
};

export type MaraActorRecord = {
  actor: string;
  role: string;
  events: number;
  actions: number;
  observations: number;
  errors: number;
  lastSeq: number;
  lastDetail: string;
};

export type MaraReasoningKind = "decision" | "observation" | "result" | "error" | "event";

export type MaraReasoningStep = {
  id: string;
  seq: number;
  actor: string;
  role: string;
  kind: MaraReasoningKind;
  summary: string;
  action?: string;
  handoffFrom?: string;
};

export type MaraServiceNowStatus = "waiting" | "working" | "approval_required" | "complete" | "blocked";

export type MaraServiceNowSupervisor = {
  status: MaraServiceNowStatus;
  headline: string;
  summary: string;
  nextAction?: string;
  events: MaraReasoningStep[];
};

export type MaraFinding = {
  id: string;
  number: string;
  type: string;
  severity: string;
  stagedCiId?: string;
  stagedCiLabel?: string;
  recommendation: string;
};

export type MaraReviewDecision = {
  id: string;
  decision: string;
  findingLabel: string;
  decidedBy: string;
  rationale: string;
};

export type MaraRunRecord = {
  id: string;
  number: string;
  state: string;
  sourceSystem: string;
  started: string;
  summary: string;
};

export type MaraAuditInput = {
  timeline: TimelineEvent[];
  cis: ConfigurationItem[] | null;
  findings: MaraFinding[] | null;
  reviews: MaraReviewDecision[] | null;
  run: MaraRunRecord | null;
};

const PLANNER_SCANS = ["scan_classes", "scan_attributes", "scan_duplicates", "scan_orphans"];
const ACTION_ACTORS: Record<string, string> = {
  get_run_stats: "Router",
  scan_classes: "Atlas",
  scan_attributes: "Atlas",
  scan_duplicates: "Scout",
  scan_orphans: "Weaver",
  apply_confidence_gate: "Sentry",
  write_summary: "Ledger",
  finish: "Ledger",
};
const SPECIALISTS: Record<string, string> = {
  Comprehend: "Run orchestrator",
  Router: "Planner",
  Atlas: "Class & attribute analysis",
  Scout: "Duplicate detection",
  Weaver: "Relationship coverage",
  Sentry: "Deterministic confidence gate",
  Ledger: "Audit ledger writer",
  Mara: "LLM agent supervisor",
};
const KNOWN_RUN_STATES = ["draft", "ingesting", "analyzing", "simulated", "awaiting_approval", "committing", "complete", "failed"];

export function normalizeMaraFindings(payload: unknown): MaraFinding[] {
  return arrayFromPayload(payload, ["findings"]).map((item, index) => {
    const row = record(item);
    return {
      id: text(row.sys_id ?? row.id, `finding-${index + 1}`),
      number: text(row.number, `DWF-${index + 1}`),
      type: text(row.type, "data_quality"),
      severity: text(row.severity, "info").toLowerCase(),
      stagedCiId: referenceId(row.staged_ci),
      stagedCiLabel: referenceLabel(row.staged_ci),
      recommendation: text(row.recommendation),
    };
  });
}

export function normalizeMaraReviews(payload: unknown): MaraReviewDecision[] {
  return arrayFromPayload(payload, ["reviews", "decisions"]).map((item, index) => {
    const row = record(item);
    return {
      id: text(row.sys_id ?? row.id, `review-${index + 1}`),
      decision: text(row.decision, "deferred").toLowerCase(),
      findingLabel: text(referenceLabel(row.finding), "Unlinked finding"),
      decidedBy: text(referenceLabel(row.decided_by), "Policy"),
      rationale: text(row.rationale),
    };
  });
}

export function normalizeMaraRun(payload: unknown): MaraRunRecord | null {
  const row = objectFromPayload(payload, ["run", "result", "data"]);
  const id = text(row.sys_id ?? row.id);
  if (!id) return null;
  return {
    id,
    number: text(row.number, id.slice(0, 8).toUpperCase()),
    state: text(row.state, "unknown").toLowerCase(),
    sourceSystem: text(row.source_system, "unknown"),
    started: text(row.started),
    summary: text(row.summary),
  };
}

export function runMaraAudit(input: MaraAuditInput): { checks: MaraCheck[]; actors: MaraActorRecord[] } {
  const ordered = [...input.timeline].sort((a, b) => a.seq - b.seq);
  return {
    checks: [
      sequenceCheck(ordered),
      plannerFlowCheck(ordered),
      specialistCoverageCheck(ordered),
      duplicateActionCheck(ordered),
      errorCheck(ordered),
      gateConsistencyCheck(ordered, input.cis),
      writeContainmentCheck(ordered),
      findingsLinkageCheck(input.cis, input.findings),
      reviewDecisionCheck(ordered, input.reviews),
      runStateCheck(ordered, input.run),
    ],
    actors: actorRecords(ordered),
  };
}

export function buildMaraReasoningSteps(timeline: TimelineEvent[]): MaraReasoningStep[] {
  const ordered = [...timeline].sort((a, b) => a.seq - b.seq);
  let previousActor = "";
  return ordered.map(event => {
    const actor = effectiveActor(event);
    const action = actionOf(event);
    const thought = topLevelThought(event.reasoning);
    const observation = topLevelObservation(event.reasoning);
    const kind: MaraReasoningKind = isErrorEvent(event)
      ? "error"
      : observation
        ? "observation"
        : isResultDetail(event.reasoning)
          ? "result"
          : action
            ? "decision"
            : "event";
    const summary = thought || (observation ? observationSummary(observation) : compactDetail(event.reasoning));
    const step: MaraReasoningStep = {
      id: event.id,
      seq: event.seq,
      actor,
      role: SPECIALISTS[actor] ?? "Recorded agent",
      kind,
      summary,
      ...(action ? { action } : {}),
      ...(previousActor && previousActor !== actor ? { handoffFrom: previousActor } : {}),
    };
    previousActor = actor;
    return step;
  });
}

export function deriveMaraServiceNowSupervisor(timeline: TimelineEvent[]): MaraServiceNowSupervisor {
  const events = buildMaraReasoningSteps(timeline).filter(step => step.actor === "Mara");
  const latest = events.at(-1);
  if (!latest) {
    return {
      status: "waiting",
      headline: "Waiting for the ServiceNow Mara agent",
      summary: "No run-scoped Mara Event Ledger entries have been recorded yet.",
      events,
    };
  }

  const evidence = `${latest.kind} ${latest.summary} ${latest.action ?? ""}`.toLowerCase();
  const status: MaraServiceNowStatus = latest.kind === "error" || /blocked|cannot continue|no safe action/.test(evidence)
    ? "blocked"
    : /approval|required human|governance boundary|held for review/.test(evidence)
      ? "approval_required"
      : latest.kind === "result" || /completed|complete|finished|solution ready/.test(evidence)
        ? "complete"
        : "working";
  const headline = status === "approval_required"
    ? "Mara reached a governance boundary"
    : status === "complete"
      ? "Mara completed the supervisor analysis"
      : status === "blocked"
        ? "Mara stopped on an unresolved blocker"
        : "Mara is coordinating the next safe action";

  return {
    status,
    headline,
    summary: latest.summary,
    ...(latest.action ? { nextAction: latest.action } : {}),
    events,
  };
}

function actionOf(event: TimelineEvent) {
  const detail = event.reasoning.trim();
  if (!/^(Thought|Handoff|Action):/i.test(detail)) return undefined;
  return detail.match(/(?:^|\|\s*)Action:\s*([a-z0-9_]+)/i)?.[1]?.toLowerCase();
}

function plannerActionOf(event: TimelineEvent) {
  if (!/^Thought:/i.test(event.reasoning.trim())) return undefined;
  return actionOf(event);
}

function isObservation(event: TimelineEvent) {
  return Boolean(topLevelObservation(event.reasoning));
}

function isErrorEvent(event: TimelineEvent) {
  return event.status === "error" || /^(error|failure|exception)\s*:/i.test(event.reasoning.trim());
}

function firstSeqByAction(timeline: TimelineEvent[]) {
  const seqs = new Map<string, number>();
  for (const event of timeline) {
    const action = actionOf(event);
    if (action && !seqs.has(action)) seqs.set(action, event.seq);
  }
  return seqs;
}

function gateEvent(timeline: TimelineEvent[]) {
  return timeline.find(event =>
    actionOf(event) === "apply_confidence_gate" ||
    (effectiveActor(event) === "Sentry" && isObservation(event) && /confidence gate/i.test(event.reasoning)),
  );
}

function gateResult(timeline: TimelineEvent[]) {
  for (const event of timeline) {
    if (actionOf(event) !== "apply_confidence_gate" && !/confidence gate applied/i.test(event.reasoning)) continue;
    const held = namedCount(event.reasoning, "held");
    const cleared = namedCount(event.reasoning, "cleared");
    if (held !== undefined && cleared !== undefined) return { seq: event.seq, held, cleared };
  }
  return undefined;
}

function namedCount(detail: string, label: "held" | "cleared") {
  const match =
    detail.match(new RegExp(`\\b(\\d+)\\s+(?:records?\\s+)?${label}\\b`, "i")) ??
    detail.match(new RegExp(`\\b${label}\\s*[:=]?\\s*(\\d+)\\b`, "i"));
  return match ? Number(match[1]) : undefined;
}

function check(id: string, title: string, status: MaraCheckStatus, summary: string, evidence: string[] = []): MaraCheck {
  return { id, title, status, summary, evidence };
}

function sequenceCheck(timeline: TimelineEvent[]): MaraCheck {
  const title = "Ledger sequence integrity";
  if (!timeline.length) return check("sequence", title, "unverifiable", "No Event Ledger entries were recorded for this run.");
  const seqs = timeline.map(event => event.seq);
  const unique = new Set(seqs);
  const duplicates = [...new Set(seqs.filter((seq, index) => seqs.indexOf(seq) !== index))];
  const gaps: number[] = [];
  for (let seq = Math.min(...seqs); seq <= Math.max(...seqs); seq++) if (!unique.has(seq)) gaps.push(seq);
  if (!duplicates.length && !gaps.length) {
    return check("sequence", title, "pass", `Sequences ${Math.min(...seqs)}–${Math.max(...seqs)} are unique and contiguous across ${timeline.length} entries.`);
  }
  return check("sequence", title, "fail", "The Event Ledger sequence is broken.", [
    ...(duplicates.length ? [`Duplicate sequence numbers: ${duplicates.join(", ")}`] : []),
    ...(gaps.length ? [`Missing sequence numbers: ${gaps.join(", ")}`] : []),
  ]);
}

function plannerFlowCheck(timeline: TimelineEvent[]): MaraCheck {
  const title = "Required Comprehend tool order";
  if (!timeline.length) return check("flow", title, "unverifiable", "No Event Ledger entries were recorded for this run.");
  const seqs = firstSeqByAction(timeline);
  const gate = gateEvent(timeline);
  const statsSeq = seqs.get("get_run_stats");
  const scanSeqs = PLANNER_SCANS.map(scan => [scan, seqs.get(scan)] as const);
  const missingScans = scanSeqs.filter(([, seq]) => seq === undefined).map(([scan]) => scan);
  const summarySeq = seqs.get("write_summary") ?? timeline.find(event => /executive summary/i.test(event.reasoning))?.seq;

  const issues: string[] = [];
  if (statsSeq === undefined) issues.push("get_run_stats was never recorded.");
  if (missingScans.length) issues.push(`Missing specialist scans: ${missingScans.join(", ")}.`);
  if (!gate) issues.push("No confidence-gate event was recorded.");
  if (summarySeq === undefined) issues.push("No summary event was recorded.");
  const recordedScanSeqs = scanSeqs.flatMap(([, seq]) => seq === undefined ? [] : [seq]);
  if (statsSeq !== undefined && recordedScanSeqs.some(seq => seq < statsSeq)) issues.push("A specialist scan ran before get_run_stats.");
  if (gate && recordedScanSeqs.some(seq => seq > gate.seq)) issues.push("A specialist scan ran after the confidence gate.");
  if (gate && summarySeq !== undefined && summarySeq < gate.seq) issues.push("The summary was written before the confidence gate.");

  if (!issues.length) return check("flow", title, "pass", "Run stats, all four specialist scans, the confidence gate, and the summary ran in the required order.");
  return check("flow", title, "fail", "The recorded run deviates from the required Comprehend sequence.", issues);
}

function specialistCoverageCheck(timeline: TimelineEvent[]): MaraCheck {
  const title = "Specialist coverage";
  if (!timeline.length) return check("coverage", title, "unverifiable", "No Event Ledger entries were recorded for this run.");
  const seen = new Set(timeline.map(effectiveActor));
  const required = ["Router", "Atlas", "Scout", "Weaver", "Sentry", "Ledger"];
  const missing = required.filter(actor => !seen.has(actor));
  if (!missing.length) return check("coverage", title, "pass", "All six specialists left evidence in this run's ledger.");
  return check("coverage", title, "fail", "Specialists are missing from the recorded evidence.", [`No ledger events from: ${missing.join(", ")}.`]);
}

function duplicateActionCheck(timeline: TimelineEvent[]): MaraCheck {
  const title = "Duplicate planner actions";
  const seqsPerAction = new Map<string, number[]>();
  for (const event of timeline) {
    const action = plannerActionOf(event);
    if (action) seqsPerAction.set(action, [...(seqsPerAction.get(action) ?? []), event.seq]);
  }
  if (!seqsPerAction.size) return check("duplicates", title, "unverifiable", "No planner actions were recorded in the Event Ledger.");
  const repeated = [...seqsPerAction.entries()].filter(([, seqs]) => seqs.length > 1);
  if (!repeated.length) return check("duplicates", title, "pass", `Each of the ${seqsPerAction.size} recorded planner actions ran exactly once.`);
  return check("duplicates", title, "warn", "Some planner actions were recorded more than once — verify whether deterministic recovery re-ran them.",
    repeated.map(([action, seqs]) => `${action} at sequences ${seqs.join(", ")}`));
}

function errorCheck(timeline: TimelineEvent[]): MaraCheck {
  const title = "Recorded errors";
  if (!timeline.length) return check("errors", title, "unverifiable", "No Event Ledger entries were recorded for this run.");
  const errors = timeline.filter(isErrorEvent);
  if (!errors.length) return check("errors", title, "pass", "No error events appear in this run's ledger.");
  return check("errors", title, "fail", `${errors.length} error ${errors.length === 1 ? "event was" : "events were"} recorded.`,
    errors.map(event => `#${event.seq} ${event.source}: ${event.reasoning}`));
}

function gateConsistencyCheck(timeline: TimelineEvent[], cis: ConfigurationItem[] | null): MaraCheck {
  const title = "Gate result vs staged records";
  const gate = gateResult(timeline);
  if (!gate) return check("gate", title, "unverifiable", "No gate event in the ledger reports held and cleared counts.");
  if (cis === null) return check("gate", title, "unverifiable", "Staged CI data is unavailable, so the gate counts cannot be cross-checked.");
  const actualCleared = cis.filter(ci => ci.status === "live").length;
  const actualHeld = cis.length - actualCleared;
  if (gate.held === actualHeld && gate.cleared === actualCleared) {
    return check("gate", title, "pass", `Sentry reported ${gate.held} held / ${gate.cleared} cleared, matching the ${cis.length} staged records.`);
  }
  return check("gate", title, "fail", "Sentry's recorded gate result does not match the staged records.", [
    `Ledger gate event #${gate.seq}: ${gate.held} held, ${gate.cleared} cleared.`,
    `Staged CI records: ${actualHeld} held, ${actualCleared} cleared.`,
  ]);
}

function writeContainmentCheck(timeline: TimelineEvent[]): MaraCheck {
  const title = "Write containment";
  if (!timeline.length) return check("containment", title, "unverifiable", "No Event Ledger entries were recorded for this run.");
  const committed = timeline.filter(event => event.step === 6);
  const approved = timeline.filter(event => event.step === 5);
  if (!committed.length) return check("containment", title, "pass", "No CMDB commit events were recorded — this run has not written outside IRE governance.");
  if (!approved.length) {
    return check("containment", title, "fail", "Commit events were recorded without any preceding approval or simulation evidence.",
      committed.map(event => `#${event.seq} ${event.source}: ${event.reasoning}`));
  }
  return check("containment", title, "pass", `${committed.length} commit ${committed.length === 1 ? "event is" : "events are"} preceded by approval evidence.`);
}

function findingsLinkageCheck(cis: ConfigurationItem[] | null, findings: MaraFinding[] | null): MaraCheck {
  const title = "Held records have findings";
  if (findings === null) return check("findings", title, "unverifiable", "The bridge does not expose /findings yet. Deploy the findings resource to verify.");
  if (cis === null) return check("findings", title, "unverifiable", "Staged CI data is unavailable, so findings cannot be linked to held records.");
  const conflicted = cis.filter(ci => ci.status === "review");
  const uncovered = conflicted.filter(ci => !findings.some(finding => finding.stagedCiId === ci.id));
  if (!conflicted.length) return check("findings", title, "pass", `No staged records are in conflict; ${findings.length} findings on file.`);
  if (!uncovered.length) return check("findings", title, "pass", `All ${conflicted.length} conflicted records are covered by at least one of ${findings.length} findings.`);
  return check("findings", title, "fail", "Conflicted records lack a supporting finding.", uncovered.map(ci => `${ci.name} (${ci.id})`));
}

function reviewDecisionCheck(timeline: TimelineEvent[], reviews: MaraReviewDecision[] | null): MaraCheck {
  const title = "Approvals backed by review decisions";
  if (reviews === null) return check("reviews", title, "unverifiable", "The bridge does not expose /reviews yet. Deploy the reviews resource to verify.");
  const approvals = timeline.filter(event => event.step === 5 && /approv/i.test(`${event.name} ${event.reasoning}`));
  if (!approvals.length) return check("reviews", title, "pass", `No approval events recorded; ${reviews.length} review decisions on file.`);
  if (reviews.length) return check("reviews", title, "pass", `${approvals.length} approval ${approvals.length === 1 ? "event is" : "events are"} backed by ${reviews.length} review decisions.`);
  return check("reviews", title, "fail", "Approval events were recorded without any review decision on file.",
    approvals.map(event => `#${event.seq} ${event.source}: ${event.reasoning}`));
}

function runStateCheck(timeline: TimelineEvent[], run: MaraRunRecord | null): MaraCheck {
  const title = "Run state consistency";
  if (run === null) return check("state", title, "unverifiable", "The bridge does not expose /run yet. Deploy the run resource to verify.");
  if (!KNOWN_RUN_STATES.includes(run.state)) {
    return check("state", title, "warn", `Run ${run.number} reports state "${run.state}", which is not a known migration-run choice.`);
  }
  const hasGate = Boolean(gateEvent(timeline));
  const hasApproval = timeline.some(event => event.step === 5 && /approv/i.test(`${event.name} ${event.reasoning}`));
  const issues: string[] = [];
  if (["awaiting_approval", "committing", "complete"].includes(run.state) && !hasGate) {
    issues.push(`State "${run.state}" requires confidence-gate evidence, but none was recorded.`);
  }
  if (["committing", "complete"].includes(run.state) && !hasApproval) {
    issues.push(`State "${run.state}" requires approval evidence, but none was recorded.`);
  }
  if (issues.length) return check("state", title, "fail", `Run ${run.number} state "${run.state}" is inconsistent with the ledger.`, issues);
  return check("state", title, "pass", `Run ${run.number} state "${run.state}" is consistent with the recorded ledger evidence.`);
}

function actorRecords(timeline: TimelineEvent[]): MaraActorRecord[] {
  const byActor = new Map<string, MaraActorRecord>();
  for (const event of timeline) {
    const actor = effectiveActor(event);
    const current = byActor.get(actor) ?? {
      actor,
      role: SPECIALISTS[actor] ?? "Recorded actor",
      events: 0,
      actions: 0,
      observations: 0,
      errors: 0,
      lastSeq: 0,
      lastDetail: "",
    };
    current.events += 1;
    if (plannerActionOf(event)) current.actions += 1;
    else if (isObservation(event)) current.observations += 1;
    if (isErrorEvent(event)) current.errors += 1;
    if (event.seq >= current.lastSeq) {
      current.lastSeq = event.seq;
      current.lastDetail = event.reasoning;
    }
    byActor.set(actor, current);
  }
  const order = Object.keys(SPECIALISTS);
  return [...byActor.values()].sort((a, b) => {
    const left = order.indexOf(a.actor);
    const right = order.indexOf(b.actor);
    if (left < 0 && right < 0) return a.actor.localeCompare(b.actor);
    if (left < 0) return 1;
    if (right < 0) return -1;
    return left - right;
  });
}

function effectiveActor(event: TimelineEvent): string {
  const recorded = event.source.trim();
  const action = actionOf(event);
  if (recorded && recorded.toLowerCase() !== "comprehend") return recorded;
  if (action && ACTION_ACTORS[action]) return ACTION_ACTORS[action];
  const detail = event.reasoning.toLowerCase();
  if (detail.includes("confidence gate")) return "Sentry";
  if (detail.includes("class scan") || detail.includes("attribute scan")) return "Atlas";
  if (detail.includes("duplicate scan")) return "Scout";
  if (detail.includes("orphan scan")) return "Weaver";
  if (detail.includes("executive summary") || detail.includes("planner completion")) return "Ledger";
  if (detail.includes("staged cis") || detail.includes("run stats")) return "Router";
  return recorded || "Comprehend";
}

function compactDetail(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 320 ? `${normalized.slice(0, 317)}...` : normalized;
}

function topLevelThought(value: string) {
  return value.trim().match(/^Thought:\s*(.*?)(?:\s*\|\s*Action:|$)/i)?.[1]?.trim();
}

function topLevelObservation(value: string) {
  return value.trim().match(/^Observation:\s*([\s\S]*)$/i)?.[1]?.trim();
}

function isResultDetail(value: string) {
  return /\b(?:analysis|mara)\s+completed\b|\bverified\b|\bfinished\b|summary finding written/i.test(value);
}

function observationSummary(value: string): string {
  const normalized = value.trim();
  if (!normalized.startsWith("{")) return compactDetail(normalized);

  try {
    const payload = record(JSON.parse(normalized));
    const explicit = text(payload.observation ?? payload.summary ?? payload.message).trim();
    const warning = text(payload.warning).trim();
    if (explicit) return compactDetail([explicit, warning].filter(Boolean).join(" "));

    const run = record(payload.run);
    const ciCounts = record(payload.ci_counts ?? payload.ciCounts);
    const findings = record(payload.findings);
    const reviews = record(payload.reviews);
    const ledger = record(payload.ledger);
    const parts = [
      text(run.number) && `Run ${text(run.number)} · ${text(run.state, "state unavailable")}`,
      text(ciCounts.total) && `${text(ciCounts.total)} staged CIs (${text(ciCounts.cleared, "0")} cleared, ${text(ciCounts.held, "0")} held)`,
      text(findings.total) && `${text(findings.total)} findings`,
      text(reviews.total_decisions ?? reviews.totalDecisions) && `${text(reviews.total_decisions ?? reviews.totalDecisions)} review decisions`,
      text(ledger.count) && `${text(ledger.count)} prior ledger events`,
    ].filter(Boolean);
    if (parts.length) return compactDetail(parts.join(" · "));
  } catch {
    const aggregate = aggregateObservationFromTruncatedJson(normalized);
    if (aggregate) return aggregate;
  }

  return compactDetail(normalized);
}

function aggregateObservationFromTruncatedJson(value: string) {
  const run = jsonObjectFragment(value, "run");
  const ciCounts = jsonObjectFragment(value, "ci_counts");
  const findings = jsonObjectFragment(value, "findings");
  const reviews = jsonObjectFragment(value, "reviews");
  const ledger = jsonObjectFragment(value, "ledger");
  const runNumber = jsonStringValue(run, "number");
  const runState = jsonStringValue(run, "state");
  const totalCis = jsonNumberValue(ciCounts, "total");
  const cleared = jsonNumberValue(ciCounts, "cleared");
  const held = jsonNumberValue(ciCounts, "held");
  const totalFindings = jsonNumberValue(findings, "total");
  const totalDecisions = jsonNumberValue(reviews, "total_decisions");
  const ledgerCount = jsonNumberValue(ledger, "count");
  const parts = [
    runNumber && `Run ${runNumber}${runState ? ` · ${runState}` : ""}`,
    totalCis && `${totalCis} staged CIs (${cleared ?? "0"} cleared, ${held ?? "0"} held)`,
    totalFindings && `${totalFindings} findings`,
    totalDecisions !== undefined && `${totalDecisions} review decisions`,
    ledgerCount && `${ledgerCount} prior ledger events`,
  ].filter(Boolean);
  return parts.length ? compactDetail(parts.join(" · ")) : "";
}

function jsonObjectFragment(value: string, key: string) {
  const start = value.search(new RegExp(`"${key}"\\s*:\\s*\\{`, "i"));
  if (start < 0) return "";
  const remainder = value.slice(start);
  const nextObject = remainder.slice(1).search(/,"[a-z0-9_]+":\{/i);
  return nextObject < 0 ? remainder : remainder.slice(0, nextObject + 1);
}

function jsonStringValue(value: string, key: string) {
  return value.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, "i"))?.[1];
}

function jsonNumberValue(value: string, key: string) {
  return value.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, "i"))?.[1];
}
