// Node smoke tests for the pure frontend/API error helpers extracted from
// cmdb-dashboard. Covers the eight cases the bug tickets requested:
//
//   - 4xx and 5xx are classified differently
//   - Cold load (no run) classifies 400/404 as "unavailable", not "backend"
//   - Comprehend GET returns JSON 405 with allowed:["POST"]
//   - Comprehend error extraction understands every response shape
//     ServiceNow can return, including {result:{success:false,error:...}}
//   - friendlyIreError never duplicates the label+message
//   - Cold load makes no run-scoped requests (loadData("") path)
//   - Unscoped CIs cannot trigger run actions (liveRunReady gate)
//
// Anything that requires a real browser (console noise, DOM disabled state)
// is covered by asserting on the corresponding pure logic instead.

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");

const repoRoot = path.resolve(__dirname, "..");

// Load the TypeScript source and strip types with the local typescript
// package (already a dev dep). This avoids spawning tsc + writing an outDir
// and keeps the test self-contained. transpileModule preserves runtime
// semantics — including `export class EndpointError extends Error`.
const ts = require(path.join(repoRoot, "node_modules", "typescript"));
const source = fs.readFileSync(
  path.join(repoRoot, "app", "lib", "cmdb", "frontend-errors.ts"),
  "utf8",
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
  },
});
const cjsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keystone-smoke-")), "frontend-errors.cjs");
fs.writeFileSync(cjsPath, transpiled.outputText, "utf8");
const errors = require(cjsPath);

// ----- 1. classifyEndpointStatus: 4xx vs 5xx vs cold-load -----
{
  const { classifyEndpointStatus } = errors;
  // 5xx and network failures are always backend
  assert.equal(classifyEndpointStatus(500, false), "backend");
  assert.equal(classifyEndpointStatus(502, true), "backend");
  assert.equal(classifyEndpointStatus(0, false), "backend");
  assert.equal(classifyEndpointStatus(0, true), "backend");
  // 400/404 with NO run: expected, not an error
  assert.equal(classifyEndpointStatus(400, false), "unavailable");
  assert.equal(classifyEndpointStatus(404, false), "unavailable");
  // 400/404 WITH an active run: client/request error
  assert.equal(classifyEndpointStatus(400, true), "client");
  assert.equal(classifyEndpointStatus(404, true), "client");
  // Other 4xx (401/403/405/409) are always client errors
  assert.equal(classifyEndpointStatus(401, false), "client");
  assert.equal(classifyEndpointStatus(403, true), "client");
  assert.equal(classifyEndpointStatus(405, false), "client");
  assert.equal(classifyEndpointStatus(409, true), "client");
  // 2xx and 3xx are not error paths but the helper's default is "backend"
  // — callers only invoke it on !response.ok so this branch is defensive.
  console.log("  ✓ classifyEndpointStatus handles 4xx/5xx/cold-load correctly");
}

// ----- 2. friendlyIreError never duplicates the label -----
{
  const { friendlyIreError } = errors;

  // Exact duplicate of the label (the reported bug)
  const dup = friendlyIreError("NOT_CONFIGURED", "Missing ServiceNow IRE configuration.");
  assert.equal(dup, "Missing ServiceNow IRE configuration.");
  assert.ok(!/Missing ServiceNow IRE configuration\.\s+Missing/.test(dup), "must not repeat label");

  // Case-insensitive duplicate
  const caseDup = friendlyIreError("NOT_CONFIGURED", "missing servicenow ire configuration.");
  assert.equal(caseDup, "Missing ServiceNow IRE configuration.");

  // Raw message is a substring of the label
  const sub = friendlyIreError("NOT_CONFIGURED", "Missing ServiceNow IRE configuration");
  assert.equal(sub, "Missing ServiceNow IRE configuration.");

  // Different useful detail — appended
  const detailed = friendlyIreError("IRE_FAILED", "target CI 267a is already deleted");
  assert.equal(detailed, "ServiceNow rejected the IRE action. target CI 267a is already deleted");

  // Empty message — label only
  assert.equal(friendlyIreError("NOT_CONFIGURED", ""), "Missing ServiceNow IRE configuration.");
  assert.equal(friendlyIreError("NOT_CONFIGURED", "   "), "Missing ServiceNow IRE configuration.");

  // Unknown code — falls back to raw message
  assert.equal(friendlyIreError("MYSTERY", "explode"), "explode");
  assert.equal(friendlyIreError("MYSTERY", ""), "IRE error (MYSTERY).");

  console.log("  ✓ friendlyIreError never duplicates label + message");
}

// ----- 3. extractComprehendError understands every ServiceNow shape -----
{
  const { extractComprehendError } = errors;

  // Top-level {error}
  assert.equal(extractComprehendError({ error: "flat error" }, {}, 400), "flat error");

  // Top-level {message}
  assert.equal(extractComprehendError({ message: "flat message" }, {}, 400), "flat message");

  // {result:{error}}
  assert.equal(
    extractComprehendError({ result: { error: "one-nested" } }, {}, 404),
    "one-nested",
  );

  // {result:{success:false,error:...}} — the 404 shape Alex returns
  const notFoundShape = {
    result: { success: false, migration_run_id: "abc", error: "Migration Run was not found." },
  };
  assert.equal(
    extractComprehendError(notFoundShape, notFoundShape.result, 404),
    "Migration Run was not found.",
  );

  // {result:{result:{error}}}
  assert.equal(
    extractComprehendError({ result: { result: { error: "deep" } } }, {}, 500),
    "deep",
  );

  // No error string anywhere — falls back to status-labeled default
  assert.equal(
    extractComprehendError({ result: { success: true } }, {}, 503),
    "Comprehend start failed (503).",
  );

  console.log("  ✓ extractComprehendError handles every ServiceNow shape");
}

// ----- 4. EndpointError carries kind + status for downstream classification -----
{
  const { EndpointError, classifyEndpointStatus } = errors;
  const cold = new EndpointError("findings", 400, classifyEndpointStatus(400, false), "Missing run parameter");
  assert.equal(cold.kind, "unavailable");
  assert.equal(cold.status, 400);
  assert.equal(cold.resource, "findings");
  assert.ok(cold instanceof Error);

  const hot = new EndpointError("findings", 400, classifyEndpointStatus(400, true), "Bad payload");
  assert.equal(hot.kind, "client");

  const dead = new EndpointError("cis", 502, classifyEndpointStatus(502, true), "upstream broken");
  assert.equal(dead.kind, "backend");

  console.log("  ✓ EndpointError preserves kind/status/resource/detail");
}

// ----- 5. Comprehend route GET returns JSON 405 with allowed:["POST"] -----
{
  const routeSrc = fs.readFileSync(
    path.join(repoRoot, "app", "api", "cmdb", "comprehend", "route.ts"),
    "utf8",
  );
  assert.ok(/export async function GET\(/.test(routeSrc), "GET handler must be exported");
  assert.ok(/status:\s*405/.test(routeSrc), "GET must respond 405");
  assert.ok(/allowed:\s*\["POST"\]/.test(routeSrc), "GET must advertise allowed:['POST']");
  assert.ok(/allow:\s*"POST"/.test(routeSrc), "GET must set Allow header");
  console.log("  ✓ Comprehend GET route returns JSON 405 with allowed:['POST']");
}

// ----- 6. Cold load makes no run-scoped requests -----
{
  const dashSrc = fs.readFileSync(path.join(repoRoot, "app", "cmdb-dashboard.tsx"), "utf8");
  // The new loadData short-circuits with no runId — the early return must
  // happen before any Promise.allSettled(resourceNames.map(...)) fires.
  const loadDataBody = dashSrc.slice(dashSrc.indexOf("const loadData = useCallback"));
  const earlyReturnBlock = loadDataBody.slice(0, loadDataBody.indexOf("setApiState(\"connecting\")"));
  assert.ok(/if\s*\(!runId\)/.test(earlyReturnBlock), "loadData must guard on !runId");
  assert.ok(/return;/.test(earlyReturnBlock), "loadData must return before fetching");
  // No fetch to /api/cmdb/... inside the early-return branch
  assert.ok(!/fetch\(\s*["'`]\/api\/cmdb/.test(earlyReturnBlock), "no fetch in cold branch");
  // resourceState reads as unavailable, not connecting/error
  assert.ok(/unavailable/.test(earlyReturnBlock), "cold state must be unavailable");
  console.log("  ✓ loadData(\"\") makes no run-scoped requests");
}

// ----- 7. Unscoped CIs cannot trigger run actions (liveRunReady gate) -----
{
  const dashSrc = fs.readFileSync(path.join(repoRoot, "app", "cmdb-dashboard.tsx"), "utf8");
  const gate = /const\s+liveRunReady\s*=\s*Boolean\(activeRunId\s*&&\s*selectedCi\s*&&\s*apiState\s*!==\s*"demo"\)/;
  assert.ok(gate.test(dashSrc), "liveRunReady must require activeRunId + selectedCi + non-demo apiState");
  // Phase E exposes only Simulate and Approve; both are disabled without a live run.
  const buttonMatches = dashSrc.match(/disabled=\{!liveRunReady[^}]*\}/g) || [];
  assert.equal(buttonMatches.length, 2, `expected exactly 2 !liveRunReady-gated buttons, got ${buttonMatches.length}`);
  assert.equal(/runIreAction\("execute"|runIreAction\("verify"/.test(dashSrc), false,
    "Execute and Verify must remain server-owned status operations");
  // Cold load sets apiState to "demo" so liveRunReady is false even if a CI
  // happens to be selected from an earlier session
  assert.ok(/setApiState\("demo"\)/.test(dashSrc), "cold branch must force apiState='demo'");
  console.log("  ✓ Unscoped CIs cannot trigger run actions (liveRunReady stays false)");
}

// ----- 8. Comprehend error surfacing wires extractComprehendError -----
{
  const dashSrc = fs.readFileSync(path.join(repoRoot, "app", "cmdb-dashboard.tsx"), "utf8");
  assert.ok(
    /throw new Error\(extractComprehendError\(body,\s*payload,\s*response\.status\)\)/.test(dashSrc),
    "startComprehend must use extractComprehendError",
  );
  // The error is stored on analysisMessage which is already visibly rendered.
  assert.ok(/setAnalysisMessage\(error instanceof Error \? error\.message/.test(dashSrc),
    "analysisMessage must surface the extracted error");
  console.log("  ✓ Invalid Comprehend run surfaces backend error text");
}

// ----- 9. No cold-load console 400s (behavioral invariant) -----
{
  // Equivalent to running the app cold: loadData("") returns before any
  // fetch. This is enforced by test #6 above; if that passes there can be no
  // 400s at cold load. Also assert readEndpoint itself never fires with an
  // empty resource name or malformed URL.
  const dashSrc = fs.readFileSync(path.join(repoRoot, "app", "cmdb-dashboard.tsx"), "utf8");
  assert.ok(/const query = hasRun \? `\?run=\$\{encodeURIComponent\(runId\)\}` : "";/.test(dashSrc),
    "readEndpoint must build the query from hasRun");
  console.log("  ✓ Cold load path emits no run-scoped requests → no 400 flood");
}

fs.rmSync(path.dirname(cjsPath), { recursive: true, force: true });
void Module;
console.log("\nsmoke-frontend-errors: all assertions passed");
