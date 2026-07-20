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
    if (!path.extname(candidate) && fs.existsSync(`${candidate}.ts`)) {
      return `${candidate}.ts`;
    }
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

require.extensions[".ts"] = function loadTypeScript(module, filename) {
  if (!filename.startsWith(root)) return module._compile(fs.readFileSync(filename, "utf8"), filename);
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { mockCis } = require("../app/cmdb-data.ts");
const { deriveRemediationWorkQueue } = require("../app/lib/cmdb/work-queue.ts");
const { normalizeIreActionResponse } = require("../app/lib/cmdb/ire.ts");

const runId = "e0ac4df32b82871060aefba6b891bf5b";
const ci = {
  ...mockCis[0],
  id: "24ac4df32b82871060aefba6b891bf5c",
  stagedCiId: "24ac4df32b82871060aefba6b891bf5c",
  migrationRunId: runId,
  name: "pay-gw-lnx-03",
};

const simulationEvent = {
  id: "ev-sim",
  seq: 10,
  step: 5,
  name: "IRE simulation completed",
  recordName: ci.name,
  className: ci.className,
  operation: "INSERT",
  source: "ServiceNow",
  confidence: 0.98,
  time: "now",
  status: "review",
  reasoning: "Simulation completed with fingerprint fp-123 and needs review approval.",
};

const verifiedEvent = {
  ...simulationEvent,
  id: "ev-verify",
  seq: 12,
  step: 6,
  name: "Verification passed",
  status: "complete",
  reasoning: "Verification passed by read-back for execution correlation ks-execute-1.",
};

const pendingApproval = deriveRemediationWorkQueue({ cis: [ci], timeline: [simulationEvent] });
assert.equal(pendingApproval.items[0]?.bucket, "needs_approval");
assert.equal(pendingApproval.liveBackedCount, 1);

const verified = deriveRemediationWorkQueue({ cis: [ci], timeline: [simulationEvent, verifiedEvent] });
assert.equal(verified.items[0]?.bucket, "verified");

const staleExecution = deriveRemediationWorkQueue({
  cis: [ci],
  timeline: [],
  ireRecords: {
    [ci.id]: {
      simulation: { success: true, action: "simulate", state: "simulated_pending_approval", status: "incomplete" },
      approval: { success: true, action: "approve", state: "approved_for_execution", status: "approved" },
      execution: {
        success: false,
        action: "execute",
        state: "execution_rejected_stale_simulation",
        error: { code: "STALE_SIMULATION", message: "Approved simulation fingerprint is stale." },
      },
    },
  },
});
assert.equal(staleExecution.items[0]?.bucket, "blocked");

const restoredApproval = deriveRemediationWorkQueue({
  cis: [ci],
  timeline: [{
    ...simulationEvent,
    recordName: "alexn",
    reasoning: `Simulation: incomplete | staged_ci_id=${ci.id} correlation_id=ks-simulate-restored simulation_fingerprint=fp-restored`,
  }],
  findings: [{ id: "finding-1", number: "DWF0001136", stagedCiId: ci.id, recommendation: "Review simulation" }],
  reviews: [{ id: "review-1", findingId: "finding-1", decision: "approved", rationale: "Approved after review", policyApproved: true }],
});
assert.equal(restoredApproval.items[0]?.bucket, "ready_to_execute");
assert.equal(restoredApproval.items[0]?.simulationCorrelation, "ks-simulate-restored");
assert.equal(restoredApproval.items[0]?.simulationFingerprint, "fp-restored");
assert.equal(restoredApproval.items[0]?.source, "servicenow_ledger");

const stateOnlyApproval = deriveRemediationWorkQueue({
  cis: [ci],
  timeline: [],
  ireRecords: {
    [ci.id]: {
      approval: { success: true, action: "approve", state: "approved_for_execution" },
    },
  },
});
assert.equal(stateOnlyApproval.items[0]?.bucket, "ready_to_execute");

const staleResponse = normalizeIreActionResponse("execute", {
  result: {
    result: {
      success: false,
      action: "execute",
      state: "execution_rejected_stale_simulation",
      correlation_id: "ks-execute-request-only",
      error: {
        code: "STALE_SIMULATION",
        message: "Simulation is stale - data has changed since simulation",
        details: ["Approved fingerprint: fp-old", "Current fingerprint: fp-new"],
      },
    },
  },
});
assert.equal(staleResponse.error?.code, "STALE_SIMULATION");
assert.deepEqual(staleResponse.error?.details, ["Approved fingerprint: fp-old", "Current fingerprint: fp-new"]);

const failedExecutionDoesNotVerify = deriveRemediationWorkQueue({
  cis: [ci],
  timeline: [],
  ireRecords: {
    [ci.id]: {
      execution: staleResponse,
    },
  },
});
assert.equal(failedExecutionDoesNotVerify.items[0]?.executionCorrelation, undefined);

const persistedVerificationFailure = deriveRemediationWorkQueue({
  cis: [ci],
  timeline: [simulationEvent, {
    ...simulationEvent,
    id: "ev-execute",
    seq: 11,
    name: "IRE committed",
    reasoning: `CI committed | staged_ci_id=${ci.id} execution_correlation_id=ks-execute-persisted`,
  }, {
    ...simulationEvent,
    id: "ev-verify-failed",
    seq: 12,
    name: "Verification failed",
    status: "error",
    reasoning: `Verification completed with mismatches | staged_ci_id=${ci.id} execution_correlation_id=ks-execute-persisted`,
  }],
  findings: [{ id: "finding-1", number: "DWF0001136", stagedCiId: ci.id, recommendation: "Review simulation" }],
  reviews: [{ id: "review-1", findingId: "finding-1", decision: "approved", rationale: "Approved after review", policyApproved: true }],
});
assert.equal(persistedVerificationFailure.items[0]?.bucket, "blocked");
assert.equal(persistedVerificationFailure.items[0]?.lifecycle, "verification_failed");
assert.equal(persistedVerificationFailure.items[0]?.executionCorrelation, "ks-execute-persisted");

console.log("work-queue smoke passed");
