export type ServiceNowSysId = string;
export type IsoDateTime = string;

export type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  meta: {
    correlation_id?: string;
  };
  error: ApiError | null;
};

export type ApiError = {
  code: string;
  message: string;
  details?: unknown[];
};

export const serviceNowTables = {
  migrationRun: "x_kest_dotwalkers_migration_run",
  stagedCiRecord: "x_kest_dotwalkers_staged_ci_record",
  stagedRelationship: "x_kest_dotwalkers_staged_relationship",
  finding: "x_kest_dotwalkers_finding",
  reviewDecision: "x_kest_dotwalkers_review_decision",
  eventLedger: "x_kest_dotwalkers_event_ledger",
} as const;

export type MigrationRunState =
  | "draft"
  | "ingesting"
  | "analyzing"
  | "simulated"
  | "awaiting_approval"
  | "committing"
  | "complete"
  | "failed";

export type SourceSystem = "servicenow" | "cloudquery" | "helix" | "csv" | "json" | "microsoft" | "ibm" | "other";

export type MigrationRun = {
  sys_id: ServiceNowSysId;
  number: string;
  summary?: string;
  initiated_by?: ServiceNowReference;
  source_system: SourceSystem;
  started?: IsoDateTime;
  completed?: IsoDateTime;
  team_prefix: string;
  state: MigrationRunState;
};

export type ServiceNowReference = {
  sys_id: ServiceNowSysId;
  display_value?: string;
  table?: string;
};

export type SourceIdentity = {
  source_name?: string;
  source_native_key?: string;
  source_record_id?: string;
  source_identifier?: string;
};

export type ParserMetadata = {
  parser_version: string;
  source_row_number?: number;
  raw_row_json?: Record<string, unknown>;
  normalized_row_json?: Record<string, unknown>;
};

export type IdentificationStatus = "pending" | "match_found" | "new_ci" | "conflict" | "rejected";

export type CiMatchSummary = {
  ci?: ServiceNowReference;
  match_score?: number;
  evidence?: string[];
  source: "deterministic_lookup" | "ire_simulation" | "ire_execution" | "manual";
};

export type StagedCiRecord = {
  sys_id: ServiceNowSysId;
  number: string;
  migration_run: ServiceNowReference;
  team_prefix: string;
  confidence?: number;
  proposed_class?: string;
  source_identifier?: string;
  identification_status: IdentificationStatus;
  payload?: string;
  matched_ci?: ServiceNowReference;
  source_identity?: SourceIdentity;
  parser_metadata?: ParserMetadata;
  candidate_matched_ci?: CiMatchSummary;
  simulation_matched_ci?: CiMatchSummary;
  executed_target_ci?: CiMatchSummary;
};

export type RelationshipTypeEvidence = {
  raw_string?: string;
  normalized_string?: string;
  resolved_type?: ServiceNowReference;
  evidence?: string[];
};

export type StagedRelationshipStatus = "pending" | "validated" | "requires_review" | "rejected" | "executed" | "failed";

export type StagedRelationship = {
  sys_id: ServiceNowSysId;
  migration_run: ServiceNowReference;
  team_prefix: string;
  parent_ci?: ServiceNowReference;
  child_ci?: ServiceNowReference;
  relationship_type?: ServiceNowReference;
  status: StagedRelationshipStatus | string;
  source_relationship_type?: RelationshipTypeEvidence;
  normalized_relationship_type?: RelationshipTypeEvidence;
  proposed_relationship_type?: RelationshipTypeEvidence;
};

export type FindingRecordKind = "finding" | "recommendation" | "ai_summary";

export type Finding = {
  sys_id: ServiceNowSysId;
  number: string;
  migration_run: ServiceNowReference;
  team_prefix: string;
  staged_ci?: ServiceNowReference;
  type: string;
  record_kind?: FindingRecordKind;
  severity?: string;
  recommendation?: string;
};

export type ReviewDecision = {
  sys_id: ServiceNowSysId;
  migration_run: ServiceNowReference;
  team_prefix: string;
  finding: ServiceNowReference;
  decision: "approved" | "rejected" | "deferred" | string;
  rationale?: string;
  decided_by?: ServiceNowReference;
  policy_approved?: boolean;
};

export type MigrationEventType =
  | "run_created"
  | "file_received"
  | "record_staged"
  | "record_normalized"
  | "validation_passed"
  | "validation_failed"
  | "class_proposed"
  | "candidate_match_found"
  | "relationship_proposed"
  | "agent_started"
  | "agent_completed"
  | "review_requested"
  | "review_approved"
  | "review_rejected"
  | "ire_simulation_started"
  | "ire_simulation_completed"
  | "ire_execution_started"
  | "ire_execution_completed"
  | "verification_passed"
  | "verification_failed"
  | "run_completed";

export type CompactEventDetail = {
  summary: string;
  status?: "pending" | "success" | "warning" | "failed";
  staged_ci_id?: ServiceNowSysId;
  finding_id?: ServiceNowSysId;
  correlation_id?: string;
  confidence?: number;
  evidence_count?: number;
  elapsed_ms?: number;
};

export type EventLedgerEntry = {
  sys_id: ServiceNowSysId;
  migration_run: ServiceNowReference;
  team_prefix: string;
  sequence: number;
  event_type: MigrationEventType | string;
  actor?: string;
  detail?: string | CompactEventDetail;
  sys_created_on?: IsoDateTime;
};

export type HealthDimension = "completeness" | "correctness" | "compliance" | "relationship_integrity" | "freshness";

export type HealthScore = {
  overall: number;
  dimensions: Record<HealthDimension, number>;
};

export type PriorityScore = {
  overall: number;
  business_impact: number;
  data_quality_impact: number;
  affected_scope: number;
  confidence: number;
  remediation_effort: number;
  execution_risk: number;
};

export function isApiEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ApiEnvelope<T>>;
  return typeof candidate.success === "boolean" && "data" in candidate && typeof candidate.meta === "object" && "error" in candidate;
}
