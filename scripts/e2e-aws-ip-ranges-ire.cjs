// End-to-end: live AWS IP Ranges → adapter → ServiceNow /import (quarantine) → IRE /simulate.
//
// Safety:
//   - Samples a small number of prefixes (default 5) so we don't spray 10k rows.
//   - Uses target=staging, mode=quarantine, directCmdbWrite=false on import.
//   - IRE simulate is a dry-run reconcile against the staged draft; no CMDB write.
//
// Env (reads from .env.local automatically):
//   CMDB_API_BASE_URL   required
//   CMDB_API_TOKEN or CMDB_API_USERNAME + CMDB_API_PASSWORD
//   E2E_SAMPLE_SIZE     optional; default 5
//
// Run: node scripts/e2e-aws-ip-ranges-ire.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "..");
const ts = require(path.join(repoRoot, "node_modules", "typescript"));

// ---- .env.local loader (no external deps) --------------------------------
(function loadDotenv() {
  const file = path.join(repoRoot, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const FEED_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json";
const SAMPLE_SIZE = Number(process.env.E2E_SAMPLE_SIZE || 5);
const BASE = (process.env.CMDB_API_BASE_URL || "").replace(/\/+$/, "");
assert.ok(BASE, "CMDB_API_BASE_URL is required (in .env.local)");

function authHeader() {
  if (process.env.CMDB_API_TOKEN) return `Bearer ${process.env.CMDB_API_TOKEN}`;
  if (process.env.CMDB_API_USERNAME && process.env.CMDB_API_PASSWORD) {
    const raw = `${process.env.CMDB_API_USERNAME}:${process.env.CMDB_API_PASSWORD}`;
    return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }
  throw new Error("Set CMDB_API_TOKEN or CMDB_API_USERNAME+CMDB_API_PASSWORD");
}

function loadAdapters() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "keystone-e2e-ire-"));
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ type: "commonjs" }));
  fs.writeFileSync(
    path.join(ws, "import-staging.js"),
    "module.exports = { CSV_PARSER_VERSION: 'keystone-browser-csv-v1' };\n",
  );
  const src = fs.readFileSync(path.join(repoRoot, "app/lib/cmdb/source-adapters.ts"), "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText.replace(/require\(["'`]\.\/import-staging["'`]\)/g, "require('./import-staging')");
  fs.writeFileSync(path.join(ws, "source-adapters.js"), out);
  return { adapters: require(path.join(ws, "source-adapters.js")), ws };
}

async function readJson(response) {
  const text = await response.text();
  try { return { text, json: JSON.parse(text) }; }
  catch { return { text, json: null }; }
}

// Walk the ServiceNow response envelope for the first 32-hex sys_id-shaped
// value under any of the well-known keys. Returns {runId, stagedCiId} where
// possible; either may be null.
function extractIds(json) {
  if (!json) return { runId: null, stagedCiId: null };
  const hex32 = /^[0-9a-f]{32}$/;
  let runId = null;
  let stagedCiId = null;
  const runKeys = new Set(["migration_run_id", "migrationRunId", "runId", "run_id", "migration_run"]);
  const ciKeys = new Set(["staged_ci_id", "stagedCiId", "sys_id", "id"]);
  function visit(node, keyHint) {
    if (!node) return;
    if (typeof node === "string") {
      if (hex32.test(node.toLowerCase())) {
        if (!runId && keyHint && runKeys.has(keyHint)) runId = node.toLowerCase();
        else if (!stagedCiId && keyHint && ciKeys.has(keyHint)) stagedCiId = node.toLowerCase();
      }
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) visit(item, keyHint); return; }
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object" && "value" in value && typeof value.value === "string") {
        visit(value.value, key);
      } else {
        visit(value, key);
      }
    }
  }
  visit(json, null);
  return { runId, stagedCiId };
}

async function main() {
  console.log(`E2E: AWS IP Ranges → /import (quarantine) → /ire/simulate`);
  console.log(`  target        : ${BASE}`);
  console.log(`  sample size   : ${SAMPLE_SIZE} prefixes`);

  const { adapters, ws } = loadAdapters();
  try {
    // 1. Fetch live feed
    const t0 = Date.now();
    const feedRes = await fetch(FEED_URL);
    assert.equal(feedRes.status, 200);
    const feed = await feedRes.json();
    console.log(`  ✓ fetched ${feed.prefixes.length} prefixes in ${Date.now() - t0}ms`);

    // 2. Sample + adapter transform
    const sampled = { ...feed, prefixes: feed.prefixes.slice(0, SAMPLE_SIZE) };
    const aws = adapters.getSourceAdapter("aws-ip-ranges");
    const staging = aws.transform(sampled, { sourceName: "E2E AWS IP Ranges" });
    console.log(`  ✓ adapter produced ${staging.cis.length} CIs`);

    // 3. POST to ServiceNow /import
    const runName = `e2e-aws-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const importBody = {
      sourceType: "aws-ip-ranges",
      sourceName: "E2E AWS IP Ranges",
      runName,
      sourceUrl: FEED_URL,
      sourceFileName: "ip-ranges.json",
      format: "json",
      payload: staging,
      target: "staging",
      mode: "quarantine",
      directCmdbWrite: false,
    };
    const importUrl = `${BASE}/import`;
    console.log(`  → POST ${importUrl}   (runName=${runName})`);
    const importRes = await fetch(importUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: authHeader(),
      },
      body: JSON.stringify(importBody),
    });
    const importParsed = await readJson(importRes);
    console.log(`    ← HTTP ${importRes.status}`);
    if (importRes.status >= 400) {
      console.error("    body:", importParsed.text.slice(0, 800));
      throw new Error(`import failed with HTTP ${importRes.status}`);
    }

    const ids = extractIds(importParsed.json);
    if (!ids.runId) {
      console.log("    import response preview:", importParsed.text.slice(0, 800));
      throw new Error("import response did not include a migration run id");
    }
    console.log(`    migration_run_id: ${ids.runId}`);

    // 3b. Fetch staged CIs for this run to grab a staged_ci_id.
    const cisUrl = `${BASE}/cis?migration_run_id=${encodeURIComponent(ids.runId)}`;
    console.log(`  → GET ${cisUrl}`);
    const cisRes = await fetch(cisUrl, {
      headers: { accept: "application/json", authorization: authHeader() },
    });
    const cisParsed = await readJson(cisRes);
    console.log(`    ← HTTP ${cisRes.status}`);
    if (cisRes.status >= 400) {
      console.error("    body:", cisParsed.text.slice(0, 800));
      throw new Error(`/cis lookup failed with HTTP ${cisRes.status}`);
    }
    const rows = (cisParsed.json && cisParsed.json.result && cisParsed.json.result.result) || [];
    assert.ok(Array.isArray(rows) && rows.length > 0, "expected at least one staged CI for this run");
    const stagedCi = rows.find(r => typeof r.sys_id === "string" && /^[0-9a-f]{32}$/i.test(r.sys_id));
    assert.ok(stagedCi, "no row had a 32-hex sys_id");
    ids.stagedCiId = stagedCi.sys_id.toLowerCase();
    console.log(`    staged_ci_id    : ${ids.stagedCiId}  (${stagedCi.display_name} / ${stagedCi.class})`);

    // 3c. Poll /run until the pipeline (Comprehend → Mara → Prioritize) advances
    //     out of "analyzing" — simulate is gated by run state, so calling it too
    //     early yields RUN_STATE_INVALID.
    const runUrl = `${BASE}/run?run=${encodeURIComponent(ids.runId)}`;
    const POLL_MAX_MS = 90_000, POLL_INTERVAL_MS = 3_000;
    const pollT0 = Date.now();
    let runState = "analyzing";
    while (Date.now() - pollT0 < POLL_MAX_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const rr = await fetch(runUrl, { headers: { accept: "application/json", authorization: authHeader() } });
      const rp = await readJson(rr);
      const payload = rp.json && rp.json.result && rp.json.result.result;
      runState = (payload && payload.state) || runState;
      process.stdout.write(`    run state: ${runState} (${Math.round((Date.now() - pollT0)/1000)}s)\n`);
      if (runState !== "analyzing" && runState !== "importing" && runState !== "queued") break;
    }
    if (runState === "analyzing") {
      throw new Error(`Run stuck in state=${runState} after ${POLL_MAX_MS}ms — pipeline did not advance`);
    }

    // 4. POST to /ire/simulate
    const correlationId = `e2e-${crypto.randomBytes(6).toString("hex")}`;
    const idempotencyKey = `e2e-idem-${crypto.randomBytes(6).toString("hex")}`;
    const simulateBody = {
      migration_run_id: ids.runId,
      staged_ci_id: ids.stagedCiId,
      correlation_id: correlationId,
      idempotency_key: idempotencyKey,
    };
    const simulateUrl = `${BASE}/ire/simulate`;
    console.log(`  → POST ${simulateUrl}`);
    console.log(`    body:`, simulateBody);
    const simRes = await fetch(simulateUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: authHeader(),
      },
      body: JSON.stringify(simulateBody),
    });
    const simParsed = await readJson(simRes);
    console.log(`    ← HTTP ${simRes.status}`);
    console.log(`    body:`, simParsed.text.slice(0, 1200));
    if (simRes.status >= 400) throw new Error(`simulate failed with HTTP ${simRes.status}`);

    console.log("\ne2e-aws-ip-ranges-ire: import + IRE simulate completed");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error("\ne2e-aws-ip-ranges-ire FAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
});
