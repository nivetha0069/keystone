import {
  approveRemediationCampaign,
  campaignError,
  pendingRemediationReviewProposals,
  planRemediationCampaign,
  prepareRemediationApprovalManifest,
  remediationFailureGroups,
  remediationCampaignStatus,
  retryRemediationCampaign,
  simulateRemediationCampaign,
  type CampaignSelection,
} from "../../../../lib/cmdb/remediation-campaign";
import {
  approveApprovalPacket,
  approvalPacketStatus,
  pendingApprovalPacketProposals,
  planApprovalPacket,
  prepareApprovalPacket,
  recoverLatestApprovalPacketSelection,
  type ApprovalPacketSelection,
} from "../../../../lib/cmdb/approval-packet";
import { invokeCampaignIre, invokeCampaignProposal, loadCampaignSnapshot } from "../../../../lib/cmdb/server-campaign-bridge";

const ACTIONS = new Set(["plan", "failure-groups", "simulate", "retry", "prepare-approval", "approve", "status", "plan-packet", "prepare-packet", "approve-packet", "packet-status"]);
const FORBIDDEN_EXECUTABLE_FIELDS = new Set([
  "attributes", "class", "class_name", "cmdb_values", "decision", "mapping", "mapping_version",
  "identity_evidence", "operation", "payload", "policy_version", "proposed_class", "rationale",
  "retry_count", "max_retries", "source_identifier", "strategy", "strategy_id", "values",
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
    if (action.endsWith("packet") || action === "packet-status") {
      return await handlePacketAction(action, incoming);
    }
    const selection = campaignSelection(incoming);
    const snapshot = await loadCampaignSnapshot(selection.migration_run_id);
    if (action === "plan") {
      return Response.json({
        ...planRemediationCampaign(snapshot, selection.work_group_signature || undefined, selection.limit),
        approval_enabled: process.env.CMDB_AGENT_BATCH_APPROVAL_ENABLED === "true",
      });
    }
    if (action === "failure-groups") return Response.json(remediationFailureGroups(snapshot));
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
    if (action === "retry") {
      return Response.json(await retryRemediationCampaign(snapshot, selection, (item, generated) => invokeCampaignIre("simulate", {
        migration_run_id: selection.migration_run_id,
        staged_ci_id: item.staged_ci_id,
        correlation_id: generated.correlation_id,
        idempotency_key: generated.idempotency_key,
      })));
    }
    if (action === "prepare-approval") {
      const pending = pendingRemediationReviewProposals(snapshot, selection);
      for (const item of pending) {
        const response = await invokeCampaignProposal({
          migration_run_id: selection.migration_run_id,
          staged_ci_id: item.staged_ci_id,
          finding_id: item.finding_id,
          simulation_correlation_id: item.simulation_correlation_id,
          simulation_fingerprint: item.simulation_fingerprint,
          correlation_id: "ks-campaign:" + selection.campaign_id + ":prepare:" + item.staged_ci_id,
          idempotency_key: "keystone:campaign:" + selection.campaign_id + ":prepare:" + item.staged_ci_id,
        });
        // Never blindly retry an ambiguous proposal response. The fresh
        // snapshot below reconciles whether ServiceNow persisted the review.
        if (!response.success && systemicProposalFailure(response.error?.code)) break;
      }
      const refreshed = pending.length ? await loadCampaignSnapshot(selection.migration_run_id) : snapshot;
      return Response.json(prepareRemediationApprovalManifest(refreshed, selection));
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

async function handlePacketAction(action: string, incoming: Record<string, unknown>) {
  let selection = packetSelection(incoming);
  let snapshot = await loadCampaignSnapshot(selection.migration_run_id);
  if (action === "plan-packet") {
    const plan = planApprovalPacket(snapshot);
    return Response.json({ ...plan, approval_enabled: false, demo_mode: packetDemoMode() });
  }
  if (action === "prepare-packet") {
    const plan = planApprovalPacket(snapshot);
    const pending = pendingApprovalPacketProposals(snapshot);
    for (const item of pending) {
      const response = await invokeCampaignProposal({
        migration_run_id: selection.migration_run_id,
        staged_ci_id: item.staged_ci_id,
        finding_id: item.finding_id,
        simulation_correlation_id: item.simulation_correlation_id,
        simulation_fingerprint: item.simulation_fingerprint,
        correlation_id: `ks-packet:${plan.packet_id}:prepare:${item.staged_ci_id}`,
        idempotency_key: `keystone:packet:${plan.packet_id}:prepare:${item.staged_ci_id}`,
      });
      if (!response.success && systemicProposalFailure(response.error?.code)) break;
    }
    snapshot = pending.length ? await loadCampaignSnapshot(selection.migration_run_id) : snapshot;
    const packet = prepareApprovalPacket(snapshot, selection);
    return Response.json({
      ...packet,
      approval_enabled: packet.packet_hash ? exactPacketHashGate(packet.packet_hash) : false,
      demo_mode: packetDemoMode(),
    });
  }
  if (action === "packet-status") {
    if (!selection.packet_id || !selection.packet_hash) {
      selection = recoverLatestApprovalPacketSelection(snapshot) ?? selection;
    }
    return Response.json(approvalPacketStatus(snapshot, selection));
  }
  if (!selection.packet_id || !selection.packet_hash || !selection.child_manifest_ids?.length || !selection.staged_ci_ids?.length) {
    throw campaignError("INVALID_REQUEST", "Packet id, exact hash, child manifest hashes, and frozen staged CI identifiers are required.");
  }
  const recomputed = prepareApprovalPacket(snapshot, selection);
  if (!recomputed.packet_hash || !exactPacketHashGate(recomputed.packet_hash)) {
    return Response.json({ error: "Packet approval is locked until this exact hash is authorized server-side.", code: "PACKET_APPROVAL_DISABLED" }, { status: 403 });
  }
  const result = await approveApprovalPacket(snapshot, selection, (item, generated) => invokeCampaignIre("approve", {
    migration_run_id: selection.migration_run_id,
    staged_ci_id: item.staged_ci_id,
    finding_id: item.finding_id,
    review_decision_id: item.review_decision_id,
    simulation_correlation_id: item.simulation_correlation_id,
    simulation_fingerprint: item.simulation_fingerprint,
    correlation_id: generated.correlation_id,
    idempotency_key: generated.idempotency_key,
  }), () => loadCampaignSnapshot(selection.migration_run_id));
  return Response.json(result);
}

function systemicProposalFailure(code?: string) {
  return ["NOT_CONFIGURED", "UNAUTHORIZED", "FORBIDDEN", "UPSTREAM_UNREACHABLE"].includes(code || "");
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

function packetSelection(incoming: Record<string, unknown>): ApprovalPacketSelection {
  const migrationRunId = identifier(incoming.migration_run_id ?? incoming.migrationRunId);
  if (!migrationRunId) throw campaignError("INVALID_REQUEST", "A canonical migration_run_id is required.");
  const stagedIds = stringArray(incoming.staged_ci_ids, value => identifier(value));
  const childManifestIds = stringArray(incoming.child_manifest_ids, value => hex(value, 64));
  if (stagedIds.length > 100 || childManifestIds.length > 5) {
    throw campaignError("INVALID_REQUEST", "Approval packets contain at most 100 records and five child manifests.");
  }
  if (new Set(stagedIds).size !== stagedIds.length || new Set(childManifestIds).size !== childManifestIds.length) {
    throw campaignError("INVALID_REQUEST", "Packet identifiers must be unique.");
  }
  return {
    migration_run_id: migrationRunId,
    packet_id: hex(incoming.packet_id, 24),
    packet_hash: hex(incoming.packet_hash, 64),
    child_manifest_ids: childManifestIds,
    staged_ci_ids: stagedIds,
  };
}

function stringArray(value: unknown, normalize: (entry: unknown) => string | undefined) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw campaignError("INVALID_REQUEST", "Packet identifier collections must be arrays.");
  const normalized = value.map(normalize);
  if (normalized.some(entry => !entry)) throw campaignError("INVALID_REQUEST", "Packet identifier collection contains a malformed value.");
  return normalized as string[];
}

function exactPacketHashGate(packetHash: string) {
  return (process.env.CMDB_AGENT_APPROVAL_PACKET_HASH || "").trim().toUpperCase() === packetHash.toUpperCase();
}

function packetDemoMode() {
  if (process.env.CMDB_APPROVAL_PACKET_DEMO_MODE !== "true") return false;
  const endpoints = [
    process.env.CMDB_API_BASE_URL,
    process.env.CMDB_IRE_BASE_URL,
    process.env.CMDB_IRE_APPROVE_URL,
    process.env.CMDB_REMEDIATE_URL,
  ].filter((value): value is string => Boolean(value));
  return endpoints.length > 0 && endpoints.every(loopbackUrl);
}

function loopbackUrl(value: string) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}


function identifier(value: unknown) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{32}$/.test(candidate) ? candidate : "";
}

function token(value: unknown, max: number) {
  const candidate = typeof value === "string" ? value.trim() : "";
  // Work-group signatures are server-derived and may contain a normalized
  // class label with spaces (for example, `class_alias:linux srv:class`).
  // The campaign validator still requires an exact match to the authoritative
  // server-generated plan before any action is invoked.
  return candidate.length <= max && /^[a-zA-Z0-9:._ -]*$/.test(candidate) ? candidate : "";
}

function hex(value: unknown, length: number) {
  const candidate = typeof value === "string" ? value.trim().toUpperCase() : "";
  return new RegExp(`^[0-9A-F]{${length}}$`).test(candidate) ? candidate : undefined;
}

function numericLimit(value: unknown) {
  const candidate = Number(value);
  return Number.isFinite(candidate) ? candidate : 20;
}
