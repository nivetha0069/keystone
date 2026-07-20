import type { ServiceNowReference, ServiceNowSysId, SourceIdentity, StagedCiRecord } from "./contracts";

export type IreMode = "simulate" | "execute";

export type IreAction = "simulate" | "approve" | "execute" | "verify";

export type IreLifecycleState =
  | "not_simulated"
  | "simulation_failed"
  | "simulated_pending_approval"
  | "approved_for_execution"
  | "execution_rejected_stale_simulation"
  | "executing"
  | "executed_pending_verification"
  | "verified"
  | "verification_failed";

export type IrePreviewItem = {
  className: string;
  internal_id: string;
  values: Record<string, string | number | boolean>;
};

export type IrePreviewRelation = {
  parent_internal_id: string;
  child_internal_id: string;
  type?: string;
};

export type IrePayloadPreview = {
  items: IrePreviewItem[];
  relations: IrePreviewRelation[];
};

export type IreOperationPreview = {
  mode: IreMode;
  migration_run_id: ServiceNowSysId;
  staged_ci_id: ServiceNowSysId;
  source_identity: SourceIdentity;
  payload_preview: IrePayloadPreview;
};

export type IreValidationIssue = {
  code: "MISSING_CLASS" | "MISSING_INTERNAL_ID" | "MISSING_VALUES" | "EXECUTE_NOT_ALLOWED";
  message: string;
};

export type IreValidationResult = {
  valid: boolean;
  issues: IreValidationIssue[];
};

export type IreActionRequestBase = {
  migration_run_id: ServiceNowSysId;
  staged_ci_id: ServiceNowSysId;
  correlation_id: string;
  idempotency_key: string;
};

export type IreSimulateRequest = IreActionRequestBase;

export type IreApprovalRequest = IreActionRequestBase & {
  decision: "approved" | "rejected" | "deferred";
  rationale: string;
  simulation_correlation_id?: string;
};

export type IreExecuteRequest = IreActionRequestBase & {
  simulation_correlation_id: string;
};

export type IreVerifyRequest = IreActionRequestBase & {
  execution_correlation_id: string;
};

export type IreActionRequest = IreSimulateRequest | IreApprovalRequest | IreExecuteRequest | IreVerifyRequest;

export type IreActionError = {
  code:
    | "NOT_CONFIGURED"
    | "INVALID_REQUEST"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "SIMULATION_REQUIRED"
    | "APPROVAL_REQUIRED"
    | "STALE_SIMULATION"
    | "DUPLICATE_EXECUTION"
    | "IRE_FAILED"
    | "VERIFY_MISMATCH"
    | "UPSTREAM_UNREACHABLE";
  message: string;
  details?: unknown;
};

export type IreServiceBoundary = {
  simulate(stagedCiId: ServiceNowSysId): Promise<IreSimulationResult>;
  execute(stagedCiId: ServiceNowSysId): Promise<IreExecutionResult>;
};

export type IreSimulationResult = {
  mode: "simulate";
  staged_ci_id: ServiceNowSysId;
  matched_ci?: ServiceNowReference;
  status: "matched" | "new_ci" | "conflict" | "incomplete" | "failed";
  evidence?: string[];
};

export type IreExecutionResult = {
  mode: "execute";
  staged_ci_id: ServiceNowSysId;
  target_ci?: ServiceNowReference;
  status: "inserted" | "updated" | "unchanged" | "partially_verified" | "failed";
  verification_summary?: string;
};

export type IreActionResponse = {
  success: boolean;
  action: IreAction;
  state: IreLifecycleState;
  migration_run_id?: ServiceNowSysId;
  staged_ci_id?: ServiceNowSysId;
  correlation_id?: string;
  idempotency_key?: string;
  simulation_correlation_id?: string;
  execution_correlation_id?: string;
  simulation_fingerprint?: string;
  finding?: ServiceNowReference;
  review_decision?: ServiceNowReference;
  matched_ci?: ServiceNowReference;
  target_ci?: ServiceNowReference;
  status?: IreSimulationResult["status"] | IreExecutionResult["status"] | "approved" | "rejected" | "deferred" | "verified";
  operation?: "insert" | "update" | "unchanged" | "conflict" | "incomplete" | "failed";
  evidence?: string[];
  verification_summary?: string;
  playback_event_ids?: ServiceNowSysId[];
  error?: IreActionError;
};

export type IreLifecycleSnapshot = {
  simulation?: Pick<IreActionResponse, "success" | "state" | "status" | "simulation_correlation_id" | "correlation_id">;
  approval?: Pick<IreActionResponse, "success" | "state" | "status">;
  execution?: Pick<IreActionResponse, "success" | "state" | "execution_correlation_id" | "correlation_id" | "error">;
  verification?: Pick<IreActionResponse, "success" | "state" | "status" | "error">;
};

export const IRE_ACTIONS = ["simulate", "approve", "execute", "verify"] as const;

export function isIreAction(value: string): value is IreAction {
  return (IRE_ACTIONS as readonly string[]).includes(value);
}

export function createIreCorrelationId(prefix: IreAction, seed = Date.now()): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `ks-${prefix}-${seed}-${random}`;
}

export function buildIrePayloadPreview(record: StagedCiRecord): IrePayloadPreview {
  const parsedPayload = parsePayload(record.payload);
  const values = normalizedValues(parsedPayload);
  const internalId = record.source_identity?.source_native_key || record.source_identity?.source_record_id || record.source_identifier || record.number;

  return {
    items: [
      {
        className: record.proposed_class || "",
        internal_id: internalId,
        values,
      },
    ],
    relations: [],
  };
}

export function buildIreOperationPreview(mode: IreMode, record: StagedCiRecord): IreOperationPreview {
  return {
    mode,
    migration_run_id: record.migration_run.sys_id,
    staged_ci_id: record.sys_id,
    source_identity: {
      source_identifier: record.source_identifier,
      ...record.source_identity,
    },
    payload_preview: buildIrePayloadPreview(record),
  };
}

export function validateIrePayloadPreview(preview: IreOperationPreview): IreValidationResult {
  const issues: IreValidationIssue[] = [];
  const [item] = preview.payload_preview.items;

  if (preview.mode === "execute") {
    issues.push({
      code: "EXECUTE_NOT_ALLOWED",
      message: "Browser-side previews cannot authorize or perform IRE execution; ServiceNow must rebuild and execute the authoritative payload.",
    });
  }

  if (!item?.className) {
    issues.push({ code: "MISSING_CLASS", message: "A proposed CMDB class is required before IRE simulation." });
  }

  if (!item?.internal_id) {
    issues.push({ code: "MISSING_INTERNAL_ID", message: "A stable source identifier is required before IRE simulation." });
  }

  if (!item || Object.keys(item.values).length === 0) {
    issues.push({ code: "MISSING_VALUES", message: "At least one preview value is required before IRE simulation." });
  }

  return { valid: issues.length === 0, issues };
}

export function normalizeIreActionResponse(action: IreAction, payload: unknown): IreActionResponse {
  const row = unwrapObject(payload);
  const success = bool(row.success, !row.error);

  return {
    success,
    action: actionFrom(row.action, action),
    state: lifecycleState(row.state, action, success),
    migration_run_id: stringValue(row.migration_run_id ?? row.migrationRunId),
    staged_ci_id: stringValue(row.staged_ci_id ?? row.stagedCiId),
    correlation_id: stringValue(row.correlation_id ?? row.correlationId),
    idempotency_key: stringValue(row.idempotency_key ?? row.idempotencyKey),
    simulation_correlation_id: stringValue(row.simulation_correlation_id ?? row.simulationCorrelationId),
    execution_correlation_id: stringValue(row.execution_correlation_id ?? row.executionCorrelationId),
    simulation_fingerprint: stringValue(row.simulation_fingerprint ?? row.simulationFingerprint),
    finding: reference(row.finding),
    review_decision: reference(row.review_decision ?? row.reviewDecision),
    matched_ci: reference(row.matched_ci ?? row.matchedCi),
    target_ci: reference(row.target_ci ?? row.targetCi),
    status: stringValue(row.status) as IreActionResponse["status"],
    operation: stringValue(row.operation) as IreActionResponse["operation"],
    evidence: stringArray(row.evidence),
    verification_summary: stringValue(row.verification_summary ?? row.verificationSummary),
    playback_event_ids: stringArray(row.playback_event_ids ?? row.playbackEventIds),
    error: errorObject(row.error),
  };
}

export function deriveIreLifecycleState(snapshot: IreLifecycleSnapshot): IreLifecycleState {
  if (snapshot.verification) {
    if (snapshot.verification.success && (snapshot.verification.state === "verified" || snapshot.verification.status === "verified")) return "verified";
    return "verification_failed";
  }

  if (snapshot.execution) {
    if (snapshot.execution.success) return "executed_pending_verification";
    if (snapshot.execution.error?.code === "STALE_SIMULATION") return "execution_rejected_stale_simulation";
    return snapshot.execution.state ?? "execution_rejected_stale_simulation";
  }

  if (snapshot.approval?.success && (snapshot.approval.status === "approved" || snapshot.approval.state === "approved_for_execution")) return "approved_for_execution";
  if (snapshot.approval?.success && snapshot.approval.status === "rejected") return "simulated_pending_approval";

  if (snapshot.simulation) {
    if (!snapshot.simulation.success) return "simulation_failed";
    return snapshot.simulation.state ?? "simulated_pending_approval";
  }

  return "not_simulated";
}

export function ireLifecycleLabel(state: IreLifecycleState): string {
  const labels: Record<IreLifecycleState, string> = {
    not_simulated: "Not simulated",
    simulation_failed: "Simulation failed",
    simulated_pending_approval: "Pending approval",
    approved_for_execution: "Approved for execution",
    execution_rejected_stale_simulation: "Execution rejected",
    executing: "Executing",
    executed_pending_verification: "Pending verification",
    verified: "Verified",
    verification_failed: "Verification failed",
  };
  return labels[state];
}

function parsePayload(payload: string | undefined): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizedValues(payload: Record<string, unknown>): Record<string, string | number | boolean> {
  const source = objectRecord(payload.normalized_row_json) || objectRecord(payload.normalized) || payload;
  const allowedKeys = ["name", "host_name", "fqdn", "serial_number", "ip_address", "mac_address", "manufacturer", "model", "operating_system", "os_version"];
  const values: Record<string, string | number | boolean> = {};

  for (const key of allowedKeys) {
    const value = source[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      values[key] = value;
    }
  }

  return values;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function unwrapObject(payload: unknown): Record<string, unknown> {
  let current = objectRecord(payload) || {};
  for (let depth = 0; depth < 4; depth++) {
    const nested = objectRecord(current.result) || objectRecord(current.data);
    if (!nested) break;
    current = nested;
  }
  return current;
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown) {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap(item => stringValue(item) ?? []);
}

function actionFrom(value: unknown, fallback: IreAction): IreAction {
  const candidate = stringValue(value);
  return candidate && isIreAction(candidate) ? candidate : fallback;
}

function lifecycleState(value: unknown, action: IreAction, success: boolean): IreLifecycleState {
  const candidate = stringValue(value);
  const states: IreLifecycleState[] = [
    "not_simulated",
    "simulation_failed",
    "simulated_pending_approval",
    "approved_for_execution",
    "execution_rejected_stale_simulation",
    "executing",
    "executed_pending_verification",
    "verified",
    "verification_failed",
  ];
  if (candidate && states.includes(candidate as IreLifecycleState)) return candidate as IreLifecycleState;
  if (!success && action === "simulate") return "simulation_failed";
  if (!success && action === "verify") return "verification_failed";
  if (!success && action === "execute") return "execution_rejected_stale_simulation";
  if (action === "simulate") return "simulated_pending_approval";
  if (action === "approve") return "approved_for_execution";
  if (action === "execute") return "executed_pending_verification";
  return "verified";
}

function reference(value: unknown): ServiceNowReference | undefined {
  if (typeof value === "string" && value) return { sys_id: value };
  const row = objectRecord(value);
  if (!row) return undefined;
  const sysId = stringValue(row.sys_id ?? row.value);
  if (!sysId) return undefined;
  return {
    sys_id: sysId,
    display_value: stringValue(row.display_value ?? row.displayValue ?? row.name),
    table: stringValue(row.table),
  };
}

function errorObject(value: unknown): IreActionError | undefined {
  const row = objectRecord(value);
  if (!row) return undefined;
  return {
    code: (stringValue(row.code) || "IRE_FAILED") as IreActionError["code"],
    message: stringValue(row.message) || "The IRE action failed.",
    details: row.details,
  };
}
