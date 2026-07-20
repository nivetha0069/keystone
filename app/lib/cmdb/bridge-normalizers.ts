import {
  ConfigurationItem,
  HealthData,
  HealthFix,
  Operation,
  Relationship,
  TimelineEvent,
  mockHealth,
} from "../../cmdb-data";

const playbackSteps = ["Intake", "Staging", "AI read", "Confidence gate", "IRE", "CMDB", "Event log"];

export function normalizeCis(payload: unknown): ConfigurationItem[] {
  return arrayFromPayload(payload).map((item, index) => {
    const row = item as Record<string, unknown>;
    const op = operation(row.operation ?? row.ire_operation);
    const conf = confidence(row.confidence ?? row.mapping_confidence, op === "REVIEW" ? 0 : 0.9);
    const status = op === "REVIEW" ? "review" : op === "INSERT_AS_INCOMPLETE" ? "incomplete" : "live";
    const health = healthScore(row.health ?? row.health_score, Math.round(conf * 100));

    return {
      id: str(row.id ?? row.sys_id ?? row.ci_id, `CI-${index + 1}`),
      stagedCiId: str(row.stagedCiId ?? row.staged_ci_id ?? row.sys_id ?? row.id, `CI-${index + 1}`),
      migrationRunId: optionalStr(row.migrationRunId ?? row.migration_run_id ?? referenceValue(row.migration_run)),
      name: str(row.displayName ?? row.display_name ?? row.name ?? row.ci_name ?? row.host_name, `Unnamed CI ${index + 1}`),
      className: str(row.className ?? row.class ?? row.sys_class_name, "Unclassified"),
      ip: str(row.ip ?? row.ip_address),
      source: str(row.source ?? row.discovery_source, "Migration Pipeline"),
      operation: op,
      confidence: conf,
      health,
      updatedAt: str(row.updatedAt ?? row.updated_at ?? row.sys_updated_on, "Just now"),
      status,
      provenance: normalizeProvenance(row, conf, op),
    };
  });
}

export function normalizeTimeline(payload: unknown): TimelineEvent[] {
  const events = arrayFromPayload(payload).map((item, index) => {
    const row = item as Record<string, unknown>;
    const step = Math.min(7, Math.max(1, num(row.step, eventStep(row.name ?? row.event_name, (index % 7) + 1))));
    return {
      id: str(row.id ?? row.sys_id, `EV-${index + 1}`),
      seq: num(row.seq ?? row.sequence, index + 1),
      step,
      name: str(row.name ?? row.event_name, playbackSteps[step - 1]),
      recordName: str(row.recordName ?? row.record_name ?? row.ci_name, "Record"),
      className: str(row.className ?? row.class ?? row.ci_class, "Unclassified"),
      operation: operation(row.operation),
      source: str(row.source, "Migration Pipeline"),
      confidence: confidence(row.confidence, 0),
      time: str(row.time ?? row.created_at ?? row.sys_created_on, "Just now"),
      status: normalizeTimelineStatus(row.status),
      reasoning: str(row.reasoning ?? row.detail ?? row.message, "Event recorded by the migration pipeline."),
    };
  }).sort((a, b) => a.step - b.step || a.seq - b.seq);

  return fillTimelineGaps(events);
}

export function normalizeRelationships(payload: unknown): Relationship[] {
  return arrayFromPayload(payload).map((item, index) => {
    const row = item as Record<string, unknown>;
    return {
      id: str(row.id ?? row.sys_id, `REL-${index + 1}`),
      source: str(row.source ?? row.parent ?? row.from),
      target: str(row.target ?? row.child ?? row.to),
      type: str(row.type ?? row.relationship_type, "Depends on"),
      confidence: confidence(row.confidence, 0.9),
    };
  });
}

export function normalizeHealth(payload: unknown): HealthData {
  const outer = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const raw = ((outer.result ?? outer.data ?? outer.health ?? outer) || {}) as Record<string, unknown>;
  const fixesRaw = (raw.fixes ?? raw.recommendations ?? raw.priorities) as unknown;
  const fixes = arrayFromPayload(fixesRaw).map((item, index) => {
    const row = item as Record<string, unknown>;
    return {
      id: str(row.id, `FIX-${index + 1}`),
      rank: num(row.rank, index + 1),
      title: str(row.title ?? row.name, "Recommended fix"),
      description: str(row.description ?? row.reason).trim(),
      impact: impactScore(row.impact ?? row.score_impact),
      affected: num(row.affected ?? row.count, 0),
      tool: str(row.tool ?? row.agent, "IRE advisor"),
      severity: normalizeSeverity(row.severity),
    };
  });

  return {
    score: num(raw.score ?? raw.health_score, mockHealth.score),
    baselineScore: optionalNum(raw.baseline_score ?? raw.baselineScore),
    verifiedScore: optionalNum(raw.verified_score ?? raw.verifiedScore ?? raw.current_verified_score),
    projectedScore: optionalNum(raw.projected_score ?? raw.projectedScore),
    dimensionScores: normalizeDimensionScores(raw.dimension_scores ?? raw.dimensions),
    workGroupImpacts: normalizeWorkGroupImpacts(raw.work_group_impacts ?? raw.workGroupImpacts),
    grade: str(raw.grade, mockHealth.grade),
    ciCount: num(raw.ciCount ?? raw.ci_count ?? raw.total_cis, mockHealth.ciCount),
    // Legacy bridge names describe detected candidates during the current read-only stage.
    duplicateCandidates: num(
      raw.duplicates_detected ??
      raw.duplicate_candidates ??
      raw.duplicate_count ??
      raw.duplicates ??
      raw.duplicatesMerged ??
      raw.duplicates_merged ??
      raw.duplicates_avoided,
      mockHealth.duplicateCandidates,
    ),
    reviewCount: num(raw.reviewCount ?? raw.review_count ?? raw.pending_review, mockHealth.reviewCount),
    relationshipCount: num(raw.relationshipCount ?? raw.relationship_count ?? raw.relationships, mockHealth.relationshipCount),
    completeness: num(raw.completeness, mockHealth.completeness),
    correctness: num(raw.correctness, mockHealth.correctness),
    compliance: num(raw.compliance, mockHealth.compliance),
    duplicateRate: num(raw.duplicateRate ?? raw.duplicate_rate, mockHealth.duplicateRate),
    staleRecords: num(raw.staleRecords ?? raw.stale_records, mockHealth.staleRecords),
    fixes: fixes.length ? fixes : mockHealth.fixes,
  };
}

function normalizeDimensionScores(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, raw]) => [key, optionalNum(raw)] as const)
      .filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeWorkGroupImpacts(value: unknown): HealthData["workGroupImpacts"] {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const signature = optionalStr(row.signature ?? row.work_group_signature);
    if (!signature) return [];
    return [{
      signature,
      projected: num(row.projected ?? row.projected_lift, 0),
      realized: num(row.realized ?? row.realized_lift, 0),
      stagedCiIds: Array.isArray(row.staged_ci_ids)
        ? row.staged_ci_ids.map(value => optionalStr(value)).filter((value): value is string => Boolean(value))
        : undefined,
    }];
  });
  return normalized.length ? normalized : undefined;
}

function arrayFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const value = payload as Record<string, unknown>;
  for (const key of ["result", "data", "items", "records", "cis", "events", "relationships"]) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
    if (value[key] && typeof value[key] === "object") {
      const nested = arrayFromPayload(value[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function str(value: unknown, fallback = "-") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function optionalStr(value: unknown) {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

function referenceValue(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  return row.sys_id ?? row.value;
}

function num(value: unknown, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function optionalNum(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function confidence(value: unknown, fallback = 0) {
  const parsed = num(value, fallback);
  return parsed > 1 ? parsed / 100 : parsed;
}

function operation(value: unknown): Operation {
  const normalized = str(value, "NO_CHANGE").toUpperCase().replaceAll(" ", "_") as Operation;
  return ["INSERT", "UPDATE", "NO_CHANGE", "INSERT_AS_INCOMPLETE", "REVIEW", "ERROR"].includes(normalized) ? normalized : "NO_CHANGE";
}

function healthScore(value: unknown, fallback: number) {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "ok") return 85;
    if (normalized === "warning") return 60;
    if (normalized === "critical") return 30;
  }
  return num(value, fallback);
}

function impactScore(value: unknown) {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "critical" || normalized === "high") return 6;
    if (normalized === "medium") return 3;
    if (normalized === "low") return 1;
  }
  return num(value, 1);
}

function normalizeSeverity(value: unknown): HealthFix["severity"] {
  const normalized = str(value, "medium").toLowerCase();
  if (normalized === "critical" || normalized === "high" || normalized === "medium") return normalized;
  if (normalized === "warning") return "medium";
  return "medium";
}

function normalizeTimelineStatus(value: unknown): TimelineEvent["status"] {
  const normalized = str(value, "complete").toLowerCase();
  if (normalized === "failed") return "error";
  if (normalized === "active" || normalized === "review" || normalized === "error") return normalized;
  return "complete";
}

function eventStep(value: unknown, fallback: number) {
  const normalized = str(value, "").toLowerCase();
  const map: Record<string, number> = {
    ingested: 1,
    analyzed: 3,
    simulated: 4,
    approved: 5,
    committed: 6,
    error: 7,
  };
  return map[normalized] ?? fallback;
}

function fillTimelineGaps(events: TimelineEvent[]) {
  if (!events.length) return events;
  const byStep = new Map<number, TimelineEvent>();
  for (const event of events) if (!byStep.has(event.step)) byStep.set(event.step, event);
  const first = events[0];
  const filled: TimelineEvent[] = [];

  for (let step = 1; step <= 7; step++) {
    const existing = byStep.get(step);
    if (existing) {
      filled.push(existing);
      continue;
    }

    filled.push({
      id: `EV-PENDING-${step}`,
      seq: step,
      step,
      name: playbackSteps[step - 1],
      recordName: first.recordName,
      className: "Unclassified",
      operation: "NO_CHANGE",
      source: first.source,
      confidence: 0,
      time: "Pending",
      status: "review",
      reasoning: "No live bridge event has been recorded for this stage yet.",
    });
  }

  return filled;
}

function normalizeProvenance(row: Record<string, unknown>, conf: number, op: Operation): ConfigurationItem["provenance"] {
  if (Array.isArray(row.provenance)) {
    return row.provenance.map((item, index) => {
      if (item && typeof item === "object") return item as ConfigurationItem["provenance"][number];
      return { label: index === 0 ? "Source" : `Provenance ${index + 1}`, value: String(item) };
    });
  }

  return [
    { label: "Source", value: str(row.source ?? row.discovery_source, "Migration Pipeline") },
    { label: "Classification", value: str(row.className ?? row.class ?? row.sys_class_name, "Unclassified") },
    { label: "Confidence", value: conf === 0 ? "Pending analysis" : `${Math.round(conf * 100)}%` },
    { label: "IRE result", value: op },
  ];
}
