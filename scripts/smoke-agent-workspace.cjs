const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveTypeScript(request, parent, isMain, options) {
  if ((request.startsWith("./") || request.startsWith("../")) && parent?.filename) {
    const candidate = path.resolve(path.dirname(parent.filename), request);
    if (!path.extname(candidate) && fs.existsSync(candidate + ".ts")) return candidate + ".ts";
  }
  return originalResolve.call(this, request, parent, isMain, options);
};
require.extensions[".ts"] = function loadTypeScript(module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { deriveRemediationWorkQueue } = require("../app/lib/cmdb/work-queue.ts");
const { deriveAgentWorkspaceSnapshot } = require("../app/lib/cmdb/agent-workspace.ts");
const { deriveWorkspaceViewState, hasCprHandoffGap } = require("../app/lib/cmdb/workspace-view-state.ts");
const { deriveDeferredPresentation, deriveRunJourney } = require("../app/lib/cmdb/run-journey.ts");
const { sanitizeIreRequest } = require("../app/api/cmdb/ire/[action]/route.ts");

const runId = "e0ac4df32b82871060aefba6b891bf5b";
const cis = [
  ci("11111111111111111111111111111111", "linux-a", "Linux Srv", "live"),
  ci("22222222222222222222222222222222", "unknown-b", "Unclassified", "incomplete"),
];
const findings = [
  { id: "f1", number: "DWF1", stagedCiId: cis[0].id, type: "class_alias", severity: "high", recommendation: "Normalize Linux Srv to an allowed class." },
  { id: "f2", number: "DWF2", stagedCiId: cis[1].id, type: "identity", severity: "critical", recommendation: "Missing serial_number and FQDN; identity is ambiguous." },
];
const timeline = [
  event(1, "Baseline captured", "Prioritize", "baseline_score=70 projected_score=80"),
  { ...event(2, "IRE simulation completed", "Mara", detail("ire_simulation_completed")), id: "2".repeat(32), recordName: "linux-a", status: "review" },
  { ...event(3, "Approval recorded", "Mara", detail("approval_recorded")), id: "3".repeat(32), recordName: "linux-a", status: "review" },
  { ...event(4, "IRE execution committed", "Mara", detail("ire_execution_completed")), id: "4".repeat(32), recordName: "linux-a", step: 6 },
  { ...event(5, "Verification passed", "Mara", detail("verification_passed")), id: "5".repeat(32), recordName: "linux-a", step: 6 },
];
const health = {
  score: 74, baselineScore: 70, verifiedScore: 74, projectedScore: 80, grade: "B",
  ciCount: 2, duplicateCandidates: 0, reviewCount: 1, relationshipCount: 1,
  completeness: 70, correctness: 74, compliance: 80, duplicateRate: 0, staleRecords: 0,
  fixes: [],
};
const relationships = [{ id: "r1", source: cis[0].id, target: cis[1].id, type: "Depends on", confidence: 1 }];
const queue = deriveRemediationWorkQueue({ cis, timeline, findings, reviews: [] });
const snapshot = deriveAgentWorkspaceSnapshot({ runLabel: "RUN-LIVE", runState: "awaiting_approval", cis, timeline, relationships, findings, reviews: [], health, queue });
const reconstructed = deriveAgentWorkspaceSnapshot({ runLabel: "RUN-LIVE", runState: "awaiting_approval", cis, timeline: JSON.parse(JSON.stringify(timeline)), relationships, findings, reviews: [], health, queue: deriveRemediationWorkQueue({ cis, timeline, findings, reviews: [] }) });

assert.deepEqual(reconstructed, snapshot, "refresh reconstruction must be deterministic");
assert.equal(snapshot.groups.find(group => group.category === "class_alias")?.strategy, "normalize_known_class_alias");
assert.match(snapshot.groups.find(group => group.category === "missing_identifier")?.blocker || "", /identity evidence/i);
assert.deepEqual(snapshot.health, { baseline: 70, verified: 74, projected: 80, realizedLift: 4, remainingLift: 6 });
assert.deepEqual(snapshot.relationships, { total: 1, ready: 0, blocked: 1 });

const completedComprehend = [
  event(1, "Analysis completed", "Comprehend", "Analysis completed. 2000 staged CIs processed."),
];
const derivedHealthSnapshot = deriveAgentWorkspaceSnapshot({
  runLabel: "RUN-DERIVED-HEALTH",
  runState: "analyzing",
  cis: cis.map(item => ({ ...item, health: 70 })),
  timeline: completedComprehend,
  relationships: [],
  findings,
  reviews: [],
  health: { ...health, baselineScore: undefined, verifiedScore: undefined, projectedScore: undefined, score: 100 },
  queue,
});
assert.equal(derivedHealthSnapshot.health.baseline, 70, "missing historical scores must fall back to staged CI health");
assert.ok(derivedHealthSnapshot.health.verified >= derivedHealthSnapshot.health.baseline);
assert.ok(derivedHealthSnapshot.health.projected >= derivedHealthSnapshot.health.verified);

assert.equal(hasCprHandoffGap("analyzing", completedComprehend), true);
assert.equal(hasCprHandoffGap("analyzing", [...completedComprehend, event(2, "Mara started", "Mara", "Supervisor started")]), false);
assert.equal(hasCprHandoffGap("awaiting_approval", completedComprehend), false);

const handoffView = deriveWorkspaceViewState({
  runLabel: "RUN-HANDOFF",
  runId,
  runState: "analyzing",
  apiState: "live",
  cis,
  timeline: completedComprehend,
  relationships,
  findings,
  reviews: [],
  health,
});
assert.equal(handoffView.handoffGap, true);
assert.equal(handoffView.prioritizeStatus, "working", "locally derived groups cannot impersonate live Prioritize evidence");
assert.equal(handoffView.activePhase, "prioritize");

const historicalPacketView = deriveWorkspaceViewState({
  runLabel: "RUN-HISTORICAL-PACKET",
  runId,
  runState: "analyzing",
  apiState: "live",
  cis: [
    ci(cis[0].id, "linux-a", "Linux Srv", "live"),
    ci("33333333333333333333333333333333", "linux-ready", "Linux Srv", "live"),
  ],
  timeline: [
    ...timeline,
    event(6, "Approval packet prepared", "Mara", "Prepared bounded approval packet for prior work."),
  ],
  relationships: [],
  findings: Array.from({ length: 51 }, (_, index) => ({
    id: `historical-finding-${index}`,
    number: `DWF-H-${index}`,
    stagedCiId: cis[0].id,
    type: "orphan_rel",
    severity: "warning",
    recommendation: "Historical evidence only.",
  })),
  reviews: Array.from({ length: 71 }, (_, index) => ({
    id: `historical-review-${index}`,
    findingId: `historical-finding-${index % 51}`,
    decision: index < 20 ? "approved" : "deferred",
  })),
  health: { ...health, ciCount: 2, reviewCount: 71 },
});
assert.equal(historicalPacketView.approvalPacketPrepared, true, "historical packet evidence remains visible");
assert.equal(historicalPacketView.requiresApproval, false, "historical packet evidence must not reopen approval");
assert.equal(historicalPacketView.approvalCount, 0, "evidence row counts must not masquerade as CI approvals");
assert.equal(historicalPacketView.heldCount, 0, "evidence row counts must not masquerade as held CIs");
assert.equal(historicalPacketView.readyToSimulateCount, 2, "current CI lifecycle rows should be presented as ready to simulate");
assert.equal(historicalPacketView.activePhase, "remediate", "remaining simulation work must keep Agent Workspace on Remediate");
assert.equal(historicalPacketView.mara.headline, "Ready for simulation");
const deferredPresentation = deriveDeferredPresentation(deriveRunJourney(historicalPacketView), historicalPacketView);
assert.equal(deferredPresentation.activeChapter, "verify");
assert.equal(deferredPresentation.chapters.find(chapter => chapter.id === "verify")?.isActive, true);
assert.equal(deferredPresentation.chapters.find(chapter => chapter.id === "remediate")?.pause, undefined);
assert.match(deferredPresentation.narration, /ServiceNow/i);

const verifiedJourney = deriveRunJourney({
  ...historicalPacketView,
  queue: {
    ...historicalPacketView.queue,
    items: [{
      ...historicalPacketView.queue.items[0],
      bucket: "verified",
      targetCiSysId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      executionCorrelation: "ks-exec-summary",
      ci: { ...historicalPacketView.queue.items[0].ci, operation: "INSERT", className: "cmdb_ci_linux_server" },
    }],
  },
});
const verifiedEvidence = verifiedJourney.chapters.find(chapter => chapter.id === "verify")?.evidence;
assert.equal(verifiedEvidence?.kind, "verify");
assert.equal(verifiedEvidence?.verifiedCount, 1);
assert.equal(verifiedEvidence?.targetCount, 1);
assert.equal(verifiedEvidence?.operationCounts.insert, 1);
assert.deepEqual(verifiedEvidence?.destinationTables, [{
  table: "cmdb_ci_linux_server", total: 1, inserted: 1, updated: 0, reconciled: 0,
}]);

const workspaceSource = fs.readFileSync(path.join(root, "app", "agent-workspace.tsx"), "utf8");
assert.match(workspaceSource, /Review next bounded packet/, "Agent Workspace must expose the bounded packet route");
assert.match(workspaceSource, /View completed results/, "Agent Workspace must expose a presentation-only defer route");
assert.match(workspaceSource, /ServiceNow was not changed/, "the defer route must disclose its non-authoritative scope");
assert.match(workspaceSource, /MARA&amp;apos;S VERIFICATION SUMMARY|MARA&apos;S VERIFICATION SUMMARY/, "Verify must expose a durable Mara summary");
assert.match(workspaceSource, /ServiceNow destination tables/, "Agent Workspace summary must expose destination tables");
assert.match(workspaceSource, /SERVICENOW TABLE/, "verified groups must label the exact target table clearly");

const execute = sanitizeIreRequest("execute", {
  migration_run_id: runId,
  staged_ci_id: cis[0].id,
  correlation_id: "ks-execute-1",
  idempotency_key: "keystone:execute:1",
  simulation_correlation_id: "ks-sim-1",
  className: "cmdb_ci_server",
  values: { name: "must-not-pass" },
  payload: { dangerous: true },
  team_prefix: "NOT_AUTH",
});
assert.deepEqual(Object.keys(execute).sort(), [
  "correlation_id", "idempotency_key", "migration_run_id", "simulation_correlation_id", "staged_ci_id",
]);
assert.equal(JSON.stringify(execute).includes("must-not-pass"), false);

const approve = sanitizeIreRequest("approve", {
  migration_run_id: runId,
  staged_ci_id: cis[0].id,
  finding_id: "33333333333333333333333333333333",
  review_decision_id: "44444444444444444444444444444444",
  correlation_id: "ks-approve-1",
  idempotency_key: "keystone:approve:1",
  simulation_correlation_id: "ks-sim-1",
  simulation_fingerprint: "A".repeat(64),
  decision: "rejected",
  rationale: "must-not-pass",
  operation: "UPDATE",
  payload: { dangerous: true },
});
assert.deepEqual(Object.keys(approve).sort(), [
  "correlation_id", "finding_id", "idempotency_key", "migration_run_id", "review_decision_id",
  "simulation_correlation_id", "simulation_fingerprint", "staged_ci_id",
]);
assert.equal(JSON.stringify(approve).includes("must-not-pass"), false);

console.log("agent workspace smoke checks passed");

function ci(id, name, className, status) {
  return { id, stagedCiId: id, migrationRunId: runId, name, className, ip: "", source: "fixture", operation: status === "incomplete" ? "INSERT_AS_INCOMPLETE" : "INSERT", confidence: .9, health: 70, updatedAt: "", status, provenance: [] };
}
function event(seq, name, source, reasoning) {
  return { id: "e" + seq, seq, step: seq >= 4 ? 5 : 4, name, recordName: "Migration run", className: "Run event", operation: "NO_CHANGE", source, confidence: 1, time: "now", status: "complete", reasoning };
}
function detail(action) {
  const base = { action, staged_ci_id: cis[0].id, simulation_correlation_id: "ks-sim-1", simulation_fingerprint: "A".repeat(64), proposed_class: "cmdb_ci_linux_server" };
  if (action === "approval_recorded") Object.assign(base, { decision: "approved", policy_approved: false, approval_event_id: "3".repeat(32) });
  if (action === "ire_execution_completed" || action === "verification_passed") Object.assign(base, {
    approval_event_id: "3".repeat(32), execution_correlation_id: "4".repeat(32),
    target_ci_sys_id: "a".repeat(32), operation: "INSERT",
  });
  return JSON.stringify(base);
}
