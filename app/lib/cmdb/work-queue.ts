import type { ConfigurationItem, HealthFix, TimelineEvent } from "../../cmdb-data";
import {
  deriveIreLifecycleState,
  type IreActionResponse,
  type IreLifecycleState,
  type IreLifecycleSnapshot,
} from "./ire";
import type { RemediationFinding, RemediationReview } from "./comprehend-adapter";

export type WorkQueueBucketId =
  | "ready_to_simulate"
  | "simulation_failed"
  | "needs_approval"
  | "ready_to_execute"
  | "needs_verification"
  | "verified"
  | "blocked";

export type WorkQueueItem = {
  id: string;
  stagedCiId: string;
  ci: ConfigurationItem;
  lifecycle: IreLifecycleState;
  bucket: WorkQueueBucketId;
  source: WorkQueueItemSource;
  reason: string;
  evidence: string[];
  latestEvent?: TimelineEvent;
  healthFix?: HealthFix;
  simulationCorrelation?: string;
  simulationFingerprint?: string;
  executionCorrelation?: string;
  targetCiSysId?: string;
  targetCiName?: string;
  finding?: RemediationFinding;
  review?: RemediationReview;
};

export type WorkQueueItemSource = "servicenow_ledger" | "servicenow_records" | "live_action" | "derived_staging" | "demo_fallback";

export type WorkQueueBucket = {
  id: WorkQueueBucketId;
  label: string;
  description: string;
  items: WorkQueueItem[];
};

export type WorkQueueSummary = {
  items: WorkQueueItem[];
  buckets: WorkQueueBucket[];
  liveBackedCount: number;
  fallbackCount: number;
};

export type WorkbenchRecord = {
  simulation?: IreActionResponse;
  approval?: IreActionResponse;
  execution?: IreActionResponse;
  verification?: IreActionResponse;
};

export const workQueueBucketDefinitions: Omit<WorkQueueBucket, "items">[] = [
  { id: "ready_to_simulate", label: "Ready to simulate", description: "Eligible staged CIs with no simulation evidence yet." },
  { id: "simulation_failed", label: "Simulation failed", description: "ServiceNow IRE simulation returned an error or failed result." },
  { id: "needs_approval", label: "Needs approval", description: "Simulation evidence exists and is waiting for review." },
  { id: "ready_to_execute", label: "Ready to execute", description: "A review decision approved the current simulation." },
  { id: "needs_verification", label: "Needs verification", description: "Execution completed and read-back is still pending." },
  { id: "verified", label: "Verified", description: "Read-back verification passed for the executed CI." },
  { id: "blocked", label: "Blocked", description: "Rejected, stale, failed verification, or staged-data blockers." },
];

export function deriveRemediationWorkQueue(input: {
  cis: ConfigurationItem[];
  timeline: TimelineEvent[];
  healthFixes?: HealthFix[];
  findings?: RemediationFinding[];
  reviews?: RemediationReview[];
  ireRecords?: Record<string, WorkbenchRecord>;
  pending?: { ciId?: string; action?: "simulate" | "approve" | "execute" | "verify" | null };
  demoFallback?: boolean;
}): WorkQueueSummary {
  const items = input.cis
    .filter(ci => ci.id || ci.stagedCiId)
    .map(ci => {
      const stagedCiId = ci.stagedCiId || ci.id;
      const workbench = input.ireRecords?.[ci.id] ?? {};
      const matchingEvents = matchingLedgerEvents(ci, input.timeline);
      const ledgerLifecycle = lifecycleFromLedger(matchingEvents);
      const actionLifecycle = lifecycleFromWorkbench(workbench, input.pending?.ciId === ci.id ? input.pending.action : null);
      const findings = relatedFindings(ci, input.findings ?? []);
      const reviews = relatedReviews(findings, input.reviews ?? []);
      const review = reviews.at(-1);
      const reviewLifecycle = review?.decision === "approved"
        ? "approved_for_execution"
        : review?.decision === "rejected"
          ? "simulated_pending_approval"
          : null;
      const persistedLifecycle = lifecycleFromPersistedEvidence(ledgerLifecycle, reviewLifecycle, matchingEvents);
      const lifecycle = actionLifecycle ?? persistedLifecycle ?? lifecycleFromStaging(ci);
      const approvalRejected = Boolean(
        (workbench.approval?.success && workbench.approval.status === "rejected") || review?.decision === "rejected",
      );
      const bucket = bucketForLifecycle(lifecycle, approvalRejected);
      const latestEvent = matchingEvents.at(-1);
      const playback = playbackIdentifiers(matchingEvents);
      const finding = findings.at(-1);
      const healthFix = relatedHealthFix(ci, input.healthFixes ?? []);
      const source: WorkQueueItem["source"] = actionLifecycle
        ? "live_action"
        : ledgerLifecycle
          ? "servicenow_ledger"
          : finding || review
            ? "servicenow_records"
          : input.demoFallback
            ? "demo_fallback"
            : "derived_staging";

      return {
        id: ci.id,
        stagedCiId,
        ci,
        lifecycle,
        bucket,
        source,
        reason: queueReason({ ci, lifecycle, bucket, latestEvent, healthFix, review, approvalRejected }),
        evidence: queueEvidence({ ci, workbench, latestEvent, healthFix, finding, review, playback }),
        latestEvent,
        healthFix,
        simulationCorrelation: workbench.simulation?.simulation_correlation_id ?? workbench.simulation?.correlation_id ?? playback.simulationCorrelation,
        simulationFingerprint: workbench.simulation?.simulation_fingerprint ?? playback.simulationFingerprint,
        executionCorrelation: workbench.execution
          ? workbench.execution.success
            ? workbench.execution.execution_correlation_id
            : undefined
          : playback.executionCorrelation,
        targetCiSysId: workbench.execution?.target_ci?.sys_id ?? playback.targetCiSysId,
        targetCiName: workbench.execution?.target_ci?.display_value ?? playback.targetCiName,
        finding,
        review,
      };
    });

  const buckets = workQueueBucketDefinitions.map(bucket => ({
    ...bucket,
    items: items.filter(item => item.bucket === bucket.id),
  }));

  return {
    items,
    buckets,
    liveBackedCount: items.filter(item => item.source === "servicenow_ledger" || item.source === "servicenow_records" || item.source === "live_action").length,
    fallbackCount: items.filter(item => item.source === "demo_fallback").length,
  };
}

export function bucketForLifecycle(lifecycle: IreLifecycleState, approvalRejected = false): WorkQueueBucketId {
  if (approvalRejected) return "blocked";
  if (lifecycle === "not_simulated") return "ready_to_simulate";
  if (lifecycle === "simulation_failed") return "simulation_failed";
  if (lifecycle === "simulated_pending_approval") return "needs_approval";
  if (lifecycle === "approved_for_execution") return "ready_to_execute";
  if (lifecycle === "executing" || lifecycle === "executed_pending_verification") return "needs_verification";
  if (lifecycle === "verified") return "verified";
  return "blocked";
}

function lifecycleFromWorkbench(workbench: WorkbenchRecord, pendingAction?: "simulate" | "approve" | "execute" | "verify" | null): IreLifecycleState | null {
  if (pendingAction === "execute") return "executing";
  if (!workbench.simulation && !workbench.approval && !workbench.execution && !workbench.verification) return null;
  return deriveIreLifecycleState(workbench as IreLifecycleSnapshot);
}

function lifecycleFromStaging(ci: ConfigurationItem): IreLifecycleState {
  if (ci.operation === "ERROR" || ci.status === "incomplete") return "simulation_failed";
  return "not_simulated";
}

function lifecycleFromLedger(events: TimelineEvent[]): IreLifecycleState | null {
  for (const event of [...events].reverse()) {
    const text = `${event.name} ${event.reasoning} ${event.operation} ${event.status}`.toLowerCase();
    if (text.includes("verification") && (text.includes("failed") || text.includes("mismatch") || event.status === "error")) return "verification_failed";
    if (text.includes("verification") && (text.includes("passed") || text.includes("verified") || text.includes("successful") || text.includes("read-back"))) return "verified";
    if (text.includes("ire execution") && (text.includes("started") || event.status === "active")) return "executing";
    if ((text.includes("ire execution") || text.includes("committed") || text.includes("cmdb published")) && event.status !== "error") return "executed_pending_verification";
    if ((text.includes("stale") || text.includes("fingerprint")) && (text.includes("reject") || text.includes("failed"))) return "execution_rejected_stale_simulation";
    if (text.includes("approved") || text.includes("approval recorded")) return "approved_for_execution";
    if ((text.includes("simulation") || text.includes("simulated") || text.includes("ire reconciled")) && (text.includes("failed") || text.includes("error") || event.status === "error")) return "simulation_failed";
    if (text.includes("simulation") || text.includes("simulated") || text.includes("ire reconciled")) return "simulated_pending_approval";
  }
  return null;
}

function lifecycleFromPersistedEvidence(
  ledgerLifecycle: IreLifecycleState | null,
  reviewLifecycle: IreLifecycleState | null,
  events: TimelineEvent[],
): IreLifecycleState | null {
  if (!ledgerLifecycle) return reviewLifecycle;
  if (ledgerLifecycle !== "simulated_pending_approval" || reviewLifecycle !== "approved_for_execution") return ledgerLifecycle;

  const approvalWasRecorded = events.some(event => {
    const text = `${event.name} ${event.reasoning}`.toLowerCase();
    return text.includes("approved") || text.includes("approval recorded");
  });
  return approvalWasRecorded ? ledgerLifecycle : reviewLifecycle;
}

/**
 * True if the event is a run-level Mara observation blob, not a per-CI
 * IRE event. These events dump aggregate counts (ready_count, held_count,
 * ...) or start with `Observation:` / `Thought:` markers; treating them as
 * per-CI evidence lets a run-wide summary be attributed to whatever CI
 * happens to be selected.
 */
export function isMaraObservationEvent(event: TimelineEvent): boolean {
  const actor = (event.source || "").toLowerCase();
  const text = (event.reasoning || "").trim();
  if (/mara/i.test(actor)) return true;
  if (/^\s*(observation|thought)\s*:/i.test(text)) return true;
  // Raw JSON payload in a ledger event is only ever a Mara-style dump.
  if (/^[[{]/.test(text)) return true;
  // Aggregate-count markers Mara emits — never per-CI.
  if (/"?ready_count"?\s*[:=]/i.test(text) && /"?held_count"?\s*[:=]/i.test(text)) return true;
  return false;
}

/** Case-insensitive equality — treats null/undefined as no match. */
function equalsCi(candidate: string | undefined | null, ci: ConfigurationItem): boolean {
  if (!candidate) return false;
  const value = candidate.toString().trim().toLowerCase();
  if (!value) return false;
  const ciIds = [ci.id, ci.stagedCiId, ci.name]
    .filter((v): v is string => Boolean(v))
    .map(v => v.toLowerCase());
  return ciIds.includes(value);
}

/**
 * A ledger event is CI-scoped only if it identifies exactly this staged CI —
 * either by naming it in `recordName` (identity match, not substring), or by
 * carrying a `staged_ci_id=` / `target_ci_sys_id=` metadata token in its
 * reasoning that matches the CI. Substring/name matches used to leak
 * unrelated events (e.g. Mara run summaries mentioning a CI in passing) into
 * per-CI evidence — that is exactly the bug this filter closes.
 */
export function isCiScopedTimelineEvent(event: TimelineEvent, ci: ConfigurationItem): boolean {
  if (isMaraObservationEvent(event)) return false;
  if (equalsCi(event.recordName, ci)) return true;
  const reasoning = event.reasoning || "";
  const stagedCiId = ci.stagedCiId || ci.id;
  if (stagedCiId) {
    const pattern = new RegExp(`\\b(staged_ci_id|target_ci_sys_id|ci_sys_id)\\s*=\\s*${escapeRegex(stagedCiId)}\\b`, "i");
    if (pattern.test(reasoning)) return true;
  }
  return false;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchingLedgerEvents(ci: ConfigurationItem, timeline: TimelineEvent[]) {
  return timeline.filter(event => isCiScopedTimelineEvent(event, ci));
}

function relatedFindings(ci: ConfigurationItem, findings: RemediationFinding[]) {
  const ids = [ci.id, ci.stagedCiId].filter((value): value is string => Boolean(value));
  return findings.filter(finding =>
    ids.includes(finding.stagedCiId ?? "") ||
    ids.includes(finding.stagedCiLabel ?? "") ||
    finding.stagedCiLabel === ci.name,
  );
}

function relatedReviews(findings: RemediationFinding[], reviews: RemediationReview[]) {
  const findingKeys = findings.flatMap(finding => [finding.id, finding.number]).filter(Boolean);
  return reviews.filter(review =>
    findingKeys.includes(review.findingId ?? "") || findingKeys.includes(review.findingLabel ?? ""),
  );
}

function playbackIdentifiers(events: TimelineEvent[]) {
  const text = events.map(event => event.reasoning).join(" ");
  return {
    simulationCorrelation: lastMetadataValue(text, "simulation_correlation_id") ?? lastSimulationCorrelation(text),
    simulationFingerprint: lastMetadataValue(text, "simulation_fingerprint"),
    executionCorrelation: lastMetadataValue(text, "execution_correlation_id"),
    targetCiSysId: lastMetadataValue(text, "target_ci_sys_id"),
    targetCiName: lastMetadataValue(text, "actual_name") ?? lastMetadataValue(text, "target_ci_name"),
  };
}

function lastMetadataValue(text: string, key: string) {
  return [...text.matchAll(new RegExp(`\\b${key}=([^\\s|]+)`, "g"))].at(-1)?.[1];
}

function lastSimulationCorrelation(text: string) {
  return [...text.matchAll(/\bcorrelation_id=(ks-simulate-[^\s|]+)/g)].at(-1)?.[1];
}

function relatedHealthFix(ci: ConfigurationItem, fixes: HealthFix[]) {
  if (ci.status === "incomplete") return fixes.find(fix => /incomplete|identifier|ire|missing/i.test(`${fix.title} ${fix.description} ${fix.tool}`));
  if (ci.status === "review") return fixes.find(fix => /review|approval|duplicate|class|ownership/i.test(`${fix.title} ${fix.description} ${fix.tool}`));
  return fixes.find(fix => /simulate|ire|duplicate|stale/i.test(`${fix.title} ${fix.description} ${fix.tool}`));
}

function queueReason(input: {
  ci: ConfigurationItem;
  lifecycle: IreLifecycleState;
  bucket: WorkQueueBucketId;
  latestEvent?: TimelineEvent;
  healthFix?: HealthFix;
  review?: RemediationReview;
  approvalRejected?: boolean;
}) {
  if (input.approvalRejected) return "Review decision rejected the current remediation path.";
  if (input.review?.decision === "approved") return input.review.rationale || "ServiceNow review decision approved the current simulation.";
  if (input.latestEvent && !isMaraObservationEvent(input.latestEvent)) return input.latestEvent.reasoning;
  if (input.healthFix) return input.healthFix.description;
  if (input.bucket === "ready_to_simulate") return "Staged record has enough local gate evidence to request non-mutating IRE simulation.";
  if (input.bucket === "simulation_failed") return "Staged record is incomplete or already failed local eligibility checks.";
  return `Derived from staged CI status ${input.ci.status} and lifecycle ${input.lifecycle}.`;
}

function queueEvidence(input: {
  ci: ConfigurationItem;
  workbench: WorkbenchRecord;
  latestEvent?: TimelineEvent;
  healthFix?: HealthFix;
  finding?: RemediationFinding;
  review?: RemediationReview;
  playback: ReturnType<typeof playbackIdentifiers>;
}) {
  return [
    input.workbench.simulation?.simulation_fingerprint && `fingerprint ${shortId(input.workbench.simulation.simulation_fingerprint)}`,
    input.workbench.simulation?.finding?.display_value && `finding ${input.workbench.simulation.finding.display_value}`,
    input.playback.simulationFingerprint && `fingerprint ${shortId(input.playback.simulationFingerprint)}`,
    input.finding?.number && `finding ${input.finding.number}`,
    input.review?.decision && `review ${input.review.decision}`,
    input.workbench.execution?.execution_correlation_id && `execution ${shortId(input.workbench.execution.execution_correlation_id)}`,
    input.latestEvent && `ledger seq ${input.latestEvent.seq}`,
    input.healthFix && `${input.healthFix.affected} affected by ${input.healthFix.title}`,
    `${Math.round(input.ci.confidence * 100)}% confidence`,
  ].filter((value): value is string => Boolean(value));
}

function shortId(value: string) {
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}
