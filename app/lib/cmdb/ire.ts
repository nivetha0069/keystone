import type { ServiceNowReference, ServiceNowSysId, SourceIdentity, StagedCiRecord } from "./contracts";

export type IreMode = "simulate" | "execute";

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
