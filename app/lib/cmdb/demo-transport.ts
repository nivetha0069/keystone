// The single seam between the app and ServiceNow.
//
// Every backend call in the frontend goes through `cmdbFetch`. When demo mode is
// off it delegates to the real `fetch` verbatim, so behaviour is byte-identical
// to having no demo layer at all. When demo mode is on it answers locally and
// **never touches the network** — governed writes (IRE, /remediate, approval
// packets) are simulated in memory so the operator can walk the whole story
// without a single request leaving the browser.
//
// Note on `node:crypto`: `remediation-campaign.ts` and `approval-packet.ts`
// import `createHash`, which cannot run in a browser. Those modules are
// deliberately imported here as **types only**; the payloads below are
// synthesized and the compiler checks them against the real production types,
// so a shape drift breaks the build rather than the demo.

import { isDemoMode } from "./demo-mode";
import {
  DEMO_CI_COUNT,
  DEMO_CAMPAIGN_SIZE,
  DEMO_PACKET_SIZE,
  DEMO_RUN_ID,
  DEMO_RUN_STATE,
  DEMO_SOURCE_URL,
  DEMO_STAGE_EVENT_COUNTS,
  DEMO_RUN_LABEL,
  DEMO_RUN_NUMBER,
  demoCiSeeds,
  demoCisPayload,
  demoClockAt,
  demoEventId,
  demoFindingId,
  demoFindingSeeds,
  demoFindingsPayload,
  demoFingerprint,
  demoHealthPayload,
  demoInstancePayload,
  demoPacketCohort,
  demoRelationshipsPayload,
  demoReviewId,
  demoReviewsPayload,
  demoRunPayload,
  demoStagedCiId,
  demoTargetCiId,
  demoTimelinePayload,
  demoUsagePayload,
  type DemoCiSeed,
} from "./demo-fixture";
import type { IreAction, IreActionResponse } from "./ire";
import type {
  CampaignSummary,
  RemediationApprovalManifest,
  RemediationApprovalManifestItem,
  RemediationCampaignActionItem,
  RemediationCampaignApprovalResult,
  RemediationCampaignBulkSimulationResult,
  RemediationCampaignItem,
  RemediationCampaignPlan,
  RemediationCampaignSimulationResult,
  RemediationCampaignStatus,
  RemediationFailureGroupsResult,
} from "./remediation-campaign";
import type {
  ApprovalPacketAggregate,
  ApprovalPacketApprovalResult,
  ApprovalPacketChild,
  ApprovalPacketPlan,
  ApprovalPacketProgressItem,
  ApprovalPacketSample,
  ApprovalPacketStatus,
  FrozenApprovalPacket,
} from "./approval-packet";

/**
 * Small artificial latency. Without it every simulated action resolves in the
 * same tick and the pending/spinner states never render, which would make the
 * demo feel unlike the real thing.
 */
const LATENCY_MS = 240;

// Literal copies of the exported policy constants. They cannot be imported as
// values (their modules pull in `node:crypto`), but TypeScript still checks each
// one against the corresponding `typeof …` literal type below.
const APPROVAL_PACKET_POLICY_VERSION = "bounded-approval-packet-v2";
const CAMPAIGN_INSERT_POLICY_VERSION = "bounded-insert-v1";
const CAMPAIGN_CLASS_BOUND_POLICY_VERSION = "servicenow-allowlisted-class-v1";
const CAMPAIGN_SIMULATION_EVIDENCE_VERSION = "keystone.simulation.v2";

const DEMO_WORK_GROUP = "IP Network|INSERT";
const DEMO_GROUP_TITLE = "Healthy AWS prefixes creating new network CIs";
const DEMO_CLASS_NAME = demoPacketCohort[0]?.className ?? "IP Network";
const DEMO_OPERATION_FAMILY = "INSERT";

/**
 * Pipeline progression for the simulated run. Importing from the demo source
 * URL resets the run to stage 0; every subsequent `/timeline` read serves the
 * current stage's slice of the ledger and then advances one stage, so the
 * app's own 8-second polling walks the run through intake → scans → gate →
 * IRE/seal without any UI change. `DONE_STAGE` is one past the last content
 * stage: the run only reports its terminal state after the *full* ledger has
 * been served, otherwise polling would stop with a half-told story.
 */
const DONE_STAGE = DEMO_STAGE_EVENT_COUNTS.length; // 4
const contentStageOf = (stage: number) => Math.min(stage, DEMO_STAGE_EVENT_COUNTS.length - 1);

// ---------------------------------------------------------------------------
// In-memory simulated write state
// ---------------------------------------------------------------------------

type DemoIreRecord = {
  simulation?: IreActionResponse;
  approval?: IreActionResponse;
  execution?: IreActionResponse;
  verification?: IreActionResponse;
};

type PacketPhase = "none" | "planned" | "prepared" | "authorized" | "committing" | "completed";

type DemoWriteState = {
  ire: Map<string, DemoIreRecord>;
  packetPhase: PacketPhase;
  packetSequence: number;
  packetSeeds: DemoCiSeed[];
  /** Advances on each packet-status poll so progress visibly converges. */
  packetPolls: number;
  campaignSimulated: boolean;
  campaignApproved: boolean;
  proposals: Set<string>;
  /**
   * Pipeline progression stage, 0..DONE_STAGE. Entering demo mode starts at
   * DONE_STAGE (fully analyzed) so no surface ever looks stuck; importing from
   * the demo source URL rewinds to 0 so the operator can watch the whole
   * pipeline run start to end on the app's own polling.
   */
  stage: number;
  /**
   * Ledger events produced by simulated writes, appended to what `/timeline`
   * returns. This is what makes demo mode complete end to end: the Agent
   * Workspace journey, the work queue, and the "View completed results" control
   * are all derived from the Event Ledger, so a write that leaves no ledger
   * evidence looks to the rest of the UI like nothing happened.
   */
  ledger: Array<Record<string, unknown>>;
  /** Staged CIs that already have a completed simulation entry. */
  simulated: Set<string>;
  /** Staged CIs that already have a verification_passed entry, so polls do not duplicate it. */
  verified: Set<string>;
};

function freshState(stage: number = DONE_STAGE): DemoWriteState {
  return {
    ire: new Map(),
    packetPhase: "none",
    packetSequence: 0,
    packetSeeds: [],
    packetPolls: 0,
    campaignSimulated: false,
    campaignApproved: false,
    proposals: new Set(),
    stage,
    ledger: [],
    simulated: new Set(),
    verified: new Set(),
  };
}

let state = freshState();

/**
 * Discard every simulated write. Called when demo mode is switched off so
 * locally-fabricated approval and execution evidence can never be mistaken for
 * real ServiceNow evidence in a later live session.
 */
export function resetDemoWriteState(): void {
  state = freshState();
}

/** Read-only view used by the smoke test. */
export function demoWriteSnapshot() {
  return {
    ire: new Map(state.ire),
    packetPhase: state.packetPhase,
    packetSequence: state.packetSequence,
    packetSize: state.packetSeeds.length,
    campaignSimulated: state.campaignSimulated,
    campaignApproved: state.campaignApproved,
    proposalCount: state.proposals.size,
    stage: state.stage,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pathOf(input: RequestInfo | URL): string | null {
  try {
    if (typeof input === "string") return input.startsWith("/") ? input.split("?")[0] : new URL(input).pathname;
    if (input instanceof URL) return input.pathname;
    return new URL(input.url).pathname;
  } catch { return null; }
}

/**
 * True when a request mentions the simulated run anywhere — query string, path,
 * or JSON body. Used to keep fabricated identifiers off the wire regardless of
 * which side of the toggle the caller started on.
 */
function referencesDemoRun(input: RequestInfo | URL, init?: RequestInit): boolean {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.toLowerCase().includes(DEMO_RUN_ID)) return true;
  } catch { /* fall through to the body check */ }
  if (typeof init?.body === "string" && init.body.toLowerCase().includes(DEMO_RUN_ID)) return true;
  return false;
}

function demoRequestedByUrl(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const value = new URL(window.location.href).searchParams.get("demo");
    return value === "1" || value === "true";
  } catch {
    return false;
  }
}

async function bodyOf(init?: RequestInit): Promise<Record<string, unknown>> {
  if (!init?.body || typeof init.body !== "string") return {};
  try { return JSON.parse(init.body) as Record<string, unknown>; } catch { return {}; }
}

/**
 * Structured per-CI lifecycle actions the work queue recognises. Anything
 * outside this set is treated as a run-level evidence dump and ignored, so the
 * strings matter — see isStructuredCiLifecycleEvent in work-queue.ts.
 */
type LedgerAction =
  | "ire_simulation_completed"
  | "ire_simulation_failed"
  | "approval_recorded"
  | "ire_execution_claimed"
  | "ire_execution_completed"
  | "verification_passed";

/**
 * Append one keystone.agent.v1 ledger entry for a staged CI.
 *
 * The actor is deliberately never Mara: Mara's entries are classified as
 * run-level observations and excluded from per-CI scoping.
 */
function appendLedgerEvent(
  seed: DemoCiSeed,
  action: LedgerAction,
  status: "completed" | "failed" | "started",
  summary: string,
  extra: Record<string, unknown> = {},
): string {
  const detail = JSON.stringify({
    schema: "keystone.agent.v1",
    phase: "remediate",
    actor: "IRE",
    decision_source: "deterministic",
    action,
    status,
    summary,
    staged_ci_id: seed.sysId,
    migration_run_id: DEMO_RUN_ID,
    ...extra,
  });
  const index = state.ledger.length;
  const eventId = demoEventId(2000 + index);
  state.ledger.push({
    sys_id: eventId,
    sequence: 100 + index,
    event_type: action.includes("verification") ? "verified"
      : action.includes("execution") ? "committed"
      : action.includes("approval") ? "approved"
      : "simulated",
    agent: "IRE",
    staged_ci: { display_value: seed.name },
    status: status === "failed" ? "error" : "complete",
    detail,
    sys_created_on: demoClockAt(600 + index * 3),
  });
  return eventId;
}

/**
 * Emit the complete simulation → approval → execution → verification chain for
 * one record.
 *
 * `deriveCorrelatedVerifiedOutcomes` will only count a record as a verified
 * outcome when all four entries cross-reference each other exactly: the
 * execution and verification must name the approval's own event sys_id, and the
 * simulation correlation, fingerprint, target CI, and operation must match at
 * every hop. That check is the product's integrity guarantee, so the demo
 * satisfies it rather than working around it — otherwise the run reports
 * "no records reached verification" while showing six verified.
 */
function appendVerifiedChain(seed: DemoCiSeed): void {
  if (state.verified.has(seed.sysId)) return;
  state.verified.add(seed.sysId);

  const operation = seed.operation === "INSERT" ? "INSERT" : "UPDATE";
  const simulationCorrelation = `ks-simulate:demo:${seed.index}`;
  const executionCorrelation = `ks-exec:demo:${seed.index}`;
  const fingerprint = demoFingerprint(seed.index);
  const targetCiSysId = demoTargetCiId(seed.index);
  const evidence = {
    simulation_correlation_id: simulationCorrelation,
    simulation_fingerprint: fingerprint,
    proposed_class: seed.table,
    operation,
    evidence_version: CAMPAIGN_SIMULATION_EVIDENCE_VERSION,
    class_policy_version: CAMPAIGN_CLASS_BOUND_POLICY_VERSION,
  };

  if (!state.simulated.has(seed.sysId)) {
    state.simulated.add(seed.sysId);
    appendLedgerEvent(seed, "ire_simulation_completed", "completed",
      `Simulation prepared for ${seed.name} in proposal mode.`, evidence);
  }

  const approvalEventId = appendLedgerEvent(seed, "approval_recorded", "completed",
    `Approval recorded for ${seed.name} against the exact simulation evidence.`, {
      ...evidence,
      finding_id: demoFindingId(seed.index),
      review_decision_id: demoReviewId(seed.index),
      decision: "approved",
      // Mirrors the live contract: a human authorized this packet, so it is not
      // a policy auto-approval.
      policy_approved: false,
    });

  appendLedgerEvent(seed, "ire_execution_completed", "completed",
    `IRE applied the governed change to ${seed.name}.`, {
      ...evidence,
      approval_event_id: approvalEventId,
      execution_correlation_id: executionCorrelation,
      target_ci_sys_id: targetCiSysId,
    });

  appendLedgerEvent(seed, "verification_passed", "completed",
    `Read-back confirmed ${seed.name} in the CMDB with the governed attribute set.`, {
      ...evidence,
      approval_event_id: approvalEventId,
      execution_correlation_id: executionCorrelation,
      target_ci_sys_id: targetCiSysId,
    });
}

/**
 * Record a read-back for one CI, once. This is the entry the work queue turns
 * into a `verified` bucket item, which is in turn what completes the Verify
 * chapter and enables "View completed results".
 */
function markVerified(seed: DemoCiSeed): void {
  appendVerifiedChain(seed);
}

/**
 * The current stage's slice of the fixture ledger, plus everything the
 * simulated writes have produced. Write evidence only ever exists once the run
 * is terminal (the UI locks IRE until then), so appending it at DONE_STAGE
 * cannot leak post-run events into an in-progress replay.
 */
function timelinePayloadWithWrites() {
  const base = demoTimelinePayload(DEMO_STAGE_EVENT_COUNTS[contentStageOf(state.stage)]).result;
  return { result: state.stage >= DONE_STAGE ? [...base, ...state.ledger] : base };
}

/**
 * Stage-gated reads. `/cis` is always full (records exist from the moment they
 * are staged); scan output, gate output, and the terminal run state appear in
 * pipeline order as `/timeline` reads advance the stage. Gates compare against
 * the post-advance stage because within one polling batch the timeline handler
 * runs before these do.
 */
const READ_PAYLOADS: Record<string, () => unknown> = {
  cis: demoCisPayload,
  timeline: () => {
    const payload = timelinePayloadWithWrites();
    if (state.stage < DONE_STAGE) state.stage += 1;
    return payload;
  },
  relationships: () => (state.stage >= 2 ? demoRelationshipsPayload() : { result: [] }),
  findings: () => (state.stage >= 3 ? demoFindingsPayload() : { result: [] }),
  reviews: () => (state.stage >= 3 ? demoReviewsPayload() : { result: [] }),
  health: () => (state.stage >= 3 ? demoHealthPayload() : { result: { ci_count: DEMO_CI_COUNT } }),
  run: () => demoRunPayload(state.stage >= DONE_STAGE ? DEMO_RUN_STATE : "analyzing"),
};

/**
 * Drop-in replacement for `fetch` on every `/api/cmdb/*` call.
 *
 * Demo off → the real `fetch`, unchanged. Demo on → a locally built `Response`,
 * so callers keep using `.ok`, `.status`, and `.json()` exactly as before.
 */
export async function cmdbFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // `?demo=1` is authoritative before React restores the external-store flag.
  // This closes the hydration window where the instance probe could otherwise
  // escape to the live compatibility route before Demo Mode becomes enabled.
  if (!isDemoMode() && !demoRequestedByUrl()) {
    // Hard containment, independent of any race. Polling intervals and in-flight
    // requests survive the moment the toggle flips, so a request carrying the
    // simulated run id can otherwise reach the real instance after demo mode is
    // already off. Fail it closed instead: the caller discards a failed resource
    // and the restored run reloads a moment later.
    if (referencesDemoRun(input, init)) {
      return json({
        error: "Stale simulated request discarded. The demo run is never sent to ServiceNow.",
      }, 409);
    }
    return fetch(input, init);
  }

  const path = pathOf(input);
  if (!path || !path.startsWith("/api/cmdb/")) return fetch(input, init);

  await new Promise(resolve => setTimeout(resolve, LATENCY_MS));
  const segments = path.replace(/^\/api\/cmdb\//, "").split("/").filter(Boolean);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = await bodyOf(init);

  if (method === "GET") {
    const [resource] = segments;
    if (resource === "instance") return json(demoInstancePayload());
    if (resource === "usage") return json(demoUsagePayload());
    const reader = READ_PAYLOADS[resource];
    if (reader) return json(reader());
    return json({ error: `Unknown CMDB resource: ${resource}` }, 404);
  }

  if (segments[0] === "comprehend") {
    // While the simulated pipeline is progressing, mirror ServiceNow's
    // "already queued" answer; once terminal, its "nothing to do" answer.
    return json({
      result: {
        success: true,
        ...(state.stage >= DONE_STAGE ? { already_completed: true } : { already_running: true }),
        migration_run_id: DEMO_RUN_ID,
      },
    });
  }
  if (segments[0] === "import") return json(demoImportResponse(body));
  if (segments[0] === "remediate") return demoRemediate(body);
  if (segments[0] === "ire") return demoIre(segments[1] as IreAction, body);
  if (segments[0] === "remediation-campaign") return demoCampaign(segments[1] ?? "", body);

  return json({ error: "Writes are not allowed on this route" }, 405);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function demoImportResponse(body: Record<string, unknown>) {
  // One source, one outcome: whatever the operator supplied, the demo stages
  // the frozen AWS IP Ranges snapshot — the same count every single time —
  // and rewinds the simulated pipeline to stage 0 so the run can be watched
  // progressing start to end. The rewind also discards any prior simulated
  // IRE/packet evidence, exactly as a fresh run would.
  state = freshState(0);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(`keystone.ireRecords.${DEMO_RUN_ID}`);
    } catch {
      // Storage may be unavailable in hardened browser contexts.
    }
  }

  return {
    result: {
      success: true,
      migration_run_id: DEMO_RUN_ID,
      run: { sys_id: DEMO_RUN_ID, number: DEMO_RUN_NUMBER, display_value: DEMO_RUN_LABEL },
      run_name: typeof body.runName === "string" && body.runName.trim() ? body.runName.trim() : DEMO_RUN_LABEL,
      source_url: DEMO_SOURCE_URL,
      staged: DEMO_CI_COUNT,
      target: "staging",
      mode: "quarantine",
    },
  };
}

// ---------------------------------------------------------------------------
// Governed proposal
// ---------------------------------------------------------------------------

function demoRemediate(body: Record<string, unknown>): Response {
  const stagedCiId = String(body.staged_ci_id ?? "");
  const correlationId = String(body.correlation_id ?? "");
  if (!stagedCiId || !correlationId) {
    return json({ error: "Invalid remediate request: exact proposal identifiers are required." }, 400);
  }
  state.proposals.add(`${stagedCiId}:${correlationId}`);
  return json({
    result: {
      success: true,
      mode: "proposal",
      staged_ci_id: stagedCiId,
      correlation_id: correlationId,
      message: "Simulated proposal recorded. No ServiceNow or CMDB endpoint was contacted.",
    },
  });
}

// ---------------------------------------------------------------------------
// IRE lifecycle
// ---------------------------------------------------------------------------

function seedFor(stagedCiId: string): DemoCiSeed | undefined {
  return demoCiSeeds.find(seed => seed.sysId === stagedCiId.toLowerCase());
}

function ireError(action: IreAction, code: NonNullable<IreActionResponse["error"]>["code"], message: string, status = 409): Response {
  const payload: IreActionResponse = {
    success: false,
    action,
    state: action === "simulate" ? "simulation_failed" : "not_simulated",
    error: { code, message },
  };
  return json(payload, status);
}

function demoIre(action: IreAction, body: Record<string, unknown>): Response {
  const stagedCiId = String(body.staged_ci_id ?? "").toLowerCase();
  const correlationId = String(body.correlation_id ?? "");
  const seed = seedFor(stagedCiId);
  if (!seed) return ireError(action, "NOT_FOUND", "This staged CI is not part of the simulated run.", 404);

  const record = state.ire.get(stagedCiId) ?? {};
  const base = {
    migration_run_id: DEMO_RUN_ID,
    staged_ci_id: stagedCiId,
    correlation_id: correlationId,
    idempotency_key: String(body.idempotency_key ?? ""),
  };

  if (action === "simulate") {
    // Idempotent replay: return the stored evidence rather than minting a second
    // simulation, matching how ServiceNow treats a repeated idempotency key.
    if (record.simulation) return json(record.simulation);
    if (seed.status === "incomplete" || seed.operation === "ERROR") {
      const failed: IreActionResponse = {
        ...base,
        success: false,
        action,
        state: "simulation_failed",
        status: seed.operation === "ERROR" ? "failed" : "incomplete",
        proposed_class: seed.className,
        evidence: [
          "Identification rules could not establish a unique identity.",
          "No serial number or FQDN was supplied by the source record.",
        ],
        error: { code: "IRE_FAILED", message: "Simulated IRE could not identify this record." },
      };
      appendLedgerEvent(seed, "ire_simulation_failed", "failed",
        `IRE could not establish a unique identity for ${seed.name}.`);
      state.ire.set(stagedCiId, { ...record, simulation: failed });
      return json(failed);
    }
    const simulation: IreActionResponse = {
      ...base,
      success: true,
      action,
      state: "simulated_pending_approval",
      status: seed.operation === "INSERT" ? "new_ci" : "matched",
      operation: seed.operation === "INSERT" ? "insert" : seed.operation === "UPDATE" ? "update" : "unchanged",
      simulation_correlation_id: correlationId,
      simulation_fingerprint: demoFingerprint(seed.index),
      proposed_class: seed.className,
      target_class: seed.className,
      source_class: seed.className,
      work_group_signature: `${seed.className}|${seed.operation}`,
      class_policy_version: CAMPAIGN_CLASS_BOUND_POLICY_VERSION,
      evidence_version: CAMPAIGN_SIMULATION_EVIDENCE_VERSION,
      decision_source: "deterministic",
      ...(seed.operation === "UPDATE"
        ? { matched_ci: { sys_id: demoTargetCiId(seed.index), display_value: seed.name } }
        : {}),
      evidence: [
        `Matched on serial number and FQDN for ${seed.name}.`,
        `Proposed class ${seed.className} validated against the allowlist.`,
        "Proposal mode only — no CMDB write occurred.",
      ],
    };
    appendLedgerEvent(seed, "ire_simulation_completed", "completed",
      `Simulation prepared for ${seed.name} in proposal mode.`,
      { simulation_correlation_id: correlationId, simulation_fingerprint: demoFingerprint(seed.index) });
    state.simulated.add(seed.sysId);
    state.ire.set(stagedCiId, { ...record, simulation });
    return json(simulation);
  }

  if (action === "approve") {
    if (!record.simulation?.success) return ireError(action, "SIMULATION_REQUIRED", "Simulate this record before requesting approval.");
    if (record.approval) return json(record.approval);
    const suppliedFingerprint = String(body.simulation_fingerprint ?? "").toUpperCase();
    if (suppliedFingerprint && suppliedFingerprint !== record.simulation.simulation_fingerprint) {
      return ireError(action, "STALE_SIMULATION", "The approved simulation no longer matches the current evidence.");
    }
    const approval: IreActionResponse = {
      ...base,
      success: true,
      action,
      state: "approved_for_execution",
      status: "approved",
      simulation_correlation_id: record.simulation.simulation_correlation_id,
      simulation_fingerprint: record.simulation.simulation_fingerprint,
      finding: { sys_id: demoFindingId(seed.index), display_value: `DWF-${seed.index}` },
      review_decision: { sys_id: demoReviewId(seed.index), display_value: "approved" },
      evidence: ["Simulated approval recorded against the exact simulation evidence."],
    };
    appendLedgerEvent(seed, "approval_recorded", "completed",
      `Approval recorded for ${seed.name} against the exact simulation evidence.`,
      { finding_id: demoFindingId(seed.index), review_decision_id: demoReviewId(seed.index) });
    // The workbench states it plainly: "Execute + Verify are automatic —
    // ServiceNow execution and verification are monitored from Event Ledger
    // evidence." The UI therefore never calls execute/verify for a single CI;
    // it just watches the ledger. Without emitting that chain here the record
    // would sit at "Approved for execution" forever, so approving one CI would
    // dead-end exactly like the packet flow used to. The monitoring poll picks
    // this up on its next pass and the row converges to Verified.
    appendVerifiedChain(seed);
    state.ire.set(stagedCiId, { ...record, approval });
    return json(approval);
  }

  if (action === "execute") {
    if (!record.approval?.success) return ireError(action, "APPROVAL_REQUIRED", "Execution is blocked until an approval is recorded.");
    if (record.execution) return json(record.execution);
    const execution: IreActionResponse = {
      ...base,
      success: true,
      action,
      state: "executed_pending_verification",
      status: seed.operation === "INSERT" ? "inserted" : "updated",
      execution_correlation_id: `ks-exec:${stagedCiId.slice(0, 12)}`,
      simulation_correlation_id: record.simulation?.simulation_correlation_id,
      simulation_fingerprint: record.simulation?.simulation_fingerprint,
      target_ci: { sys_id: demoTargetCiId(seed.index), display_value: seed.name },
      target_ci_sys_id: demoTargetCiId(seed.index),
      evidence: ["Simulated IRE execution. No ServiceNow or CMDB endpoint was contacted."],
    };
    appendLedgerEvent(seed, "ire_execution_claimed", "started", `Execution chain claimed for ${seed.name}.`);
    appendLedgerEvent(seed, "ire_execution_completed", "completed",
      `IRE applied the governed change to ${seed.name}.`,
      { execution_correlation_id: execution.execution_correlation_id, target_ci_sys_id: demoTargetCiId(seed.index) });
    state.ire.set(stagedCiId, { ...record, execution });
    return json(execution);
  }

  if (!record.execution?.success) return ireError(action, "VERIFICATION_PENDING", "Nothing has been executed for this record yet.");
  if (record.verification) return json(record.verification);
  const suppliedExecution = String(body.execution_correlation_id ?? "");
  if (suppliedExecution && suppliedExecution !== record.execution.execution_correlation_id) {
    return ireError(action, "VERIFY_MISMATCH", "Verification must use the specific execution correlation ID.");
  }
  const verification: IreActionResponse = {
    ...base,
    success: true,
    action: "verify",
    state: "verified",
    status: "verified",
    execution_correlation_id: record.execution.execution_correlation_id,
    target_ci: record.execution.target_ci,
    target_ci_sys_id: record.execution.target_ci_sys_id,
    verification_summary: `Read-back confirmed ${seed.name} in the CMDB with the governed attribute set.`,
    evidence: ["Simulated read-back verification passed."],
  };
  markVerified(seed);
  state.ire.set(stagedCiId, { ...record, verification });
  return json(verification);
}

// ---------------------------------------------------------------------------
// Campaign and approval packet
// ---------------------------------------------------------------------------

function remainingSeeds(): DemoCiSeed[] {
  return demoPacketCohort.filter(seed => !state.verified.has(seed.sysId));
}

function campaignSeeds(): DemoCiSeed[] {
  return remainingSeeds().slice(0, DEMO_CAMPAIGN_SIZE);
}

function beginNextPacket(): DemoCiSeed[] {
  const next = remainingSeeds().slice(0, DEMO_PACKET_SIZE);
  state.packetSeeds = next;
  if (next.length) {
    state.packetSequence += 1;
    state.packetPhase = "planned";
    state.packetPolls = 0;
  }
  return next;
}

function ensureCurrentPacket(): DemoCiSeed[] {
  if (!state.packetSeeds.length || state.packetPhase === "completed") return beginNextPacket();
  return state.packetSeeds;
}

function packetId(): string {
  return `ks-packet:demo-${String(state.packetSequence).padStart(4, "0")}`;
}

function packetHash(): string {
  return demoFingerprint(800_000 + state.packetSequence);
}

function campaignId(childIndex = 1): string {
  return `ks-campaign:demo-${String(state.packetSequence).padStart(4, "0")}-${String(childIndex).padStart(2, "0")}`;
}

function manifestId(childIndex = 1): string {
  return `ks-manifest:demo-${String(state.packetSequence).padStart(4, "0")}-${String(childIndex).padStart(2, "0")}`;
}

function summary(total: number, overrides: Partial<CampaignSummary> = {}): CampaignSummary {
  return {
    total,
    eligible: total,
    excluded: 0,
    succeeded: 0,
    failed: 0,
    approved: 0,
    executing: 0,
    verifying: 0,
    verified: 0,
    blocked: 0,
    ...overrides,
  };
}

function campaignItems(seeds = campaignSeeds()): RemediationCampaignItem[] {
  return seeds.map(seed => ({
    staged_ci_id: seed.sysId,
    name: seed.name,
    class_name: seed.className,
    staged_operation: seed.operation,
    lifecycle: state.campaignSimulated ? "simulated_pending_approval" : "not_simulated",
  }));
}

function manifestItems(seeds = state.packetSeeds): RemediationApprovalManifestItem[] {
  return seeds.map(seed => ({
    staged_ci_id: seed.sysId,
    name: seed.name,
    finding_id: demoFindingId(seed.index),
    review_decision_id: demoReviewId(seed.index),
    simulation_correlation_id: `ks-simulate:demo:${seed.index}`,
    simulation_fingerprint: demoFingerprint(seed.index),
    operation: "INSERT",
    policy_version: CAMPAIGN_INSERT_POLICY_VERSION,
    proposed_class: seed.className,
    class_policy_version: CAMPAIGN_CLASS_BOUND_POLICY_VERSION,
    evidence_version: CAMPAIGN_SIMULATION_EVIDENCE_VERSION,
    retry_count: 0,
  }));
}

function actionItems(
  seeds = state.packetSeeds,
  overrides: Partial<RemediationCampaignActionItem> = {},
): RemediationCampaignActionItem[] {
  return seeds.map(seed => ({
    staged_ci_id: seed.sysId,
    name: seed.name,
    success: true,
    state: "simulated_pending_approval",
    simulation_correlation_id: `ks-simulate:demo:${seed.index}`,
    simulation_fingerprint: demoFingerprint(seed.index),
    ...overrides,
  }));
}

function packetAggregate(): ApprovalPacketAggregate {
  const total = state.packetSeeds.length;
  const committing = state.packetPhase === "committing" || state.packetPhase === "completed";
  const pollIncrement = Math.max(1, total);
  const verified = state.packetPhase === "completed"
    ? total
    : committing
      ? Math.min(total, state.packetPolls * pollIncrement)
      : 0;
  return {
    total,
    children: 1,
    operations: { INSERT: total, UPDATE: 0, NO_CHANGE: 0 },
    risks: { critical: 0, high: 0, medium: total, low: 0, unknown: 0 },
    excluded: excludedRecords().length,
    blocked: 0,
    approved: committing ? total : 0,
    executing: committing ? Math.max(0, total - verified) : 0,
    verifying: committing ? Math.max(0, Math.min(total - verified, 2)) : 0,
    verified,
  };
}

function excludedRecords() {
  return demoCiSeeds
    .filter(seed => seed.status !== "live")
    .slice(0, 12)
    .map(seed => ({
      staged_ci_id: seed.sysId,
      name: seed.name,
      reason: seed.status === "incomplete"
        ? "IRE could not establish a unique identity for this record."
        : "Held by the confidence gate for human review.",
    }));
}

function packetChildren(): ApprovalPacketChild[] {
  return Array.from(
    { length: Math.ceil(state.packetSeeds.length / DEMO_CAMPAIGN_SIZE) },
    (_unused, index) => {
      const childIndex = index + 1;
      const seeds = state.packetSeeds.slice(index * DEMO_CAMPAIGN_SIZE, childIndex * DEMO_CAMPAIGN_SIZE);
      return {
        child_index: childIndex,
        campaign_id: campaignId(childIndex),
        manifest_id: manifestId(childIndex),
        item_count: seeds.length,
        operation_families: ["INSERT"],
        items: manifestItems(seeds),
      };
    },
  );
}

function packetSamples(): ApprovalPacketSample[] {
  return state.packetSeeds.slice(0, 5).map(seed => ({
    staged_ci_id: seed.sysId,
    name: seed.name,
    class_name: seed.className,
    operation: "INSERT",
    risk: "medium",
    child_campaign_id: campaignId(Math.floor(state.packetSeeds.indexOf(seed) / DEMO_CAMPAIGN_SIZE) + 1),
    simulation_fingerprint: demoFingerprint(seed.index),
  }));
}

/** 30 minutes past the fixture clock, so the freshness window reads plausibly. */
const DEMO_PACKET_EXPIRY = "2026-07-28T06:38:41.000Z";

function frozenPacket(): FrozenApprovalPacket & { approval_enabled: boolean; demo_mode: boolean } {
  return {
    success: true,
    stage: "review_ready",
    migration_run_id: DEMO_RUN_ID,
    packet_id: packetId(),
    packet_hash: packetHash(),
    policy_version: APPROVAL_PACKET_POLICY_VERSION,
    work_group_signature: DEMO_WORK_GROUP,
    group_title: DEMO_GROUP_TITLE,
    class_name: DEMO_CLASS_NAME,
    operation_family: DEMO_OPERATION_FAMILY,
    expires_at: DEMO_PACKET_EXPIRY,
    children: packetChildren(),
    items: manifestItems(),
    exclusions: excludedRecords(),
    samples: packetSamples(),
    aggregate: packetAggregate(),
    // Authorization is armed only after the operator types the exact hash and
    // presses Authorize — demo mode enforces the same two-step gate as live.
    approval_enabled: state.packetPhase === "authorized",
    demo_mode: true,
  };
}

function packetProgressItems(): ApprovalPacketProgressItem[] {
  const aggregate = packetAggregate();
  return state.packetSeeds.map((seed, index) => ({
    staged_ci_id: seed.sysId,
    name: seed.name,
    child_campaign_id: campaignId(Math.floor(index / DEMO_CAMPAIGN_SIZE) + 1),
    operation: "INSERT",
    state: index < aggregate.verified
      ? "verified"
      : state.packetPhase === "committing"
        ? "executing"
        : state.packetPhase === "completed"
          ? "verified"
          : "awaiting_approval",
    execution_correlation_id: `ks-exec:demo:${seed.index}`,
    target_ci_sys_id: demoTargetCiId(seed.index),
  }));
}

function demoCampaign(action: string, body: Record<string, unknown>): Response {
  switch (action) {
    case "plan": {
      const seeds = campaignSeeds();
      const total = seeds.length;
      const plan: RemediationCampaignPlan = {
        success: true,
        stage: "planning",
        migration_run_id: DEMO_RUN_ID,
        campaign_id: campaignId(),
        work_group_signature: DEMO_WORK_GROUP,
        group_title: DEMO_GROUP_TITLE,
        max_items: DEMO_CAMPAIGN_SIZE,
        deferred_count: Math.max(0, remainingSeeds().length - total),
        items: campaignItems(seeds),
        exclusions: excludedRecords(),
      };
      return json({ ...plan, approval_enabled: false });
    }

    case "failure-groups": {
      const failing = demoCiSeeds.filter(seed => seed.status !== "live");
      const groups: RemediationFailureGroupsResult["groups"] = [
        {
          work_group_signature: "identity|incomplete",
          title: "Incomplete identity evidence",
          category: "identity",
          class_name: "Mixed",
          state: "eligible",
          max_retries: 1,
          items: failing.filter(seed => seed.status === "incomplete").map(seed => ({
            staged_ci_id: seed.sysId,
            name: seed.name,
            error_code: "IRE_FAILED",
            message: "No serial number or FQDN was supplied by the source record.",
            retry_count: 0,
            retry_eligible: true,
          })),
        },
        {
          work_group_signature: "class|mismatch",
          title: "Proposed class held for review",
          category: "classification",
          class_name: "Mixed",
          state: "blocked",
          max_retries: 1,
          blocker: "A human review decision is required before another simulation is attempted.",
          items: failing.filter(seed => seed.status === "review").map(seed => ({
            staged_ci_id: seed.sysId,
            name: seed.name,
            error_code: "RUN_STATE_INVALID",
            message: "Held by the confidence gate below the deterministic threshold.",
            retry_count: 0,
            retry_eligible: false,
          })),
        },
      ];
      const result: RemediationFailureGroupsResult = {
        success: true,
        stage: "planning",
        migration_run_id: DEMO_RUN_ID,
        groups,
        summary: {
          groups: groups.length,
          records: groups.reduce((sum, group) => sum + group.items.length, 0),
          eligible: groups[0].items.length,
          blocked: groups[1].items.length,
          exhausted: 0,
        },
      };
      return json(result);
    }

    case "simulate": {
      const seeds = campaignSeeds();
      const total = seeds.length;
      state.campaignSimulated = true;
      for (const seed of seeds) {
        appendLedgerEvent(seed, "ire_simulation_completed", "completed",
          `Campaign simulation prepared ${seed.name} in proposal mode.`,
          { simulation_correlation_id: `ks-simulate:demo:${seed.index}`, simulation_fingerprint: demoFingerprint(seed.index) });
        state.simulated.add(seed.sysId);
      }
      const result: RemediationCampaignSimulationResult = {
        success: true,
        stage: "simulating",
        migration_run_id: DEMO_RUN_ID,
        campaign_id: campaignId(),
        work_group_signature: DEMO_WORK_GROUP,
        concurrency: 3,
        items: actionItems(seeds),
        summary: summary(total, { succeeded: total }),
      };
      return json(result);
    }

    case "simulate-all": {
      const seeds = remainingSeeds();
      const total = seeds.length;
      state.campaignSimulated = true;
      for (const seed of seeds) {
        appendLedgerEvent(seed, "ire_simulation_completed", "completed",
          `Campaign simulation prepared ${seed.name} in proposal mode.`,
          { simulation_correlation_id: `ks-simulate:demo:${seed.index}`, simulation_fingerprint: demoFingerprint(seed.index) });
        state.simulated.add(seed.sysId);
      }
      const group: RemediationCampaignSimulationResult = {
        success: true,
        stage: "simulating",
        migration_run_id: DEMO_RUN_ID,
        campaign_id: campaignId(),
        work_group_signature: DEMO_WORK_GROUP,
        concurrency: 3,
        items: actionItems(seeds),
        summary: summary(total, { succeeded: total }),
      };
      const result: RemediationCampaignBulkSimulationResult = {
        success: true,
        stage: "completed",
        migration_run_id: DEMO_RUN_ID,
        concurrency: 3,
        max_groups: Math.ceil(total / DEMO_CAMPAIGN_SIZE),
        group_count: Math.ceil(total / DEMO_CAMPAIGN_SIZE),
        groups: [group],
        items: group.items,
        summary: group.summary,
      };
      return json(result);
    }

    case "retry": {
      const seeds = campaignSeeds();
      const total = seeds.length;
      const result = {
        success: true,
        stage: "simulating" as const,
        migration_run_id: DEMO_RUN_ID,
        campaign_id: campaignId(),
        work_group_signature: DEMO_WORK_GROUP,
        concurrency: 1 as const,
        strategy_id: "normalize_known_class_alias" as const,
        mapping_version: "class-alias-v1" as const,
        items: actionItems(seeds, { retry_count: 1, max_retries: 1 }),
        summary: summary(total, { succeeded: total }),
      };
      return json(result);
    }

    case "prepare-approval": {
      const seeds = campaignSeeds();
      const total = seeds.length;
      const manifest: RemediationApprovalManifest = {
        success: true,
        stage: "review_ready",
        migration_run_id: DEMO_RUN_ID,
        campaign_id: campaignId(),
        manifest_id: manifestId(),
        work_group_signature: DEMO_WORK_GROUP,
        items: manifestItems(seeds),
        exclusions: excludedRecords(),
        summary: summary(total, { succeeded: total }),
      };
      return json(manifest);
    }

    case "approve": {
      const seeds = campaignSeeds();
      const total = seeds.length;
      state.campaignApproved = true;
      const result: RemediationCampaignApprovalResult = {
        success: true,
        stage: "executing",
        migration_run_id: DEMO_RUN_ID,
        campaign_id: campaignId(),
        manifest_id: manifestId(),
        items: actionItems(seeds, { state: "executed_pending_verification" }),
        summary: summary(total, { succeeded: total, approved: total, executing: total }),
      };
      return json(result);
    }

    case "status": {
      const seeds = campaignSeeds();
      const total = seeds.length;
      const result: RemediationCampaignStatus = {
        success: true,
        stage: state.campaignApproved ? "executing" : state.campaignSimulated ? "review_ready" : "planning",
        migration_run_id: DEMO_RUN_ID,
        campaign_id: campaignId(),
        work_group_signature: DEMO_WORK_GROUP,
        items: campaignItems(seeds).map(item => ({
          ...item,
          bucket: state.campaignApproved ? "needs_verification" : state.campaignSimulated ? "needs_approval" : "ready_to_simulate",
        })),
        summary: summary(total, {
          succeeded: state.campaignSimulated ? total : 0,
          approved: state.campaignApproved ? total : 0,
          executing: state.campaignApproved ? total : 0,
        }),
      };
      return json(result);
    }

    case "plan-packet": {
      const seeds = ensureCurrentPacket();
      if (!seeds.length) {
        return json({ code: "PACKET_EMPTY", error: "All demo records have already reached correlated verification." }, 409);
      }
      const total = seeds.length;
      const children = packetChildren();
      const plan: ApprovalPacketPlan = {
        success: true,
        stage: "planning",
        migration_run_id: DEMO_RUN_ID,
        packet_id: packetId(),
        policy_version: APPROVAL_PACKET_POLICY_VERSION,
        work_group_signature: DEMO_WORK_GROUP,
        group_title: DEMO_GROUP_TITLE,
        class_name: DEMO_CLASS_NAME,
        operation_family: DEMO_OPERATION_FAMILY,
        max_items: DEMO_PACKET_SIZE,
        max_children: 5,
        preparable_count: total,
        deferred_count: Math.max(0, remainingSeeds().length - total),
        children: children.map(child => ({
          child_index: child.child_index,
          campaign_id: child.campaign_id,
          item_count: child.item_count,
          items: campaignItems(child.items.map(item => demoCiSeeds.find(seed => seed.sysId === item.staged_ci_id)!).filter(Boolean)),
        })),
        exclusions: excludedRecords(),
      };
      return json({ ...plan, approval_enabled: false, demo_mode: true });
    }

    case "prepare-packet": {
      const seeds = ensureCurrentPacket();
      if (!seeds.length) {
        return json({ code: "PACKET_EMPTY", error: "All demo records have already reached correlated verification." }, 409);
      }
      // Re-preparing always resets the authorization, exactly like the real
      // one-time capability: a fresh packet must be re-authorized.
      state.packetPhase = "prepared";
      state.packetPolls = 0;
      return json(frozenPacket());
    }

    case "authorize-packet": {
      if (state.packetPhase !== "prepared" && state.packetPhase !== "authorized") {
        return json({ error: "Prepare a fresh review-ready packet before authorizing it." }, 409);
      }
      const confirmation = String(body.confirmation_hash ?? "").trim().toUpperCase();
      if (confirmation !== packetHash()) {
        return json({ error: "The confirmation hash does not match this exact packet." }, 400);
      }
      state.packetPhase = "authorized";
      return json(frozenPacket());
    }

    case "approve-packet":
    case "autonomous-packet": {
      if (action === "autonomous-packet") {
        const seeds = ensureCurrentPacket();
        if (!seeds.length) {
          return json({ code: "PACKET_EMPTY", error: "No additional healthy new CIs remain for an autonomous packet." }, 409);
        }
        state.packetPhase = "authorized";
      } else if (state.packetPhase !== "authorized") {
        return json({ error: "Authorize this exact packet before committing it." }, 409);
      }
      state.packetPhase = "committing";
      state.packetPolls = 0;
      const approval: ApprovalPacketApprovalResult = {
        success: true,
        stage: "executing",
        migration_run_id: DEMO_RUN_ID,
        packet_id: packetId(),
        packet_hash: packetHash(),
        items: actionItems(state.packetSeeds, { state: "executed_pending_verification" }).map((item, index) => ({
          ...item,
          child_campaign_id: campaignId(Math.floor(index / DEMO_CAMPAIGN_SIZE) + 1),
        })),
        aggregate: packetAggregate(),
      };
      if (action === "autonomous-packet") {
        return json({
          success: true,
          stage: approval.stage,
          autonomous: true,
          autonomy_policy: "MARA_HEALTHY_INSERT_V1",
          packet: frozenPacket(),
          approval,
        });
      }
      return json(approval);
    }

    case "packet-status": {
      const total = state.packetSeeds.length;
      if (!total) {
        return json({ code: "PACKET_EMPTY", error: "No demo approval packet has been prepared." }, 409);
      }
      if (state.packetPhase === "committing") {
        state.packetPolls += 1;
        if (packetAggregate().verified >= total) state.packetPhase = "completed";
      }
      const aggregate = packetAggregate();
      // Convergence is mirrored into the ledger as it happens, so the Agent
      // Workspace journey advances in step with the packet progress panel
      // instead of the two disagreeing.
      for (const seed of state.packetSeeds.slice(0, aggregate.verified)) appendVerifiedChain(seed);
      const children = packetChildren();
      const result: ApprovalPacketStatus = {
        success: true,
        stage: state.packetPhase === "completed"
          ? "completed"
          : state.packetPhase === "committing"
            ? "executing"
            : state.packetPhase === "authorized" || state.packetPhase === "prepared"
              ? "review_ready"
              : "planning",
        migration_run_id: DEMO_RUN_ID,
        packet_id: packetId(),
        packet_hash: packetHash(),
        expires_at: DEMO_PACKET_EXPIRY,
        children: children.map((child, index) => ({
          campaign_id: child.campaign_id,
          manifest_id: child.manifest_id,
          item_count: child.item_count,
          verified: Math.max(0, Math.min(child.item_count, aggregate.verified - index * DEMO_CAMPAIGN_SIZE)),
          blocked: 0,
        })),
        items: packetProgressItems(),
        exclusions: excludedRecords(),
        aggregate,
      };
      return json(result);
    }

    default:
      return json({ error: "Unknown remediation campaign action." }, 404);
  }
}

/** Exported for the smoke test so it does not have to re-derive these. */
export const demoTransportConstants = {
  packetSize: DEMO_PACKET_SIZE,
  campaignSize: DEMO_CAMPAIGN_SIZE,
  eligibleCount: demoPacketCohort.length,
  findingCount: demoFindingSeeds.length,
  stagedCiId: demoStagedCiId,
};
