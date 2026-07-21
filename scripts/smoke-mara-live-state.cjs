// Smoke tests for the shared Mara live-state adapter and draggable mascot.

const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const outDir = path.join(__dirname, "..", ".smoke-mara");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

execSync(
  `npx tsc --module commonjs --target es2022 --lib es2022,dom --outDir "${outDir}" --skipLibCheck --esModuleInterop --moduleResolution node --jsx react ./app/lib/cmdb/workspace-view-state.ts ./app/lib/ui/use-draggable-mascot.ts`,
  { stdio: "inherit", cwd: path.join(__dirname, "..") },
);

// Rename outputs to .cjs so require() works under "type": "module".
function toCjs(file) {
  const target = file.replace(/\.js$/, ".cjs");
  fs.renameSync(file, target);
  // Rewrite relative imports inside so require finds .cjs siblings.
  const contents = fs.readFileSync(target, "utf8").replace(/require\("\.\/([^\"]+)"\)/g, (_all, name) => {
    return `require("./${name}.cjs")`;
  }).replace(/require\("\.\.\/([^\"]+)"\)/g, (_all, name) => `require("../${name}.cjs")`);
  fs.writeFileSync(target, contents);
  return target;
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) toCjs(full);
  }
}
walk(outDir);

const workspacePath = path.join(outDir, "lib", "cmdb", "workspace-view-state.cjs");
const dragPath = path.join(outDir, "lib", "ui", "use-draggable-mascot.cjs");

function assert(condition, message) {
  if (!condition) { console.error("FAIL:", message); process.exit(1); }
}

const workspace = require(workspacePath);
const { deriveMaraLiveState, deriveWorkspaceViewState } = workspace;

const drag = require(dragPath);
const { clampPosition, defaultPosition, readStoredPosition } = drag;

// --- 1. State mapping: approval required ---
{
  const live = deriveMaraLiveState({
    hasRun: true, runStateLower: "awaiting_approval", analysisState: "started", apiState: "live",
    requiresApproval: true, approvalCount: 2, heldCount: 2, executingCount: 0, verifiedCount: 0,
    prioritizeStatus: "complete", remediateStatus: "approval_required",
    verifyStatus: "waiting", comprehendStatus: "complete", activityCards: [], activeAction: "",
  });
  assert(live.state === "awaiting_approval", `state=${live.state}`);
  assert(live.visualState === "awaiting_approval", `visualState=${live.visualState}`);
  assert(/records need your review/.test(live.message), `message: ${live.message}`);
  assert(live.actions.includes("review_findings") && live.actions.includes("open_approvals"), `actions: ${live.actions}`);
}

// --- 2. State mapping: executing ---
{
  const live = deriveMaraLiveState({
    hasRun: true, runStateLower: "executing", analysisState: "started", apiState: "live",
    requiresApproval: false, approvalCount: 0, heldCount: 0, executingCount: 3, verifiedCount: 0,
    prioritizeStatus: "complete", remediateStatus: "working",
    verifyStatus: "waiting", comprehendStatus: "complete", activityCards: [],
  });
  assert(live.state === "executing", `executing state=${live.state}`);
  assert(live.message.includes("IRE"), `executing message: ${live.message}`);
}

// --- 3. State mapping: verifying ---
{
  const live = deriveMaraLiveState({
    hasRun: true, runStateLower: "verifying", analysisState: "started", apiState: "live",
    requiresApproval: false, approvalCount: 0, heldCount: 0, executingCount: 0, verifiedCount: 0,
    prioritizeStatus: "complete", remediateStatus: "complete",
    verifyStatus: "working", comprehendStatus: "complete", activityCards: [],
  });
  assert(live.state === "verifying", `verifying state=${live.state}`);
  assert(live.message.toLowerCase().includes("verifying"), `verifying message: ${live.message}`);
}

// --- 4. State mapping: completed ---
{
  const live = deriveMaraLiveState({
    hasRun: true, runStateLower: "committed", analysisState: "started", apiState: "live",
    requiresApproval: false, approvalCount: 0, heldCount: 0, executingCount: 0, verifiedCount: 5,
    prioritizeStatus: "complete", remediateStatus: "complete",
    verifyStatus: "complete", comprehendStatus: "complete", activityCards: [],
  });
  assert(live.state === "completed", `completed state=${live.state}`);
  assert(live.visualState === "blooming", `blooming visual`);
}

// --- 5. Never sleeping with an active run ---
{
  const live = deriveMaraLiveState({
    hasRun: true, runStateLower: "analyzing", analysisState: "started", apiState: "live",
    requiresApproval: false, approvalCount: 0, heldCount: 0, executingCount: 0, verifiedCount: 0,
    prioritizeStatus: "waiting", remediateStatus: "waiting",
    verifyStatus: "waiting", comprehendStatus: "working", activityCards: [],
  });
  assert(live.state !== "sleeping", `must not sleep during active run, got ${live.state}`);
  assert(live.state === "inspecting", `expected inspecting, got ${live.state}`);
}

// --- 6. No raw JSON leak into Mara copy ---
{
  const live = deriveMaraLiveState({
    hasRun: true, runStateLower: "analyzing", analysisState: "started", apiState: "live",
    requiresApproval: false, approvalCount: 0, heldCount: 0, executingCount: 0, verifiedCount: 0,
    prioritizeStatus: "waiting", remediateStatus: "waiting",
    verifyStatus: "waiting", comprehendStatus: "working", activityCards: [],
    activeAction: 'Observation: {"ready_count": 8}',
  });
  assert(!live.message.includes("Observation:"), "message must not contain Observation");
  assert(!live.message.includes("{"), "message must not contain JSON braces");
}

// --- 7. Sleeping only when no run ---
{
  const live = deriveMaraLiveState({
    hasRun: false, runStateLower: "", analysisState: "idle", apiState: "demo",
    requiresApproval: false, approvalCount: 0, heldCount: 0, executingCount: 0, verifiedCount: 0,
    prioritizeStatus: "unknown", remediateStatus: "unknown",
    verifyStatus: "waiting", comprehendStatus: "unknown", activityCards: [],
  });
  assert(live.state === "sleeping", `no-run sleeping, got ${live.state}`);
  assert(live.actions[0] === "start_rescue", `sleeping actions: ${live.actions}`);
}

// --- 8. Transition key: same state + same latestEventId → stable ---
{
  const base = {
    hasRun: true, runStateLower: "analyzing", analysisState: "started", apiState: "live",
    requiresApproval: false, approvalCount: 0, heldCount: 0, executingCount: 0, verifiedCount: 0,
    prioritizeStatus: "working", remediateStatus: "waiting",
    verifyStatus: "waiting", comprehendStatus: "complete",
    activityCards: [{ id: "evt-1", seq: 1, phase: "prioritize", actor: "Mara", status: "active", headline: "x", summary: "x", technical: "" }],
    latestTimelineTime: "10:00",
  };
  const a = deriveMaraLiveState(base);
  const b = deriveMaraLiveState({ ...base });
  assert(a.state === b.state, "state stable");
  assert(a.latestEventId === b.latestEventId, "latestEventId stable");
  assert(a.latestEventId === "evt-1", `latestEventId: ${a.latestEventId}`);
}

// --- 9. Approval synchronization: workspace + Mara agree ---
{
  const view = deriveWorkspaceViewState({
    runLabel: "RUN-TEST", runId: "test", runState: "awaiting_approval", apiState: "live",
    analysisState: "started",
    cis: [{ id: "c1", stagedCiId: "s1", name: "n1", className: "x", ip: "0", source: "x", operation: "REVIEW", confidence: 0.9, health: 90, updatedAt: "", status: "review", provenance: [] }],
    timeline: [],
    relationships: [],
    findings: [{ id: "f1", severity: "critical" }],
    reviews: [],
    health: { score: 0, grade: "", ciCount: 0, duplicateCandidates: 0, reviewCount: 0, relationshipCount: 0, completeness: 0, correctness: 0, compliance: 0, duplicateRate: 0, staleRecords: 0, fixes: [] },
  });
  assert(view.requiresApproval === true, "workspace requiresApproval");
  assert(view.mara.state === "awaiting_approval", `mara state matches, got ${view.mara.state}`);
  assert(view.governance.tone === "attention", "governance attention when awaiting approval");
}

// --- 10. Viewport clamping ---
{
  const vp = { width: 1440, height: 900 };
  const clamped = clampPosition({ x: 5000, y: -100 }, false, vp);
  assert(clamped.x < vp.width && clamped.x >= 16, `clamped.x=${clamped.x}`);
  assert(clamped.y >= 16 && clamped.y < vp.height, `clamped.y=${clamped.y}`);
}

// --- 11. Default position anchors bottom-right ---
{
  const vp = { width: 1440, height: 900 };
  const pos = defaultPosition(false, vp);
  assert(pos.x > vp.width / 2, `default x should be right-side, got ${pos.x}`);
  assert(pos.y > vp.height / 2, `default y should be bottom, got ${pos.y}`);
}

// --- 12. Persisted position round trip (mock localStorage) ---
{
  const store = new Map();
  global.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    matchMedia: () => ({ matches: false }),
    innerWidth: 1440,
    innerHeight: 900,
  };
  store.set("keystone.mara.pos.desktop", JSON.stringify({ x: 400, y: 300 }));
  const read = readStoredPosition(false, { width: 1440, height: 900 });
  assert(read && read.x === 400 && read.y === 300, `persisted: ${JSON.stringify(read)}`);
  // Out-of-bounds stored value should be clamped back into viewport.
  store.set("keystone.mara.pos.desktop", JSON.stringify({ x: 5000, y: 5000 }));
  const readClamped = readStoredPosition(false, { width: 1440, height: 900 });
  assert(readClamped && readClamped.x < 1440 && readClamped.y < 900, `oob clamped: ${JSON.stringify(readClamped)}`);
  delete global.window;
}

// --- 13. Mobile docking: mobile position anchors to bottom with room for nav ---
{
  const vp = { width: 375, height: 812 };
  const pos = defaultPosition(true, vp);
  assert(pos.y < vp.height - 60, `mobile y leaves room for nav, got ${pos.y}`);
  assert(pos.x + 64 <= vp.width, `mobile x fits, got ${pos.x}`);
}

console.log("smoke-mara-live-state: all assertions passed");
