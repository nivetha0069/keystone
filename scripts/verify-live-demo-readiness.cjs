const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

registerTypeScript();
const {
  normalizeComprehendCis,
  normalizeComprehendTimeline,
  normalizeRemediationFindings,
  normalizeRemediationReviews,
} = require("../app/lib/cmdb/comprehend-adapter.ts");
const { deriveRemediationWorkQueue } = require("../app/lib/cmdb/work-queue.ts");
const { evaluateLiveDemoReadiness, readinessSignature } = require("../app/lib/cmdb/terminal-outcomes.ts");

const options = parseArgs(process.argv.slice(2));

main().catch(error => {
  console.error(JSON.stringify({ ready: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

async function main() {
  const first = await refresh();
  if (options.intervalMs) await new Promise(resolve => setTimeout(resolve, options.intervalMs));
  const second = await refresh();
  const stable = readinessSignature(first) === readinessSignature(second);
  const result = {
    ready: first.ready && second.ready && stable,
    stable,
    migration_run_id: options.run,
    expected_total: first.expectedTotal,
    expected_operations: options.expectedOperations,
    first,
    second,
    ...(stable ? {} : { stability_failure: "The two GET-only refreshes returned different terminal outcome or binding sets." }),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}

async function refresh() {
  const [cisPayload, timelinePayload, findingsPayload, reviewsPayload] = await Promise.all(
    ["cis", "timeline", "findings", "reviews"].map(fetchResource),
  );
  const cis = normalizeComprehendCis(cisPayload);
  const timeline = normalizeComprehendTimeline(timelinePayload);
  const findings = normalizeRemediationFindings(findingsPayload);
  const reviews = normalizeRemediationReviews(reviewsPayload);
  const queue = deriveRemediationWorkQueue({ cis, timeline, findings, reviews });
  return evaluateLiveDemoReadiness({
    queue,
    timeline,
    expectedTotal: options.expectedTotal ?? queue.items.length,
    expectedOperations: options.expectedOperations,
  });
}

async function fetchResource(resource) {
  const url = new URL(`${options.base}/${resource}`);
  url.searchParams.set("run", options.run);
  const response = await fetch(url, { headers: authorizationHeaders(), cache: "no-store" });
  const text = await response.text();
  if (!response.ok) throw new Error(`${resource} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new Error(`${resource} returned invalid JSON.`); }
}

function parseArgs(args) {
  const value = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const run = String(value("--run") || process.env.CMDB_LIVE_DEMO_RUN_ID || "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(run)) throw new Error("--run must be a canonical 32-character migration run sys_id.");
  const base = String(value("--base") || process.env.CMDB_API_BASE_URL || "http://127.0.0.1:3000/api/cmdb").replace(/\/$/, "");
  const rawExpectedTotal = value("--expected-total");
  const expectedTotal = rawExpectedTotal === undefined ? undefined : Number(rawExpectedTotal);
  if (expectedTotal !== undefined && (!Number.isInteger(expectedTotal) || expectedTotal < 1)) throw new Error("--expected-total must be a positive integer.");
  const intervalMs = Number(value("--interval-ms") || 1500);
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60000) throw new Error("--interval-ms must be between 0 and 60000.");
  return { run, base, expectedTotal, intervalMs, expectedOperations: parseExpectedOperations(value("--expect")) };
}

function parseExpectedOperations(raw) {
  if (!raw) return undefined;
  const result = {};
  for (const entry of String(raw).split(",")) {
    const match = entry.trim().match(/^(INSERT|UPDATE|NO_CHANGE)=(\d+)$/i);
    if (!match) throw new Error("--expect must use INSERT=number,UPDATE=number,NO_CHANGE=number syntax.");
    result[match[1].toUpperCase()] = Number(match[2]);
  }
  return result;
}

function authorizationHeaders() {
  if (process.env.CMDB_API_TOKEN) return { accept: "application/json", authorization: `Bearer ${process.env.CMDB_API_TOKEN}` };
  if (process.env.CMDB_API_USERNAME && process.env.CMDB_API_PASSWORD) {
    return { accept: "application/json", authorization: `Basic ${Buffer.from(`${process.env.CMDB_API_USERNAME}:${process.env.CMDB_API_PASSWORD}`).toString("base64")}` };
  }
  return { accept: "application/json" };
}

function registerTypeScript() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolveTypeScript(request, parent, isMain, options) {
    if ((request.startsWith("./") || request.startsWith("../")) && parent?.filename) {
      const candidate = path.resolve(path.dirname(parent.filename), request);
      if (!path.extname(candidate) && fs.existsSync(`${candidate}.ts`)) return `${candidate}.ts`;
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
  require.extensions[".ts"] = function loadTypeScript(module, filename) {
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
    }).outputText;
    module._compile(output, filename);
  };
}
