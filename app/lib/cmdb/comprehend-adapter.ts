import {
  ConfigurationItem,
  HealthData,
  HealthFix,
  Operation,
  Relationship,
  TimelineEvent,
} from "../../cmdb-data";

const SENTRY_THRESHOLD = 0.5;

export function normalizeComprehendCis(payload: unknown): ConfigurationItem[] {
  return arrayFromPayload(payload, ["cis", "records", "items"]).map((item, index) => {
    const row = record(item);
    const sourceIdentity = record(row.source_identity);
    const sourcePayload = jsonRecord(row.payload);
    const normalized = record(sourcePayload.normalized_row_json ?? sourcePayload.normalized);
    const values = Object.keys(normalized).length ? normalized : sourcePayload;
    const confidence = normalizeConfidence(row.confidence ?? row.mapping_confidence);
    const operation = deriveComprehendOutcome(row, confidence);
    const status: ConfigurationItem["status"] =
      operation === "REVIEW" || operation === "ERROR"
        ? "review"
        : operation === "INSERT_AS_INCOMPLETE"
          ? "incomplete"
          : "live";
    const sourceIdentifier = text(
      row.source_identifier ??
      sourceIdentity.source_identifier ??
      sourceIdentity.source_record_id ??
      sourceIdentity.source_native_key,
      `record-${index + 1}`,
    );
    const name = text(
      row.display_name ??
      row.name ??
      row.ci_name ??
      values.name ??
      values.host_name ??
      values.hostname ??
      values.fqdn ??
      sourceIdentifier,
      `Unnamed staged CI ${index + 1}`,
    );
    const className = text(
      row.proposed_class ??
      row.class_name ??
      row.class ??
      values.proposed_class ??
      values.ci_class ??
      values.sys_class_name,
      "Unclassified",
    );
    const source = text(
      row.source ??
      row.source_name ??
      sourceIdentity.source_name ??
      values.source ??
      values.source_system,
      "External source",
    );
    const matchedCi = referenceLabel(row.matched_ci);
    const gateLabel =
      operation === "REVIEW" || operation === "ERROR"
        ? "Held for human review"
        : operation === "INSERT_AS_INCOMPLETE"
          ? "Held below confidence threshold"
          : "Cleared by deterministic gate";

    return {
      id: text(row.number ?? row.id ?? row.sys_id, `DCI-${index + 1}`),
      name,
      className,
      ip: text(row.ip ?? row.ip_address ?? values.ip ?? values.ip_address, "Not supplied"),
      source,
      operation,
      confidence,
      health: healthScore(row.health ?? row.health_score, confidence, status),
      updatedAt: text(row.updated_at ?? row.sys_updated_on ?? row.updatedAt, "Just now"),
      status,
      provenance: [
        {
          label: "Staged record",
          value: text(row.number ?? row.sys_id, `DCI-${index + 1}`),
          detail: `Quarantined source identity: ${sourceIdentifier}`,
        },
        {
          label: "Atlas classification",
          value: className,
          detail: className === "Unclassified" ? "No valid proposed CMDB class is available." : "Proposed class validated during Comprehend.",
        },
        {
          label: "Sentry confidence gate",
          value: `${Math.round(confidence * 100)}% · ${gateLabel}`,
          detail: `Deterministic threshold: ${Math.round(SENTRY_THRESHOLD * 100)}%.`,
        },
        ...(matchedCi
          ? [{
              label: "Candidate CMDB match",
              value: matchedCi,
              detail: "Candidate only; no IRE simulation or CMDB write has occurred.",
            }]
          : []),
        {
          label: "Next governed step",
          value: status === "live" ? "Eligible for future IRE simulation" : "Human review required",
          detail: "Comprehend does not directly write to cmdb_ci or cmdb_rel_ci.",
        },
      ],
    };
  });
}

export function normalizeComprehendTimeline(payload: unknown): TimelineEvent[] {
  return arrayFromPayload(payload, ["timeline", "events", "records", "items"])
    .map((item, index) => {
      const row = record(item);
      const eventType = text(row.event_type ?? row.name ?? row.event_name, "analyzed").toLowerCase();
      const detail = detailText(row.detail ?? row.reasoning ?? row.message);
      const actor = text(
        referenceLabel(row.actor) ??
        referenceLabel(row.agent) ??
        referenceLabel(row.agent_name) ??
        referenceLabel(row.source) ??
        referenceLabel(row.record_name) ??
        inferActorFromLedgerDetail(detail),
        "Comprehend",
      );
      const step = eventPhase(eventType, actor, detail);
      const confidence = normalizeConfidence(row.confidence ?? row.mapping_confidence);
      const status = timelineStatus(row.status, eventType, detail);

      return {
        id: text(row.id ?? row.sys_id, `EV-${index + 1}`),
        seq: number(row.sequence ?? row.seq, index + 1),
        step,
        name: eventTitle(actor, eventType, detail),
        recordName: text(referenceLabel(row.staged_ci) ?? row.record_name ?? row.ci_name, "Migration run"),
        className: text(row.proposed_class ?? row.ci_class ?? row.class, "Run event"),
        operation: timelineOperation(row.operation ?? row.ire_operation, status),
        source: actor,
        confidence,
        time: text(row.sys_created_on ?? row.created_at ?? row.time, "Just now"),
        status,
        reasoning: detail || "Event recorded by the Dotwalkers Event Ledger.",
      };
    })
    .sort((a, b) => a.seq - b.seq);
}

export function normalizeComprehendRelationships(payload: unknown): Relationship[] {
  return arrayFromPayload(payload, ["relationships", "records", "items"]).map((item, index) => {
    const row = record(item);
    return {
      id: text(row.id ?? row.sys_id, `REL-${index + 1}`),
      source: text(referenceLabel(row.parent_ci ?? row.parent ?? row.source ?? row.from), "Unknown parent"),
      target: text(referenceLabel(row.child_ci ?? row.child ?? row.target ?? row.to), "Unknown child"),
      type: text(
        referenceLabel(row.relationship_type ?? row.normalized_relationship_type ?? row.type),
        "Depends on::Used by",
      ),
      confidence: normalizeConfidence(row.confidence, 1),
    };
  });
}

export function normalizeComprehendHealth(payload: unknown): HealthData {
  const raw = objectFromPayload(payload, ["health", "data", "result"]);
  const fixes = arrayFromPayload(raw.fixes ?? raw.recommendations ?? raw.priorities, ["fixes", "records", "items"])
    .map((item, index) => normalizeFix(record(item), index));
  const duplicateFixCount = fixes
    .filter(fix => `${fix.title} ${fix.tool}`.toLowerCase().includes("duplicate"))
    .reduce((sum, fix) => sum + fix.affected, 0);
  const completeness = number(raw.completeness ?? record(raw.dimensions).completeness, 0);
  const correctness = number(raw.correctness ?? record(raw.dimensions).correctness, 0);
  const compliance = number(raw.compliance ?? record(raw.dimensions).compliance, 0);
  const explicitScore = optionalNumber(raw.score ?? raw.health_score ?? raw.overall);
  const dimensions = [completeness, correctness, compliance].filter(value => value > 0);
  const score = explicitScore ?? (dimensions.length ? Math.round(dimensions.reduce((sum, value) => sum + value, 0) / dimensions.length) : 0);

  return {
    score,
    grade: text(raw.grade, healthGrade(score)),
    ciCount: number(raw.ciCount ?? raw.ci_count ?? raw.total_cis ?? raw.total, 0),
    duplicatesMerged: number(
      raw.duplicate_count ?? raw.duplicates ?? raw.duplicatesMerged ?? raw.duplicates_merged,
      duplicateFixCount,
    ),
    reviewCount: number(raw.reviewCount ?? raw.review_count ?? raw.pending_review ?? raw.held, 0),
    relationshipCount: number(raw.relationshipCount ?? raw.relationship_count ?? raw.relationships, 0),
    completeness,
    correctness,
    compliance,
    duplicateRate: number(raw.duplicateRate ?? raw.duplicate_rate, 0),
    staleRecords: number(raw.staleRecords ?? raw.stale_records, 0),
    fixes,
  };
}

function deriveComprehendOutcome(row: Record<string, unknown>, confidence: number): Operation {
  const explicit = text(row.operation ?? row.ire_operation, "").toUpperCase().replaceAll(" ", "_");
  if (["INSERT", "UPDATE", "NO_CHANGE", "INSERT_AS_INCOMPLETE", "REVIEW", "ERROR"].includes(explicit)) {
    return explicit as Operation;
  }

  const status = text(row.identification_status ?? row.status, "pending").toLowerCase();
  if (status === "conflict" || status === "rejected" || status === "requires_review") return "REVIEW";
  if (status === "failed" || status === "error") return "ERROR";
  if (confidence < SENTRY_THRESHOLD) return "INSERT_AS_INCOMPLETE";
  if (hasReference(row.matched_ci)) return "UPDATE";
  return "INSERT";
}

function eventPhase(eventType: string, actor: string, detail: string) {
  const lowerActor = actor.toLowerCase();
  const lowerDetail = detail.toLowerCase();
  if (eventType === "ingested" || eventType.includes("file_received") || lowerDetail.includes("seed data created")) return 1;
  if (eventType.includes("record_staged") || lowerDetail.includes("staged safely")) return 2;
  if (lowerActor === "sentry" || eventType.includes("confidence") || lowerDetail.includes("confidence gate")) return 4;
  if (eventType === "simulated" || eventType === "approved" || eventType.includes("review_")) return 5;
  if (eventType === "committed" || eventType.includes("ire_execution") || eventType === "run_completed") return 6;
  if (lowerActor === "ledger" || eventType === "error" || lowerDetail.includes("analysis completed") || lowerDetail.includes("planner completion")) return 7;
  return 3;
}

function eventTitle(actor: string, eventType: string, detail: string) {
  const action = detail.match(/\bAction:\s*([a-z0-9_]+)/i)?.[1];
  if (action) return `${actor} selected ${humanize(action)}`;
  if (/^observation:/i.test(detail)) return `${actor} recorded an observation`;
  if (/analysis session started/i.test(detail)) return "Analysis session started";
  if (/analysis completed/i.test(detail)) return "Analysis completed";
  if (/seed data created/i.test(detail)) return "Seed data created";
  return `${actor} · ${humanize(eventType)}`;
}

function timelineOperation(value: unknown, status: TimelineEvent["status"]): Operation {
  const explicit = text(value, "").toUpperCase().replaceAll(" ", "_");
  if (["INSERT", "UPDATE", "NO_CHANGE", "INSERT_AS_INCOMPLETE", "REVIEW", "ERROR"].includes(explicit)) {
    return explicit as Operation;
  }
  if (status === "error") return "ERROR";
  return "NO_CHANGE";
}

function timelineStatus(explicitStatus: unknown, eventType: string, detail: string): TimelineEvent["status"] {
  const explicit = text(explicitStatus, "").toLowerCase();
  if (["complete", "active", "review", "error"].includes(explicit)) return explicit as TimelineEvent["status"];
  const normalized = `${eventType} ${detail}`.toLowerCase();
  if (normalized.includes("error") || normalized.includes("failed") || normalized.includes("exception")) return "error";
  if (eventType === "approved") return "review";
  if (normalized.includes("started") && !normalized.includes("completed")) return "active";
  return "complete";
}

function inferActorFromLedgerDetail(detail: string) {
  const normalized = detail.toLowerCase();
  const action = normalized.match(/\baction:\s*([a-z0-9_]+)/)?.[1];
  const actionActors: Record<string, string> = {
    get_run_stats: "Router",
    scan_classes: "Atlas",
    scan_attributes: "Atlas",
    scan_duplicates: "Scout",
    scan_orphans: "Weaver",
    apply_confidence_gate: "Sentry",
    write_summary: "Ledger",
  };
  if (action && actionActors[action]) return actionActors[action];
  if (normalized.includes("analysis session started") || normalized.includes("analysis completed")) return "Comprehend";
  if (normalized.includes("planner requested completion") || normalized.includes("planner completion")) return "Ledger";
  if (normalized.includes("confidence gate applied")) return "Sentry";
  if (normalized.includes("class scan") || normalized.includes("attribute scan")) return "Atlas";
  if (normalized.includes("duplicate scan")) return "Scout";
  if (normalized.includes("orphan scan")) return "Weaver";
  if (normalized.includes("executive summary")) return "Ledger";
  if (normalized.includes("staged cis") || normalized.includes("run stats")) return "Router";
  return undefined;
}

function normalizeFix(row: Record<string, unknown>, index: number): HealthFix {
  return {
    id: text(row.id ?? row.sys_id ?? row.number, `FIX-${index + 1}`),
    rank: number(row.rank, index + 1),
    title: text(row.title ?? row.name ?? row.type, "Comprehend finding"),
    description: text(row.description ?? row.reason ?? row.recommendation, "Review the supporting finding in ServiceNow.").trim(),
    impact: impact(row.impact ?? row.score_impact ?? row.severity),
    affected: number(row.affected ?? row.count, 0),
    tool: text(row.tool ?? row.agent, toolForFinding(text(row.type ?? row.title, ""))),
    severity: severity(row.severity),
  };
}

function toolForFinding(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("duplicate")) return "Scout";
  if (normalized.includes("orphan") || normalized.includes("relationship")) return "Weaver";
  if (normalized.includes("class") || normalized.includes("attribute")) return "Atlas";
  return "Sentry";
}

function severity(value: unknown): HealthFix["severity"] {
  const normalized = text(value, "medium").toLowerCase();
  if (normalized === "critical") return "critical";
  if (normalized === "high") return "high";
  return "medium";
}

function impact(value: unknown) {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "critical" || normalized === "high") return 6;
    if (normalized === "warning" || normalized === "medium") return 3;
    if (normalized === "info" || normalized === "low") return 1;
  }
  return number(value, 1);
}

function healthScore(value: unknown, confidence: number, status: ConfigurationItem["status"]) {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "ok") return 85;
    if (normalized === "warning") return 60;
    if (normalized === "critical") return 30;
  }
  const explicit = optionalNumber(value);
  if (explicit !== undefined) return explicit;
  if (status === "review") return Math.min(49, Math.round(confidence * 100));
  if (status === "incomplete") return Math.min(59, Math.round(confidence * 100));
  return Math.max(50, Math.round(confidence * 100));
}

function normalizeConfidence(value: unknown, fallback = 0) {
  const parsed = number(value, fallback);
  return Math.max(0, Math.min(1, parsed > 1 ? parsed / 100 : parsed));
}

function referenceLabel(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  const ref = record(value);
  const label = ref.display_value ?? ref.name ?? ref.number ?? ref.source_identifier ?? ref.sys_id;
  return label === undefined || label === null ? undefined : String(label).trim() || undefined;
}

function hasReference(value: unknown) {
  return Boolean(referenceLabel(value));
}

function detailText(value: unknown) {
  if (typeof value === "string") {
    if (!value.trim()) return "";
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") {
        const parsedRecord = record(parsed);
        return text(parsedRecord.summary ?? parsedRecord.detail, JSON.stringify(parsed));
      }
    } catch {
      return value.trim();
    }
    return value.trim();
  }
  if (value && typeof value === "object") {
    const valueRecord = record(value);
    return text(valueRecord.summary ?? valueRecord.detail, JSON.stringify(value));
  }
  return "";
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function arrayFromPayload(payload: unknown, preferredKeys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  const value = record(payload);
  for (const key of [...preferredKeys, "result", "data", "items", "records"]) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
    if (value[key] && typeof value[key] === "object") {
      const nested = arrayFromPayload(value[key], preferredKeys);
      if (nested.length) return nested;
    }
  }
  return [];
}

function objectFromPayload(payload: unknown, preferredKeys: string[]): Record<string, unknown> {
  const value = record(payload);
  for (const key of preferredKeys) {
    if (value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) {
      return objectFromPayload(value[key], preferredKeys.filter(candidate => candidate !== key));
    }
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = "") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function healthGrade(score: number) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return score > 0 ? "E" : "—";
}

function humanize(value: string) {
  const spaced = value.replaceAll("_", " ").trim();
  return spaced ? `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}` : "Event";
}
