import type { ConfigurationItem, TimelineEvent } from "../../cmdb-data";
import type { RemediationCampaignPlan } from "./remediation-campaign";

const PERSISTED_CAMPAIGN_ACTIONS = new Set([
  "approval_recorded", "approval_resume_prepared", "ire_execution_claimed",
  "ire_execution_completed", "ire_execution_failed", "ire_execution_reconciliation_required",
  "ire_verification_claimed", "verification_passed", "verification_failed",
]);

type CampaignEvidence = {
  campaignId: string;
  stagedCiIds: Set<string>;
  freshness: number;
};

/** Recover the latest approved campaign solely from persisted ServiceNow evidence. */
export function recoverLatestCampaignPlan(
  migrationRunId: string,
  cis: ConfigurationItem[],
  timeline: TimelineEvent[],
): RemediationCampaignPlan | undefined {
  const campaigns = new Map<string, CampaignEvidence>();
  for (const event of timeline) {
    const detail = eventDetail(event.reasoning);
    if (!detail || !PERSISTED_CAMPAIGN_ACTIONS.has(detail.action)) continue;
    if (detail.migration_run_id?.toLowerCase() !== migrationRunId.toLowerCase()) continue;
    const correlation = detail.correlation_id ?? "";
    const match = correlation.match(/^ks-campaign:([0-9a-f]{24}):approve:/i);
    const stagedCiId = detail.staged_ci_id?.toLowerCase();
    if (!match || !stagedCiId || !/^[0-9a-f]{32}$/.test(stagedCiId)) continue;
    const campaignId = match[1].toUpperCase();
    const current = campaigns.get(campaignId) ?? { campaignId, stagedCiIds: new Set<string>(), freshness: 0 };
    current.stagedCiIds.add(stagedCiId);
    current.freshness = Math.max(current.freshness, eventFreshness(event));
    campaigns.set(campaignId, current);
  }

  const latest = [...campaigns.values()].sort((left, right) => right.freshness - left.freshness || right.campaignId.localeCompare(left.campaignId))[0];
  if (!latest?.stagedCiIds.size) return undefined;
  const byId = new Map(cis.flatMap(ci => [
    [ci.id.toLowerCase(), ci] as const,
    [(ci.stagedCiId || ci.id).toLowerCase(), ci] as const,
  ]));
  const stagedCiIds = [...latest.stagedCiIds].sort();
  const selected = stagedCiIds.map(id => byId.get(id));
  if (selected.some(ci => !ci)) return undefined;
  const items = selected as ConfigurationItem[];
  const className = items[0].className;
  const operationFamily = safeOperationFamily(items[0].operation);
  if (items.some(ci => ci.className !== className || safeOperationFamily(ci.operation) !== operationFamily)) return undefined;
  const signature = `eligible:${slug(className)}:${operationFamily}`;
  return {
    success: true,
    stage: "planning",
    migration_run_id: migrationRunId,
    campaign_id: latest.campaignId,
    work_group_signature: signature,
    group_title: `Remediate ${className} ${operationFamily}`,
    max_items: items.length,
    deferred_count: 0,
    items: items.map(ci => ({
      staged_ci_id: ci.stagedCiId || ci.id,
      name: ci.name,
      class_name: ci.className,
      staged_operation: ci.operation,
      lifecycle: "persisted",
    })).sort((left, right) => left.staged_ci_id.localeCompare(right.staged_ci_id)),
    exclusions: [],
  };
}

function eventDetail(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      action: typeof parsed.action === "string" ? parsed.action : "",
      migration_run_id: typeof parsed.migration_run_id === "string" ? parsed.migration_run_id : undefined,
      staged_ci_id: typeof parsed.staged_ci_id === "string" ? parsed.staged_ci_id : undefined,
      correlation_id: typeof parsed.correlation_id === "string" ? parsed.correlation_id : undefined,
    };
  } catch {
    return null;
  }
}

function eventFreshness(event: TimelineEvent) {
  const parsed = Date.parse((event.time || "").trim().replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : event.seq;
}

function safeOperationFamily(operation: string) {
  return operation === "UPDATE" || operation === "NO_CHANGE" ? "safe-update" : operation.toLowerCase();
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "unclassified";
}
