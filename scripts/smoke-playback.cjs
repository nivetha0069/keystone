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

const {
  buildPlaybackTimeline,
  mapPlaybackEventToNodes,
  derivePlaybackNodeStates,
  DERIVED_STAGING_TITLE,
} = require("../app/lib/cmdb/playback.ts");

// Minimal ledger-event factory. Fields mirror normalizeComprehendTimeline output.
let seqCounter = 0;
function ev(overrides) {
  seqCounter += 1;
  return {
    id: `EV-${seqCounter}`,
    seq: seqCounter,
    step: 3,
    name: "event",
    recordName: "run",
    className: "Run event",
    operation: "NO_CHANGE",
    source: "Comprehend",
    confidence: 0,
    time: `06:00:${String(seqCounter).padStart(2, "0")}`,
    status: "complete",
    reasoning: "",
    ...overrides,
  };
}

// A realistic real-agent run: Atlas/Scout classify, Sentry gates, Ledger seals,
// and a Mara oversight observation whose JSON name-drops the other agents.
// No explicit intake/staging ledger event is emitted.
const atlas = ev({ id: "e-atlas", seq: 1, step: 3, source: "Atlas", name: "Atlas selected scan classes", reasoning: "Action: scan_classes | proposed cmdb_ci_linux_server" });
const scout = ev({ id: "e-scout", seq: 2, step: 3, source: "Scout", name: "Scout selected scan duplicates", reasoning: "Action: scan_duplicates | 2 candidates" });
const sentry = ev({ id: "e-sentry", seq: 3, step: 4, source: "Sentry", name: "Sentry recorded an observation", reasoning: "Observation: confidence gate applied | 3 held 1 cleared" });
const ledger = ev({ id: "e-ledger", seq: 4, step: 7, source: "Ledger", name: "Ledger selected write summary", reasoning: "Action: write_summary" });
const mara = ev({ id: "e-mara", seq: 5, step: 3, source: "Mara", name: "Mara recorded an observation", reasoning: '{"schema":"keystone.agent.v1","observed":["Atlas","Scout","Sentry"],"note":"staged records past the confidence gate"}' });
const run = [atlas, scout, sentry, ledger, mara];

// --- 1. Staging is first when staged records exist -------------------------
// Fed out of order to also prove deterministic sorting.
const framesStaged = buildPlaybackTimeline({ timeline: [sentry, atlas, mara, ledger, scout], stagedCiCount: 4 });
assert.equal(framesStaged[0].derived, true, "derived staging frame is synthesized");
assert.equal(framesStaged[0].primaryNodeId, "staging");
assert.equal(framesStaged[0].title, DERIVED_STAGING_TITLE);

// --- 2. Ledger order is stable (seq asc), derived staging leads ------------
assert.deepEqual(
  framesStaged.map(f => f.id),
  ["derived-staging", "e-atlas", "e-scout", "e-sentry", "e-ledger", "e-mara"],
  "frames are ordered by ledger sequence with staging first",
);

// --- 3. An Atlas event highlights only Atlas (its ai-read node) ------------
const atlasMap = mapPlaybackEventToNodes(atlas);
assert.equal(atlasMap.primaryNodeId, "ai-read");
assert.deepEqual(atlasMap.relatedNodeIds, [], "Atlas does not drag other nodes along");

// --- 4. Mara JSON name-dropping other agents highlights none --------------
const maraMap = mapPlaybackEventToNodes(mara);
assert.equal(maraMap.primaryNodeId, undefined, "oversight actor owns no workflow node");
assert.deepEqual(maraMap.relatedNodeIds, []);

// --- 5. A parallel frame reaches the furthest of its declared nodes -------
const pAtlas = ev({ id: "p-atlas", seq: 10, time: "06:10:00", source: "Atlas", reasoning: "Action: scan_classes" });
const pSentry = ev({ id: "p-sentry", seq: 10, time: "06:10:00", source: "Sentry", reasoning: "Action: apply_confidence_gate" });
const parallelFrames = buildPlaybackTimeline({ timeline: [pAtlas, pSentry], stagedCiCount: 0 });
assert.equal(parallelFrames.length, 1, "same seq+time collapse into one recorded frame");
assert.equal(parallelFrames[0].primaryNodeId, "ai-read");
assert.deepEqual(parallelFrames[0].relatedNodeIds, ["confidence-gate"]);
const parallelStates = derivePlaybackNodeStates(parallelFrames, 0);
assert.equal(parallelStates.activeNodeId, "confidence-gate", "light advances to the furthest declared node");
assert.equal(parallelStates.states["ai-read"], "done");
assert.equal(parallelStates.states["confidence-gate"], "active");
assert.equal(parallelStates.states["staging"], "untouched", "unrelated nodes stay dark");
assert.equal(parallelStates.states["ire"], "untouched");

// --- 6. An unknown event highlights nothing -------------------------------
const unknown = ev({ id: "e-unknown", step: 0, source: "Zorp", name: "???", reasoning: "opaque payload" });
assert.equal(mapPlaybackEventToNodes(unknown).primaryNodeId, undefined);

// --- 7. Monotonic progression: light only moves right, never blanks -------
const s0 = derivePlaybackNodeStates(framesStaged, 0);
assert.equal(s0.states["staging"], "active", "restart / frame 0 sits on Staging");
assert.equal(s0.states["ai-read"], "upcoming");

const s1 = derivePlaybackNodeStates(framesStaged, 1); // Atlas frame
assert.equal(s1.states["staging"], "done");
assert.equal(s1.states["ai-read"], "active");

const s3 = derivePlaybackNodeStates(framesStaged, 3); // Sentry frame
assert.equal(s3.states["ai-read"], "done", "an earlier reached stage stays completed");
assert.equal(s3.states["confidence-gate"], "active");

const sEnd = derivePlaybackNodeStates(framesStaged, framesStaged.length - 1); // Mara frame (no node)
assert.equal(sEnd.activeNodeId, "event-log", "oversight final frame keeps the light on the furthest stage");
assert.equal(sEnd.states["ire"], "untouched", "a skipped stage is never shown as completed");
assert.equal(sEnd.states["cmdb"], "untouched");

// The light never rewinds even when a later event revisits an earlier stage.
const backslide = buildPlaybackTimeline({
  timeline: [
    ev({ id: "b-atlas", seq: 1, source: "Atlas", reasoning: "Action: scan_classes" }),
    ev({ id: "b-sentry", seq: 2, source: "Sentry", reasoning: "Action: apply_confidence_gate" }),
    ev({ id: "b-atlas2", seq: 3, source: "Atlas", reasoning: "Action: scan_duplicates" }),
  ],
  stagedCiCount: 0,
});
const backslideEnd = derivePlaybackNodeStates(backslide, backslide.length - 1); // last frame is an ai-read event
assert.equal(backslideEnd.activeNodeId, "confidence-gate", "light stays on the furthest stage reached");
assert.equal(backslideEnd.states["ai-read"], "done");

// --- 8. Polling appends without disturbing existing frames ----------------
const appended = ev({ id: "e-extra", seq: 6, source: "Ledger", reasoning: "Action: write_summary" });
const framesAfterPoll = buildPlaybackTimeline({ timeline: [...run, appended], stagedCiCount: 4 });
assert.deepEqual(
  framesAfterPoll.slice(0, framesStaged.length).map(f => f.id),
  framesStaged.map(f => f.id),
  "a newly polled event appends; earlier frame identities/order are unchanged",
);

// --- 9. Run change: a new run's first frame is its real opening ------------
// A run WITH an explicit Router staging event needs no derived frame and opens
// on Staging, so resetting activeStep to 0 lands on that run's first evidence.
const router = ev({ id: "e-router", seq: 1, step: 2, source: "Router", name: "Router selected get run stats", reasoning: "Action: get_run_stats | 4 staged CIs" });
const runB = buildPlaybackTimeline({ timeline: [router, atlas], stagedCiCount: 4 });
assert.equal(runB[0].id, "e-router", "explicit staging evidence is not duplicated by a derived frame");
assert.equal(runB[0].primaryNodeId, "staging");
assert.equal(runB.some(f => f.derived), false);

// --- 10. Empty timeline with staged records still shows a staging frame ----
const empty = buildPlaybackTimeline({ timeline: [], stagedCiCount: 2 });
assert.equal(empty.length, 1);
assert.equal(empty[0].primaryNodeId, "staging");
assert.equal(empty[0].derived, true);

// --- 11. Node click-to-seek targets the first frame for that node ----------
assert.equal(s0.firstFrameForNode["confidence-gate"], 3, "seek target is the first frame that reaches the node");
assert.equal(s0.firstFrameForNode["intake"], undefined, "never-reached nodes have no seek target");

console.log("playback smoke passed");
