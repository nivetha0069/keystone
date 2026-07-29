// The simulated migration run served while demo mode is on.
//
// Everything here is emitted in the *raw* ServiceNow wire shape and then passed
// through the real `normalizeComprehend*` adapters, so demo mode exercises the
// production normalization path rather than bypassing it. If an adapter changes,
// the demo changes with it.
//
// Two hard rules:
//   1. Deterministic. No `Math.random`, no `Date.now`. The same fixture renders
//      identically on every load, so screenshots and smoke assertions are stable.
//   2. Structurally valid. The frontend validates its own identifiers before any
//      governed action — 32-hex for run/staged-CI/finding ids, 64-hex uppercase
//      for simulation fingerprints. The literal strings from `cmdb-data.ts`
//      ("CI-00482") would fail every one of those guards, so ids are minted here
//      as real hex that is still obviously fake at a glance.

const HEX_NAMESPACE = "deadbeefcafef00d";

/** 32-hex id: namespace + a one-char kind marker + a zero-padded index. */
function demoSysId(kind: "c" | "f" | "a" | "e" | "b" | "d", index: number): string {
  return `${HEX_NAMESPACE}${kind}${String(index).padStart(15, "0")}`;
}

/** 64-hex uppercase, matching the `simulation_fingerprint` contract. */
export function demoFingerprint(index: number): string {
  return `${HEX_NAMESPACE.toUpperCase().repeat(3)}C${String(index).padStart(15, "0")}`;
}

export const DEMO_RUN_ID = demoSysId("d", 1);

/**
 * Guard for every persistence site (URL `?run=`, run context, runs registry).
 *
 * Deliberately keyed on the *run id* rather than the demo-mode flag: when the
 * toggle flips off, effects that depend on the flag re-run while `activeRunId`
 * is still the simulated one, so a flag-based guard loses that race and leaks
 * the demo run into localStorage and the address bar. The id cannot race with
 * itself.
 */
export function isDemoRunId(runId: string | undefined | null): boolean {
  return typeof runId === "string" && runId.toLowerCase() === DEMO_RUN_ID;
}
export const DEMO_RUN_NUMBER = "DWR-DEMO-0001";
export const DEMO_RUN_LABEL = "Baxter estate consolidation (demo)";
/** Terminal so pipeline polling stops, but outside RUN_STATES_BLOCKING_IRE so Remediate stays reachable. */
export const DEMO_RUN_STATE = "simulated";

export const demoStagedCiId = (index: number) => demoSysId("c", index);
export const demoFindingId = (index: number) => demoSysId("f", index);
export const demoReviewId = (index: number) => demoSysId("a", index);
export const demoEventId = (index: number) => demoSysId("e", index);
export const demoTargetCiId = (index: number) => demoSysId("b", index);

// ---------------------------------------------------------------------------
// Configuration items
// ---------------------------------------------------------------------------

type DemoOperation = "INSERT" | "UPDATE" | "NO_CHANGE" | "INSERT_AS_INCOMPLETE" | "REVIEW" | "ERROR";

type Archetype = {
  prefix: string;
  /** Human-readable label shown in the UI. */
  className: string;
  /**
   * The real CMDB table. Structured ledger evidence carries table names, not
   * display labels — `terminal-outcomes.ts` validates them against
   * /^[a-z][a-z0-9_]{2,79}$/ before a verified outcome will correlate.
   */
  table: string;
  source: string;
  subnet: string;
  /**
   * The outcome family this class reconciles to. Driving the operation from the
   * archetype rather than the row index is what makes an approval packet
   * possible: `planApprovalPacket` only accepts a *homogeneous* class +
   * operation-family cohort, so a per-index operation cycle would fragment
   * every class into groups of one or two.
   */
  family: "INSERT" | "UPDATE" | "NO_CHANGE";
};

// Eight archetypes across six waves gives 48 records — six per class, enough
// for a realistic bounded packet (max 100, but a handful reads better on screen).
const ARCHETYPES: Archetype[] = [
  { prefix: "pay-gw-lnx", className: "Linux Server", table: "cmdb_ci_linux_server", source: "Baxter Inventory", subnet: "10.42.18", family: "UPDATE" },
  { prefix: "payments-db", className: "Oracle Database", table: "cmdb_ci_db_ora_instance", source: "Legacy CMDB", subnet: "10.42.21", family: "NO_CHANGE" },
  { prefix: "edge-lb-prod", className: "Load Balancer", table: "cmdb_ci_lb", source: "NetBox", subnet: "10.42.9", family: "INSERT" },
  { prefix: "sap-app-eu", className: "Application Server", table: "cmdb_ci_app_server", source: "Spreadsheet", subnet: "10.51.6", family: "INSERT" },
  { prefix: "fileshare-nyc", className: "Windows Server", table: "cmdb_ci_win_server", source: "SCCM", subnet: "10.60.2", family: "UPDATE" },
  { prefix: "warehouse-esx", className: "ESX Server", table: "cmdb_ci_esx_server", source: "vCenter Export", subnet: "10.71.11", family: "INSERT" },
  { prefix: "analytics-pg", className: "PostgreSQL Instance", table: "cmdb_ci_db_postgresql_instance", source: "Spreadsheet", subnet: "10.51.19", family: "NO_CHANGE" },
  { prefix: "core-switch", className: "Network Switch", table: "cmdb_ci_ip_switch", source: "vCenter Export", subnet: "10.10.1", family: "UPDATE" },
];

export const DEMO_CI_COUNT = 48;

/**
 * The archetype whose whole cohort is clean and homogeneous — this is what the
 * simulated approval packet is built from.
 */
const PACKET_ARCHETYPE_INDEX = 0;

/**
 * A demo where every record sails through is a worse demo. These exceptions
 * deliberately keep the full outcome spread — held records, incomplete
 * identity, and one hard error — so the review queue, the Sankey, and the
 * blocked bucket all have something real to show. They are placed on
 * archetypes 3 and 7 so the packet cohort (archetype 0) stays clean.
 */
function operationFor(index: number): DemoOperation {
  if (index === 43) return "ERROR";
  if (index % 16 === 3) return "REVIEW";
  if (index % 16 === 7) return "INSERT_AS_INCOMPLETE";
  if (index % 16 === 11) return "REVIEW";
  if (index % 16 === 15) return "INSERT_AS_INCOMPLETE";
  return ARCHETYPES[index % ARCHETYPES.length].family;
}

function confidenceFor(index: number, operation: DemoOperation): number {
  if (operation === "ERROR") return 0.21;
  if (operation === "REVIEW") return 0.42 + (index % 5) / 100;
  if (operation === "INSERT_AS_INCOMPLETE") return 0.34 + (index % 4) / 100;
  return 0.91 + (index % 9) / 100;
}

function ciNameFor(index: number): string {
  const archetype = ARCHETYPES[index % ARCHETYPES.length];
  const ordinal = Math.floor(index / ARCHETYPES.length) + 1;
  return `${archetype.prefix}-${String(ordinal).padStart(2, "0")}`;
}

/** Fixed base clock keeps timestamps stable across reloads. */
const BASE_DATE = "2026-07-28";
export function demoClockAt(offsetSeconds: number): string {
  return clockAt(offsetSeconds);
}
function clockAt(offsetSeconds: number): string {
  const total = 6 * 3600 + 8 * 60 + 41 + offsetSeconds;
  const hh = String(Math.floor(total / 3600) % 24).padStart(2, "0");
  const mm = String(Math.floor(total / 60) % 60).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${BASE_DATE} ${hh}:${mm}:${ss}`;
}

export type DemoCiSeed = {
  index: number;
  sysId: string;
  name: string;
  className: string;
  table: string;
  source: string;
  ip: string;
  operation: DemoOperation;
  confidence: number;
  /** live | review | incomplete, mirroring what the adapter will derive. */
  status: "live" | "review" | "incomplete";
};

export const demoCiSeeds: DemoCiSeed[] = Array.from({ length: DEMO_CI_COUNT }, (_unused, index) => {
  const archetype = ARCHETYPES[index % ARCHETYPES.length];
  const operation = operationFor(index);
  const status = operation === "REVIEW" || operation === "ERROR"
    ? "review"
    : operation === "INSERT_AS_INCOMPLETE"
      ? "incomplete"
      : "live";
  return {
    index,
    sysId: demoStagedCiId(index),
    name: ciNameFor(index),
    className: archetype.className,
    table: archetype.table,
    source: archetype.source,
    ip: `${archetype.subnet}.${(index * 7) % 240 + 3}`,
    operation,
    confidence: Number(confidenceFor(index, operation).toFixed(2)),
    status,
  } satisfies DemoCiSeed;
});

/** Counts derived once and reused by the ledger prose and the health payload. */
const clearedCount = demoCiSeeds.filter(seed => seed.status === "live").length;
const heldCount = DEMO_CI_COUNT - clearedCount;
const incompleteCount = demoCiSeeds.filter(seed => seed.status === "incomplete").length;
const duplicateCandidateCount = demoCiSeeds.filter(
  seed => seed.status === "live" && seed.index % ARCHETYPES.length === PACKET_ARCHETYPE_INDEX,
).length;

export function demoCisPayload() {
  return {
    result: demoCiSeeds.map(seed => ({
      sys_id: seed.sysId,
      number: `DCI${String(10000 + seed.index)}`,
      display_name: seed.name,
      proposed_class: seed.className,
      source_name: seed.source,
      ip_address: seed.ip,
      operation: seed.operation,
      confidence: seed.confidence,
      class_valid: seed.status === "live",
      identification_status: seed.status === "live" ? "identified" : "requires_review",
      migration_run: { value: DEMO_RUN_ID, display_value: DEMO_RUN_NUMBER },
      ...(seed.operation === "UPDATE"
        ? { matched_ci: { value: demoTargetCiId(seed.index), display_value: seed.name } }
        : {}),
      source_identity: {
        source_name: seed.source,
        source_record_id: `SRC-${String(4800 + seed.index)}`,
      },
      sys_updated_on: clockAt(seed.index * 3),
    })),
  };
}

// ---------------------------------------------------------------------------
// Event ledger
// ---------------------------------------------------------------------------

type DemoEventSeed = {
  eventType: string;
  actor?: string;
  detail: string;
  status?: "complete" | "active" | "review" | "error";
  recordName?: string;
};

/**
 * Ordered to cover every one of the seven `PLAYBACK_NODES`. The playback mapper
 * keys off explicit `Action: <name>` tokens and event-type milestone keywords —
 * these details are written to hit those, not to read prettily.
 */
const EVENT_SEEDS: DemoEventSeed[] = [
  { eventType: "ingested", actor: "Comprehend", detail: `Analysis session started for the Baxter estate consolidation batch. Seed data created from ${DEMO_CI_COUNT} fingerprinted source rows.` },
  { eventType: "record_staged", actor: "Router", detail: `Staged safely: ${DEMO_CI_COUNT} rows quarantined in the staging table. No CMDB access occurred.` },
  { eventType: "analyzed", detail: `Action: get_run_stats | summary=Run stats collected for ${DEMO_CI_COUNT} staged CIs across ${new Set(ARCHETYPES.map(a => a.source)).size} source systems.` },
  // Counts in ledger prose are interpolated from the actual seeds. Hard-coding
  // them lets the narrative drift out of step with the table beneath it, which a
  // viewer notices immediately.
  { eventType: "analyzed", detail: `Action: scan_classes | summary=Class scan proposed ${new Set(ARCHETYPES.map(a => a.className)).size} distinct CMDB classes; ${clearedCount} of ${DEMO_CI_COUNT} records validated.` },
  { eventType: "analyzed", detail: "Action: scan_attributes | summary=Attribute scan mapped 9 of 10 required attributes on average." },
  { eventType: "analyzed", detail: `Action: scan_duplicates | summary=Duplicate scan flagged ${duplicateCandidateCount} probable pairs on serial and FQDN signals.` },
  { eventType: "analyzed", detail: "Action: scan_orphans | summary=Orphan scan found 5 staged CIs with no proposed relationship." },
  { eventType: "analyzed", detail: `Action: apply_confidence_gate | summary=Confidence gate applied. ${clearedCount} records cleared the 50% deterministic threshold, ${DEMO_CI_COUNT - clearedCount} were held.` },
  { eventType: "analyzed", actor: "Mara", detail: "Observation: Mara reviewed the deterministic specialist output and accepted the confidence gate result without override." },
  { eventType: "simulated", actor: "IRE", detail: "IRE simulation prepared for the cleared cohort. Identification and reconciliation ran in proposal mode only.", recordName: ciNameFor(0) },
  { eventType: "approved", actor: "Mara", detail: "Approval review deferred pending human authorization of the bounded packet.", recordName: ciNameFor(3), status: "review" },
  { eventType: "committed", actor: "IRE", detail: "CMDB published: governed attribute updates applied and the discovery source tagged as Migration Pipeline.", recordName: ciNameFor(0) },
  { eventType: "analyzed", actor: "Prioritize", detail: "PriorityScorer ranked 4 health recommendations by projected score lift." },
  { eventType: "analyzed", detail: "Action: write_summary | summary=Executive summary written. Analysis completed and the decision trail is sealed." },
];

export function demoTimelinePayload() {
  return {
    result: EVENT_SEEDS.map((seed, index) => ({
      sys_id: demoEventId(index + 1),
      sequence: index + 1,
      event_type: seed.eventType,
      ...(seed.actor ? { agent: seed.actor } : {}),
      ...(seed.recordName ? { staged_ci: { display_value: seed.recordName } } : {}),
      ...(seed.status ? { status: seed.status } : {}),
      detail: seed.detail,
      sys_created_on: clockAt(index * 4),
    })),
  };
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

// The relationship graph only lays out the first seven CIs, so the edges are
// concentrated there — otherwise the panel renders nodes with no lines.
const RELATIONSHIP_PAIRS: Array<[number, number, string, number]> = [
  [0, 1, "Depends on::Used by", 0.96],
  [2, 0, "Routes to::Routed by", 0.92],
  [3, 1, "Reads from::Read by", 0.78],
  [5, 0, "Exchanges with::Exchanges with", 0.73],
  [4, 3, "Supports::Supported by", 0.88],
  [6, 1, "Depends on::Used by", 0.9],
  [2, 6, "Routes to::Routed by", 0.85],
  [8, 1, "Depends on::Used by", 0.81],
  [9, 12, "Hosted on::Hosts", 0.77],
  [7, 11, "Hosted on::Hosts", 0.83],
];

export function demoRelationshipsPayload() {
  return {
    result: RELATIONSHIP_PAIRS.map(([parent, child, type, confidence], index) => ({
      sys_id: demoSysId("e", 500 + index),
      parent_ci: { value: demoStagedCiId(parent), display_value: ciNameFor(parent) },
      child_ci: { value: demoStagedCiId(child), display_value: ciNameFor(child) },
      relationship_type: type,
      confidence,
    })),
  };
}

// ---------------------------------------------------------------------------
// Findings and review decisions
// ---------------------------------------------------------------------------

type DemoFindingSeed = {
  ciIndex: number;
  type: string;
  severity: "critical" | "high" | "medium";
  recommendation: string;
  decision: "deferred" | "approved" | "rejected";
  rationale: string;
};

/**
 * Findings link to CIs by `staged_ci`, and reviews link to findings by
 * `finding`. If those references do not resolve, `deriveRemediationWorkQueue`
 * classifies every row as `derived_staging` and the Remediate and Approvals
 * views render empty — so the cross-referencing here is load-bearing.
 */
/**
 * The homogeneous cohort the simulated approval packet is prepared from: every
 * clean record of the packet archetype, all sharing one class and one operation
 * family. Exported so the transport and the smoke test agree on it.
 */
export const demoPacketCohort: DemoCiSeed[] = demoCiSeeds.filter(
  seed => seed.status === "live" && seed.index % ARCHETYPES.length === PACKET_ARCHETYPE_INDEX,
);

const packetCohortIds = new Set(demoPacketCohort.map(seed => seed.index));

export const demoFindingSeeds: DemoFindingSeed[] = demoCiSeeds
  .filter(seed => seed.status !== "live" || packetCohortIds.has(seed.index))
  .map(seed => {
    const duplicate = seed.status === "live";
    // One approved and one rejected decision so `ready_to_execute` and
    // `blocked` are both populated instead of every row landing in one bucket.
    const decision: DemoFindingSeed["decision"] =
      seed.index === 3 ? "rejected"
      : seed.index === 24 ? "approved"
      : "deferred";
    return {
      ciIndex: seed.index,
      type: duplicate ? "duplicate_candidate" : seed.status === "incomplete" ? "incomplete_identity" : "class_mismatch",
      severity: duplicate ? "high" : seed.operation === "ERROR" ? "critical" : "high",
      recommendation: duplicate
        ? `Collapse ${seed.name} against its probable duplicate before publishing.`
        : seed.status === "incomplete"
          ? `Supply a serial number or FQDN for ${seed.name} so IRE can establish identity.`
          : `Confirm the proposed class ${seed.className} for ${seed.name} before IRE simulation.`,
      decision,
      rationale: decision === "approved"
        ? "Identity evidence is sufficient; approved for governed execution."
        : decision === "rejected"
          ? "Proposed class conflicts with the authoritative source. Returned to the source owner."
          : "Held for human authorization through the bounded approval packet.",
    } satisfies DemoFindingSeed;
  });

export function demoFindingsPayload() {
  return {
    result: demoFindingSeeds.map((seed, index) => ({
      sys_id: demoFindingId(seed.ciIndex),
      number: `DWF${String(2000 + index)}`,
      staged_ci: { value: demoStagedCiId(seed.ciIndex), display_value: ciNameFor(seed.ciIndex) },
      type: seed.type,
      severity: seed.severity,
      recommendation: seed.recommendation,
    })),
  };
}

export function demoReviewsPayload() {
  return {
    result: demoFindingSeeds.map((seed, index) => ({
      sys_id: demoReviewId(seed.ciIndex),
      finding: { value: demoFindingId(seed.ciIndex), display_value: `DWF${String(2000 + index)}` },
      decision: seed.decision,
      rationale: seed.rationale,
      policy_approved: seed.decision === "approved",
    })),
  };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function demoHealthPayload() {
  // Counts are derived from the actual arrays rather than hard-coded, so the
  // KPI tiles cannot contradict the table beneath them.
  const baseline = 71;
  const verified = 78;
  const projected = 89;
  return {
    result: {
      score: verified,
      grade: "B",
      baseline_score: baseline,
      verified_score: verified,
      projected_score: projected,
      ci_count: demoCiSeeds.length,
      duplicates_detected: duplicateCandidateCount,
      review_count: heldCount,
      relationship_count: RELATIONSHIP_PAIRS.length,
      completeness: 82,
      correctness: 91,
      compliance: 96,
      duplicate_rate: Number(((duplicateCandidateCount / demoCiSeeds.length) * 100).toFixed(1)),
      stale_records: 11,
      fixes: [
        {
          id: "FIX-01", rank: 1, title: "Collapse probable server duplicates",
          description: `${duplicateCandidateCount} CI pairs share serial, FQDN, or cloud identity signals.`,
          impact: 6, affected: duplicateCandidateCount * 2, tool: "Scout", severity: "critical",
        },
        {
          id: "FIX-02", rank: 2, title: "Complete missing ownership",
          description: "Production CIs with no support group or business owner cannot be routed on incident.",
          impact: 4, affected: 14, tool: "Guard", severity: "high",
        },
        {
          id: "FIX-03", rank: 3, title: "Review incomplete IRE inserts",
          description: `${incompleteCount} records could not be uniquely identified by IRE.`,
          impact: 3, affected: incompleteCount, tool: "Guard", severity: "high",
        },
        {
          id: "FIX-04", rank: 4, title: "Refresh stale infrastructure",
          description: "Some CIs have not been observed in more than 90 days.",
          impact: 2, affected: 11, tool: "Scout", severity: "medium",
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Run record, instance, and AI usage
// ---------------------------------------------------------------------------

export function demoRunPayload() {
  return {
    result: {
      sys_id: DEMO_RUN_ID,
      number: DEMO_RUN_NUMBER,
      state: DEMO_RUN_STATE,
      source_system: "Baxter Inventory",
      started: clockAt(0),
      summary: DEMO_RUN_LABEL,
    },
  };
}

/**
 * Deliberately reports no host. Demo mode is not pretending to be connected to
 * an instance, so there is nothing to name — the demo toggle is the only signal
 * the header needs.
 */
export function demoInstancePayload() {
  return {};
}

const USAGE_SEEDS: Array<[string, string, number, number, number, string]> = [
  ["Comprehend", "claude-opus-5", 4820, 940, 3120, "success"],
  ["Comprehend", "claude-opus-5", 3610, 720, 2480, "success"],
  ["Comprehend", "claude-opus-5", 5140, 1180, 3890, "success"],
  ["Mara", "claude-opus-5", 6210, 1640, 4510, "success"],
  ["Mara", "claude-opus-5", 2980, 610, 1970, "success"],
  // At least one deterministic-fallback call so the AI Usage page's fallback
  // banner is exercised rather than sitting untested behind a happy path.
  ["Mara", "deterministic", 0, 0, 140, "fallback"],
  ["Prioritize", "claude-opus-5", 3340, 880, 2610, "success"],
  ["Prioritize", "claude-opus-5", 2110, 470, 1580, "success"],
];

export function demoUsagePayload() {
  return {
    result: {
      run_id: DEMO_RUN_ID,
      calls: USAGE_SEEDS.map(([phase, model, input, output, duration, status], index) => ({
        sys_id: demoSysId("e", 900 + index),
        sys_created_on: clockAt(index * 11),
        phase,
        model,
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
        duration_ms: duration,
        status,
      })),
    },
  };
}
