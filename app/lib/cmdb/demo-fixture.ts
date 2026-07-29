// The simulated migration run served while demo mode is on.
//
// The demo tells one story with one source: every demo import comes from the
// single public URL in `demo-source-snapshot.ts` (AWS ip-ranges.json), resolved
// from a frozen snapshot and transformed by the repository's *real*
// `aws-ip-ranges` source adapter. The staged CIs below are therefore exactly
// what a genuine AWS import would stage — same names, same class, same source
// identity — with zero network dependency.
//
// Everything is then emitted in the *raw* ServiceNow wire shape and passed
// through the real `normalizeComprehend*` adapters, so demo mode exercises the
// production normalization path rather than bypassing it. If an adapter changes,
// the demo changes with it.
//
// Two hard rules:
//   1. Deterministic. No `Math.random`, no `Date.now`. The same fixture renders
//      identically on every load, so screenshots and smoke assertions are stable.
//   2. Structurally valid. The frontend validates its own identifiers before any
//      governed action — 32-hex for run/staged-CI/finding ids, 64-hex uppercase
//      for simulation fingerprints — so ids are minted here as real hex that is
//      still obviously fake at a glance.

import { getSourceAdapter } from "./source-adapters";
import { DEMO_SERVICES, DEMO_SOURCE_NAME, DEMO_SOURCE_URL, demoSourceSnapshot } from "./demo-source-snapshot";

export { DEMO_SERVICES, DEMO_SOURCE_NAME, DEMO_SOURCE_URL } from "./demo-source-snapshot";

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
export const DEMO_RUN_LABEL = "AWS IP Ranges estate (demo)";
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

/**
 * Human-readable class label and the real CMDB table for every demo record.
 * The `aws-ip-ranges` adapter proposes `cmdb_ci_ip_network` for each prefix,
 * so the whole run is one class — which also makes the bounded-approval-packet
 * homogeneity requirement trivial to satisfy. Structured ledger evidence must
 * carry the *table* name, not the display label — `terminal-outcomes.ts`
 * validates it against /^[a-z][a-z0-9_]{2,79}$/ before a verified outcome will
 * correlate.
 */
export const DEMO_CLASS_LABEL = "IP Network";
export const DEMO_CLASS_TABLE = "cmdb_ci_ip_network";

/**
 * The IRE outcome family each AWS service's prefixes reconcile to. Driving the
 * operation from the service rather than the row index is what makes an
 * approval packet possible: `planApprovalPacket` only accepts a homogeneous
 * class + operation-family cohort, so a per-index cycle would fragment the
 * cohort into groups of one or two. Order matches `DEMO_SERVICES` — the
 * snapshot cycles services, so `index % 8` is the service.
 */
const SERVICE_FAMILIES: Array<"INSERT" | "UPDATE" | "NO_CHANGE"> = [
  "UPDATE",    // EC2 — matched existing network CIs
  "NO_CHANGE", // S3 — already current
  "INSERT",    // CLOUDFRONT — new to the CMDB
  "INSERT",    // API_GATEWAY
  "UPDATE",    // DYNAMODB
  "INSERT",    // ROUTE53_HEALTHCHECKS
  "NO_CHANGE", // AMAZON
  "UPDATE",    // GLOBALACCELERATOR
];

/**
 * The staged rows a real AWS import would produce: the actual repository
 * adapter run over the frozen snapshot. Names, source identities, and IPs all
 * come from here — nothing is invented in parallel to the real code path.
 *
 * This runs at module scope, and this module is imported by the live dashboard,
 * so a throw here would blank the whole app rather than just demo mode. The
 * adapter *does* throw (SourceAdapterError) on a payload without a `prefixes`
 * array, so an edit to the snapshot must never be able to take live mode down
 * with it. Contained deliberately: a broken snapshot degrades demo mode to an
 * empty run, which `smoke:demo-fallback` fails loudly on, while live mode is
 * completely unaffected.
 */
const adapterRows = (() => {
  try {
    return getSourceAdapter("aws-ip-ranges")
      .transform(demoSourceSnapshot, { sourceName: DEMO_SOURCE_NAME })
      .cis;
  } catch (error) {
    console.error("Demo source snapshot failed the aws-ip-ranges adapter; demo mode will be empty.", error);
    return [];
  }
})();

export const DEMO_CI_COUNT = adapterRows.length;

/**
 * The service whose whole clean cohort is homogeneous — this is what the
 * simulated approval packet is built from (EC2, index % 8 === 0).
 */
const PACKET_ARCHETYPE_INDEX = 0;

/**
 * A demo where every record sails through is a worse demo. These exceptions
 * deliberately keep the full outcome spread — held records, incomplete
 * identity, and one hard error — so the review queue, the Sankey, and the
 * blocked bucket all have something real to show. They land on services 3 and
 * 7 so the packet cohort (service 0, EC2) stays clean.
 */
function operationFor(index: number): DemoOperation {
  if (index === 43) return "ERROR";
  if (index % 16 === 3) return "REVIEW";
  if (index % 16 === 7) return "INSERT_AS_INCOMPLETE";
  if (index % 16 === 11) return "REVIEW";
  if (index % 16 === 15) return "INSERT_AS_INCOMPLETE";
  return SERVICE_FAMILIES[index % SERVICE_FAMILIES.length];
}

function confidenceFor(index: number, operation: DemoOperation): number {
  if (operation === "ERROR") return 0.21;
  if (operation === "REVIEW") return 0.42 + (index % 5) / 100;
  if (operation === "INSERT_AS_INCOMPLETE") return 0.34 + (index % 4) / 100;
  return 0.91 + (index % 9) / 100;
}

/**
 * Adapter-derived name, e.g. "aws-ec2-us-east-1-3.80.0.0/12".
 *
 * Index-safe on purpose: this is called at module scope while building the
 * event seeds, so if `adapterRows` ever came back empty (a malformed snapshot,
 * contained above) an unguarded lookup would throw right back out of module
 * evaluation and blank the live app — defeating that containment entirely.
 */
function ciNameFor(index: number): string {
  const row = adapterRows[index];
  return row?.name ?? row?.source_identifier ?? `aws-prefix-${index + 1}`;
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
  /** AWS service the prefix belongs to (EC2, S3, …). */
  service: string;
  /** AWS region the prefix is advertised from. */
  region: string;
  /** The adapter's native source record key, used as the source identity. */
  sourceRecordId: string;
  operation: DemoOperation;
  confidence: number;
  /** live | review | incomplete, mirroring what the adapter will derive. */
  status: "live" | "review" | "incomplete";
};

export const demoCiSeeds: DemoCiSeed[] = adapterRows.map((row, index) => {
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
    className: DEMO_CLASS_LABEL,
    table: DEMO_CLASS_TABLE,
    source: DEMO_SOURCE_NAME,
    ip: row.ip_address ?? ciNameFor(index),
    service: DEMO_SERVICES[index % DEMO_SERVICES.length],
    region: row.environment ?? "unknown",
    sourceRecordId: row.source_record_id ?? row.source_identifier ?? `aws-prefix-${index + 1}`,
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
  seed => seed.status === "live" && seed.index % DEMO_SERVICES.length === PACKET_ARCHETYPE_INDEX,
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
        source_record_id: seed.sourceRecordId,
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
// Orphan count is derived from the actual relationship pairs so the prose can
// never contradict the graph beneath it.
const relationshipTouched = new Set<number>();

const EVENT_SEEDS: DemoEventSeed[] = [
  { eventType: "ingested", actor: "Comprehend", detail: `Analysis session started for the ${DEMO_SOURCE_NAME} batch imported from ${DEMO_SOURCE_URL}. Seed data created from ${DEMO_CI_COUNT} fingerprinted prefixes.` },
  { eventType: "record_staged", actor: "Router", detail: `Staged safely: ${DEMO_CI_COUNT} rows quarantined in the staging table. No CMDB access occurred.` },
  { eventType: "analyzed", detail: `Action: get_run_stats | summary=Run stats collected for ${DEMO_CI_COUNT} staged CIs from one source feed (${DEMO_SOURCE_NAME}).` },
  // Counts in ledger prose are interpolated from the actual seeds. Hard-coding
  // them lets the narrative drift out of step with the table beneath it, which a
  // viewer notices immediately.
  { eventType: "analyzed", detail: `Action: scan_classes | summary=Class scan proposed one CMDB class (${DEMO_CLASS_TABLE}); ${clearedCount} of ${DEMO_CI_COUNT} records validated.` },
  { eventType: "analyzed", detail: "Action: scan_attributes | summary=Attribute scan mapped region, service, and border group for every prefix." },
  { eventType: "analyzed", detail: `Action: scan_duplicates | summary=Duplicate scan flagged ${duplicateCandidateCount} overlapping ranges on CIDR containment signals.` },
  { eventType: "analyzed", detail: `Action: scan_orphans | summary=Orphan scan found ORPHAN_COUNT staged CIs with no proposed relationship.` },
  { eventType: "analyzed", detail: `Action: apply_confidence_gate | summary=Confidence gate applied. ${clearedCount} records cleared the 50% deterministic threshold, ${DEMO_CI_COUNT - clearedCount} were held.` },
  { eventType: "analyzed", actor: "Mara", detail: "Observation: Mara reviewed the deterministic specialist output and accepted the confidence gate result without override." },
  { eventType: "simulated", actor: "IRE", detail: "IRE simulation prepared for the cleared cohort. Identification and reconciliation ran in proposal mode only.", recordName: ciNameFor(0) },
  { eventType: "approved", actor: "Mara", detail: "Approval review deferred pending human authorization of the bounded packet.", recordName: ciNameFor(3), status: "review" },
  { eventType: "committed", actor: "IRE", detail: "CMDB published: governed attribute updates applied and the discovery source tagged as Migration Pipeline.", recordName: ciNameFor(0) },
  { eventType: "analyzed", actor: "Prioritize", detail: "PriorityScorer ranked 4 health recommendations by projected score lift." },
  { eventType: "analyzed", detail: "Action: write_summary | summary=Executive summary written. Analysis completed and the decision trail is sealed." },
];

/**
 * How much of the ledger each pipeline stage exposes while the simulated run
 * progresses after an import:
 *   stage 0 — intake + staging      (events 0-1)
 *   stage 1 — deterministic scans   (events 0-6)
 *   stage 2 — gate + Mara review    (events 0-8)
 *   stage 3 — IRE, Prioritize, seal (all events; run turns terminal)
 */
export const DEMO_STAGE_EVENT_COUNTS = [2, 7, 9, EVENT_SEEDS.length] as const;

export function demoTimelinePayload(limit = EVENT_SEEDS.length) {
  return {
    result: EVENT_SEEDS.slice(0, Math.max(0, limit)).map((seed, index) => ({
      sys_id: demoEventId(index + 1),
      sequence: index + 1,
      event_type: seed.eventType,
      ...(seed.actor ? { agent: seed.actor } : {}),
      ...(seed.recordName ? { staged_ci: { display_value: seed.recordName } } : {}),
      ...(seed.status ? { status: seed.status } : {}),
      detail: seed.detail.replace("ORPHAN_COUNT", String(DEMO_CI_COUNT - relationshipTouched.size)),
      sys_created_on: clockAt(index * 4),
    })),
  };
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

// The relationship graph only lays out the first seven CIs, so the edges are
// concentrated there — otherwise the panel renders nodes with no lines.
// Network-flavoured edge types: region membership, CIDR containment, routing.
const RELATIONSHIP_PAIRS: Array<[number, number, string, number]> = [
  [0, 1, "Peers with::Peers with", 0.96],
  [2, 0, "Routes to::Routed by", 0.92],
  [3, 1, "Routes to::Routed by", 0.78],
  [5, 0, "Monitors::Monitored by", 0.73],
  [4, 3, "Peers with::Peers with", 0.88],
  [6, 1, "Contains::Member of", 0.9],
  [2, 6, "Member of::Contains", 0.85],
  [8, 1, "Peers with::Peers with", 0.81],
  [9, 12, "Contains::Member of", 0.77],
  [7, 11, "Routes to::Routed by", 0.83],
];
for (const [parent, child] of RELATIONSHIP_PAIRS) {
  relationshipTouched.add(parent);
  relationshipTouched.add(child);
}

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
  seed => seed.status === "live" && seed.index % DEMO_SERVICES.length === PACKET_ARCHETYPE_INDEX,
);

const packetCohortIds = new Set(demoPacketCohort.map(seed => seed.index));

/**
 * Every staged CI gets a finding and a review decision — not just the held
 * records and the packet cohort.
 *
 * This is load-bearing for the Remediate workbench, not cosmetic. "Commit this
 * CI to ServiceNow" is gated on `approvable`, which requires BOTH
 * `selectedQueueItem.finding?.id` and `.review?.id`. A record with no finding
 * can be simulated but can never be committed, so the button sits permanently
 * greyed out with no way for the operator to discover why. Covering every
 * record is also the truthful shape: Comprehend raises a finding for each
 * record it proposes an action on.
 */
export const demoFindingSeeds: DemoFindingSeed[] = demoCiSeeds.map(seed => {
  const duplicate = seed.status === "live" && packetCohortIds.has(seed.index);
  // One approved and one rejected decision so `ready_to_execute` and
  // `blocked` are both populated instead of every row landing in one bucket.
  const decision: DemoFindingSeed["decision"] =
    seed.index === 3 ? "rejected"
    : seed.index === 24 ? "approved"
    : "deferred";
  const type = duplicate ? "duplicate_candidate"
    : seed.status === "incomplete" ? "incomplete_identity"
    : seed.status === "review" ? "class_mismatch"
    : "reconciliation_candidate";
  return {
    ciIndex: seed.index,
    type,
    severity: seed.operation === "ERROR" ? "critical" : seed.status === "live" ? "medium" : "high",
    recommendation: type === "duplicate_candidate"
      ? `Collapse ${seed.name} against its overlapping range before publishing.`
      : type === "incomplete_identity"
        ? `Supply a network border group or VPC identifier for ${seed.name} so IRE can establish identity.`
        : type === "class_mismatch"
          ? `Confirm the proposed class ${seed.className} for ${seed.name} before IRE simulation.`
          : `Reconcile ${seed.name} into the CMDB as ${seed.operation} once its simulation is approved.`,
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
          id: "FIX-01", rank: 1, title: "Collapse overlapping duplicate ranges",
          description: `${duplicateCandidateCount} CIDR ranges overlap on containment signals and are probable duplicates.`,
          impact: 6, affected: duplicateCandidateCount * 2, tool: "Scout", severity: "critical",
        },
        {
          id: "FIX-02", rank: 2, title: "Complete missing ownership",
          description: "Network CIs with no support group or business owner cannot be routed on incident.",
          impact: 4, affected: 14, tool: "Guard", severity: "high",
        },
        {
          id: "FIX-03", rank: 3, title: "Review incomplete IRE inserts",
          description: `${incompleteCount} records could not be uniquely identified by IRE.`,
          impact: 3, affected: incompleteCount, tool: "Guard", severity: "high",
        },
        {
          id: "FIX-04", rank: 4, title: "Refresh stale network records",
          description: "Some prefixes have not been observed in the source feed for more than 90 days.",
          impact: 2, affected: 11, tool: "Scout", severity: "medium",
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Run record, instance, and AI usage
// ---------------------------------------------------------------------------

export function demoRunPayload(state: string = DEMO_RUN_STATE) {
  return {
    result: {
      sys_id: DEMO_RUN_ID,
      number: DEMO_RUN_NUMBER,
      state,
      source_system: "ip-ranges.amazonaws.com",
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
