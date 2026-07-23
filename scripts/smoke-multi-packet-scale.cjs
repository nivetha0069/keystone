const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
registerTypeScript();
const packet = require("../app/lib/cmdb/approval-packet.ts");

const RUN = "5".repeat(32);
const COUNT = 500;
const sysId = index => index.toString(16).padStart(32, "0");
const fingerprint = index => index.toString(16).padStart(64, "0").toUpperCase();
const cis = [];
const findings = [];
const reviews = [];
const timeline = [];

for (let index = 0; index < COUNT; index++) {
  const stagedId = sysId(index + 1);
  const findingId = sysId(1000 + index);
  const reviewId = sysId(2000 + index);
  const simulationCorrelation = `ks-scale-sim-${stagedId}`;
  cis.push({
    id: stagedId, stagedCiId: stagedId, migrationRunId: RUN, name: `scale-ci-${String(index + 1).padStart(4, "0")}`,
    className: "cmdb_ci_linux_server", ip: `10.40.${Math.floor(index / 254)}.${(index % 254) + 1}`,
    source: "scale-fixture", operation: "INSERT", confidence: 1, health: 100,
    updatedAt: "2026-07-22T18:00:00Z", status: "live", provenance: [],
  });
  findings.push({ id: findingId, number: `SCALE-${index + 1}`, stagedCiId: stagedId, type: "data_quality", severity: "low", recommendation: "Migrate" });
  reviews.push({ id: reviewId, findingId, decision: "deferred", rationale: "Awaiting exact packet approval", policyApproved: false });
  timeline.push(event(3000 + index, index + 1, stagedId, "ire_simulation_completed", {
    finding_id: findingId,
    simulation_correlation_id: simulationCorrelation,
    simulation_fingerprint: fingerprint(index + 1),
    operation: "INSERT",
    simulation_matched_ci: "",
    proposed_class: "cmdb_ci_linux_server",
    class_policy_version: "servicenow-allowlisted-class-v1",
    evidence_version: "keystone.simulation.v2",
  }));
  timeline.push(event(4000 + index, COUNT + index + 1, stagedId, "approval_review_deferred", {
    finding_id: findingId,
    review_decision_id: reviewId,
    simulation_correlation_id: simulationCorrelation,
    simulation_fingerprint: fingerprint(index + 1),
  }));
}

const health = { score: 100, grade: "A", ciCount: COUNT, duplicateCandidates: 0, reviewCount: COUNT, relationshipCount: 0, completeness: 100, correctness: 100, compliance: 100, duplicateRate: 0, staleRecords: 0, fixes: [] };
const snapshot = { migrationRunId: RUN, cis, timeline, findings, reviews, health, relationships: [] };
const first = packet.planApprovalPacket(snapshot);
assert.equal(first.preparable_count, 100);
assert.equal(first.deferred_count, 400);
assert.equal(first.children.length, 5);

const firstIds = new Set(first.children.flatMap(child => child.items.map(item => item.staged_ci_id)));
const terminal = [];
let sequence = timeline.length + 1;
for (const item of first.children.flatMap(child => child.items)) {
  const approvalId = sysId(10_000 + sequence);
  const executionId = sysId(20_000 + sequence);
  const targetId = sysId(30_000 + sequence);
  terminal.push(event(10_000 + sequence, sequence++, item.staged_ci_id, "approval_recorded", {
    finding_id: item.finding_id,
    review_decision_id: item.review_decision_id,
    simulation_correlation_id: item.simulation_correlation_id,
    simulation_fingerprint: item.simulation_fingerprint,
    approval_event_id: approvalId,
    decision: "approved",
    policy_approved: false,
  }, approvalId));
  terminal.push(event(20_000 + sequence, sequence++, item.staged_ci_id, "ire_execution_completed", {
    approval_event_id: approvalId,
    simulation_correlation_id: item.simulation_correlation_id,
    simulation_fingerprint: item.simulation_fingerprint,
    execution_correlation_id: executionId,
    execution_event_id: executionId,
    target_ci_sys_id: targetId,
    operation: "INSERT",
  }, executionId));
  terminal.push(event(30_000 + sequence, sequence++, item.staged_ci_id, "verification_passed", {
    approval_event_id: approvalId,
    simulation_correlation_id: item.simulation_correlation_id,
    simulation_fingerprint: item.simulation_fingerprint,
    execution_correlation_id: executionId,
    execution_event_id: executionId,
    target_ci_sys_id: targetId,
    operation: "INSERT",
  }));
}

const second = packet.planApprovalPacket({ ...snapshot, timeline: [...timeline, ...terminal] });
assert.equal(second.preparable_count, 100, "the second packet is available after the first reaches terminal evidence");
assert.equal(second.deferred_count, 300);
assert.equal(second.children.length, 5);
assert.ok(second.children.flatMap(child => child.items).every(item => !firstIds.has(item.staged_ci_id)), "terminal packet members are not selected again");
console.log("multi-packet 500-CI scale smoke passed");

function event(idSeed, seq, stagedCiId, action, extra, id) {
  return {
    id: id || sysId(idSeed), seq, step: 5, name: action, recordName: stagedCiId,
    className: "cmdb_ci_linux_server", operation: extra.operation || "INSERT", source: "Remediate", confidence: 1,
    time: `2026-07-22T18:${String(Math.floor(seq / 60) % 60).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}Z`, status: "complete",
    reasoning: JSON.stringify({ schema: "keystone.agent.v1", phase: "remediate", actor: "Remediate", decision_source: "deterministic", action, status: "completed", migration_run_id: RUN, staged_ci_id: stagedCiId, ...extra }),
  };
}

function registerTypeScript() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolveTypeScript(request, parent, isMain, options) {
    if ((request.startsWith("./") || request.startsWith("../")) && parent?.filename) {
      const candidate = path.resolve(path.dirname(parent.filename), request);
      if (!path.extname(candidate) && fs.existsSync(`${candidate}.ts`)) return `${candidate}.ts`;
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
  require.extensions[".ts"] = function loadTypeScript(module, filename) {
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename }).outputText;
    module._compile(output, filename);
  };
}
