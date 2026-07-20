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
  { ...event(2, "IRE simulation completed", "Mara", "staged_ci_id=" + cis[0].id + " simulation_correlation_id=ks-sim-1 simulation_fingerprint=fp-1"), recordName: "linux-a", status: "review" },
  { ...event(3, "Approval recorded", "Mara", "staged_ci_id=" + cis[0].id + " simulation_correlation_id=ks-sim-1 simulation_fingerprint=fp-1 decision=approved"), recordName: "linux-a", status: "review" },
  { ...event(4, "IRE execution committed", "Mara", "staged_ci_id=" + cis[0].id + " execution_correlation_id=ks-exec-1 target_ci_sys_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa simulation_fingerprint=fp-1"), recordName: "linux-a", step: 6 },
  { ...event(5, "Verification passed", "Mara", "staged_ci_id=" + cis[0].id + " execution_correlation_id=ks-exec-1 target_ci_sys_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa verified_score=74"), recordName: "linux-a", step: 6 },
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

console.log("agent workspace smoke checks passed");

function ci(id, name, className, status) {
  return { id, stagedCiId: id, migrationRunId: runId, name, className, ip: "", source: "fixture", operation: status === "incomplete" ? "INSERT_AS_INCOMPLETE" : "INSERT", confidence: .9, health: 70, updatedAt: "", status, provenance: [] };
}
function event(seq, name, source, reasoning) {
  return { id: "e" + seq, seq, step: seq >= 4 ? 5 : 4, name, recordName: "Migration run", className: "Run event", operation: "NO_CHANGE", source, confidence: 1, time: "now", status: "complete", reasoning };
}
