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
const { normalizeMaraRun, runMaraAudit } = require("../app/lib/cmdb/mara-audit.ts");
const { normalizeUsage } = require("../app/lib/cmdb/usage-adapter.ts");
const { deriveRemediationWorkQueue } = require("../app/lib/cmdb/work-queue.ts");
const { deriveCorrelatedVerifiedOutcomes } = require("../app/lib/cmdb/terminal-outcomes.ts");
const { buildPlaybackTimeline, derivePlaybackNodeStates, PLAYBACK_NODES } = require("../app/lib/cmdb/playback.ts");
const { isTerminalRunState } = require("../app/lib/cmdb/run-lifecycle.ts");
// Lazy: demo-fixture re-exports from this module, so a top-level destructure
// lands in the temporal dead zone while that chain is still initializing.
const dataset = () => require("../app/lib/cmdb/demo-dataset.json");

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

  check("a broken snapshot can never take the live app down with it", () => {
    // demo-fixture runs the adapter at module scope, and the live dashboard
    // imports that module — so a throw there would blank the whole app, not
    // just demo mode.
    const source = fs.readFileSync(path.join(root, "app", "lib", "cmdb", "demo-fixture.ts"), "utf8");
    assert.ok(/import dataset from "\.\/demo-dataset\.json"/.test(source),
      "the fixture must load the generated dataset rather than fetching anything");
    assert.equal(fixture.demoCiSeeds.length, dataset().cis.length,
      "the fixture dropped records on the way in from the dataset");
  });

  // The whole point of generating the dataset is that ONE place computes the
  // counts. This asserts the TypeScript fixture agrees with the Python
  // generator on every published number, so ledger prose and KPI tiles cannot
  // drift from the records beneath them.
  check("every fixture count matches the generator's own summary", () => {
    const summary = dataset().summary;
    const ops = {};
    for (const seed of fixture.demoCiSeeds) ops[seed.operation] = (ops[seed.operation] || 0) + 1;
    assert.deepEqual(ops, summary.operations, "operation mix drifted from the generator");
    assert.equal(fixture.DEMO_CI_COUNT, summary.record_count);
    assert.equal(fixture.DEMO_AUTONOMOUS_COUNT, summary.autonomous_count);
    assert.equal(fixture.DEMO_HELD_FOR_REVIEW_COUNT, summary.review_backlog_count);
    const h = fixture.demoHealthPayload(new Set()).result;
    assert.equal(h.baseline_score, summary.baseline_score);
    assert.equal(h.projected_score, summary.projected_score);
    assert.equal(h.completeness, summary.completeness);
    assert.equal(h.correctness, summary.correctness);
    assert.equal(h.compliance, summary.compliance);
    assert.equal(h.duplicates_detected, summary.duplicate_count);
    assert.equal(h.relationship_count, summary.relationship_count);
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
    assert.ok(/setSourceUrl\(""\)/.test(effect),
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

  // A run where every record is a clean INSERT is not a run anybody
  // recognises, and it leaves the Sankey a single flat band. The demo must
  // carry the full spread of outcomes, across several sources and classes.
  check("the run spans real sources, classes, and outcomes", () => {
    const ops = new Set(cis.map(ci => ci.operation));
    for (const expected of ["INSERT", "UPDATE", "NO_CHANGE", "REVIEW", "INSERT_AS_INCOMPLETE", "ERROR"]) {
      assert.ok(ops.has(expected), `no record has outcome ${expected}; the Sankey would lose that band`);
    }
    assert.ok(new Set(cis.map(ci => ci.source)).size >= 3, "too few source systems for a meaningful Sankey");
    assert.ok(new Set(cis.map(ci => ci.className)).size >= 4, "too few proposed classes for a meaningful Sankey");
  });

  check("every held record explains itself and no eligible record does", () => {
    for (const seed of fixture.demoCiSeeds) {
      const eligible = seed.operation === "INSERT";
      assert.equal(Boolean(seed.holdReason), !eligible,
        `${seed.name} (${seed.operation}) has the wrong hold-reason state`);
      if (seed.holdReason) assert.ok(seed.holdReason.length > 20, `${seed.name} has a uselessly vague hold reason`);
    }
  });

  check("the gate cleanly separates cleared from held", () => {
    const gate = fixture.DEMO_GATE_THRESHOLD;
    for (const seed of fixture.demoCiSeeds) {
      const defective = ["REVIEW", "INSERT_AS_INCOMPLETE", "ERROR"].includes(seed.operation);
      assert.equal(seed.confidence < gate, defective,
        `${seed.name} scores ${seed.confidence} but is ${seed.operation}`);
    }
  });

  check("health counts agree with the records beneath them", () => {
    assert.equal(health.ciCount, cis.length);
    assert.equal(health.reviewCount, fixture.DEMO_HELD_FOR_REVIEW_COUNT);
    assert.equal(health.relationshipCount, relationships.length);
    assert.equal(health.duplicateCandidates, cis.filter(ci => ci.operation === "REVIEW").length);
  });

  // A score that sat still through a whole migration was the bug that made the
  // old demo unconvincing. It must move with verified work, and stop at
  // projected rather than sailing past it.
  check("health score rises with verified work and never exceeds projected", () => {
    const ids = n => new Set(fixture.demoPacketCohort.slice(0, n).map(s => s.sysId));
    const none = fixture.demoHealthPayload(new Set()).result;
    const half = fixture.demoHealthPayload(ids(Math.floor(fixture.DEMO_AUTONOMOUS_COUNT / 2))).result;
    const full = fixture.demoHealthPayload(ids(fixture.DEMO_AUTONOMOUS_COUNT)).result;
    assert.equal(none.score, none.baseline_score, "score before any work should read the baseline");
    assert.ok(half.score > none.score, "score did not move as records verified");
    assert.ok(full.score > half.score, "score stopped moving part-way through");
    assert.ok(full.score <= full.projected_score, "realized score overtook the projection");
    assert.equal(full.projected_score, none.projected_score, "the projection drifted as work landed");
  });

  // Beat 4 of the showcase: which approvals buy the most health.
  check("work groups are homogeneous and ranked by the health they return", () => {
    const groups = fixture.demoWorkGroups;
    assert.ok(groups.length >= 3, "too few work groups to make Prioritize meaningful");
    for (const group of groups) {
      assert.equal(new Set(group.seeds.map(s => s.table)).size, 1, `${group.signature} mixes classes`);
      assert.equal(new Set(group.seeds.map(s => s.operation)).size, 1, `${group.signature} mixes operations`);
    }
    const sizes = groups.map(g => g.seeds.length);
    assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a), "groups are not ranked largest-first");
    assert.equal(sizes.reduce((a, b) => a + b, 0), fixture.DEMO_AUTONOMOUS_COUNT,
      "work groups do not account for the whole autonomous cohort");
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

  check("the autonomous cohort begins ready for simulation", () => {
    const ready = queue.buckets.find(bucket => bucket.id === "ready_to_simulate");
    assert.ok(ready.items.length >= fixture.DEMO_AUTONOMOUS_COUNT,
      `only ${ready.items.length} ready; expected at least the ${fixture.DEMO_AUTONOMOUS_COUNT}-record cohort`);
    // Held records land in `blocked` / `simulation_failed`, and should — an
    // unreconcilable record is a real defect the operator needs to see. What
    // must never happen is a *cohort* record sitting there before anything ran.
    const cohort = new Set(fixture.demoPacketCohort.map(seed => seed.sysId));
    for (const id of ["blocked", "simulation_failed"]) {
      const stuck = queue.buckets.find(bucket => bucket.id === id).items
        .filter(item => cohort.has(item.id));
      assert.deepEqual(stuck.map(item => item.ci.name), [],
        `an autonomous-cohort record started out in ${id}`);
    }
  });

  check("every cohort record is committable, and no held record is", () => {
    // "Commit this CI to ServiceNow" is gated on `approvable`, which needs BOTH
    // finding.id and review.id on the selected queue item. A record without a
    // finding can be simulated but never committed, and the button gives no
    // hint why — so every record must carry both.
    const missing = queue.items.filter(item => !item.finding?.id || !item.review?.id);
    assert.deepEqual(missing.map(item => item.ci.name), [],
      "these records could never enable the Commit button");
    // The boundary is the point of the demo: held records carry full evidence
    // so an operator can inspect them, but must never enter the cohort.
    const cohort = new Set(fixture.demoPacketCohort.map(seed => seed.sysId));
    for (const seed of fixture.demoCiSeeds) {
      assert.equal(cohort.has(seed.sysId), !seed.holdReason,
        `${seed.name} is on the wrong side of the autonomous boundary`);
    }
    // `demo_fallback` means "no backing records at all". Now that every row has
    // a real finding and review decision, servicenow_records is the honest
    // source and fallbackCount is correctly zero.
    assert.equal(queue.fallbackCount, 0);
    assert.equal(queue.liveBackedCount, queue.items.length,
      "every row should be backed by findings/reviews evidence");
  });

  // --- "Commit this CI to ServiceNow" must actually be reachable ------------
  // The button is gated on `approvable`:
  //   lifecycle === "simulated_pending_approval"
  //   && simulationCorrelation && simulationFingerprint
  //   && finding.id && review.id
  // Any record failing one of those can be simulated but never committed, and
  // the UI gives no hint why. This walks a real cohort record of every class
  // through simulate and asserts each clause independently.
  {
    resetDemoWriteState();
    const postJson = (url, payload) => readJson(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const unreachable = [];
    for (const klass of [...new Set(fixture.demoPacketCohort.map(seed => seed.className))]) {
      const seed = fixture.demoPacketCohort.find(s => s.className === klass);
      if (!seed) continue;
      const body = {
        migration_run_id: fixture.DEMO_RUN_ID,
        staged_ci_id: seed.sysId,
        correlation_id: `ks-gate-${seed.index}`,
        idempotency_key: `keystone:gate:${seed.index}`,
      };
      const simulated = (await postJson("/api/cmdb/ire/simulate", body)).body;
      const workbenchQueue = deriveRemediationWorkQueue({
        cis, timeline, findings, reviews,
        ireRecords: { [seed.sysId]: { simulation: simulated } },
      });
      const item = workbenchQueue.items.find(entry => entry.id === seed.sysId);
      const approvable = item.lifecycle === "simulated_pending_approval"
        && Boolean(item.simulationCorrelation && item.simulationFingerprint
          && item.finding?.id && item.review?.id);
      if (!approvable) {
        unreachable.push(`${seed.name} [${klass}] lifecycle=${item.lifecycle} ` +
          `corr=${Boolean(item.simulationCorrelation)} fp=${Boolean(item.simulationFingerprint)} ` +
          `finding=${Boolean(item.finding?.id)} review=${Boolean(item.review?.id)}`);
      }
    }
    check("Commit is reachable for a cohort record of every class after simulating", () => {
      assert.deepEqual(unreachable, [],
        "these records can be simulated but never committed");
    });
    resetDemoWriteState();
  }

  // --- Agent evidence and truthful pre-execution playback -------------------
  check("W-R-A-G-S and Mara all publish realistic analysis outputs", () => {
    const audit = runMaraAudit({ timeline, cis, findings, reviews, run });
    const coverage = audit.checks.find(item => item.id === "coverage");
    const flow = audit.checks.find(item => item.id === "flow");
    const errors = audit.checks.find(item => item.id === "errors");
    assert.equal(coverage.status, "pass", coverage.summary);
    assert.equal(flow.status, "pass", flow.summary);
    assert.equal(errors.status, "pass", errors.summary);
    for (const actor of ["Mara", "Weaver", "Router", "Atlas", "Sentry", "Scout", "Ledger"]) {
      assert.ok(audit.actors.some(item => item.actor === actor), `${actor} has no ledger output`);
    }
  });

  check("analysis playback does not fabricate a CMDB commit", () => {
    const frames = buildPlaybackTimeline({ timeline, stagedCiCount: cis.length });
    assert.ok(frames.length > 0, "no playback frames were built");
    const states = derivePlaybackNodeStates(frames, frames.length - 1).states;
    assert.equal(states.cmdb, "untouched", "CMDB lit up before any execution action ran");
    assert.ok(PLAYBACK_NODES.some(node => states[node.id] !== "untouched"), "analysis produced no visible playback");
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
    assert.equal(prepared.body.items.length, fixture.DEMO_PACKET_SIZE);
    assert.equal(prepared.body.children.length, 5);
    assert.ok(prepared.body.children.every(child => child.item_count <= fixture.DEMO_CAMPAIGN_SIZE));
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
    assert.equal(verified.items.length, fixture.DEMO_PACKET_SIZE,
      `expected the first bounded packet of ${fixture.DEMO_PACKET_SIZE} records to read back as verified`);
  });

  check("verified records satisfy the strict correlated-outcome check", () => {
    // deriveCorrelatedVerifiedOutcomes only counts a record when its whole
    // simulation -> approval -> execution -> verification chain cross-references
    // itself exactly. Without this the journey reports "no records reached
    // verification" while the packet panel shows six verified.
    const outcomes = deriveCorrelatedVerifiedOutcomes(finalQueue.items, finalTimeline);
    assert.equal(outcomes.length, fixture.DEMO_PACKET_SIZE,
      `only ${outcomes.length} of ${fixture.DEMO_PACKET_SIZE} records produced a correlated verified outcome`);
    for (const outcome of outcomes) {
      assert.ok(outcome.targetCiSysId, "outcome has no target CI");
      assert.ok(["INSERT", "UPDATE"].includes(outcome.operation), `unexpected operation ${outcome.operation}`);
    }
  });

  let autonomousWaves = 0;
  let empty;
  while (autonomousWaves < 10) {
    const next = await post("/api/cmdb/remediation-campaign/autonomous-packet", packetBody);
    if (!next.response.ok) {
      empty = next;
      break;
    }
    autonomousWaves += 1;
    assert.ok(next.body.packet.items.length <= fixture.DEMO_PACKET_SIZE);
    let waveStatus;
    for (let poll = 0; poll < 10; poll++) {
      waveStatus = (await post("/api/cmdb/remediation-campaign/packet-status", packetBody)).body;
      if (waveStatus.stage === "completed") break;
    }
    assert.equal(waveStatus.stage, "completed");
    assert.equal(waveStatus.aggregate.verified, waveStatus.aggregate.total);
    assert.equal(waveStatus.aggregate.blocked, 0);
  }

  check("Mara drains the autonomous cohort in successive bounded packets", () => {
    // Packets are homogeneous — one class, one operation — so the count is the
    // sum over work groups, not the cohort divided by the packet size.
    const expected = fixture.demoWorkGroups
      .reduce((sum, group) => sum + Math.ceil(group.seeds.length / fixture.DEMO_PACKET_SIZE), 0);
    assert.equal(autonomousWaves + 1, expected,
      `expected ${expected} packets across ${fixture.demoWorkGroups.length} work groups`);
    assert.equal(empty.response.status, 409);
    assert.equal(empty.body.code, "PACKET_EMPTY");
  });

  check("every committed packet stayed homogeneous", () => {
    const byGroup = new Map();
    for (const seed of fixture.demoPacketCohort) byGroup.set(seed.sysId, seed.workGroup);
    // Any packet mixing classes would have been rejected by the real approval
    // packet policy, so a demo that mixes them proves nothing.
    for (const group of fixture.demoWorkGroups) {
      assert.equal(new Set(group.seeds.map(seed => byGroup.get(seed.sysId))).size, 1);
    }
  });

  check("playback reaches all seven workflow nodes only after execution", () => {
    const frames = buildPlaybackTimeline({ timeline: finalTimeline, stagedCiCount: cis.length });
    const states = derivePlaybackNodeStates(frames, frames.length - 1).states;
    const untouched = PLAYBACK_NODES.filter(node => states[node.id] === "untouched").map(node => node.id);
    assert.deepEqual(untouched, [], `nodes never reached after execution: ${untouched.join(", ")}`);
  });

  const completedTimeline = normalizeComprehendTimeline((await readJson("/api/cmdb/timeline")).body);
  const completedQueue = deriveRemediationWorkQueue({
    cis, timeline: completedTimeline, healthFixes: health.fixes, findings, reviews, demoFallback: true,
  });
  const finalHealth = normalizeComprehendHealth((await readJson("/api/cmdb/health")).body);
  check("the run verifies the whole cohort and leaves the backlog untouched", () => {
    const verified = completedQueue.buckets.find(bucket => bucket.id === "verified");
    const needsVerification = completedQueue.buckets.find(bucket => bucket.id === "needs_verification");
    const blocked = completedQueue.buckets.find(bucket => bucket.id === "blocked");
    assert.equal(verified.items.length, fixture.DEMO_AUTONOMOUS_COUNT);
    assert.equal(needsVerification.items.length, 0);
    assert.equal(blocked.items.length, 0, "nothing should end blocked; held records were never submitted");
    assert.equal(deriveCorrelatedVerifiedOutcomes(completedQueue.items, completedTimeline).length,
      fixture.DEMO_AUTONOMOUS_COUNT);
    // The closing beat: health actually improved, and the backlog is still visible.
    assert.ok(finalHealth.score > finalHealth.baselineScore,
      `health did not move: still ${finalHealth.score}`);
    assert.ok(finalHealth.score <= finalHealth.projectedScore);
    assert.equal(finalHealth.reviewCount, fixture.DEMO_HELD_FOR_REVIEW_COUNT);
  });

  check("packet and Phase D outputs remain visible after the full run", () => {
    const detail = completedTimeline.map(event => event.reasoning).join("\n");
    assert.match(detail, /MARA_HEALTHY_INSERT_V1/);
    assert.match(detail, /Frozen ks-packet:demo-0001/);
    assert.match(detail, /approval continuation/);
    assert.match(detail, /CMDB publish completed through IRE/);
    // The closing entry must report BOTH numbers. Rounding the run up to
    // "everything verified" is exactly the overclaim this demo must not make.
    assert.match(detail, new RegExp(`${fixture.DEMO_AUTONOMOUS_COUNT}/${fixture.DEMO_AUTONOMOUS_COUNT} correlated outcomes verified`));
    assert.match(detail, new RegExp(`${fixture.DEMO_HELD_FOR_REVIEW_COUNT} staged records were never eligible`));
  });

  // --- One source, full start-to-end progression ---------------------------
  const { getSourceAdapter } = require("../app/lib/cmdb/source-adapters.ts");

  check("the demo source is a bundled dataset, never a fetch", () => {
    const meta = dataset().dataset;
    assert.equal(fixture.DEMO_SOURCE_NAME, meta.name);
    assert.equal(fixture.DEMO_DATASET_FILE, meta.file);
    assert.equal(dataset().cis.length, fixture.DEMO_CI_COUNT);
    assert.ok(meta.generator.endsWith("generate_demo_dataset.py"),
      "the dataset must record which generator produced it");
    // No demo surface may name a URL to fetch: the records ship with the app.
    const fixtureSource = fs.readFileSync(path.join(root, "app", "lib", "cmdb", "demo-fixture.ts"), "utf8");
    assert.ok(!/https?:\/\//.test(fixtureSource.replace(/^\s*(\/\/|\*).*$/gm, "")),
      "the fixture still references a URL");
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
