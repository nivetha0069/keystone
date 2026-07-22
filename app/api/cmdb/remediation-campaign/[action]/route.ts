import {
  approveRemediationCampaign,
  campaignError,
  planRemediationCampaign,
  prepareRemediationApprovalManifest,
  remediationCampaignStatus,
  simulateRemediationCampaign,
  type CampaignSelection,
} from "../../../../lib/cmdb/remediation-campaign";
import { invokeCampaignIre, loadCampaignSnapshot } from "../../../../lib/cmdb/server-campaign-bridge";

const ACTIONS = new Set(["plan", "simulate", "prepare-approval", "approve", "status"]);
const FORBIDDEN_EXECUTABLE_FIELDS = new Set([
  "attributes", "class", "class_name", "cmdb_values", "decision", "mapping", "mapping_version",
  "operation", "payload", "proposed_class", "rationale", "strategy", "strategy_id", "values",
]);

export async function GET() {
  return Response.json({ error: "Use POST for remediation campaign actions.", allowed: ["POST"] }, { status: 405, headers: { allow: "POST" } });
}

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (!ACTIONS.has(action)) return Response.json({ error: "Unknown remediation campaign action." }, { status: 404 });
  const incoming = await request.json().catch(() => ({})) as Record<string, unknown>;
  try {
    rejectExecutableFields(incoming);
    const selection = campaignSelection(incoming);
    const snapshot = await loadCampaignSnapshot(selection.migration_run_id);
    if (action === "plan") {
      return Response.json({
        ...planRemediationCampaign(snapshot, selection.work_group_signature || undefined, selection.limit),
        approval_enabled: process.env.CMDB_AGENT_BATCH_APPROVAL_ENABLED === "true",
      });
    }
    if (!selection.work_group_signature || !selection.campaign_id || !selection.staged_ci_ids?.length) {
      throw campaignError("INVALID_REQUEST", "Campaign id, work-group signature, and staged CI identifiers are required.");
    }
    if (action === "simulate") {
      const result = await simulateRemediationCampaign(snapshot, selection, (item, generated) => invokeCampaignIre("simulate", {
        migration_run_id: selection.migration_run_id,
        staged_ci_id: item.staged_ci_id,
        correlation_id: generated.correlation_id,
        idempotency_key: generated.idempotency_key,
      }));
      return Response.json(result);
    }
    if (action === "prepare-approval") {
      return Response.json(prepareRemediationApprovalManifest(snapshot, selection));
    }
    if (action === "status") {
      return Response.json(remediationCampaignStatus(snapshot, selection));
    }
    if (process.env.CMDB_AGENT_BATCH_APPROVAL_ENABLED !== "true") {
      return Response.json({ error: "Grouped approval is disabled until the manifest-specific action gate is opened.", code: "CAMPAIGN_APPROVAL_DISABLED" }, { status: 403 });
    }
    if (!selection.manifest_id) throw campaignError("INVALID_REQUEST", "A frozen manifest id is required for grouped approval.");
    const result = await approveRemediationCampaign(snapshot, selection, (item, generated) => invokeCampaignIre("approve", {
      migration_run_id: selection.migration_run_id,
      staged_ci_id: item.staged_ci_id,
      finding_id: item.finding_id,
      review_decision_id: item.review_decision_id,
      simulation_correlation_id: item.simulation_correlation_id,
      simulation_fingerprint: item.simulation_fingerprint,
      correlation_id: generated.correlation_id,
      idempotency_key: generated.idempotency_key,
    }));
    return Response.json(result);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as Error & { code: string }).code) : "CAMPAIGN_FAILED";
    const status = code === "NOT_CONFIGURED" || code === "UPSTREAM_UNREACHABLE" ? 503 : code === "UNAUTHORIZED" ? 401 : code === "FORBIDDEN" ? 403 : code.includes("NOT_FOUND") ? 404 : 409;
    return Response.json({ error: error instanceof Error ? error.message : "Remediation campaign failed.", code }, { status });
  }
}

function rejectExecutableFields(incoming: Record<string, unknown>) {
  const forbidden = Object.keys(incoming).filter(key => FORBIDDEN_EXECUTABLE_FIELDS.has(key.toLowerCase()));
  if (forbidden.length) {
    throw campaignError("INVALID_REQUEST", `Campaign executable fields are server-derived and cannot be submitted: ${forbidden.sort().join(", ")}.`);
  }
}

function campaignSelection(incoming: Record<string, unknown>): CampaignSelection {
  const migrationRunId = identifier(incoming.migration_run_id ?? incoming.migrationRunId);
  if (!migrationRunId) throw campaignError("INVALID_REQUEST", "A canonical migration_run_id is required.");
  const ids = Array.isArray(incoming.staged_ci_ids)
    ? incoming.staged_ci_ids.map(identifier).filter((value): value is string => Boolean(value))
    : [];
  if (ids.length > 20 || new Set(ids).size !== ids.length) {
    throw campaignError("INVALID_REQUEST", "Campaign staged_ci_ids must contain at most 20 unique canonical identifiers.");
  }
  return {
    migration_run_id: migrationRunId,
    work_group_signature: token(incoming.work_group_signature, 180),
    campaign_id: hex(incoming.campaign_id, 24),
    manifest_id: hex(incoming.manifest_id, 64),
    staged_ci_ids: ids,
    limit: numericLimit(incoming.limit),
  };
}

function identifier(value: unknown) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{32}$/.test(candidate) ? candidate : "";
}

function token(value: unknown, max: number) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return candidate.length <= max && /^[a-zA-Z0-9:._-]*$/.test(candidate) ? candidate : "";
}

function hex(value: unknown, length: number) {
  const candidate = typeof value === "string" ? value.trim().toUpperCase() : "";
  return new RegExp(`^[0-9A-F]{${length}}$`).test(candidate) ? candidate : undefined;
}

function numericLimit(value: unknown) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : 20;
}
