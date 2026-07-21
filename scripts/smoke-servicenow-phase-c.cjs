const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const simulation = read("servicenow/DotwalkersIreSimulationService.phase-b3.js");
const detail = read("servicenow/DotwalkersAgentEventDetailService.js");
const approve = read("servicenow/ire_approve.phase-c.js");
const remediate = read("servicenow/remediate.phase-c.js");
const mara = read("servicenow/DotwalkersMaraAgent.phase-c.js");
const action = read("servicenow/run_dotwalkers_mara.phase-c.js");
const phaseC = read("servicenow/DotwalkersPhaseCTests.phase-c.js");
const b3b = read("servicenow/DotwalkersPhaseB3BTests.phase-b3.js");
const gateway = read("app/api/cmdb/[resource]/route.ts");
const dashboard = read("app/cmdb-dashboard.tsx");

function registrations(source) {
  const match = source.match(/var tests = \[([\s\S]*?)\];/);
  assert.ok(match, "registered test list missing");
  return [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]);
}

assert.equal(crypto.createHash("sha256").update(b3b).digest("hex").toUpperCase(), "FCE49EE8B2D922E3064E1BB5300178334FB7AF0BC96B968292BE283BA6DAA940");
assert.equal(registrations(b3b).length, 41, "B3B must remain exactly 41 tests");
assert.equal(registrations(phaseC).length, 48, "Phase C must register exactly 48 tests");

assert.match(simulation, /APPROVAL_FIELDS = \{/);
assert.match(simulation, /setNewGuidValue\(eventId\)/);
assert.match(simulation, /_queueMaraEvent: function/);
assert.match(simulation, /fingerprintSimulation\([\s\S]*simulation\.operation[\s\S]*simulation\.simulation_matched_ci/);
assert.match(simulation, /buildFromPersistedStrategy/);
assert.match(simulation, /_detailMatchesBinding/);
assert.match(simulation, /approval_handoff_retry_claimed/);
assert.match(simulation, /approval_resume_claimed/);
assert.match(simulation, /approval_resume_prepared/);
assert.match(simulation, /approval_resume_failed/);
assert.match(simulation, /MARA_EVENT_QUEUE_FAILED/);
assert.match(simulation, /TOKEN_NOT_QUEUED/);
const nextSequence = simulation.slice(simulation.indexOf("_nextSequence: function"), simulation.indexOf("_parseObject: function"));
assert.match(nextSequence, /this\._newRecord\(this\.TABLES\.ledger\)/);
assert.match(nextSequence, /orderByDesc\('sequence'\)/);
assert.equal(nextSequence.includes("new GlideAggregate"), false, "sequence lookup must read the ordered ledger record");
assert.match(detail, /review_decision_id/);
assert.match(detail, /policy_approved === false/);

assert.match(approve, /new DotwalkersIreSimulationService\(\)\.approve\(body\)/);
for (const forbidden of ["GlideRecord", "identifyCI", "createOrUpdateCI", "eventQueue", "rationale", "request.body.data.decision"]) {
  assert.equal(approve.includes(forbidden), false, `ire_approve adapter contains ${forbidden}`);
}

assert.match(remediate, /new DotwalkersIreSimulationService\(\)\.recordProposal\(body\)/);
for (const forbidden of ["GlideRecord", "identifyCI", "createOrUpdateCI", "eventQueue", "rationale", "request.body.data.decision"]) {
  assert.equal(remediate.includes(forbidden), false, `remediate adapter contains ${forbidden}`);
}
assert.match(simulation, /approval_review_deferred/);
assert.match(simulation, /setNewGuidValue\(binding\.review_decision_id\)/);
assert.match(simulation, /_proposalDetailMatches/);
for (const field of ["migration_run_id", "staged_ci_id", "finding_id", "correlation_id", "idempotency_key", "simulation_correlation_id", "simulation_fingerprint"]) {
  assert.ok(gateway.includes(field), `remediate gateway missing ${field}`);
}
assert.equal(gateway.includes("fixId"), false, "legacy fixId remediate shape must be removed");
assert.equal(gateway.includes("tool: incoming.tool"), false, "legacy tool remediate shape must be removed");
assert.match(dashboard, /await loadData\(activeRunId\)/);
assert.match(dashboard, /simulation_correlation_id: simulation\.correlation/);

assert.match(action, /event\.parm2/);
assert.match(action, /validateAndClaimApprovalResume/);
assert.match(action, /prepareApprovalResume/);
assert.match(action, /recordApprovalResumePrepared/);
assert.match(action, /recordApprovalResumeFailure/);
assert.equal(/\.run\s*\(/.test(action), false, "Script Action must not invoke the Mara run loop");

const preparation = mara.slice(mara.indexOf("prepareApprovalResume:"));
assert.ok(preparation.startsWith("prepareApprovalResume:"));
for (const forbidden of ["eventQueue", "identifyCI", "createOrUpdateCI", "verifyExecution", "execute(", "_handoffToPrioritize"]) {
  assert.equal(preparation.includes(forbidden), false, `preparation method contains ${forbidden}`);
}
for (const forbidden of ["new GlideRecord('sys_script", 'new GlideRecord("sys_script', "new GlideRecord('sys_db_object", "new GlideRecord('sys_dictionary", "GlideRecord =", "GlideAggregate ="]) {
  assert.equal(phaseC.includes(forbidden), false, `Phase C tests contain ${forbidden}`);
}

for (const actionName of [
  "approval_recorded",
  "approval_handoff_queued",
  "approval_handoff_failed",
  "approval_handoff_retry_claimed",
  "approval_resume_claimed",
  "approval_resume_prepared",
  "approval_resume_failed",
]) assert.ok(simulation.includes(actionName), `${actionName} missing`);

assert.equal(/event_type[^\n]*(approval_|resume_|handoff_)/.test(simulation), false, "lifecycle names must not become event_type values");

const context = vm.createContext({
  Class: {
    create() {
      return function ServiceNowClass() {
        if (typeof this.initialize === "function") this.initialize();
      };
    },
  },
  GlideDigest: function GlideDigest() {
    this.getSHA256Hex = value => crypto.createHash("sha256").update(String(value)).digest("hex");
  },
  gs: {
    info() {},
    error() {},
    getUserID() { return "55555555555555555555555555555555"; },
    hasRole() { return true; },
  },
  JSON,
  Object,
  Array,
  String,
  Error,
  RegExp,
});
for (const [name, source] of [
  ["DotwalkersAgentEventDetailService.js", detail],
  ["DotwalkersIreSimulationService.phase-b3.js", simulation],
  ["DotwalkersMaraAgent.phase-c.js", mara],
  ["DotwalkersPhaseCTests.phase-c.js", phaseC],
]) vm.runInContext(source, context, { filename: name });
const localResult = new context.DotwalkersPhaseCTests().run();
assert.deepEqual({ passed: localResult.passed, failed: localResult.failed, total: localResult.total }, { passed: 48, failed: 0, total: 48 }, localResult.failures.join("\n"));

console.log("ServiceNow Phase C smoke checks passed (B3B 41 unchanged; Phase C 48/48 locally).");
