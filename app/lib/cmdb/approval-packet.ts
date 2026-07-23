import { createHash } from "node:crypto";
import type { TimelineEvent } from "../../cmdb-data";
import {
  CAMPAIGN_LIMIT,
  approvalManifestHash,
  buildRemediationCampaignPlan,
  campaignError,
  parseCampaignEventDetail,
  pendingRemediationReviewProposalsFromPlan,
  planRemediationCampaignChildren,
  prepareRemediationApprovalManifestFromPlan,
  type RemediationApprovalManifestItem,
  type RemediationCampaignActionItem,
  type RemediationCampaignExclusion,
  type RemediationCampaignPlan,
  type RemediationCampaignSnapshot,
  type RemediationReviewProposalItem,
} from "./remediation-campaign";
import type { IreActionResponse } from "./ire";

export const APPROVAL_PACKET_POLICY_VERSION = "bounded-approval-packet-v2" as const;
export const APPROVAL_PACKET_MAX_ITEMS = 100;
export const APPROVAL_PACKET_MAX_CHILDREN = 5 as const;
export const APPROVAL_PACKET_TTL_MS = 30 * 60 * 1000;
export const APPROVAL_PACKET_SAMPLE_LIMIT = 10;

export type ApprovalPacketStage = "planning" | "review_ready" | "approving" | "executing" | "verifying" | "completed" | "blocked" | "expired";

export type ApprovalPacketSelection = {
  migration_run_id: string;
  packet_id?: string;
  packet_hash?: string;
  child_manifest_ids?: string[];
  staged_ci_ids?: string[];
};

export type ApprovalPacketChildPlan = {
  child_index: number;
  campaign_id: string;
  item_count: number;
  items: RemediationCampaignPlan["items"];
};

export type ApprovalPacketPlan = {
  success: true;
  stage: "planning";
  migration_run_id: string;
  packet_id: string;
  policy_version: typeof APPROVAL_PACKET_POLICY_VERSION;
  work_group_signature: string;
  group_title: string;
  class_name: string;
  operation_family: string;
  max_items: 100;
  max_children: 5;
  preparable_count: number;
  deferred_count: number;
  children: ApprovalPacketChildPlan[];
  exclusions: ApprovalPacketExclusion[];
};

export type ApprovalPacketExclusion = RemediationCampaignExclusion & {
  child_campaign_id?: string;
  code?: string;
};

export type ApprovalPacketChild = {
  child_index: number;
  campaign_id: string;
  manifest_id: string;
  item_count: number;
  operation_families: Array<"INSERT" | "UPDATE">;
  items: RemediationApprovalManifestItem[];
};

export type ApprovalPacketAggregate = {
  total: number;
  children: number;
  operations: { INSERT: number; UPDATE: number; NO_CHANGE: number };
  risks: { critical: number; high: number; medium: number; low: number; unknown: number };
  excluded: number;
  blocked: number;
  approved: number;
  executing: number;
  verifying: number;
  verified: number;
};

export type ApprovalPacketSample = {
  staged_ci_id: string;
  name: string;
  class_name: string;
  operation: "INSERT" | "UPDATE";
  risk: keyof ApprovalPacketAggregate["risks"];
  child_campaign_id: string;
  simulation_fingerprint: string;
};

export type FrozenApprovalPacket = {
  success: boolean;
  stage: "review_ready" | "blocked" | "expired";
  migration_run_id: string;
  packet_id?: string;
  packet_hash?: string;
  policy_version: typeof APPROVAL_PACKET_POLICY_VERSION;
  work_group_signature: string;
  group_title: string;
  class_name: string;
  operation_family: string;
  expires_at?: string;
  children: ApprovalPacketChild[];
  items: RemediationApprovalManifestItem[];
  exclusions: ApprovalPacketExclusion[];
  samples: ApprovalPacketSample[];
  aggregate: ApprovalPacketAggregate;
};

export type ApprovalPacketApprovalItem = RemediationCampaignActionItem & {
  child_campaign_id: string;
  reconciled?: boolean;
};

export type ApprovalPacketApprovalResult = {
  success: boolean;
  stage: "executing" | "blocked";
  migration_run_id: string;
  packet_id: string;
  packet_hash: string;
  items: ApprovalPacketApprovalItem[];
  aggregate: ApprovalPacketAggregate;
  halted?: { code: string; message: string };
};

export type ApprovalPacketProgressItem = {
  staged_ci_id: string;
  name: string;
  child_campaign_id: string;
  operation: string;
  state: "awaiting_approval" | "approved" | "executing" | "verifying" | "verified" | "blocked";
  approval_event_id?: string;
  execution_correlation_id?: string;
  target_ci_sys_id?: string;
  blocker?: string;
};

export type ApprovalPacketStatus = {
  success: true;
  stage: ApprovalPacketStage;
  migration_run_id: string;
  packet_id: string;
  packet_hash: string;
  expires_at: string;
  children: Array<{ campaign_id: string; manifest_id: string; item_count: number; verified: number; blocked: number }>;
  items: ApprovalPacketProgressItem[];
  exclusions: ApprovalPacketExclusion[];
  aggregate: ApprovalPacketAggregate;
};

type PacketCandidate = {
  item: RemediationCampaignPlan["items"][number];
  class_name?: string;
  operation_family?: string;
  reason?: string;
};

export function planApprovalPacket(snapshot: RemediationCampaignSnapshot): ApprovalPacketPlan {
  const all = planRemediationCampaignChildren(snapshot);
  const candidates: PacketCandidate[] = [];
  const exclusions: ApprovalPacketExclusion[] = [...all.exclusions];

  for (const plan of all.plans) {
    const manifest = prepareRemediationApprovalManifestFromPlan(snapshot, plan);
    const pending = pendingRemediationReviewProposalsFromPlan(snapshot, plan);
    const manifestById = new Map(manifest.items.map(item => [item.staged_ci_id, item]));
    const pendingIds = new Set(pending.map(item => item.staged_ci_id));
    const reasons = new Map(manifest.exclusions.map(item => [item.staged_ci_id, item.reason]));
    for (const item of plan.items) {
      const manifestItem = manifestById.get(item.staged_ci_id);
      const family = manifestItem
        ? operationFamily(manifestItem.operation)
        : pendingIds.has(item.staged_ci_id) ? latestAuthoritativeOperationFamily(snapshot.timeline, item.staged_ci_id) : undefined;
      const className = manifestItem?.proposed_class ?? (pendingIds.has(item.staged_ci_id) ? latestAuthoritativeClass(snapshot.timeline, item.staged_ci_id) : undefined) ?? item.class_name;
      if (family) candidates.push({ item, class_name: className, operation_family: family });
      else candidates.push({ item, reason: reasons.get(item.staged_ci_id) ?? "Record lacks a fresh completed simulation eligible for packet preparation." });
    }
  }

  const homogeneous = new Map<string, PacketCandidate[]>();
  for (const candidate of candidates.filter(candidate => !candidate.reason && candidate.operation_family)) {
    const key = `${candidate.class_name}|${candidate.operation_family}`;
    homogeneous.set(key, [...(homogeneous.get(key) ?? []), candidate]);
  }
  const selectedGroup = [...homogeneous.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))[0];
  if (!selectedGroup) throw campaignError("PACKET_EMPTY", "No fresh homogeneous Phase E evidence is available for an approval packet.");
  const selectedSet = new Set(selectedGroup[1].map(candidate => candidate.item.staged_ci_id));
  const eligible = selectedGroup[1].map(candidate => candidate.item)
    .sort((left, right) => left.staged_ci_id.localeCompare(right.staged_ci_id));
  for (const candidate of candidates.filter(candidate => candidate.reason)) {
    exclusions.push({ staged_ci_id: candidate.item.staged_ci_id, name: candidate.item.name, reason: candidate.reason! });
  }
  for (const candidate of candidates.filter(candidate => !candidate.reason && !selectedSet.has(candidate.item.staged_ci_id))) {
    exclusions.push({ staged_ci_id: candidate.item.staged_ci_id, name: candidate.item.name, code: "PACKET_RISK_FAMILY_MISMATCH", reason: "Record belongs to a different authoritative operation-risk family." });
  }

  const selected = eligible.slice(0, APPROVAL_PACKET_MAX_ITEMS);
  const deferred = Math.max(0, eligible.length - selected.length);
  const plans = partitionPlans(snapshot.migrationRunId, all.work_group_signature, all.group_title, selected);
  const packetId = approvalPacketId(snapshot.migrationRunId, all.work_group_signature, selected.map(item => item.staged_ci_id));
  return {
    success: true,
    stage: "planning",
    migration_run_id: snapshot.migrationRunId,
    packet_id: packetId,
    policy_version: APPROVAL_PACKET_POLICY_VERSION,
    work_group_signature: all.work_group_signature,
    group_title: all.group_title,
    class_name: selectedGroup[1][0].class_name!,
    operation_family: selectedGroup[1][0].operation_family!,
    max_items: APPROVAL_PACKET_MAX_ITEMS,
    max_children: APPROVAL_PACKET_MAX_CHILDREN,
    preparable_count: selected.length,
    deferred_count: deferred,
    children: plans.map((plan, index) => ({ child_index: index + 1, campaign_id: plan.campaign_id, item_count: plan.items.length, items: plan.items })),
    exclusions: uniqueExclusions(exclusions),
  };
}

export function pendingApprovalPacketProposals(snapshot: RemediationCampaignSnapshot): RemediationReviewProposalItem[] {
  const plan = planApprovalPacket(snapshot);
  return packetPlans(plan).flatMap(child => pendingRemediationReviewProposalsFromPlan(snapshot, child))
    .sort((left, right) => left.staged_ci_id.localeCompare(right.staged_ci_id));
}

export function prepareApprovalPacket(
  snapshot: RemediationCampaignSnapshot,
  selection: ApprovalPacketSelection = { migration_run_id: "" },
  now = Date.now(),
): FrozenApprovalPacket {
  const normalized = snapshotWithPacketApprovals(snapshot, selection);
  const planningSnapshot = snapshotWithoutPacketProgress(normalized, selection);
  const plan = planApprovalPacket(planningSnapshot);
  validatePlanSelection(plan, selection);
  const exclusions: ApprovalPacketExclusion[] = [...plan.exclusions];
  const children: ApprovalPacketChild[] = [];

  for (const childPlan of packetPlans(plan)) {
    const prepared = prepareRemediationApprovalManifestFromPlan(planningSnapshot, childPlan);
    const freshItems: RemediationApprovalManifestItem[] = [];
    for (const item of prepared.items) {
      const timestamp = simulationTimestamp(normalized.timeline, item);
      if (timestamp === undefined) {
        exclusions.push({ staged_ci_id: item.staged_ci_id, name: item.name, child_campaign_id: childPlan.campaign_id, code: "PACKET_FRESHNESS_MISSING", reason: "Completed simulation freshness could not be verified." });
      } else {
        freshItems.push(item);
      }
    }
    for (const item of prepared.exclusions) {
      exclusions.push({ ...item, child_campaign_id: childPlan.campaign_id });
    }
    if (!freshItems.length) continue;
    const manifestId = approvalManifestHash(childPlan.campaign_id, freshItems);
    children.push({
      child_index: children.length + 1,
      campaign_id: childPlan.campaign_id,
      manifest_id: manifestId,
      item_count: freshItems.length,
      operation_families: operationFamilies(freshItems),
      items: freshItems,
    });
  }

  const items = children.flatMap(child => child.items);
  const base = packetBase(plan, children, items, exclusions, normalized);
  if (!items.length) return { ...base, success: false, stage: "blocked", children, items, exclusions: uniqueExclusions(exclusions), samples: [], aggregate: aggregate(normalized, children, exclusions) };
  const oldest = Math.min(...items.map(item => simulationTimestamp(normalized.timeline, item)!).filter(value => value !== undefined));
  const expiresAt = new Date(oldest + APPROVAL_PACKET_TTL_MS).toISOString();
  const packetId = approvalPacketId(normalized.migrationRunId, plan.work_group_signature, items.map(item => item.staged_ci_id));
  const packetHash = approvalPacketHash(normalized.migrationRunId, children, expiresAt);
  const frozen: FrozenApprovalPacket = {
    ...base,
    success: now < Date.parse(expiresAt),
    stage: now < Date.parse(expiresAt) ? "review_ready" : "expired",
    packet_id: packetId,
    packet_hash: packetHash,
    expires_at: expiresAt,
    children,
    items,
    exclusions: uniqueExclusions(exclusions),
    samples: packetSamples(normalized, packetId, children),
    aggregate: aggregate(normalized, children, exclusions),
  };
  validateFrozenSelection(frozen, selection);
  return frozen;
}

export function approvalPacketHash(migrationRunId: string, children: ApprovalPacketChild[], expiresAt: string) {
  const canonical = [...children]
    .sort((left, right) => left.campaign_id.localeCompare(right.campaign_id))
    .map(child => [child.campaign_id, child.manifest_id, child.item_count, [...child.operation_families].sort().join(",")].join("|"))
    .join("\n");
  return createHash("sha256")
    .update(`${APPROVAL_PACKET_POLICY_VERSION}|${migrationRunId.toLowerCase()}|${canonical}|${expiresAt}`)
    .digest("hex").toUpperCase();
}

export async function approveApprovalPacket(
  initialSnapshot: RemediationCampaignSnapshot,
  selection: ApprovalPacketSelection,
  approve: (item: RemediationApprovalManifestItem, request: { correlation_id: string; idempotency_key: string }) => Promise<IreActionResponse>,
  reload: () => Promise<RemediationCampaignSnapshot>,
  now = Date.now(),
): Promise<ApprovalPacketApprovalResult> {
  let snapshot = initialSnapshot;
  const packet = prepareApprovalPacket(snapshot, selection, now);
  if (!packet.packet_id || !packet.packet_hash || packet.stage !== "review_ready") {
    throw campaignError(packet.stage === "expired" ? "PACKET_EXPIRED" : "PACKET_NOT_READY", "Approval packet is not fresh and review-ready.");
  }
  const results: ApprovalPacketApprovalItem[] = [];
  let halted: ApprovalPacketApprovalResult["halted"];
  for (const child of packet.children) {
    for (const item of child.items) {
      const existing = exactPacketApproval(snapshot.timeline, packet, item);
      if (existing) {
        results.push(actionResult(item, child.campaign_id, { success: true, action: "approve", state: "approved_for_execution", status: "approved" }, true));
        continue;
      }
      const generated = packetApprovalTokens(packet, item.staged_ci_id);
      let response: IreActionResponse;
      try {
        response = await approve(item, generated);
      } catch (error) {
        response = { success: false, action: "approve", state: "approved_for_execution", error: { code: "UPSTREAM_UNREACHABLE", message: error instanceof Error ? error.message : "Approval outcome is ambiguous." } };
      }
      if (response.success) {
        results.push(actionResult(item, child.campaign_id, response));
        continue;
      }
      const code = response.error?.code ?? "IRE_FAILED";
      if (SYSTEMIC_PACKET_CODES.has(code)) {
        snapshot = await reload();
        if (exactPacketApproval(snapshot.timeline, packet, item)) {
          results.push(actionResult(item, child.campaign_id, response, true, true));
          continue;
        }
        halted = { code: code === "UPSTREAM_UNREACHABLE" ? "PACKET_APPROVAL_AMBIGUOUS" : code, message: response.error?.message ?? "Packet approval halted after a systemic failure." };
        results.push(actionResult(item, child.campaign_id, response));
        break;
      }
      results.push(actionResult(item, child.campaign_id, response));
    }
    if (halted) break;
  }
  const approved = results.filter(item => item.success).length;
  return {
    success: approved > 0 && !halted,
    stage: halted ? "blocked" : approved ? "executing" : "blocked",
    migration_run_id: packet.migration_run_id,
    packet_id: packet.packet_id,
    packet_hash: packet.packet_hash,
    items: results,
    aggregate: { ...packet.aggregate, approved, executing: approved, blocked: packet.aggregate.excluded + results.filter(item => !item.success).length },
    halted,
  };
}

export function approvalPacketStatus(
  snapshot: RemediationCampaignSnapshot,
  selection: ApprovalPacketSelection,
  now = Date.now(),
): ApprovalPacketStatus {
  const packet = prepareApprovalPacket(snapshot, selection, now);
  if (!packet.packet_id || !packet.packet_hash || !packet.expires_at) throw campaignError("PACKET_NOT_FOUND", "Frozen packet evidence could not be reconstructed.");
  const items: ApprovalPacketProgressItem[] = [];
  for (const child of packet.children) {
    for (const item of child.items) items.push(packetProgress(snapshot.timeline, packet, child, item));
  }
  const counts = {
    approved: items.filter(item => item.state !== "awaiting_approval").length,
    executing: items.filter(item => item.state === "executing").length,
    verifying: items.filter(item => item.state === "verifying").length,
    verified: items.filter(item => item.state === "verified").length,
    blocked: items.filter(item => item.state === "blocked").length,
  };
  const terminal = counts.verified + counts.blocked === items.length;
  const stage: ApprovalPacketStage = terminal
    ? counts.verified ? "completed" : "blocked"
    : counts.executing ? "executing"
      : counts.verifying ? "verifying"
        : counts.approved ? "executing"
          : packet.stage;
  return {
    success: true,
    stage,
    migration_run_id: packet.migration_run_id,
    packet_id: packet.packet_id,
    packet_hash: packet.packet_hash,
    expires_at: packet.expires_at,
    children: packet.children.map(child => {
      const scoped = items.filter(item => item.child_campaign_id === child.campaign_id);
      return { campaign_id: child.campaign_id, manifest_id: child.manifest_id, item_count: child.item_count, verified: scoped.filter(item => item.state === "verified").length, blocked: scoped.filter(item => item.state === "blocked").length };
    }),
    items,
    exclusions: packet.exclusions,
    aggregate: { ...packet.aggregate, ...counts, blocked: packet.aggregate.excluded + counts.blocked },
  };
}

export function recoverLatestApprovalPacketSelection(snapshot: RemediationCampaignSnapshot): ApprovalPacketSelection | undefined {
  const groups = new Map<string, { packet_id: string; packet_hash: string; ids: Set<string>; freshness: number }>();
  for (const event of snapshot.timeline) {
    const detail = eventObject(event);
    if (detail.action !== "approval_recorded") continue;
    const correlation = stringField(detail.correlation_id);
    const idempotency = stringField(detail.idempotency_key);
    const correlationMatch = correlation.match(/^ks-packet:([0-9A-F]{24}):approve:/i);
    const keyMatch = idempotency.match(/^keystone:packet:([0-9A-F]{64}):approve:([0-9a-f]{32})$/i);
    if (!correlationMatch || !keyMatch) continue;
    const packetId = correlationMatch[1].toUpperCase();
    const packetHash = keyMatch[1].toUpperCase();
    const key = `${packetId}:${packetHash}`;
    const current = groups.get(key) ?? { packet_id: packetId, packet_hash: packetHash, ids: new Set<string>(), freshness: 0 };
    current.ids.add(keyMatch[2].toLowerCase());
    current.freshness = Math.max(current.freshness, eventFreshness(event));
    groups.set(key, current);
  }
  const latest = [...groups.values()].sort((left, right) => right.freshness - left.freshness)[0];
  if (!latest) return undefined;
  return { migration_run_id: snapshot.migrationRunId, packet_id: latest.packet_id, packet_hash: latest.packet_hash };
}

export function packetApprovalTokens(packet: Pick<FrozenApprovalPacket, "packet_id" | "packet_hash">, stagedCiId: string) {
  if (!packet.packet_id || !packet.packet_hash) throw campaignError("PACKET_NOT_READY", "Frozen packet identifiers are required.");
  return {
    correlation_id: `ks-packet:${packet.packet_id}:approve:${itemToken(stagedCiId)}`,
    idempotency_key: `keystone:packet:${packet.packet_hash}:approve:${stagedCiId.toLowerCase()}`,
  };
}

function packetPlans(plan: ApprovalPacketPlan) {
  return plan.children.map(child => buildRemediationCampaignPlan(plan.migration_run_id, plan.work_group_signature, plan.group_title, child.items));
}

function partitionPlans(runId: string, signature: string, title: string, items: RemediationCampaignPlan["items"]) {
  const plans: RemediationCampaignPlan[] = [];
  for (let index = 0; index < items.length; index += CAMPAIGN_LIMIT) {
    plans.push(buildRemediationCampaignPlan(runId, signature, title, items.slice(index, index + CAMPAIGN_LIMIT)));
  }
  return plans;
}

function packetBase(plan: ApprovalPacketPlan, children: ApprovalPacketChild[], items: RemediationApprovalManifestItem[], exclusions: ApprovalPacketExclusion[], snapshot: RemediationCampaignSnapshot) {
  return {
    migration_run_id: plan.migration_run_id,
    policy_version: APPROVAL_PACKET_POLICY_VERSION,
    work_group_signature: plan.work_group_signature,
    group_title: plan.group_title,
    class_name: plan.class_name,
    operation_family: plan.operation_family,
    children,
    items,
    exclusions,
    samples: [] as ApprovalPacketSample[],
    aggregate: aggregate(snapshot, children, exclusions),
  };
}

function snapshotWithPacketApprovals(snapshot: RemediationCampaignSnapshot, selection: ApprovalPacketSelection) {
  if (!selection.packet_id || !selection.packet_hash) return snapshot;
  const approvedReviewIds = new Set<string>();
  for (const event of snapshot.timeline) {
    const detail = eventObject(event);
    const correlation = stringField(detail.correlation_id);
    const idempotency = stringField(detail.idempotency_key);
    if (detail.action === "approval_recorded" && correlation.startsWith(`ks-packet:${selection.packet_id}:approve:`) && idempotency.startsWith(`keystone:packet:${selection.packet_hash}:approve:`)) {
      const reviewId = stringField(detail.review_decision_id).toLowerCase();
      if (/^[0-9a-f]{32}$/.test(reviewId)) approvedReviewIds.add(reviewId);
    }
  }
  if (!approvedReviewIds.size) return snapshot;
  return { ...snapshot, reviews: snapshot.reviews.map(review => approvedReviewIds.has(review.id.toLowerCase()) ? { ...review, decision: "deferred" } : review) };
}

function snapshotWithoutPacketProgress(snapshot: RemediationCampaignSnapshot, selection: ApprovalPacketSelection) {
  if (!selection.packet_id || !selection.packet_hash) return snapshot;
  const approvalIds = new Set<string>();
  for (const event of snapshot.timeline) {
    const detail = eventObject(event);
    if (detail.action === "approval_recorded" &&
        stringField(detail.correlation_id).startsWith(`ks-packet:${selection.packet_id}:approve:`) &&
        stringField(detail.idempotency_key).startsWith(`keystone:packet:${selection.packet_hash}:approve:`)) {
      approvalIds.add(event.id.toLowerCase());
    }
  }
  if (!approvalIds.size) return snapshot;
  return {
    ...snapshot,
    timeline: snapshot.timeline.filter(event => {
      const detail = eventObject(event);
      return !approvalIds.has(event.id.toLowerCase()) && !approvalIds.has(stringField(detail.approval_event_id).toLowerCase());
    }),
  };
}

function validatePlanSelection(plan: ApprovalPacketPlan, selection: ApprovalPacketSelection) {
  if (selection.migration_run_id && selection.migration_run_id.toLowerCase() !== plan.migration_run_id.toLowerCase()) throw campaignError("PACKET_RUN_MISMATCH", "Packet run does not match authoritative evidence.");
}

function validateFrozenSelection(packet: FrozenApprovalPacket, selection: ApprovalPacketSelection) {
  if (selection.packet_id && packet.packet_id !== selection.packet_id) throw campaignError("PACKET_STALE", "Packet identifier changed and must be reviewed again.");
  if (selection.packet_hash && packet.packet_hash !== selection.packet_hash) throw campaignError("PACKET_HASH_STALE", "Packet hash changed and must be reviewed again.");
  const childIds = normalizeHex(selection.child_manifest_ids, 64);
  if (childIds.length && childIds.join("|") !== packet.children.map(child => child.manifest_id).sort().join("|")) throw campaignError("PACKET_CHILD_DRIFT", "Child manifest hashes changed and must be reviewed again.");
  const stagedIds = normalizeIds(selection.staged_ci_ids);
  if (stagedIds.length && stagedIds.join("|") !== packet.items.map(item => item.staged_ci_id.toLowerCase()).sort().join("|")) throw campaignError("PACKET_MEMBERSHIP_CHANGED", "Packet membership changed and must be reviewed again.");
}

function exactPacketApproval(timeline: TimelineEvent[], packet: FrozenApprovalPacket, item: RemediationApprovalManifestItem) {
  const tokens = packetApprovalTokens(packet, item.staged_ci_id);
  return timeline.find(event => {
    const detail = eventObject(event);
    return detail.action === "approval_recorded" &&
      stringField(detail.staged_ci_id).toLowerCase() === item.staged_ci_id.toLowerCase() &&
      stringField(detail.finding_id).toLowerCase() === item.finding_id.toLowerCase() &&
      stringField(detail.review_decision_id).toLowerCase() === item.review_decision_id.toLowerCase() &&
      stringField(detail.correlation_id) === tokens.correlation_id &&
      stringField(detail.idempotency_key) === tokens.idempotency_key &&
      stringField(detail.simulation_correlation_id) === item.simulation_correlation_id &&
      stringField(detail.simulation_fingerprint).toUpperCase() === item.simulation_fingerprint.toUpperCase();
  });
}

function packetProgress(timeline: TimelineEvent[], packet: FrozenApprovalPacket, child: ApprovalPacketChild, item: RemediationApprovalManifestItem): ApprovalPacketProgressItem {
  const approval = exactPacketApproval(timeline, packet, item);
  const base = { staged_ci_id: item.staged_ci_id, name: item.name, child_campaign_id: child.campaign_id, operation: item.operation };
  if (!approval) return { ...base, state: "awaiting_approval" };
  const bound = timeline.filter(event => {
    const detail = eventObject(event);
    return event.id === approval.id || stringField(detail.approval_event_id).toLowerCase() === approval.id.toLowerCase();
  }).sort((left, right) => eventFreshness(left) - eventFreshness(right));
  const latest = bound.at(-1);
  const detail = latest ? eventObject(latest) : {};
  const action = stringField(detail.action);
  const common = {
    ...base,
    approval_event_id: approval.id,
    execution_correlation_id: stringField(detail.execution_correlation_id || detail.execution_event_id) || undefined,
    target_ci_sys_id: stringField(detail.target_ci_sys_id) || undefined,
  };
  if (action === "verification_passed") return { ...common, state: "verified" };
  if (["verification_failed", "ire_execution_failed", "ire_execution_reconciliation_required"].includes(action)) return { ...common, state: "blocked", blocker: stringField(detail.error_code) || action };
  if (["ire_verification_claimed", "ire_execution_completed"].includes(action)) return { ...common, state: "verifying" };
  if (action === "ire_execution_claimed") return { ...common, state: "executing" };
  return { ...common, state: "approved" };
}

function simulationTimestamp(timeline: TimelineEvent[], item: RemediationApprovalManifestItem) {
  const matches = timeline.filter(event => {
    const detail = parseCampaignEventDetail(event.reasoning);
    return detail?.action === "ire_simulation_completed" &&
      detail.staged_ci_id?.toLowerCase() === item.staged_ci_id.toLowerCase() &&
      (detail.simulation_correlation_id || detail.correlation_id) === item.simulation_correlation_id &&
      detail.simulation_fingerprint?.toUpperCase() === item.simulation_fingerprint.toUpperCase();
  }).sort((left, right) => eventFreshness(left) - eventFreshness(right));
  const event = matches.at(-1);
  if (!event) return undefined;
  const parsed = Date.parse((event.time || "").trim().replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function aggregate(snapshot: RemediationCampaignSnapshot, children: ApprovalPacketChild[], exclusions: ApprovalPacketExclusion[]): ApprovalPacketAggregate {
  const result: ApprovalPacketAggregate = {
    total: 0, children: children.length,
    operations: { INSERT: 0, UPDATE: 0, NO_CHANGE: 0 },
    risks: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    excluded: uniqueExclusions(exclusions).length, blocked: uniqueExclusions(exclusions).length,
    approved: 0, executing: 0, verifying: 0, verified: 0,
  };
  const findings = new Map(snapshot.findings.map(finding => [finding.id.toLowerCase(), finding]));
  for (const item of children.flatMap(child => child.items)) {
    result.total++;
    result.operations[item.operation]++;
    result.risks[risk(findings.get(item.finding_id.toLowerCase())?.severity)]++;
  }
  return result;
}

function packetSamples(snapshot: RemediationCampaignSnapshot, packetId: string, children: ApprovalPacketChild[]) {
  const cis = new Map(snapshot.cis.flatMap(ci => [[ci.id.toLowerCase(), ci], [(ci.stagedCiId || ci.id).toLowerCase(), ci]]));
  const findings = new Map(snapshot.findings.map(finding => [finding.id.toLowerCase(), finding]));
  const selected: Array<{ child: ApprovalPacketChild; item: RemediationApprovalManifestItem }> = [];
  for (const child of children) if (child.items[0]) selected.push({ child, item: child.items[0] });
  const used = new Set(selected.map(entry => entry.item.staged_ci_id));
  const remaining = children.flatMap(child => child.items.map(item => ({ child, item })))
    .filter(entry => !used.has(entry.item.staged_ci_id))
    .sort((left, right) => sampleRank(packetId, left.item.staged_ci_id).localeCompare(sampleRank(packetId, right.item.staged_ci_id)));
  selected.push(...remaining.slice(0, Math.max(0, APPROVAL_PACKET_SAMPLE_LIMIT - selected.length)));
  return selected.slice(0, APPROVAL_PACKET_SAMPLE_LIMIT).map(({ child, item }) => ({
    staged_ci_id: item.staged_ci_id,
    name: item.name,
    class_name: item.proposed_class ?? cis.get(item.staged_ci_id.toLowerCase())?.className ?? "Unknown",
    operation: item.operation,
    risk: risk(findings.get(item.finding_id.toLowerCase())?.severity),
    child_campaign_id: child.campaign_id,
    simulation_fingerprint: item.simulation_fingerprint,
  }));
}

function actionResult(item: RemediationApprovalManifestItem, childCampaignId: string, response: IreActionResponse, reconciled = false, forceSuccess = false): ApprovalPacketApprovalItem {
  return {
    staged_ci_id: item.staged_ci_id,
    name: item.name,
    child_campaign_id: childCampaignId,
    success: forceSuccess || response.success,
    state: forceSuccess ? "approved_for_execution" : response.state,
    error_code: forceSuccess ? undefined : response.error?.code,
    message: forceSuccess ? "Persisted ServiceNow evidence reconciled the ambiguous approval outcome." : response.error?.message,
    simulation_correlation_id: item.simulation_correlation_id,
    simulation_fingerprint: item.simulation_fingerprint,
    reconciled: reconciled || undefined,
  };
}

function approvalPacketId(runId: string, signature: string, stagedCiIds: string[]) {
  return createHash("sha256")
    .update(`keystone.approval-packet.id.v1|${runId.toLowerCase()}|${signature}|${[...stagedCiIds].map(value => value.toLowerCase()).sort().join("|")}`)
    .digest("hex").slice(0, 24).toUpperCase();
}

function operationFamilies(items: RemediationApprovalManifestItem[]) {
  return [...new Set(items.map(item => item.operation))].sort() as ApprovalPacketChild["operation_families"];
}

function operationFamily(operation: string) {
  return operation === "UPDATE" ? "safe-update" : operation === "INSERT" ? "insert" : undefined;
}

function latestAuthoritativeOperationFamily(timeline: TimelineEvent[], stagedCiId: string) {
  const event = [...timeline]
    .filter(candidate => {
      const detail = parseCampaignEventDetail(candidate.reasoning);
      return detail?.action === "ire_simulation_completed" && detail.staged_ci_id?.toLowerCase() === stagedCiId.toLowerCase();
    })
    .sort((left, right) => eventFreshness(left) - eventFreshness(right))
    .at(-1);
  if (!event) return undefined;
  const operation = parseCampaignEventDetail(event.reasoning)?.operation?.toUpperCase();
  return operation === "INSERT" || operation === "UPDATE" ? operationFamily(operation) : undefined;
}

function latestAuthoritativeClass(timeline: TimelineEvent[], stagedCiId: string) {
  const event = [...timeline]
    .filter(candidate => {
      const detail = parseCampaignEventDetail(candidate.reasoning);
      return detail?.action === "ire_simulation_completed" && detail.staged_ci_id?.toLowerCase() === stagedCiId.toLowerCase();
    })
    .sort((left, right) => eventFreshness(left) - eventFreshness(right))
    .at(-1);
  return event ? parseCampaignEventDetail(event.reasoning)?.proposed_class : undefined;
}

function risk(value?: string): keyof ApprovalPacketAggregate["risks"] {
  const normalized = (value || "").toLowerCase();
  return normalized === "critical" || normalized === "high" || normalized === "medium" || normalized === "low" ? normalized : "unknown";
}

function uniqueExclusions(items: ApprovalPacketExclusion[]) {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.staged_ci_id}:${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.staged_ci_id.localeCompare(right.staged_ci_id) || left.reason.localeCompare(right.reason));
}

function eventObject(event: TimelineEvent): Record<string, unknown> {
  const parsed = parseCampaignEventDetail(event.reasoning);
  return parsed ? parsed as unknown as Record<string, unknown> : {};
}

function eventFreshness(event: TimelineEvent) {
  const parsed = Date.parse((event.time || "").trim().replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : event.seq;
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeIds(values?: string[]) {
  return [...new Set((values ?? []).map(value => value.trim().toLowerCase()).filter(value => /^[0-9a-f]{32}$/.test(value)))].sort();
}

function normalizeHex(values: string[] | undefined, length: number) {
  return [...new Set((values ?? []).map(value => value.trim().toUpperCase()).filter(value => new RegExp(`^[0-9A-F]{${length}}$`).test(value)))].sort();
}

function itemToken(stagedCiId: string) {
  return createHash("sha256").update(stagedCiId.toLowerCase()).digest("hex").slice(0, 12);
}

function sampleRank(packetId: string, stagedCiId: string) {
  return createHash("sha256").update(`${packetId}|${stagedCiId.toLowerCase()}`).digest("hex");
}

const SYSTEMIC_PACKET_CODES = new Set(["NOT_CONFIGURED", "UNAUTHORIZED", "FORBIDDEN", "UPSTREAM_UNREACHABLE", "RUN_STATE_INVALID"]);
