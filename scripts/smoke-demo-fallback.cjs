// Smoke test for manual demo mode.
//
// Verifies, without a browser, that the simulated run is coherent enough to
// drive the real UI: identifiers pass the frontend's own validators, findings
// and reviews actually resolve against staged CIs, the playback timeline covers
// every workflow node, and the simulated IRE lifecycle advances and replays
// idempotently. Also asserts the hard contract that demo mode off issues no
// local response at all.

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

const fixture = require("../app/lib/cmdb/demo-fixture.ts");
const demoMode = require("../app/lib/cmdb/demo-mode.ts");
const { cmdbFetch, resetDemoWriteState } = require("../app/lib/cmdb/demo-transport.ts");
const {
  normalizeComprehendCis,
  normalizeComprehendHealth,
  normalizeComprehendRelationships,
  normalizeComprehendTimeline,
  normalizeRemediationFindings,
  normalizeRemediationReviews,
} = require("../app/lib/cmdb/comprehend-adapter.ts");
const { normalizeMaraRun } = require("../app/lib/cmdb/mara-audit.ts");
const { normalizeUsage } = require("../app/lib/cmdb/usage-adapter.ts");
const { deriveRemediationWorkQueue } = require("../app/lib/cmdb/work-queue.ts");
const { deriveCorrelatedVerifiedOutcomes } = require("../app/lib/cmdb/terminal-outcomes.ts");
const { buildPlaybackTimeline, derivePlaybackNodeStates, PLAYBACK_NODES } = require("../app/lib/cmdb/playback.ts");
const { isTerminalRunState } = require("../app/lib/cmdb/run-lifecycle.ts");

const SYS_ID_RE = /^[0-9a-f]{32}$/;
const FINGERPRINT_RE = /^[0-9A-F]{64}$/;

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}

async function readJson(url, init) {
  const response = await cmdbFetch(url, init);
  return { response, body: await response.json() };
}

async function main() {
  // --- Demo mode off: the transport must be completely inert -----------------
  check("demo mode defaults to off", () => {
    assert.equal(demoMode.isDemoMode(), false);
  });

  check("toggling bumps the epoch so stale responses can be dropped", () => {
    const before = demoMode.demoEpoch();
    demoMode.setDemoMode(true);
    assert.ok(demoMode.demoEpoch() > before, "epoch did not advance on toggle");
    demoMode.setDemoMode(false);
    assert.ok(demoMode.demoEpoch() > before + 1, "epoch did not advance on toggle back");
  });

  demoMode.setDemoMode(true);
  resetDemoWriteState();

  // --- Identifier validity (the guards the frontend applies to itself) -------
  check("run id is a valid 32-hex sys_id", () => {
    assert.match(fixture.DEMO_RUN_ID, SYS_ID_RE);
  });

  check("every staged CI id is a valid 32-hex sys_id", () => {
    for (const seed of fixture.demoCiSeeds) assert.match(seed.sysId, SYS_ID_RE);
  });

  check("finding, review and fingerprint ids satisfy the governed-action guards", () => {
    for (const seed of fixture.demoFindingSeeds) {
      assert.match(fixture.demoFindingId(seed.ciIndex), SYS_ID_RE);
      assert.match(fixture.demoReviewId(seed.ciIndex), SYS_ID_RE);
    }
    for (const seed of fixture.demoCiSeeds) {
      assert.match(fixture.demoFingerprint(seed.index), FINGERPRINT_RE);
    }
  });

  check("the demo run id is recognised by the persistence guard", () => {
    assert.equal(fixture.isDemoRunId(fixture.DEMO_RUN_ID), true);
    assert.equal(fixture.isDemoRunId(fixture.DEMO_RUN_ID.toUpperCase()), true);
    assert.equal(fixture.isDemoRunId("e0ac4df32b82871060aefba6b891bf5b"), false);
    assert.equal(fixture.isDemoRunId(""), false);
    assert.equal(fixture.isDemoRunId(undefined), false);
  });

  check("leaving demo mode clears the presets off the live import form", () => {
    // The demo preset fills the Import form with its one source URL. If the
    // effect only ran when demoMode was true, toggling off would leave the LIVE
    // form armed with that URL — editable, pointed at the real staging
    // endpoint — and one click would POST a demo payload to ServiceNow. The
    // transport's referencesDemoRun guard does not cover this case, because the
    // body carries the source URL rather than the demo run id.
    const view = fs.readFileSync(path.join(root, "app", "import-view.tsx"), "utf8");
    const effect = view.slice(view.indexOf("const demoMode = useDemoMode()"), view.indexOf("const previewColumns"));
    assert.ok(!/if\s*\(!demoMode\)\s*return;/.test(effect),
      "the demo preset effect must not early-return on demoMode=false — it has to reset the form");
    assert.ok(/setSourceUrl\(demoMode \? DEMO_SOURCE_URL : ""\)/.test(effect),
      "leaving demo mode must clear the source URL back to empty");
    assert.ok(/demoModeApplied/.test(effect),
      "the effect must distinguish first mount from a real toggle so it does not clobber a live form on load");
  });

  check("every persistence site is guarded by run id, not the mode flag", () => {
    // A flag-only guard loses the race on toggle-off: effects re-run with
    // demoMode already false while activeRunId is still the simulated one, and
    // the demo run leaks into `?run=` and keystone.run.registry.v1.
    const dashboard = fs.readFileSync(path.join(root, "app", "cmdb-dashboard.tsx"), "utf8");
    const guards = dashboard.match(/isDemoRunId\(/g) || [];
    assert.ok(guards.length >= 3,
      `expected the URL, registry, and openRun persistence sites to be guarded by isDemoRunId; found ${guards.length}`);
    const usage = fs.readFileSync(path.join(root, "app", "ai-usage", "page.tsx"), "utf8");
    assert.ok(/isDemoRunId\(/.test(usage), "the AI Usage page must guard its rememberRun/writeRunToUrl too");
  });

  // --- Read endpoints -------------------------------------------------------
  const cisPayload = (await readJson("/api/cmdb/cis?run=" + fixture.DEMO_RUN_ID)).body;
  const cis = normalizeComprehendCis(cisPayload);
  const timeline = normalizeComprehendTimeline((await readJson("/api/cmdb/timeline")).body);
  const relationships = normalizeComprehendRelationships((await readJson("/api/cmdb/relationships")).body);
  const health = normalizeComprehendHealth((await readJson("/api/cmdb/health")).body);
  const findings = normalizeRemediationFindings((await readJson("/api/cmdb/findings")).body);
  const reviews = normalizeRemediationReviews((await readJson("/api/cmdb/reviews")).body);
  const run = normalizeMaraRun((await readJson("/api/cmdb/run")).body);

  check("all six read endpoints return usable records through the real adapters", () => {
    assert.equal(cis.length, fixture.DEMO_CI_COUNT);
    assert.ok(timeline.length > 0, "timeline is empty");
    assert.ok(relationships.length > 0, "relationships are empty");
    assert.ok(health.fixes.length > 0, "health returned no fixes");
    assert.ok(findings.length > 0, "findings are empty");
    assert.ok(reviews.length > 0, "reviews are empty");
  });

  check("the outcome spread keeps the unhappy paths visible", () => {
    const ops = new Set(cis.map(ci => ci.operation));
    for (const expected of ["UPDATE", "INSERT", "NO_CHANGE", "REVIEW", "INSERT_AS_INCOMPLETE", "ERROR"]) {
      assert.ok(ops.has(expected), `no staged CI has operation ${expected}`);
    }
  });

  check("health counts agree with the records beneath them", () => {
    assert.equal(health.ciCount, cis.length);
    assert.equal(health.reviewCount, cis.filter(ci => ci.status !== "live").length);
    assert.equal(health.relationshipCount, relationships.length);
  });

  check("health lift arithmetic is non-negative", () => {
    assert.ok(health.projectedScore >= health.verifiedScore, "projected < verified");
    assert.ok(health.verifiedScore >= health.baselineScore, "verified < baseline");
  });

  check("no relationship edge dangles outside the CI list", () => {
    const ids = new Set(cis.map(ci => ci.id));
    for (const rel of relationships) {
      assert.ok(ids.has(rel.source), `relationship source ${rel.source} is not a staged CI`);
      assert.ok(ids.has(rel.target), `relationship target ${rel.target} is not a staged CI`);
    }
  });

  check("run state stops polling but still permits IRE", () => {
    assert.equal(run.id, fixture.DEMO_RUN_ID);
    assert.ok(isTerminalRunState(run.state), `run state ${run.state} would poll forever`);
    const blocking = new Set(["queued", "importing", "analyzing", ""]);
    assert.ok(!blocking.has(run.state), `run state ${run.state} blocks Remediate`);
  });

  const usage = normalizeUsage((await readJson("/api/cmdb/usage?run=" + fixture.DEMO_RUN_ID)).body, fixture.DEMO_RUN_ID);
  check("AI usage reports calls including a deterministic-fallback one", () => {
    assert.ok(usage.calls.length > 0, "usage returned no calls");
    assert.ok(usage.totals.tokenMetricsAvailable, "usage reported no token metrics");
    assert.ok(usage.calls.some(call => call.status === "fallback"),
      "no fallback-status call, so the AI Usage fallback banner is never exercised");
  });

  const instance = (await readJson("/api/cmdb/instance")).body;
  check("demo mode names no instance host at all", () => {
    // Demo mode is not pretending to be connected, so it must not invent a
    // hostname for the header pill — the toggle is the only signal needed.
    assert.equal(instance.host, undefined);
    assert.equal(fixture.DEMO_INSTANCE_HOST, undefined);
  });

  // --- Cross-referencing (what the work queue depends on) -------------------
  const queue = deriveRemediationWorkQueue({
    cis,
    timeline,
    healthFixes: health.fixes,
    findings,
    reviews,
    demoFallback: true,
  });

  check("findings and reviews resolve against staged CIs", () => {
    const linked = queue.items.filter(item => item.finding);
    assert.ok(linked.length >= fixture.demoFindingSeeds.length - 1,
      `only ${linked.length} of ${fixture.demoFindingSeeds.length} findings resolved to a staged CI`);
    const withReview = queue.items.filter(item => item.review);
    assert.ok(withReview.length > 0, "no review decision resolved to its finding");
  });

  check("the work queue populates more than one bucket", () => {
    const populated = queue.buckets.filter(bucket => bucket.items.length > 0);
    assert.ok(populated.length >= 3, `only ${populated.length} bucket(s) have items`);
    const ids = populated.map(bucket => bucket.id);
    for (const expected of ["ready_to_simulate", "simulation_failed", "blocked"]) {
      assert.ok(ids.includes(expected), `bucket ${expected} is empty`);
    }
  });

  check("queue rows carry the demo_fallback source marker", () => {
    assert.ok(queue.fallbackCount > 0, "no queue item is marked demo_fallback");
  });

  // --- Playback coverage ----------------------------------------------------
  check("playback reaches every one of the seven workflow nodes", () => {
    const frames = buildPlaybackTimeline({ timeline, stagedCiCount: cis.length });
    assert.ok(frames.length > 0, "no playback frames were built");
    const states = derivePlaybackNodeStates(frames, frames.length - 1).states;
    const untouched = PLAYBACK_NODES.filter(node => states[node.id] === "untouched").map(node => node.id);
    assert.deepEqual(untouched, [], `nodes never reached: ${untouched.join(", ")}`);
  });

  // --- Simulated IRE lifecycle ---------------------------------------------
  const clean = fixture.demoPacketCohort[0];
  const ireBody = extra => JSON.stringify({
    migration_run_id: fixture.DEMO_RUN_ID,
    staged_ci_id: clean.sysId,
    correlation_id: "ks-smoke-correlation",
    idempotency_key: "keystone:smoke",
    ...extra,
  });
  const post = (url, body) => readJson(url, { method: "POST", headers: { "content-type": "application/json" }, body });

  const simulate = await post("/api/cmdb/ire/simulate", ireBody());
  const approve = await post("/api/cmdb/ire/approve", ireBody({
    finding_id: fixture.demoFindingId(clean.index),
    review_decision_id: fixture.demoReviewId(clean.index),
    simulation_correlation_id: "ks-smoke-correlation",
    simulation_fingerprint: fixture.demoFingerprint(clean.index),
  }));
  const execute = await post("/api/cmdb/ire/execute", ireBody());
  const verify = await post("/api/cmdb/ire/verify", ireBody({
    execution_correlation_id: execute.body.execution_correlation_id,
  }));

  check("IRE advances not_simulated -> verified", () => {
    assert.equal(simulate.body.state, "simulated_pending_approval");
    assert.equal(approve.body.state, "approved_for_execution");
    assert.equal(execute.body.state, "executed_pending_verification");
    assert.equal(verify.body.state, "verified");
    assert.match(simulate.body.simulation_fingerprint, FINGERPRINT_RE);
  });

  // A second simulate with a different correlation id must still return the
  // stored evidence, mirroring how ServiceNow treats a replayed action.
  const replay = await post("/api/cmdb/ire/simulate", ireBody({ correlation_id: "ks-smoke-replay" }));
  check("replaying simulate is idempotent and returns the stored evidence", () => {
    assert.equal(replay.body.simulation_correlation_id, simulate.body.simulation_correlation_id);
    assert.equal(replay.body.simulation_fingerprint, simulate.body.simulation_fingerprint);
  });

  const brokenSeed = fixture.demoCiSeeds.find(seed => seed.status === "incomplete");
  const brokenSim = await post("/api/cmdb/ire/simulate", JSON.stringify({
    migration_run_id: fixture.DEMO_RUN_ID,
    staged_ci_id: brokenSeed.sysId,
    correlation_id: "ks-smoke-broken",
    idempotency_key: "keystone:smoke:broken",
  }));
  check("incomplete identity produces a simulation_failed state, not a fake success", () => {
    assert.equal(brokenSim.body.success, false);
    assert.equal(brokenSim.body.state, "simulation_failed");
    assert.equal(brokenSim.body.error.code, "IRE_FAILED");
  });

  // --- Approval packet two-step gate --------------------------------------
  resetDemoWriteState();
  const packetBody = JSON.stringify({ migration_run_id: fixture.DEMO_RUN_ID });
  await post("/api/cmdb/remediation-campaign/plan-packet", packetBody);
  const prepared = await post("/api/cmdb/remediation-campaign/prepare-packet", packetBody);

  check("a freshly prepared packet is not yet authorized", () => {
    assert.equal(prepared.body.stage, "review_ready");
    assert.match(prepared.body.packet_hash, FINGERPRINT_RE);
    assert.equal(prepared.body.approval_enabled, false);
    assert.ok(prepared.body.items.length > 0, "packet has no items");
    assert.equal(prepared.body.children.length, 1);
  });

  const wrongHash = await post("/api/cmdb/remediation-campaign/authorize-packet", JSON.stringify({
    migration_run_id: fixture.DEMO_RUN_ID,
    confirmation_hash: "0".repeat(64),
  }));
  check("a mismatched confirmation hash is rejected", () => {
    assert.equal(wrongHash.response.status, 400);
  });

  const earlyCommit = await post("/api/cmdb/remediation-campaign/approve-packet", packetBody);
  check("committing before authorization is refused", () => {
    assert.equal(earlyCommit.response.status, 409);
  });

  const authorized = await post("/api/cmdb/remediation-campaign/authorize-packet", JSON.stringify({
    migration_run_id: fixture.DEMO_RUN_ID,
    confirmation_hash: prepared.body.packet_hash,
  }));
  check("the exact hash arms the one-time authorization", () => {
    assert.equal(authorized.body.approval_enabled, true);
  });

  const committed = await post("/api/cmdb/remediation-campaign/approve-packet", packetBody);
  check("commit starts the simulated execution chain", () => {
    assert.equal(committed.body.stage, "executing");
    assert.equal(committed.body.items.length, prepared.body.items.length);
  });

  let status;
  for (let poll = 0; poll < 10; poll++) {
    status = (await post("/api/cmdb/remediation-campaign/packet-status", packetBody)).body;
    if (status.stage === "completed") break;
  }
  check("packet progress reaches completed with everything verified", () => {
    assert.equal(status.stage, "completed");
    assert.equal(status.aggregate.verified, status.aggregate.total);
    assert.equal(status.aggregate.blocked, 0);
  });

  // The whole Agent Workspace journey is derived from the Event Ledger, so a
  // simulated commit that leaves no ledger evidence looks to the rest of the UI
  // like nothing happened — the run gets stuck on "awaiting decision" forever
  // and "View completed results" stays disabled (verifiedCount === 0).
  const finalTimeline = normalizeComprehendTimeline((await readJson("/api/cmdb/timeline")).body);
  const finalQueue = deriveRemediationWorkQueue({
    cis, timeline: finalTimeline, healthFixes: health.fixes, findings, reviews, demoFallback: true,
  });
  check("committing writes verification evidence back into the ledger", () => {
    assert.ok(finalTimeline.length > timeline.length,
      "the ledger gained no events from the simulated commit");
    const verified = finalQueue.buckets.find(bucket => bucket.id === "verified");
    assert.equal(verified.items.length, fixture.demoPacketCohort.length,
      `expected all ${fixture.demoPacketCohort.length} committed records to read back as verified`);
  });

  check("verified records satisfy the strict correlated-outcome check", () => {
    // deriveCorrelatedVerifiedOutcomes only counts a record when its whole
    // simulation -> approval -> execution -> verification chain cross-references
    // itself exactly. Without this the journey reports "no records reached
    // verification" while the packet panel shows six verified.
    const outcomes = deriveCorrelatedVerifiedOutcomes(finalQueue.items, finalTimeline);
    assert.equal(outcomes.length, fixture.demoPacketCohort.length,
      `only ${outcomes.length} of ${fixture.demoPacketCohort.length} records produced a correlated verified outcome`);
    for (const outcome of outcomes) {
      assert.ok(outcome.targetCiSysId, "outcome has no target CI");
      assert.ok(["INSERT", "UPDATE"].includes(outcome.operation), `unexpected operation ${outcome.operation}`);
    }
  });

  check("the run reaches a terminal end-to-end state", () => {
    // deriveVerifyStatus completes only when something verified and nothing is
    // still awaiting verification — this is the condition the demo used to be
    // unable to reach.
    const needsVerification = finalQueue.buckets.find(bucket => bucket.id === "needs_verification");
    assert.equal(needsVerification.items.length, 0,
      "records are still stuck awaiting verification, so Verify never completes");
    const needsApproval = finalQueue.buckets.find(bucket => bucket.id === "needs_approval");
    assert.equal(needsApproval.items.length, 0,
      "records still await approval, so the journey stays on Remediate");
  });

  const empty = await post("/api/cmdb/remediation-campaign/autonomous-packet", packetBody);
  check("Mara's autonomous loop is given a terminal PACKET_EMPTY answer", () => {
    assert.equal(empty.response.status, 409);
    assert.equal(empty.body.code, "PACKET_EMPTY");
  });

  // --- One source, full start-to-end progression ---------------------------
  const { demoSourceSnapshot } = require("../app/lib/cmdb/demo-source-snapshot.ts");
  const { getSourceAdapter } = require("../app/lib/cmdb/source-adapters.ts");

  check("the demo source is the one AWS URL with a format-true snapshot", () => {
    assert.equal(fixture.DEMO_SOURCE_URL, "https://ip-ranges.amazonaws.com/ip-ranges.json");
    assert.equal(demoSourceSnapshot.prefixes.length, fixture.DEMO_CI_COUNT);
    // The real repository adapter must recognise the snapshot as its own format
    // and be the thing that produced every staged record's identity.
    assert.equal(getSourceAdapter("aws-ip-ranges").detect(demoSourceSnapshot), "high");
    for (const seed of fixture.demoCiSeeds) {
      assert.ok(seed.name.startsWith("aws-"), `name ${seed.name} is not adapter-derived`);
    }
  });

  const imported = await post("/api/cmdb/import", JSON.stringify({
    sourceType: "url", sourceName: "AWS IP Ranges", runName: "smoke run",
    sourceUrl: fixture.DEMO_SOURCE_URL,
  }));
  check("import always stages the one frozen snapshot, identically every time", () => {
    assert.match(imported.body.result.migration_run_id, SYS_ID_RE);
    assert.equal(imported.body.result.staged, fixture.DEMO_CI_COUNT);
    assert.equal(imported.body.result.source_url, fixture.DEMO_SOURCE_URL);
  });

  // Import rewinds the simulated pipeline; timeline reads then advance it one
  // stage at a time, exactly as the app's own polling would.
  const timelineLength = async () =>
    normalizeComprehendTimeline((await readJson("/api/cmdb/timeline")).body).length;
  const runState = async () => normalizeMaraRun((await readJson("/api/cmdb/run")).body).state;
  const findingsCount = async () =>
    normalizeRemediationFindings((await readJson("/api/cmdb/findings")).body).length;

  const preState = await runState();
  const observedLengths = [];
  for (let step = 0; step < fixture.DEMO_STAGE_EVENT_COUNTS.length; step++) {
    observedLengths.push(await timelineLength());
  }
  const postState = await runState();

  check("the pipeline visibly progresses start to end after an import", () => {
    assert.equal(preState, "analyzing", "a fresh import must start with the run analyzing");
    assert.deepEqual(observedLengths, [...fixture.DEMO_STAGE_EVENT_COUNTS],
      "timeline reads must advance through the staged ledger slices");
    assert.equal(postState, "simulated", "the run must turn terminal only after the full ledger was served");
  });

  await post("/api/cmdb/import", JSON.stringify({ sourceType: "url", sourceUrl: fixture.DEMO_SOURCE_URL }));
  const earlyFindings = await findingsCount();
  const replayLengths = [];
  for (let step = 0; step < fixture.DEMO_STAGE_EVENT_COUNTS.length; step++) {
    replayLengths.push(await timelineLength());
  }
  const replayFindings = await findingsCount();
  check("early stages hide downstream evidence; the replay is byte-stable", () => {
    assert.equal(earlyFindings, 0, "findings must not exist before the gate stage");
    assert.deepEqual(replayLengths, observedLengths, "a second import must replay identically");
    assert.ok(replayFindings > 0, "findings must appear once the gate stage is reached");
  });

  const proposal = await post("/api/cmdb/remediate", JSON.stringify({
    migration_run_id: fixture.DEMO_RUN_ID,
    staged_ci_id: clean.sysId,
    finding_id: fixture.demoFindingId(clean.index),
    correlation_id: "ks-proposal:smoke",
    idempotency_key: "keystone:proposal:smoke",
    simulation_correlation_id: "smoke",
    simulation_fingerprint: fixture.demoFingerprint(clean.index),
  }));
  check("a governed proposal is recorded locally and says so", () => {
    assert.equal(proposal.body.result.success, true);
    assert.match(proposal.body.result.message, /No ServiceNow or CMDB endpoint was contacted/);
  });

  // --- Demo off is inert ---------------------------------------------------
  demoMode.setDemoMode(false);
  let delegated = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { delegated = true; return new Response("{}", { status: 200 }); };
  await cmdbFetch("/api/cmdb/cis?run=e0ac4df32b82871060aefba6b891bf5b");
  globalThis.fetch = realFetch;
  check("demo off issues a real network call rather than a simulated response", () => {
    assert.equal(delegated, true);
  });

  // Polling intervals and in-flight requests outlive the toggle, so a request
  // carrying the simulated run can be issued after demo mode is already off.
  // It must be failed closed, never sent to the real instance.
  let leaked = false;
  globalThis.fetch = async () => { leaked = true; return new Response("{}", { status: 200 }); };
  const straggler = await cmdbFetch(`/api/cmdb/cis?run=${fixture.DEMO_RUN_ID}`);
  const stragglerPost = await cmdbFetch("/api/cmdb/remediation-campaign/packet-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ migration_run_id: fixture.DEMO_RUN_ID }),
  });
  globalThis.fetch = realFetch;
  check("a stale simulated request never reaches the network after demo mode is off", () => {
    assert.equal(leaked, false, "the demo run id was sent to the real instance");
    assert.equal(straggler.status, 409);
    assert.equal(stragglerPost.status, 409, "a POST carrying the demo run in its body also leaked");
  });

  // --- Report --------------------------------------------------------------
  const failed = results.filter(result => !result.ok);
  for (const result of results) {
    console.log(`${result.ok ? "  ok" : "FAIL"}  ${result.name}${result.ok ? "" : `\n        ${result.message}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
