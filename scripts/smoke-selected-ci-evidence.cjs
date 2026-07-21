// Smoke tests for the CI-scoping fix in the Remediate page.
//
// Covers the five explicit acceptance cases from the ticket:
//   1. A global (run-level) Mara observation event is NOT selected as
//      CI-specific IRE evidence.
//   2. A matching staged-CI IRE simulation event IS selected.
//   3. A CI with no simulation shows the empty-state string.
//   4. A strategy/configuration failure classifies as "strategy" (not
//      "execution") and preserves the exact backend message.
//   5. Raw JSON is never surfaced in the normal CI evidence UI —
//      run-level observations go through buildRunSummaryChips instead.

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "..");
const ts = require(path.join(repoRoot, "node_modules", "typescript"));

// Load and transpile the two source modules we need.
function loadTs(relPath) {
  const src = fs.readFileSync(path.join(repoRoot, relPath), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  });
  return out.outputText;
}
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "keystone-ci-"));
// Stub every relative dependency of the two modules under test — all of
// their runtime imports (../../cmdb-data, ./ire, ./comprehend-adapter) are
// pulled purely for their types, which transpileModule erases. Providing
// an empty CJS stub for each keeps require() happy without dragging in
// the whole Next runtime.
const stubDir = path.join(workspace, "stubs");
fs.mkdirSync(stubDir, { recursive: true });
// Declaring the stub tree as commonjs makes node try .cjs when resolving
// bare require paths (require("./ire") → ire.cjs).
fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");
fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");
for (const rel of ["ire.js", "comprehend-adapter.js"]) {
  fs.writeFileSync(path.join(stubDir, rel), "module.exports = {};\n", "utf8");
}
fs.writeFileSync(path.join(workspace, "cmdb-data.js"), "module.exports = {};\n", "utf8");

function writeModule(name, src) {
  const file = path.join(stubDir, `${name}.js`);
  // Rewrite the transpiled requires so relative imports resolve inside stubDir
  // and the two-level "../../cmdb-data" walks up to /workspace/cmdb-data.
  const rewired = src
    .replace(/require\(["'`]\.\/(ire|comprehend-adapter)["'`]\)/g, "require(\"./$1\")")
    .replace(/require\(["'`]\.\.\/\.\.\/cmdb-data["'`]\)/g, "require(\"../cmdb-data\")")
    .replace(/require\(["'`]\.\/work-queue["'`]\)/g, "require(\"./work-queue\")");
  fs.writeFileSync(file, rewired, "utf8");
  return file;
}
const workQueuePath = writeModule("work-queue", loadTs("app/lib/cmdb/work-queue.ts"));
const evidencePath = writeModule("selected-ci-evidence", loadTs("app/lib/cmdb/selected-ci-evidence.ts"));

const workQueue = require(workQueuePath);
const evidence = require(evidencePath);

// ---------- Fixture helpers ----------
const CI = {
  id: "abc111",
  stagedCiId: "267a61802b528b1060aefba6b891bfd1",
  name: "Exchange Online",
  className: "cmdb_ci_service",
  ip: "",
  source: "dotwalkers_test_import",
  operation: "REVIEW",
  confidence: 0.65,
  health: 60,
  updatedAt: "now",
  status: "review",
  provenance: [],
};

function event(overrides) {
  return {
    id: "EV-1",
    seq: 1,
    step: 3,
    name: "event",
    recordName: "",
    className: "",
    operation: "NO_CHANGE",
    source: "ServiceNow",
    confidence: 0,
    time: "now",
    status: "complete",
    reasoning: "",
    ...overrides,
  };
}

// ---------- 1. Global Mara event NOT selected as CI evidence ----------
{
  const maraObservation = event({
    id: "EV-mara",
    source: "Mara",
    recordName: "run-summary",
    reasoning: 'Observation: {"ready_count":8,"held_count":2,"exchange online":"referenced"}',
  });
  const ciSpecific = event({
    id: "EV-sim",
    source: "IRE",
    recordName: CI.stagedCiId,
    reasoning: "Simulation recorded for staged CI. simulation_correlation_id=ks-simulate-42 simulation_fingerprint=abc123",
  });
  const timeline = [maraObservation, ciSpecific];
  const queue = workQueue.deriveRemediationWorkQueue({ cis: [CI], timeline });
  const item = queue.items[0];
  // Latest CI-scoped event must be the IRE one, not the Mara observation
  // (even though the Mara blob mentions the CI name in passing).
  assert.equal(item.latestEvent?.id, "EV-sim", "matching CI event must be picked, not the Mara observation");
  // Reason must never include the raw observation blob text.
  assert.ok(!/ready_count|held_count|Observation:/i.test(item.reason), `reason leaked observation blob: ${item.reason}`);
  // Only-Mara timeline: the CI has NO ci-scoped event at all.
  const maraOnly = workQueue.deriveRemediationWorkQueue({ cis: [CI], timeline: [maraObservation] });
  assert.equal(maraOnly.items[0].latestEvent, undefined, "a lone Mara observation must not become CI evidence");
  assert.notEqual(maraOnly.items[0].source, "servicenow_ledger", "Mara observation must not upgrade source to ledger");
  console.log("  ✓ global Mara event is not selected as CI IRE evidence");
}

// ---------- 2. Matching staged-CI simulation event IS selected ----------
{
  const sim = event({
    id: "EV-real-sim",
    source: "IRE",
    recordName: CI.stagedCiId,
    reasoning: "Simulation recorded. simulation_fingerprint=fp-abc",
  });
  const queue = workQueue.deriveRemediationWorkQueue({ cis: [CI], timeline: [sim] });
  const item = queue.items[0];
  assert.equal(item.latestEvent?.id, "EV-real-sim");
  assert.equal(item.source, "servicenow_ledger", `expected servicenow_ledger source, got ${item.source}`);
  assert.ok(item.lifecycle === "simulated_pending_approval", `lifecycle should reflect a real simulation, got ${item.lifecycle}`);
  console.log("  ✓ matching staged-CI simulation event is selected as evidence");
}

// ---------- 2b. Metadata-based match (reasoning carries staged_ci_id=...) ----------
{
  const sim = event({
    id: "EV-metadata",
    source: "IRE",
    recordName: "different-record",
    reasoning: `IRE simulation started staged_ci_id=${CI.stagedCiId} simulation_fingerprint=fp-x`,
  });
  const queue = workQueue.deriveRemediationWorkQueue({ cis: [CI], timeline: [sim] });
  assert.equal(queue.items[0].latestEvent?.id, "EV-metadata", "metadata token must match even when recordName differs");
  console.log("  ✓ staged_ci_id metadata token also matches");
}

// ---------- 3. Missing CI simulation → empty-state string ----------
{
  const emptyWorkbench = {};
  assert.equal(evidence.hasCiSpecificIreResponse(emptyWorkbench), false);
  assert.equal(evidence.hasCiSpecificIreResponse(null), false);
  assert.equal(evidence.hasCiSpecificIreResponse(undefined), false);
  assert.equal(
    evidence.CI_EVIDENCE_EMPTY_STATE,
    "No CI-specific IRE simulation response was recorded.",
  );
  // And the dashboard's card must actually render this string in the empty branch.
  const dashSrc = fs.readFileSync(path.join(repoRoot, "app/cmdb-dashboard.tsx"), "utf8");
  assert.ok(/\{CI_EVIDENCE_EMPTY_STATE\}/.test(dashSrc), "dashboard must render CI_EVIDENCE_EMPTY_STATE");
  console.log("  ✓ missing CI simulation shows the empty-state string");
}

// ---------- 3b. Strategy failure takes precedence over hasResponse (bug fix) ----------
{
  // Workbench holds a failing simulation with a strategy error. Even though
  // hasCiSpecificIreResponse is true, the dashboard must render the
  // StrategyFailureCard — NOT the "Live IRE response" card. Verified via
  // classification precedence in the dashboard source.
  const dashSrc = fs.readFileSync(path.join(repoRoot, "app/cmdb-dashboard.tsx"), "utf8");
  const evidenceFn = dashSrc.slice(dashSrc.indexOf("function SelectedCiIreEvidence"));
  const strategyCheckIdx = evidenceFn.indexOf("failure.kind === \"strategy\"");
  const hasResponseCheckIdx = evidenceFn.indexOf("if (hasResponse)");
  assert.ok(strategyCheckIdx > 0 && hasResponseCheckIdx > 0, "both branches must exist");
  assert.ok(strategyCheckIdx < hasResponseCheckIdx,
    "strategy failure classification must come BEFORE the hasResponse branch, otherwise the StrategyFailureCard is unreachable when a failing simulation is on the workbench");
  // Also assert the execution-failure branch inside hasResponse: a
  // non-strategy failure must render a red execution-error card, not
  // pretend "Live IRE response" succeeded.
  assert.ok(/ci-scope-execution-error/.test(dashSrc), "execution-failure variant must exist");
  assert.ok(/isExecutionFailure/.test(dashSrc), "execution-failure branch must set the class from the classifier");
  console.log("  ✓ strategy failure takes precedence over hasResponse branch");
}

// ---------- 4. Strategy failure classifies correctly + preserves message ----------
{
  const workbench = {
    simulation: {
      success: false,
      action: "simulate",
      state: "simulation_failed",
      error: {
        code: "IRE_FAILED",
        message: "No supported deterministic remediation strategy exists for this class alias.",
      },
    },
  };
  const cls = evidence.classifySimulationFailure(workbench, CI);
  assert.equal(cls.kind, "strategy", `expected kind=strategy, got ${cls.kind}`);
  assert.equal(cls.message, "No supported deterministic remediation strategy exists for this class alias.");
  assert.equal(cls.className, "cmdb_ci_service");
  assert.equal(cls.strategy, "unavailable");

  // Regression: the exact wording the live backend returned on 2026-07-21
  // ("No supported deterministic strategy for this class alias") — no
  // "remediation" word. Must still classify as strategy.
  const live = evidence.classifySimulationFailure({
    simulation: {
      success: false,
      action: "simulate",
      state: "simulation_failed",
      error: { code: "IRE_FAILED", message: "No supported deterministic strategy for this class alias" },
    },
  }, CI);
  assert.equal(live.kind, "strategy", "must catch the live-backend wording, not just the canonical one");
  assert.equal(live.strategy, "unavailable");

  // A non-strategy failure classifies as execution and preserves the raw msg.
  const exec = evidence.classifySimulationFailure({
    simulation: {
      success: false,
      action: "simulate",
      state: "simulation_failed",
      error: { code: "IRE_FAILED", message: "ServiceNow rejected the IRE action." },
    },
  }, CI);
  assert.equal(exec.kind, "execution");
  assert.equal(exec.message, "ServiceNow rejected the IRE action.");

  // hasCiSpecificIreResponse must be true for a failing simulation — we
  // still have a per-CI response, it just failed.
  assert.equal(evidence.hasCiSpecificIreResponse(workbench), true);

  // No workbench → kind=none
  const none = evidence.classifySimulationFailure({}, CI);
  assert.equal(none.kind, "none");
  console.log("  ✓ strategy failure classifies correctly and preserves the exact message");
}

// ---------- 5. Raw JSON never in normal CI evidence ----------
{
  // 5a. Reason sanitizer: latestEvent that is a Mara observation must NOT
  // land in the CI reason string.
  const maraObs = event({
    id: "EV-only-mara",
    source: "Mara",
    recordName: CI.stagedCiId, // intentionally matches identity — but is still a Mara observation blob
    reasoning: 'Observation: {"ready_count":8,"held_count":2}',
  });
  const q = workQueue.deriveRemediationWorkQueue({ cis: [CI], timeline: [maraObs] });
  const item = q.items[0];
  assert.ok(!/ready_count|held_count|Observation:/i.test(item.reason),
    `reason must not leak Mara JSON: ${item.reason}`);
  // isMaraObservationEvent recognises the event.
  assert.equal(workQueue.isMaraObservationEvent(maraObs), true);
  // isCiScopedTimelineEvent rejects it despite the matching recordName.
  assert.equal(workQueue.isCiScopedTimelineEvent(maraObs, CI), false);

  // 5b. buildRunSummaryChips extracts numeric chips and keeps the raw JSON
  // only under a Technical evidence disclosure (returned as `raw`).
  const summary = evidence.buildRunSummaryChips('Observation: {"ready_count":8,"held_count":2,"verified_count":0,"failed_count":1}');
  const chipLabels = summary.chips.map(c => c.label);
  assert.deepEqual(chipLabels, ["ready", "held", "failed"], `chip labels ${JSON.stringify(chipLabels)}`);
  assert.equal(summary.chips.find(c => c.label === "ready").value, "8");
  assert.equal(summary.chips.find(c => c.label === "held").value, "2");
  assert.equal(summary.chips.find(c => c.label === "held").tone, "warn");
  assert.equal(summary.chips.find(c => c.label === "ready").tone, "good");
  // Zero counts (verified_count:0) are filtered out.
  assert.ok(!chipLabels.includes("verified"));
  assert.ok(summary.raw, "raw JSON must be preserved for Technical evidence disclosure");
  assert.ok(/"ready_count"/.test(summary.raw));

  // 5c. Non-JSON reasoning → no chips, no raw
  assert.deepEqual(evidence.buildRunSummaryChips("").chips, []);
  assert.deepEqual(evidence.buildRunSummaryChips("just prose").chips, []);
  console.log("  ✓ raw JSON is absent from the normal CI evidence UI");
}

// ---------- 6. UI wiring: dashboard uses the new components + labels ----------
{
  const dashSrc = fs.readFileSync(path.join(repoRoot, "app/cmdb-dashboard.tsx"), "utf8");
  assert.ok(/<SelectedCiIreEvidence\b/.test(dashSrc), "SelectedCiIreEvidence must be mounted");
  assert.ok(/<RunSummarySection\b/.test(dashSrc), "RunSummarySection must be mounted");
  assert.ok(/<StrategyFailureCard\b/.test(dashSrc), "StrategyFailureCard must be present");
  assert.ok(/CI-SPECIFIC \\u00b7 SELECTED STAGED CI|CI-SPECIFIC · SELECTED STAGED CI/.test(dashSrc), "CI-scope label must be present");
  assert.ok(/RUN-WIDE \\u00b7 MARA SUMMARY|RUN-WIDE · MARA SUMMARY/.test(dashSrc), "Run-wide label must be present");
  // The old un-scoped .queue-evidence render block must be gone from the CI panel.
  assert.ok(!/className="queue-evidence"/.test(dashSrc.split("SelectedCiIreEvidence")[0]),
    "old .queue-evidence render must be replaced");
  console.log("  ✓ Dashboard wires new CI-scoped components and labels");
}

fs.rmSync(workspace, { recursive: true, force: true });
console.log("\nsmoke-selected-ci-evidence: all assertions passed");
