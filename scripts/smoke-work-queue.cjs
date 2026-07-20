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

console.log("work-queue smoke passed");
