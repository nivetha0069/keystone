import { createHash } from "node:crypto";
import type { ConfigurationItem, HealthData, Relationship, TimelineEvent } from "../../cmdb-data";
import type { RemediationFinding, RemediationReview } from "./comprehend-adapter";
import { deriveAgentWorkGroups, parseAgentEventDetail, type AgentEventDetailV1, type AgentWorkGroup } from "./agent-workspace";
import type { IreActionResponse } from "./ire";
import { deriveRemediationWorkQueue, isCiScopedTimelineEvent, sortTimelineByFreshness, type WorkQueueItem } from "./work-queue";

export const CAMPAIGN_LIMIT = 20;
export const CAMPAIGN_SIMULATION_CONCURRENCY = 3;
export const CAMPAIGN_INSERT_POLICY_VERSION = "bounded-insert-v1";
export const CAMPAIGN_INSERT_CLASS_ALLOWLIST = ["cmdb_ci_linux_server"] as const;
export const CAMPAIGN_RETRY_STRATEGY_ID = "normalize_known_class_alias" as const;
export const CAMPAIGN_RETRY_MAPPING_VERSION = "class-alias-v1" as const;
export const CAMPAIGN_MAX_RETRIES = 1;
const INSERT_CLASS_ALLOWLIST = new Set<string>(CAMPAIGN_INSERT_CLASS_ALLOWLIST);

export type RemediationCampaignStage =
  | "planning"
  | "simulating"
  | "review_ready"
  | "approving"
  | "executing"
  | "verifying"
  | "completed"
  | "blocked";

export type RemediationCampaignSnapshot = {
  migrationRunId: string;
  cis: ConfigurationItem[];
  timeline: TimelineEvent[];
  findings: RemediationFinding[];
  reviews: RemediationReview[];
  health: HealthData;
  relationships?: Relationship[];
};

export type RemediationCampaignExclusion = {
  staged_ci_id: string;
  name: string;
  reason: string;
};

export type RemediationCampaignItem = {
  staged_ci_id: string;
  name: string;
  class_name: string;
  staged_operation: string;
  lifecycle: string;
};

export type RemediationCampaignPlan = {
  success: true;
  stage: "planning";
  migration_run_id: string;
  campaign_id: string;
  work_group_signature: string;
  group_title: string;
  strategy_id?: "normalize_known_class_alias";
  max_items: number;
  deferred_count: number;
  items: RemediationCampaignItem[];
  exclusions: RemediationCampaignExclusion[];
};

export type RemediationCampaignActionItem = {
  staged_ci_id: string;
  name: string;
  success: boolean;
  state: string;
  error_code?: string;
  message?: string;
  simulation_correlation_id?: string;
  simulation_fingerprint?: string;
  strategy_id?: typeof CAMPAIGN_RETRY_STRATEGY_ID;
  mapping_version?: typeof CAMPAIGN_RETRY_MAPPING_VERSION;
  retry_count?: number;
  max_retries?: number;
};

export type RemediationCampaignSimulationResult = {
  success: boolean;
  stage: "simulating" | "blocked";
  migration_run_id: string;
  campaign_id: string;
  work_group_signature: string;
  concurrency: 3;
  items: RemediationCampaignActionItem[];
  summary: CampaignSummary;
  halted?: { code: string; message: string };
};

export type RemediationFailureGroupItem = {
  staged_ci_id: string;
  name: string;
  error_code: string;
  message: string;
  retry_count: number;
  retry_eligible: boolean;
};

export type RemediationFailureGroup = {
  work_group_signature: string;
  title: string;
  category: string;
  class_name: string;
  state: "eligible" | "blocked" | "exhausted";
  strategy_id?: typeof CAMPAIGN_RETRY_STRATEGY_ID;
  mapping_version?: typeof CAMPAIGN_RETRY_MAPPING_VERSION;
  max_retries: 1;
  blocker?: string;
  items: RemediationFailureGroupItem[];
};

export type RemediationFailureGroupsResult = {
  success: true;
  stage: "planning";
  migration_run_id: string;
  groups: RemediationFailureGroup[];
  summary: { groups: number; records: number; eligible: number; blocked: number; exhausted: number };
};

export type RemediationCampaignRetryResult = {
  success: boolean;
  stage: "simulating" | "blocked";
  migration_run_id: string;
  campaign_id: string;
  work_group_signature: string;
  concurrency: 1;
  strategy_id: typeof CAMPAIGN_RETRY_STRATEGY_ID;
  mapping_version: typeof CAMPAIGN_RETRY_MAPPING_VERSION;
  items: RemediationCampaignActionItem[];
  summary: CampaignSummary;
  halted?: { code: string; message: string };
};

export type RemediationApprovalManifestItem = {
  staged_ci_id: string;
  name: string;
  finding_id: string;
  review_decision_id: string;
  simulation_correlation_id: string;
  simulation_fingerprint: string;
  operation: "INSERT" | "UPDATE" | "NO_CHANGE";
  policy_version?: typeof CAMPAIGN_INSERT_POLICY_VERSION;
  identity_evidence?: "ire_unmatched";
  strategy_id?: "normalize_known_class_alias";
  mapping_version?: string;
  retry_count: number;
};

export type RemediationReviewProposalItem = {
  staged_ci_id: string;
  name: string;
  finding_id: string;
  simulation_correlation_id: string;
  simulation_fingerprint: string;
};

export type RemediationApprovalManifest = {
  success: boolean;
  stage: "review_ready" | "blocked";
  migration_run_id: string;
  campaign_id: string;
  manifest_id?: string;
  work_group_signature: string;
  items: RemediationApprovalManifestItem[];
  exclusions: RemediationCampaignExclusion[];
  summary: CampaignSummary;
};

export type CampaignSummary = {
  total: number;
  eligible: number;
  excluded: number;
  succeeded: number;
  failed: number;
  approved: number;
  executing: number;
  verifying: number;
  verified: number;
  blocked: number;
};

export type RemediationCampaignApprovalResult = {
  success: boolean;
  stage: "approving" | "executing" | "blocked";
  migration_run_id: string;
  campaign_id: string;
  manifest_id: string;
  items: RemediationCampaignActionItem[];
  summary: CampaignSummary;
  halted?: { code: string; message: string };
};

export type RemediationCampaignStatus = {
  success: true;
  stage: RemediationCampaignStage;
  migration_run_id: string;
  campaign_id: string;
  work_group_signature: string;
  items: Array<RemediationCampaignItem & {
    bucket: string;
    execution_correlation_id?: string;
    target_ci_sys_id?: string;
  }>;
  summary: CampaignSummary;
};

export type CampaignSelection = {
  migration_run_id: string;
  work_group_signature: string;
  campaign_id?: string;
  manifest_id?: string;
  staged_ci_ids?: string[];
  limit?: number;
};

export type RemediationCampaignPlanSet = {
  migration_run_id: string;
  work_group_signature: string;
  group_title: string;
  plans: RemediationCampaignPlan[];
  exclusions: RemediationCampaignExclusion[];
  deferred_count: number;
};

type CampaignContext = {
  queueItems: WorkQueueItem[];
  groups: AgentWorkGroup[];
};

export function planRemediationCampaign(
  snapshot: RemediationCampaignSnapshot,
  requestedSignature?: string,
  requestedLimit = CAMPAIGN_LIMIT,
): RemediationCampaignPlan {
  const context = campaignContext(snapshot);
  const limit = clampLimit(requestedLimit);
  const available = campaignGroups(context.queueItems, context.groups);
  const selected = requestedSignature
    ? available.find(group => group.signature === requestedSignature)
    : available.find(group => group.items.some(item => simulationEligible(item, group.strategy)));
  if (!selected) throw campaignError("CAMPAIGN_GROUP_NOT_FOUND", "No homogeneous remediation group is available for this run.");

  const sorted = [...selected.items].sort((left, right) => left.stagedCiId.localeCompare(right.stagedCiId));
  const items: RemediationCampaignItem[] = [];
  const exclusions: RemediationCampaignExclusion[] = [];
  let deferredCount = 0;
  const seen = new Set<string>();
  for (const item of sorted) {
    const reason = seen.has(item.stagedCiId)
      ? "Duplicate staged CI identifier was removed from the campaign."
      : item.ci.migrationRunId && item.ci.migrationRunId.toLowerCase() !== snapshot.migrationRunId.toLowerCase()
        ? "Staged CI belongs to a different migration run."
        : simulationExclusion(item, selected.strategy);
    seen.add(item.stagedCiId);
    if (reason) exclusions.push(exclusion(item, reason));
    else if (items.length < limit) items.push(campaignItem(item));
    else deferredCount++;
  }
  if (!items.length) throw campaignError("CAMPAIGN_EMPTY", "The selected group has no records eligible for bounded simulation.");
  const campaignId = campaignHash(snapshot.migrationRunId, selected.signature, items.map(item => item.staged_ci_id));
  return {
    success: true,
    stage: "planning",
    migration_run_id: snapshot.migrationRunId,
    campaign_id: campaignId,
    work_group_signature: selected.signature,
    group_title: selected.title,
    strategy_id: selected.strategy,
    max_items: limit,
    deferred_count: deferredCount,
    items,
    exclusions,
  };
}

/**
 * Internal Phase E composition primitive used by bounded approval packets.
 * It deliberately selects only the stable class/operation fallback group and
 * partitions it without changing the existing single-campaign planner.
 */
export function planRemediationCampaignChildren(
  snapshot: RemediationCampaignSnapshot,
  requestedSignature?: string,
  requestedTotal = Number.MAX_SAFE_INTEGER,
): RemediationCampaignPlanSet {
  const context = campaignContext(snapshot);
  const available = campaignGroups(context.queueItems, context.groups)
    .filter(group => group.signature.startsWith("eligible:"));
  const selected = requestedSignature
    ? available.find(group => group.signature === requestedSignature)
    : available.find(group => group.items.some(item => simulationEligible(item, group.strategy)));
  if (!selected) throw campaignError("CAMPAIGN_GROUP_NOT_FOUND", "No homogeneous remediation group is available for this run.");

  const sorted = [...selected.items].sort((left, right) => left.stagedCiId.localeCompare(right.stagedCiId));
  const items: RemediationCampaignItem[] = [];
  const exclusions: RemediationCampaignExclusion[] = [];
  const seen = new Set<string>();
  const totalLimit = Math.max(1, Math.min(sorted.length, Number.isFinite(requestedTotal) ? Math.floor(requestedTotal) : sorted.length));
  let deferredCount = 0;
  for (const item of sorted) {
    const reason = seen.has(item.stagedCiId)
      ? "Duplicate staged CI identifier was removed from the campaign."
      : item.ci.migrationRunId && item.ci.migrationRunId.toLowerCase() !== snapshot.migrationRunId.toLowerCase()
        ? "Staged CI belongs to a different migration run."
        : simulationExclusion(item, selected.strategy);
    seen.add(item.stagedCiId);
    if (reason) exclusions.push(exclusion(item, reason));
    else if (items.length < totalLimit) items.push(campaignItem(item));
    else deferredCount++;
  }
  if (!items.length) throw campaignError("CAMPAIGN_EMPTY", "The selected group has no records eligible for bounded simulation.");

  const plans: RemediationCampaignPlan[] = [];
  for (let index = 0; index < items.length; index += CAMPAIGN_LIMIT) {
    plans.push(buildRemediationCampaignPlan(
      snapshot.migrationRunId,
      selected.signature,
      selected.title,
      items.slice(index, index + CAMPAIGN_LIMIT),
      index === 0 ? exclusions : [],
      Math.max(0, items.length - index - CAMPAIGN_LIMIT) + deferredCount,
    ));
  }
  return {
    migration_run_id: snapshot.migrationRunId,
    work_group_signature: selected.signature,
    group_title: selected.title,
    plans,
    exclusions,
    deferred_count: deferredCount,
  };
}

export function buildRemediationCampaignPlan(
  migrationRunId: string,
  workGroupSignature: string,
  groupTitle: string,
  items: RemediationCampaignItem[],
  exclusions: RemediationCampaignExclusion[] = [],
  deferredCount = 0,
): RemediationCampaignPlan {
  const ordered = [...items].sort((left, right) => left.staged_ci_id.localeCompare(right.staged_ci_id));
  return {
    success: true,
    stage: "planning",
    migration_run_id: migrationRunId,
    campaign_id: campaignHash(migrationRunId, workGroupSignature, ordered.map(item => item.staged_ci_id)),
    work_group_signature: workGroupSignature,
    group_title: groupTitle,
    max_items: CAMPAIGN_LIMIT,
    deferred_count: deferredCount,
    items: ordered,
    exclusions,
  };
}

export function validateCampaignSelection(snapshot: RemediationCampaignSnapshot, selection: CampaignSelection) {
  if (snapshot.migrationRunId !== selection.migration_run_id) {
    throw campaignError("CAMPAIGN_RUN_MISMATCH", "Campaign run does not match the authoritative snapshot.");
  }
  const plan = planRemediationCampaign(snapshot, selection.work_group_signature, selection.limit);
  const requestedIds = normalizeIds(selection.staged_ci_ids);
  const plannedIds = plan.items.map(item => item.staged_ci_id);
  if (requestedIds.length && requestedIds.join("|") !== plannedIds.join("|")) {
    throw campaignError("CAMPAIGN_MEMBERSHIP_CHANGED", "Campaign membership changed and must be reviewed again.");
  }
  if (selection.campaign_id && selection.campaign_id !== plan.campaign_id) {
    throw campaignError("CAMPAIGN_STALE", "Campaign evidence changed and must be planned again.");
  }
  return plan;
}

export async function simulateRemediationCampaign(
  snapshot: RemediationCampaignSnapshot,
  selection: CampaignSelection,
  simulate: (item: RemediationCampaignItem, request: { correlation_id: string; idempotency_key: string }) => Promise<IreActionResponse>,
): Promise<RemediationCampaignSimulationResult> {
  const plan = validateCampaignSelection(snapshot, selection);
  let halted: RemediationCampaignSimulationResult["halted"];
  const results = await mapConcurrentUntilHalt(plan.items, CAMPAIGN_SIMULATION_CONCURRENCY, async item => {
    const token = itemToken(item.staged_ci_id);
    try {
      const response = await simulate(item, {
        correlation_id: `ks-campaign:${plan.campaign_id}:simulate:${token}`,
        idempotency_key: `keystone:campaign:${plan.campaign_id}:simulate:${item.staged_ci_id}`,
      });
      const result = actionItem(item, response);
      if (!result.success && result.error_code && SYSTEMIC_ERROR_CODES.has(result.error_code)) {
        halted = { code: result.error_code, message: result.message || "Campaign halted after a systemic simulation failure." };
      }
      return result;
    } catch (error) {
      halted = { code: "UPSTREAM_UNREACHABLE", message: error instanceof Error ? error.message : "Simulation request failed." };
      return failedActionItem(item, halted.code, halted.message);
    }
  }, () => halted);
  const completedIds = new Set(results.map(item => item.staged_ci_id));
  if (halted) {
    for (const item of plan.items) {
      if (!completedIds.has(item.staged_ci_id)) results.push(failedActionItem(item, "CAMPAIGN_HALTED", `Not attempted after ${halted.code}.`));
    }
  }
  results.sort((left, right) => left.staged_ci_id.localeCompare(right.staged_ci_id));
  const summary = summaryFromActions(results, plan.exclusions.length);
  return {
    success: results.some(item => item.success),
    stage: results.some(item => item.success) ? "simulating" : "blocked",
    migration_run_id: plan.migration_run_id,
    campaign_id: plan.campaign_id,
    work_group_signature: plan.work_group_signature,
    concurrency: CAMPAIGN_SIMULATION_CONCURRENCY,
    items: results,
    summary,
    halted,
  };
}

export function prepareRemediationApprovalManifest(
  snapshot: RemediationCampaignSnapshot,
  selection: CampaignSelection,
): RemediationApprovalManifest {
  const plan = validateCampaignSelection(snapshot, selection);
  return prepareRemediationApprovalManifestFromPlan(snapshot, plan);
}

export function prepareRemediationApprovalManifestFromPlan(
  snapshot: RemediationCampaignSnapshot,
  plan: RemediationCampaignPlan,
): RemediationApprovalManifest {
  const context = campaignContext(snapshot);
  const byId = new Map(context.queueItems.map(item => [item.stagedCiId, item]));
  const items: RemediationApprovalManifestItem[] = [];
  const exclusions = [...plan.exclusions];
  for (const planned of plan.items) {
    const queueItem = byId.get(planned.staged_ci_id);
    if (!queueItem) {
      exclusions.push({ staged_ci_id: planned.staged_ci_id, name: planned.name, reason: "Staged CI is no longer present." });
      continue;
    }
    const evidence = latestSimulationEvidence(snapshot.timeline, queueItem);
    const review = simulationBoundReview(snapshot, queueItem, evidence);
    const reason = approvalExclusion(queueItem, evidence, review);
    if (reason) {
      exclusions.push(exclusion(queueItem, reason));
      continue;
    }
    items.push({
      staged_ci_id: queueItem.stagedCiId,
      name: queueItem.ci.name,
      finding_id: evidence!.finding_id!,
      review_decision_id: review!.id,
      simulation_correlation_id: evidence!.simulation_correlation_id!,
      simulation_fingerprint: evidence!.simulation_fingerprint!,
      operation: evidence!.operation as "INSERT" | "UPDATE" | "NO_CHANGE",
      ...(evidence!.operation === "INSERT" ? {
        policy_version: CAMPAIGN_INSERT_POLICY_VERSION,
        identity_evidence: "ire_unmatched" as const,
      } : {}),
      strategy_id: evidence!.strategy_id,
      mapping_version: evidence!.mapping_version,
      retry_count: evidence!.retry_count ?? 0,
    });
  }
  items.sort((left, right) => left.staged_ci_id.localeCompare(right.staged_ci_id));
  const manifestId = items.length ? approvalManifestHash(plan.campaign_id, items) : undefined;
  return {
    success: items.length > 0,
    stage: items.length ? "review_ready" : "blocked",
    migration_run_id: plan.migration_run_id,
    campaign_id: plan.campaign_id,
    manifest_id: manifestId,
    work_group_signature: plan.work_group_signature,
    items,
    exclusions,
    summary: {
      ...emptySummary(items.length + exclusions.length),
      eligible: items.length,
      excluded: exclusions.length,
      blocked: exclusions.length,
    },
  };
}

/**
 * Return simulation-bound proposal records that still need a deferred review.
 * The API route persists them, reloads ServiceNow, and freezes a manifest only
 * from the reloaded authoritative evidence.
 */
export function pendingRemediationReviewProposals(
  snapshot: RemediationCampaignSnapshot,
  selection: CampaignSelection,
): RemediationReviewProposalItem[] {
  const plan = validateCampaignSelection(snapshot, selection);
  return pendingRemediationReviewProposalsFromPlan(snapshot, plan);
}

export function pendingRemediationReviewProposalsFromPlan(
  snapshot: RemediationCampaignSnapshot,
  plan: RemediationCampaignPlan,
): RemediationReviewProposalItem[] {
  const context = campaignContext(snapshot);
  const byId = new Map(context.queueItems.map(item => [item.stagedCiId, item]));
  const items: RemediationReviewProposalItem[] = [];
  for (const planned of plan.items) {
    const queueItem = byId.get(planned.staged_ci_id);
    if (!queueItem) continue;
    const evidence = latestSimulationEvidence(snapshot.timeline, queueItem);
    if (preReviewExclusion(queueItem, evidence)) continue;
    if (simulationBoundReview(snapshot, queueItem, evidence)) continue;
    items.push({
      staged_ci_id: queueItem.stagedCiId,
      name: queueItem.ci.name,
      finding_id: evidence!.finding_id!,
      simulation_correlation_id: evidence!.simulation_correlation_id!,
      simulation_fingerprint: evidence!.simulation_fingerprint!,
    });
  }
  return items.sort((left, right) => left.staged_ci_id.localeCompare(right.staged_ci_id));
}

export async function approveRemediationCampaign(
  snapshot: RemediationCampaignSnapshot,
  selection: CampaignSelection,
  approve: (item: RemediationApprovalManifestItem, request: { correlation_id: string; idempotency_key: string }) => Promise<IreActionResponse>,
): Promise<RemediationCampaignApprovalResult> {
  const manifest = prepareRemediationApprovalManifest(snapshot, selection);
  if (!manifest.manifest_id || selection.manifest_id !== manifest.manifest_id) {
    throw campaignError("CAMPAIGN_MANIFEST_STALE", "Approval manifest changed and must be reviewed again.");
  }
  const results: RemediationCampaignActionItem[] = [];
  let halted: RemediationCampaignApprovalResult["halted"];
  for (const item of manifest.items) {
    try {
      const token = itemToken(item.staged_ci_id);
      const response = await approve(item, {
        correlation_id: `ks-campaign:${manifest.campaign_id}:approve:${token}`,
        idempotency_key: `keystone:campaign:${manifest.manifest_id}:approve:${item.staged_ci_id}`,
      });
      const result = actionItem(item, response);
      results.push(result);
      const code = result.error_code;
      if (!result.success && code && SYSTEMIC_ERROR_CODES.has(code)) {
        halted = { code, message: result.message || "Campaign halted after a systemic approval failure." };
        break;
      }
    } catch (error) {
      halted = { code: "UPSTREAM_UNREACHABLE", message: error instanceof Error ? error.message : "Approval request failed." };
      results.push(failedActionItem(item, halted.code, halted.message));
      break;
    }
  }
  const summary = summaryFromActions(results, manifest.exclusions.length);
  summary.approved = results.filter(item => item.success).length;
  summary.executing = summary.approved;
  return {
    success: results.some(item => item.success) && !halted,
    stage: halted ? "blocked" : results.some(item => item.success) ? "executing" : "blocked",
    migration_run_id: manifest.migration_run_id,
    campaign_id: manifest.campaign_id,
    manifest_id: manifest.manifest_id,
    items: results,
    summary,
    halted,
  };
}

export function remediationCampaignStatus(snapshot: RemediationCampaignSnapshot, selection: CampaignSelection): RemediationCampaignStatus {
  const frozen = validateFrozenCampaignSelection(snapshot, selection);
  const items = frozen.items.map(current => {
    const structured = campaignLifecycleEvidence(snapshot.timeline, current);
    return {
      ...campaignItem(current),
      lifecycle: structured?.lifecycle ?? current.lifecycle,
      bucket: structured?.bucket ?? current.bucket,
      execution_correlation_id: structured?.execution_correlation_id ?? current.executionCorrelation,
      target_ci_sys_id: structured?.target_ci_sys_id ?? current.targetCiSysId,
    };
  });
  const counts = {
    verified: items.filter(item => item.bucket === "verified").length,
    executing: items.filter(item => item.lifecycle === "executing").length,
    verifying: items.filter(item => item.bucket === "needs_verification").length,
    blocked: items.filter(item => item.bucket === "blocked" || item.bucket === "simulation_failed").length,
    approved: items.filter(item => item.bucket === "ready_to_execute" || item.bucket === "needs_verification" || item.bucket === "verified").length,
  };
  const stage: RemediationCampaignStage = counts.verified + counts.blocked === items.length
    ? counts.verified ? "completed" : "blocked"
    : counts.executing
      ? "executing"
      : counts.verifying
        ? "verifying"
        : counts.approved
          ? "executing"
          : counts.blocked === items.length
            ? "blocked"
            : items.some(item => item.bucket === "needs_approval")
              ? "review_ready"
              : "simulating";
  return {
    success: true,
    stage,
    migration_run_id: snapshot.migrationRunId,
    campaign_id: frozen.campaignId,
    work_group_signature: selection.work_group_signature,
    items,
    summary: {
      total: items.length,
      eligible: items.length - counts.blocked,
      excluded: 0,
      succeeded: items.length - counts.blocked,
      failed: counts.blocked,
      approved: counts.approved,
      executing: counts.executing,
      verifying: counts.verifying,
      verified: counts.verified,
      blocked: counts.blocked,
    },
  };
}

export function remediationFailureGroups(snapshot: RemediationCampaignSnapshot): RemediationFailureGroupsResult {
  const context = campaignContext(snapshot);
  const failedById = new Map(context.queueItems
    .filter(item => item.bucket === "simulation_failed" || item.bucket === "blocked")
    .flatMap(item => [[item.stagedCiId, item], [item.id, item]]));
  const groups: RemediationFailureGroup[] = [];
  for (const group of context.groups) {
    const queueItems = group.stagedCiIds.flatMap(id => failedById.get(id) ?? []);
    if (!queueItems.length) continue;
    const items = queueItems.map(item => {
      const evidence = latestRetryEvidence(snapshot.timeline, item);
      const retryCount = Math.max(0, evidence.retry_count ?? 0);
      return {
        staged_ci_id: item.stagedCiId,
        name: item.ci.name,
        error_code: evidence.error_code || failureCode(item.reason),
        message: evidence.message || item.reason,
        retry_count: retryCount,
        retry_eligible: group.strategy === CAMPAIGN_RETRY_STRATEGY_ID && retryCount < CAMPAIGN_MAX_RETRIES,
      };
    }).sort((left, right) => left.staged_ci_id.localeCompare(right.staged_ci_id));
    const strategy = group.strategy === CAMPAIGN_RETRY_STRATEGY_ID ? CAMPAIGN_RETRY_STRATEGY_ID : undefined;
    const eligible = items.some(item => item.retry_eligible);
    const exhausted = Boolean(strategy) && items.every(item => item.retry_count >= CAMPAIGN_MAX_RETRIES);
    groups.push({
      work_group_signature: group.signature,
      title: group.title,
      category: group.category,
      class_name: group.targetClass,
      state: eligible ? "eligible" : exhausted ? "exhausted" : "blocked",
      strategy_id: strategy,
      mapping_version: strategy ? CAMPAIGN_RETRY_MAPPING_VERSION : undefined,
      max_retries: CAMPAIGN_MAX_RETRIES,
      blocker: eligible ? undefined : exhausted ? "The one-retry budget is exhausted." : group.blocker || "No allowlisted deterministic retry strategy is available.",
      items,
    });
  }
  groups.sort((left, right) => stateRank(left.state) - stateRank(right.state) || right.items.length - left.items.length || left.work_group_signature.localeCompare(right.work_group_signature));
  return {
    success: true,
    stage: "planning",
    migration_run_id: snapshot.migrationRunId,
    groups,
    summary: {
      groups: groups.length,
      records: groups.reduce((sum, group) => sum + group.items.length, 0),
      eligible: groups.filter(group => group.state === "eligible").reduce((sum, group) => sum + group.items.filter(item => item.retry_eligible).length, 0),
      blocked: groups.filter(group => group.state === "blocked").reduce((sum, group) => sum + group.items.length, 0),
      exhausted: groups.filter(group => group.state === "exhausted").reduce((sum, group) => sum + group.items.length, 0),
    },
  };
}

export async function retryRemediationCampaign(
  snapshot: RemediationCampaignSnapshot,
  selection: CampaignSelection,
  simulate: (item: RemediationCampaignItem, request: { correlation_id: string; idempotency_key: string }) => Promise<IreActionResponse>,
): Promise<RemediationCampaignRetryResult> {
  const plan = validateCampaignSelection(snapshot, selection);
  const failureGroup = remediationFailureGroups(snapshot).groups.find(group => group.work_group_signature === plan.work_group_signature);
  if (!failureGroup || failureGroup.strategy_id !== CAMPAIGN_RETRY_STRATEGY_ID) {
    throw campaignError("CAMPAIGN_RETRY_NOT_ALLOWED", "The selected failure group has no allowlisted deterministic retry strategy.");
  }
  const failureItems = new Map(failureGroup.items.map(item => [item.staged_ci_id, item]));
  const results: RemediationCampaignActionItem[] = [];
  let halted: RemediationCampaignRetryResult["halted"];
  for (const item of plan.items) {
    const failure = failureItems.get(item.staged_ci_id);
    if (!failure?.retry_eligible) {
      results.push({ staged_ci_id: item.staged_ci_id, name: item.name, success: false, state: "blocked", error_code: "RETRY_LIMIT_REACHED", message: failure?.message || "No retry evidence is available.", retry_count: failure?.retry_count ?? CAMPAIGN_MAX_RETRIES, max_retries: CAMPAIGN_MAX_RETRIES });
      continue;
    }
    try {
      const token = itemToken(item.staged_ci_id);
      const response = await simulate(item, {
        correlation_id: `ks-campaign:${plan.campaign_id}:retry:${token}:1`,
        idempotency_key: `keystone:campaign:${plan.campaign_id}:retry:${item.staged_ci_id}:1`,
      });
      const result = actionItem(item, response);
      if (response.success && (response.strategy_id !== CAMPAIGN_RETRY_STRATEGY_ID || response.mapping_version !== CAMPAIGN_RETRY_MAPPING_VERSION || response.retry_count !== 1 || response.max_retries !== CAMPAIGN_MAX_RETRIES)) {
        results.push({ ...result, success: false, state: "blocked", error_code: "RETRY_EVIDENCE_MISSING", message: "ServiceNow did not return the exact allowlisted retry evidence." });
        continue;
      }
      results.push(result);
      if (!result.success && result.error_code && SYSTEMIC_ERROR_CODES.has(result.error_code)) {
        halted = { code: result.error_code, message: result.message || "Campaign halted after a systemic retry failure." };
        break;
      }
    } catch (error) {
      halted = { code: "UPSTREAM_UNREACHABLE", message: error instanceof Error ? error.message : "Retry request failed." };
      results.push(failedActionItem(item, halted.code, halted.message));
      break;
    }
  }
  const summary = summaryFromActions(results, plan.exclusions.length);
  return {
    success: results.some(item => item.success) && !halted,
    stage: halted || !results.some(item => item.success) ? "blocked" : "simulating",
    migration_run_id: plan.migration_run_id,
    campaign_id: plan.campaign_id,
    work_group_signature: plan.work_group_signature,
    concurrency: 1,
    strategy_id: CAMPAIGN_RETRY_STRATEGY_ID,
    mapping_version: CAMPAIGN_RETRY_MAPPING_VERSION,
    items: results,
    summary,
    halted,
  };
}

/**
 * Status follows the identifiers frozen into the reviewed campaign instead of
 * replanning the current simulation queue. Successful records intentionally
 * leave that queue during Execute and Verify, so replanning would replace them
 * with later eligible records and incorrectly report membership drift.
 */
function validateFrozenCampaignSelection(snapshot: RemediationCampaignSnapshot, selection: CampaignSelection) {
  if (snapshot.migrationRunId !== selection.migration_run_id) {
    throw campaignError("CAMPAIGN_RUN_MISMATCH", "Campaign run does not match the authoritative snapshot.");
  }
  const requestedIds = normalizeIds(selection.staged_ci_ids);
  if (!requestedIds.length) {
    throw campaignError("INVALID_REQUEST", "Frozen campaign staged CI identifiers are required for status reconstruction.");
  }
  const context = campaignContext(snapshot);
  const byId = new Map(context.queueItems.flatMap(item => [
    [item.stagedCiId.toLowerCase(), item] as const,
    [item.id.toLowerCase(), item] as const,
  ]));
  const items: WorkQueueItem[] = [];
  for (const id of requestedIds) {
    const item = byId.get(id);
    if (!item) {
      throw campaignError("CAMPAIGN_MEMBERSHIP_CHANGED", "A frozen campaign item is no longer present in the authoritative run snapshot.");
    }
    items.push(item);
  }
  const expectedCampaignId = campaignHash(snapshot.migrationRunId, selection.work_group_signature, requestedIds);
  if (!selection.campaign_id || selection.campaign_id !== expectedCampaignId) {
    throw campaignError("CAMPAIGN_STALE", "Frozen campaign identifiers do not match the supplied campaign id.");
  }
  return { campaignId: expectedCampaignId, items };
}

export function approvalManifestHash(campaignId: string, items: RemediationApprovalManifestItem[]) {
  const includesInsert = items.some(item => item.operation === "INSERT");
  const canonical = [...items]
    .sort((left, right) => left.staged_ci_id.localeCompare(right.staged_ci_id))
    .map(item => [
      item.staged_ci_id,
      item.finding_id,
      item.review_decision_id,
      item.simulation_correlation_id,
      item.simulation_fingerprint.toUpperCase(),
      item.operation,
      ...(item.operation === "INSERT" ? [item.policy_version ?? "", item.identity_evidence ?? ""] : []),
    ].join("|"))
    .join("\n");
  const version = includesInsert ? "keystone.campaign.manifest.v2" : "keystone.campaign.manifest.v1";
  return createHash("sha256").update(`${version}|${campaignId}|${canonical}`).digest("hex").toUpperCase();
}

function campaignContext(snapshot: RemediationCampaignSnapshot): CampaignContext {
  const queue = deriveRemediationWorkQueue({
    cis: snapshot.cis,
    timeline: snapshot.timeline,
    findings: snapshot.findings,
    reviews: snapshot.reviews,
    healthFixes: snapshot.health.fixes,
  });
  return {
    queueItems: queue.items,
    groups: deriveAgentWorkGroups({ cis: snapshot.cis, findings: snapshot.findings, health: snapshot.health, queue }),
  };
}

function campaignGroups(items: WorkQueueItem[], groups: AgentWorkGroup[]) {
  const byId = new Map(items.flatMap(item => [[item.stagedCiId, item], [item.id, item]]));
  const result: Array<{ signature: string; title: string; strategy?: "normalize_known_class_alias"; items: WorkQueueItem[] }> = [];
  const assigned = new Set<string>();
  for (const group of groups) {
    const groupItems = group.stagedCiIds.flatMap(id => byId.get(id) ?? []).filter(item => !assigned.has(item.stagedCiId));
    if (!groupItems.length) continue;
    groupItems.forEach(item => assigned.add(item.stagedCiId));
    result.push({ signature: group.signature, title: group.title, strategy: group.strategy, items: groupItems });
  }
  // Always expose the stable class/operation fallback as well as diagnostic
  // groups. Findings can appear after simulation and must not silently change
  // the campaign identity that the user already reviewed.
  const fallback = new Map<string, WorkQueueItem[]>();
  for (const item of items) {
    const signature = `eligible:${slug(item.ci.className)}:${safeOperationFamily(item.ci.operation)}`;
    fallback.set(signature, [...(fallback.get(signature) ?? []), item]);
  }
  for (const [signature, groupItems] of fallback) {
    result.push({ signature, title: `Remediate ${groupItems[0].ci.className} ${safeOperationFamily(groupItems[0].ci.operation)}`, items: groupItems });
  }
  return result.sort((left, right) => right.items.length - left.items.length || left.signature.localeCompare(right.signature));
}

function simulationEligible(item: WorkQueueItem, strategy?: string) {
  return !simulationExclusion(item, strategy);
}

function simulationExclusion(item: WorkQueueItem, strategy?: string) {
  if (!/^[0-9a-f]{32}$/i.test(item.stagedCiId)) return "A canonical staged CI sys_id is required.";
  if (item.bucket === "verified" || item.bucket === "needs_verification" || item.bucket === "ready_to_execute") return "The record already advanced beyond simulation.";
  if (["ERROR", "INSERT_AS_INCOMPLETE"].includes(item.ci.operation) && strategy !== "normalize_known_class_alias") return "The staged record is blocked and has no allowlisted retry strategy.";
  if (item.bucket === "blocked" && strategy !== "normalize_known_class_alias") return "The record is blocked and requires individual review.";
  return "";
}

function approvalExclusion(
  item: WorkQueueItem,
  evidence: ReturnType<typeof latestSimulationEvidence>,
  review: RemediationReview | undefined,
) {
  const reason = preReviewExclusion(item, evidence);
  if (reason) return reason;
  if (!review || !/^[0-9a-f]{32}$/i.test(review.id)) return "A deferred review bound to the latest simulation is missing.";
  if (review.decision !== "deferred") return `Review is ${review.decision || "unknown"}; only deferred reviews may enter a new manifest.`;
  return "";
}

function simulationBoundReview(
  snapshot: RemediationCampaignSnapshot,
  item: WorkQueueItem,
  evidence: ReturnType<typeof latestSimulationEvidence>,
) {
  if (!evidence?.finding_id || !evidence.simulation_correlation_id || !evidence.simulation_fingerprint) return undefined;
  const marker = sortTimelineByFreshness(snapshot.timeline.filter(event => {
    const detail = parseCampaignEventDetail(event.reasoning);
    return detail?.action === "approval_review_deferred" &&
      detail.migration_run_id?.toLowerCase() === snapshot.migrationRunId.toLowerCase() &&
      detail.staged_ci_id?.toLowerCase() === item.stagedCiId.toLowerCase() &&
      detail.finding_id?.toLowerCase() === evidence.finding_id!.toLowerCase() &&
      detail.simulation_correlation_id === evidence.simulation_correlation_id &&
      detail.simulation_fingerprint?.toUpperCase() === evidence.simulation_fingerprint!.toUpperCase() &&
      /^[0-9a-f]{32}$/i.test(detail.review_decision_id ?? "");
  }))[0];
  if (!marker) return undefined;
  const detail = parseCampaignEventDetail(marker.reasoning);
  return snapshot.reviews.find(review => review.id.toLowerCase() === detail?.review_decision_id?.toLowerCase());
}

function preReviewExclusion(item: WorkQueueItem, evidence: ReturnType<typeof latestSimulationEvidence>) {
  if (!evidence) return "No completed canonical simulation was found.";
  if (!evidence.simulation_correlation_id) return "Simulation correlation is missing.";
  if (!/^[0-9A-F]{64}$/.test(evidence.simulation_fingerprint ?? "")) return "Canonical simulation fingerprint is missing or malformed.";
  if (evidence.operation !== "INSERT" && evidence.operation !== "UPDATE" && evidence.operation !== "NO_CHANGE") return (evidence.operation || "Unknown") + " is not eligible for group approval.";
  if (evidence.operation === "INSERT") {
    if (!INSERT_CLASS_ALLOWLIST.has(item.ci.className)) return item.ci.className + " is not allowlisted by " + CAMPAIGN_INSERT_POLICY_VERSION + ".";
    if (evidence.simulation_matched_ci === undefined) return "Authoritative unmatched-identity evidence is missing for INSERT.";
    if (evidence.simulation_matched_ci) return "IRE found an existing CMDB match; INSERT is not eligible.";
    if (item.ci.status !== "live" || item.ci.operation === "INSERT_AS_INCOMPLETE") return "Incomplete staged records cannot enter an INSERT campaign.";
    if (!item.ci.name.trim() || /^unnamed\b/i.test(item.ci.name)) return "A stable server-derived CI name is required for INSERT.";
    if (!item.ci.source.trim()) return "A server-derived source is required for INSERT.";
  }
  if (!evidence.finding_id || !/^[0-9a-f]{32}$/i.test(evidence.finding_id)) return "Actionable finding evidence is missing.";
  if (item.bucket === "blocked" || item.bucket === "simulation_failed") return "Latest persisted evidence is blocked.";
  return "";
}

function latestSimulationEvidence(timeline: TimelineEvent[], item: WorkQueueItem) {
  const events = sortTimelineByFreshness(timeline.filter(event => {
    const detail = parseCampaignEventDetail(event.reasoning);
    return detail?.staged_ci_id?.toLowerCase() === item.stagedCiId.toLowerCase() || isCiScopedTimelineEvent(event, item.ci);
  }));
  for (const event of [...events].reverse()) {
    const detail = parseCampaignEventDetail(event.reasoning);
    if (!detail || detail.action !== "ire_simulation_completed") continue;
    return {
      simulation_correlation_id: detail.simulation_correlation_id || detail.correlation_id,
      simulation_fingerprint: detail.simulation_fingerprint?.toUpperCase(),
      finding_id: detail.finding_id || item.finding?.id,
      operation: detail.operation?.toUpperCase(),
      simulation_matched_ci: detail.simulation_matched_ci,
      strategy_id: detail.strategy_id === "normalize_known_class_alias" ? "normalize_known_class_alias" as const : undefined,
      mapping_version: detail.mapping_version,
      retry_count: detail.retry_count,
    };
  }
  return null;
}

function campaignLifecycleEvidence(timeline: TimelineEvent[], item: WorkQueueItem) {
  const evidence = sortTimelineByFreshness(timeline.filter(event => {
    const detail = parseCampaignEventDetail(event.reasoning);
    return detail?.staged_ci_id?.toLowerCase() === item.stagedCiId.toLowerCase();
  })).map(event => ({ event, detail: parseCampaignEventDetail(event.reasoning)! }));
  for (const { detail } of [...evidence].reverse()) {
    if (detail.action === "verification_passed") return {
      lifecycle: "verified", bucket: "verified",
      execution_correlation_id: detail.execution_correlation_id || detail.execution_event_id,
      target_ci_sys_id: detail.target_ci_sys_id,
    };
    if (detail.action === "verification_failed") return {
      lifecycle: "verification_failed", bucket: "blocked",
      execution_correlation_id: detail.execution_correlation_id || detail.execution_event_id,
      target_ci_sys_id: detail.target_ci_sys_id,
    };
    if (detail.action === "ire_verification_claimed" || detail.action === "ire_execution_completed") return {
      lifecycle: "executed_pending_verification", bucket: "needs_verification",
      execution_correlation_id: detail.execution_correlation_id || detail.execution_event_id,
      target_ci_sys_id: detail.target_ci_sys_id,
    };
    if (detail.action === "ire_execution_claimed") return { lifecycle: "executing", bucket: "needs_verification" };
    if (detail.action === "ire_execution_reconciliation_required" || detail.action === "ire_execution_failed") {
      return { lifecycle: "execution_reconciliation_required", bucket: "blocked" };
    }
    if (detail.action === "approval_recorded" || detail.action === "approval_resume_prepared") {
      return { lifecycle: "approved_for_execution", bucket: "ready_to_execute" };
    }
    if (detail.action === "ire_simulation_completed") return detail.operation === "UPDATE" || detail.operation === "NO_CHANGE" || insertLifecycleEligible(item, detail)
      ? { lifecycle: "simulated_pending_approval", bucket: "needs_approval" }
      : { lifecycle: "simulated_pending_approval", bucket: "blocked" };
    if (detail.action === "ire_simulation_failed") return { lifecycle: "simulation_failed", bucket: "simulation_failed" };
  }
  return null;
}

function campaignHash(runId: string, signature: string, stagedCiIds: string[]) {
  return createHash("sha256")
    .update(`keystone.campaign.v1|${runId}|${signature}|${[...stagedCiIds].sort().join("|")}`)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
}

function campaignItem(item: WorkQueueItem): RemediationCampaignItem {
  return {
    staged_ci_id: item.stagedCiId,
    name: item.ci.name,
    class_name: item.ci.className,
    staged_operation: item.ci.operation,
    lifecycle: item.lifecycle,
  };
}

function exclusion(item: WorkQueueItem, reason: string): RemediationCampaignExclusion {
  return { staged_ci_id: item.stagedCiId, name: item.ci.name, reason };
}

function actionItem(item: { staged_ci_id: string; name: string }, response: IreActionResponse): RemediationCampaignActionItem {
  return {
    staged_ci_id: item.staged_ci_id,
    name: item.name,
    success: response.success,
    state: response.state,
    error_code: response.error?.code,
    message: response.error?.message,
    simulation_correlation_id: response.simulation_correlation_id ?? response.correlation_id,
    simulation_fingerprint: response.simulation_fingerprint,
    strategy_id: response.strategy_id === CAMPAIGN_RETRY_STRATEGY_ID ? CAMPAIGN_RETRY_STRATEGY_ID : undefined,
    mapping_version: response.mapping_version === CAMPAIGN_RETRY_MAPPING_VERSION ? CAMPAIGN_RETRY_MAPPING_VERSION : undefined,
    retry_count: response.retry_count,
    max_retries: response.max_retries,
  };
}

function failedActionItem(item: { staged_ci_id: string; name: string }, code: string, message: string): RemediationCampaignActionItem {
  return { staged_ci_id: item.staged_ci_id, name: item.name, success: false, state: "blocked", error_code: code, message };
}

function summaryFromActions(items: RemediationCampaignActionItem[], excluded: number): CampaignSummary {
  const succeeded = items.filter(item => item.success).length;
  return {
    ...emptySummary(items.length + excluded),
    eligible: items.length,
    excluded,
    succeeded,
    failed: items.length - succeeded,
    blocked: excluded + items.length - succeeded,
  };
}

function emptySummary(total: number): CampaignSummary {
  return { total, eligible: 0, excluded: 0, succeeded: 0, failed: 0, approved: 0, executing: 0, verifying: 0, verified: 0, blocked: 0 };
}

async function mapConcurrentUntilHalt<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>, halted: () => unknown) {
  const results: R[] = [];
  let cursor = 0;
  async function run() {
    while (cursor < items.length && !halted()) {
      const index = cursor++;
      results.push(await worker(items[index]));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function normalizeIds(values?: string[]) {
  return [...new Set((values ?? []).map(value => value.trim().toLowerCase()).filter(Boolean))].sort();
}

function safeOperationFamily(operation: string) {
  return operation === "UPDATE" || operation === "NO_CHANGE" ? "safe-update" : operation.toLowerCase();
}

function insertLifecycleEligible(item: WorkQueueItem, detail: Partial<AgentEventDetailV1>) {
  return detail.operation === "INSERT" &&
    detail.simulation_matched_ci === "" &&
    INSERT_CLASS_ALLOWLIST.has(item.ci.className) &&
    item.ci.status === "live";
}

const CAMPAIGN_LEDGER_ACTIONS = new Set([
  "ire_simulation_started", "ire_simulation_completed", "ire_simulation_failed", "ire_simulation_blocked",
  "approval_review_deferred", "approval_recorded", "approval_resume_prepared",
  "ire_execution_claimed", "ire_execution_completed", "ire_execution_failed",
  "ire_execution_reconciliation_required", "ire_verification_claimed",
  "verification_passed", "verification_failed",
]);

/**
 * Phase B3/D evidence predates the `keystone.agent.v1` envelope in some live
 * instances, but still persists the same allowlisted lifecycle fields as JSON.
 * Campaign reconstruction accepts only known lifecycle actions from that
 * legacy shape; arbitrary JSON remains rejected.
 */
export function parseCampaignEventDetail(value: string): Partial<AgentEventDetailV1> & { action: string } | null {
  const canonical = parseAgentEventDetail(value);
  if (canonical) return canonical;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const action = typeof parsed.action === "string" ? parsed.action.trim() : "";
    if (!CAMPAIGN_LEDGER_ACTIONS.has(action)) return null;
    return { ...parsed, action } as Partial<AgentEventDetailV1> & { action: string };
  } catch {
    return null;
  }
}

function itemToken(stagedCiId: string) {
  return createHash("sha256").update(stagedCiId.toLowerCase()).digest("hex").slice(0, 12);
}

function latestRetryEvidence(timeline: TimelineEvent[], item: WorkQueueItem) {
  const events = sortTimelineByFreshness(timeline.filter(event => {
    const detail = parseCampaignEventDetail(event.reasoning);
    return detail?.staged_ci_id?.toLowerCase() === item.stagedCiId.toLowerCase();
  }));
  let retryCount = 0;
  let errorCode = "";
  let message = "";
  for (const event of events) {
    const detail = parseCampaignEventDetail(event.reasoning);
    if (!detail) continue;
    retryCount = Math.max(retryCount, typeof detail.retry_count === "number" ? detail.retry_count : 0);
    if (detail.action === "ire_simulation_failed" || detail.action === "ire_simulation_blocked") {
      errorCode = typeof detail.error_code === "string" ? detail.error_code : errorCode;
      message = detail.summary || event.reasoning || message;
    }
  }
  return { retry_count: retryCount, error_code: errorCode, message };
}

function failureCode(value: string) {
  const match = value.match(/\b(?:error[_ ]?code[=: ]+)?([A-Z][A-Z0-9_]{3,})\b/);
  return match?.[1] || "IRE_FAILED";
}

function stateRank(state: RemediationFailureGroup["state"]) {
  return state === "eligible" ? 0 : state === "blocked" ? 1 : 2;
}

function clampLimit(value: number) {
  return Math.max(1, Math.min(CAMPAIGN_LIMIT, Number.isFinite(value) ? Math.floor(value) : CAMPAIGN_LIMIT));
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unclassified";
}

const SYSTEMIC_ERROR_CODES = new Set(["NOT_CONFIGURED", "UNAUTHORIZED", "FORBIDDEN", "UPSTREAM_UNREACHABLE", "RUN_STATE_INVALID"]);

export function campaignError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
