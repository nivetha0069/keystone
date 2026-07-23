const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if ((request.startsWith("./") || request.startsWith("../")) && parent?.filename) {
    const candidate = path.resolve(path.dirname(parent.filename), request);
    if (!path.extname(candidate) && fs.existsSync(`${candidate}.ts`)) return `${candidate}.ts`;
  }
  return originalResolve.call(this, request, parent, isMain, options);
};
require.extensions[".ts"] = function (module, filename) {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  }).outputText, filename);
};

const { deriveRemediationWorkQueue } = require("../app/lib/cmdb/work-queue.ts");
const { deriveCorrelatedVerifiedOutcomes, evaluateLiveDemoReadiness, readinessSignature } = require("../app/lib/cmdb/terminal-outcomes.ts");

const RUN = "1".repeat(32);
const ids = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
const cis = ids.map((id, index) => ({ id, stagedCiId: id, migrationRunId: RUN, name: `ci-${index}`, className: "cmdb_ci_server", ip: "", source: "fixture", operation: index === 1 ? "UPDATE" : index === 2 ? "NO_CHANGE" : "INSERT", confidence: 1, health: 100, updatedAt: "", status: "live", provenance: [] }));
const timeline = [
  ...mutationEvents(cis[0], "INSERT", "1", "d".repeat(32)),
  ...mutationEvents(cis[1], "UPDATE", "2", "e".repeat(32)),
  ...reconciliationEvents(cis[2], "3", "f".repeat(32)),
];

const report = readiness(timeline, { INSERT: 1, UPDATE: 1, NO_CHANGE: 1 });
assert.equal(report.ready, true);
assert.deepEqual(report.operationCounts, { INSERT: 1, UPDATE: 1, NO_CHANGE: 1 });
assert.equal(report.mutationTotal, 2);
assert.equal(report.reconciliationTotal, 1);
assert.equal(readinessSignature(report), readinessSignature(readiness(JSON.parse(JSON.stringify(timeline)), { INSERT: 1, UPDATE: 1, NO_CHANGE: 1 })));

const stagedProjection = readiness([], { INSERT: 1 });
assert.equal(stagedProjection.terminalTotal, 0, "staged operations never count as terminal outcomes");
assert.equal(stagedProjection.ready, false);

const malformed = replaceDetail(timeline, "verification_passed", ids[0], detail => ({ ...detail, target_ci_sys_id: "bad" }));
assert.equal(derive(malformed).some(item => item.stagedCiId === ids[0]), false, "malformed targets are ignored");

const mismatched = replaceDetail(timeline, "verification_passed", ids[0], detail => ({ ...detail, execution_correlation_id: "9".repeat(32) }));
assert.equal(derive(mismatched).some(item => item.stagedCiId === ids[0]), false, "mismatched correlations are ignored");

const failed = timeline.map(event => event.reasoning.includes('"action":"verification_passed"') && event.reasoning.includes(ids[0])
  ? { ...event, reasoning: event.reasoning.replace("verification_passed", "verification_failed"), status: "error" }
  : event);
assert.equal(derive(failed).some(item => item.stagedCiId === ids[0]), false, "failed verification never counts");

const duplicateBinding = timeline.map(event => event.reasoning.includes(ids[1])
  ? replaceTarget(event, "d".repeat(32)) : event);
const duplicateReport = readiness(duplicateBinding, { INSERT: 1, UPDATE: 1, NO_CHANGE: 1 });
assert.equal(duplicateReport.ready, true, "non-INSERT targets may match an INSERT target");
const secondInsert = cis.map((ci, index) => index === 1 ? { ...ci, operation: "INSERT" } : ci);
const duplicateInsertTimeline = duplicateBinding.map(event => event.reasoning.includes(ids[1])
  ? { ...event, operation: "INSERT", reasoning: event.reasoning.replace('"operation":"UPDATE"', '"operation":"INSERT"') } : event);
const duplicateInsertQueue = deriveRemediationWorkQueue({ cis: secondInsert, timeline: duplicateInsertTimeline, findings: [], reviews: [] });
const duplicateInsertReport = evaluateLiveDemoReadiness({ queue: duplicateInsertQueue, timeline: duplicateInsertTimeline, expectedTotal: 3 });
assert.equal(duplicateInsertReport.ready, false);
assert.match(duplicateInsertReport.failures.join(" "), /distinct target bindings/);

const ambiguous = [...timeline, { ...timeline.find(event => event.reasoning.includes('"action":"verification_passed"') && event.reasoning.includes(ids[0])), id: "9".repeat(32), seq: 999 }];
assert.equal(derive(ambiguous).some(item => item.stagedCiId === ids[0]), false, "multiple terminal events are ambiguous");

const failedReconciliation = timeline.map(event => event.reasoning.includes('"action":"reconciliation_passed"')
  ? { ...event, reasoning: event.reasoning.replace("reconciliation_passed", "reconciliation_failed"), status: "error" } : event);
assert.equal(derive(failedReconciliation).some(item => item.operation === "NO_CHANGE"), false);

console.log("live demo readiness smoke passed");

function readiness(events, expectedOperations) {
  const queue = deriveRemediationWorkQueue({ cis, timeline: events, findings: [], reviews: [] });
  return evaluateLiveDemoReadiness({ queue, timeline: events, expectedTotal: 3, expectedOperations });
}
function derive(events) { return deriveCorrelatedVerifiedOutcomes(deriveRemediationWorkQueue({ cis, timeline: events, findings: [], reviews: [] }).items, events); }
function mutationEvents(ci, operation, seed, target) {
  const approval = seed.repeat(32);
  const execution = (Number(seed) + 3).toString().repeat(32);
  const base = { staged_ci_id: ci.id, simulation_correlation_id: `sim-${seed}`, simulation_fingerprint: seed.repeat(64).slice(0, 64), approval_event_id: approval };
  return [
    ev(seed, 1, "ire_simulation_completed", { ...base, operation, simulation_matched_ci: operation === "INSERT" ? "" : target }),
    ev(seed, 2, "approval_recorded", { ...base, decision: "approved", policy_approved: false }, approval),
    ev(seed, 3, "ire_execution_completed", { ...base, execution_correlation_id: execution, target_ci_sys_id: target, operation }, execution),
    ev(seed, 4, "verification_passed", { ...base, execution_correlation_id: execution, target_ci_sys_id: target, operation }),
  ];
}
function reconciliationEvents(ci, seed, target) {
  const base = { staged_ci_id: ci.id, simulation_correlation_id: `sim-${seed}`, simulation_fingerprint: seed.repeat(64).slice(0, 64), operation: "NO_CHANGE", proposed_class: ci.className, class_policy_version: "servicenow-allowlisted-class-v1", evidence_version: "keystone.simulation.v2" };
  return [
    ev(seed, 1, "ire_simulation_completed", { ...base, simulation_matched_ci: target }),
    ev(seed, 2, "reconciliation_passed", { ...base, target_ci_sys_id: target }),
  ];
}
function ev(seed, offset, action, detail, id) {
  return { id: id || `${seed}${offset}`.repeat(16).slice(0, 32), seq: Number(seed) * 10 + offset, step: 6, name: action, recordName: detail.staged_ci_id, className: "cmdb_ci_server", operation: detail.operation || "NO_CHANGE", source: "Remediate", confidence: 1, time: `2026-07-22T00:00:${String(Number(seed) * 10 + offset).padStart(2, "0")}Z`, status: action.includes("failed") ? "error" : "complete", reasoning: JSON.stringify({ action, ...detail }) };
}
function replaceDetail(events, action, stagedCiId, transform) {
  return events.map(event => {
    const detail = JSON.parse(event.reasoning);
    return detail.action === action && detail.staged_ci_id === stagedCiId ? { ...event, reasoning: JSON.stringify(transform(detail)) } : event;
  });
}
function replaceTarget(event, target) {
  const detail = JSON.parse(event.reasoning);
  if (detail.target_ci_sys_id) detail.target_ci_sys_id = target;
  if (detail.simulation_matched_ci) detail.simulation_matched_ci = target;
  return { ...event, reasoning: JSON.stringify(detail) };
}
