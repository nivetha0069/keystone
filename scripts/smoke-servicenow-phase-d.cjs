const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const simulation = read("servicenow/DotwalkersIreSimulationService.phase-b3.js");
const payload = read("servicenow/DotwalkersIrePayloadService.phase-b3.js");
const detail = read("servicenow/DotwalkersAgentEventDetailService.js");
const mara = read("servicenow/DotwalkersMaraAgent.phase-c.js");
const action = read("servicenow/run_dotwalkers_mara.phase-c.js");
const execute = read("servicenow/ire_execute.phase-d.js");
const verify = read("servicenow/ire_verify.phase-d.js");
const phaseD = read("servicenow/DotwalkersPhaseDTests.phase-d.js");
const phaseC = read("servicenow/DotwalkersPhaseCTests.phase-c.js");
const b3b = read("servicenow/DotwalkersPhaseB3BTests.phase-b3.js");

function registrations(source) {
  const match = source.match(/var tests = \[([\s\S]*?)\];/);
  assert.ok(match, "registered test list missing");
  return [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]);
}

assert.equal(crypto.createHash("sha256").update(b3b).digest("hex").toUpperCase(), "FCE49EE8B2D922E3064E1BB5300178334FB7AF0BC96B968292BE283BA6DAA940");
assert.equal(registrations(b3b).length, 41, "B3B must remain byte-for-byte unchanged at 41 tests");
assert.equal(registrations(phaseC).length, 48, "Phase C must remain exactly 48 tests");
assert.equal(registrations(phaseD).length, 32, "Phase D must register exactly 32 tests");

for (const expected of [
  "continuePreparedApproval", "_executionAuthority", "_acquireExecutionClaim",
  "_recordExecutionReconciliation", "_continueVerification", "_acquireVerificationClaim",
  "ire_execution_claimed", "ire_execution_completed", "ire_execution_failed",
  "ire_execution_reconciliation_required", "ire_verification_claimed",
  "verification_passed", "verification_failed",
]) assert.ok(simulation.includes(expected), `${expected} missing`);

assert.match(simulation, /setNewGuidValue\(eventId\)/);
assert.match(simulation, /createOrUpdateCI\([\s\S]*'Other Automated'/);
assert.equal((simulation.match(/createOrUpdateCI\(/g) || []).length, 1, "one production IRE commit wrapper required");
assert.match(simulation, /buildFromPersistedStrategy/);
assert.match(simulation, /fingerprintSimulation/);
assert.match(simulation, /LATEST_SIMULATION_MISMATCH/);
assert.match(simulation, /LEGACY_FINGERPRINT/);
assert.match(simulation, /IRE_INVOCATION_AMBIGUOUS/);
assert.match(simulation, /EXECUTION_PRECOMMIT_FAILED/);
assert.match(simulation, /VERIFICATION_TRANSPORT_FAILED/);

const phaseDBlock = simulation.slice(
  simulation.indexOf("continuePreparedApproval: function"),
  simulation.indexOf("_validateApprovalRequest: function"),
);
assert.equal(phaseDBlock.includes("identifyCI("), false, "Phase D must not call identifyCI");
assert.equal(phaseDBlock.includes("eventQueue("), false, "Phase D must not add an event continuation");
assert.equal(phaseDBlock.includes("new GlideRecord('cmdb_ci"), false, "Phase D must use the existing read wrapper");
assert.equal(phaseDBlock.includes("setValue('cmdb_"), false, "Phase D must not write CMDB records directly");

for (const adapter of [execute, verify]) {
  assert.equal(adapter.includes("GlideRecord"), false, "REST adapter must remain thin");
  assert.equal(adapter.includes("identifyCI"), false, "REST adapter must not simulate");
  assert.equal(adapter.includes("createOrUpdateCI"), false, "REST adapter must not execute IRE");
  assert.equal(adapter.includes("eventQueue"), false, "REST adapter must not queue lifecycle events");
}
assert.match(execute, /executionStatus/);
assert.match(verify, /verificationStatus/);
assert.match(action, /recordApprovalResumePrepared[\s\S]*continueApprovalResume/);
assert.match(mara, /continueApprovalResume: function/);
const deterministicMara = mara.slice(mara.indexOf("continueApprovalResume: function"));
for (const forbidden of ["_callMaraLLM", "_handoffToPrioritize", "identifyCI", "createOrUpdateCI", "eventQueue"]) {
  assert.equal(deterministicMara.includes(forbidden), false, `Phase D Mara continuation contains ${forbidden}`);
}

for (const field of [
  "resume_prepared_event_id", "root_execution_claim_id", "execution_claim_id",
  "execution_event_id", "root_verification_claim_id", "verification_claim_id",
  "verification_event_id",
]) assert.ok(detail.includes(field), `compact detail missing ${field}`);

for (const forbidden of [
  "GlideRecord =", "GlideAggregate =", "sn_cmdb =", "new GlideRecord('sys_import",
  "new GlideRecord('sys_script", "new GlideRecord('sys_db_object", "new GlideRecord('sys_dictionary",
]) assert.equal(phaseD.includes(forbidden), false, `Phase D tests contain forbidden global/cross-scope pattern ${forbidden}`);

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
  GlideRecord: function GlideRecord() { throw new Error("live GlideRecord dependency was not overridden"); },
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
  ["DotwalkersIrePayloadService.phase-b3.js", payload],
  ["DotwalkersIreSimulationService.phase-b3.js", simulation],
  ["DotwalkersMaraAgent.phase-c.js", mara],
  ["DotwalkersPhaseDTests.phase-d.js", phaseD],
]) vm.runInContext(source, context, { filename: name });

const localResult = new context.DotwalkersPhaseDTests().run();
assert.deepEqual(
  { passed: localResult.passed, failed: localResult.failed, total: localResult.total },
  { passed: 32, failed: 0, total: 32 },
  localResult.failures.join("\n"),
);

console.log("ServiceNow Phase D smoke checks passed (Phase D 32/32; Phase C 48/48; B3B 41 byte-for-byte unchanged).\n");
