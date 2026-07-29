// End-to-end test against the live AWS IP Ranges feed.
//
//   1. Fetch https://ip-ranges.amazonaws.com/ip-ranges.json
//   2. Route it through recommendAdapter → must pick aws-ip-ranges
//   3. Transform via the adapter and validate every emitted StagingCiDraft
//      is well-formed and consistent with the upstream prefix.
//   4. Re-transform to prove determinism on a real-world payload (not
//      just the tiny fixture used by smoke-source-adapters).
//
// Run: node scripts/e2e-aws-ip-ranges.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "..");
const ts = require(path.join(repoRoot, "node_modules", "typescript"));

const FEED_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json";
const FETCH_TIMEOUT_MS = 30_000;

function loadAdapters() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "keystone-e2e-aws-"));
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ type: "commonjs" }));
  fs.writeFileSync(
    path.join(ws, "import-staging.js"),
    "module.exports = { CSV_PARSER_VERSION: 'keystone-browser-csv-v1' };\n",
  );
  const src = fs.readFileSync(path.join(repoRoot, "app/lib/cmdb/source-adapters.ts"), "utf8");
  const compiled = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText.replace(/require\(["'`]\.\/import-staging["'`]\)/g, "require('./import-staging')");
  fs.writeFileSync(path.join(ws, "source-adapters.js"), compiled);
  return { adapters: require(path.join(ws, "source-adapters.js")), ws };
}

async function fetchFeed() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const t0 = Date.now();
    const res = await fetch(FEED_URL, { signal: controller.signal });
    assert.equal(res.status, 200, `expected HTTP 200, got ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    assert.match(contentType, /json/i, `expected JSON content-type, got "${contentType}"`);
    const json = await res.json();
    console.log(`  ✓ Fetched ${FEED_URL} in ${Date.now() - t0}ms`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function validateFeedShape(feed) {
  assert.ok(feed && typeof feed === "object", "feed must be an object");
  assert.equal(typeof feed.syncToken, "string", "syncToken must be a string");
  assert.equal(typeof feed.createDate, "string", "createDate must be a string");
  assert.ok(Array.isArray(feed.prefixes), "prefixes must be an array");
  assert.ok(feed.prefixes.length > 1000, `expected > 1000 prefixes, got ${feed.prefixes.length}`);
  const first = feed.prefixes[0];
  for (const key of ["ip_prefix", "region", "service", "network_border_group"]) {
    assert.ok(key in first, `expected key "${key}" on first prefix`);
  }
  console.log(`  ✓ Feed shape valid — syncToken=${feed.syncToken}, prefixes=${feed.prefixes.length}`);
}

function validateAdapterOutput(feed, adapters) {
  const chosen = adapters.recommendAdapter(feed);
  assert.equal(chosen.id, "aws-ip-ranges", `recommender picked ${chosen.id}`);
  console.log("  ✓ recommendAdapter selected aws-ip-ranges");

  const aws = adapters.getSourceAdapter("aws-ip-ranges");
  const t0 = Date.now();
  const out = aws.transform(feed, { sourceName: "AWS IP Ranges (live)" });
  const elapsed = Date.now() - t0;

  assert.equal(out.cis.length, feed.prefixes.length, "one CI per prefix");
  assert.equal(out.relationships.length, 0, "AWS adapter emits no relationships");
  assert.ok(out.parserVersion.includes("aws-ip-ranges"), "parserVersion tagged with adapter");
  console.log(`  ✓ transform → ${out.cis.length} CIs in ${elapsed}ms`);

  // Sample-invariant checks on every CI: shape is uniform.
  const seenNativeKeys = new Set();
  const classCounts = new Map();
  const regionCounts = new Map();
  const serviceCounts = new Map();
  for (let i = 0; i < out.cis.length; i++) {
    const ci = out.cis[i];
    const prefix = feed.prefixes[i];
    assert.equal(ci.className, "cmdb_ci_ip_network");
    assert.equal(ci.ci_class, "cmdb_ci_ip_network");
    assert.equal(ci.source, "AWS");
    assert.equal(ci.ip_address, prefix.ip_prefix, `ip_address must match prefix at row ${i}`);
    assert.equal(ci.environment, prefix.region, `environment must equal region at row ${i}`);
    assert.equal(ci.support_group, prefix.service, `support_group must equal service at row ${i}`);
    assert.equal(ci.id, ci.source_identifier, "id and source_identifier must match");
    assert.equal(ci.source_row_number, i + 1, "row number is 1-based");
    assert.ok(ci.parser_version.includes("aws-ip-ranges"), "per-CI parser_version tagged");
    assert.ok(ci.source_native_key.startsWith("aws-prefix-"), "native key uses adapter prefix");
    seenNativeKeys.add(ci.source_native_key);
    classCounts.set(ci.className, (classCounts.get(ci.className) || 0) + 1);
    regionCounts.set(ci.environment, (regionCounts.get(ci.environment) || 0) + 1);
    serviceCounts.set(ci.support_group, (serviceCounts.get(ci.support_group) || 0) + 1);
  }
  console.log(`  ✓ All ${out.cis.length} CIs are shape-valid and consistent with upstream prefix`);
  console.log(`      distinct native keys : ${seenNativeKeys.size}`);
  console.log(`      distinct regions     : ${regionCounts.size}`);
  console.log(`      distinct services    : ${serviceCounts.size}`);

  // Top-5 services and regions — sanity signal, not asserted.
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${k}=${v}`).join(", ");
  console.log(`      top services         : ${top(serviceCounts, 5)}`);
  console.log(`      top regions          : ${top(regionCounts, 5)}`);

  // Determinism on a real payload.
  const again = aws.transform(feed, { sourceName: "AWS IP Ranges (live)" });
  assert.equal(again.cis.length, out.cis.length);
  assert.deepEqual(again.cis[0], out.cis[0], "first CI must be identical across calls");
  assert.deepEqual(again.cis[out.cis.length - 1], out.cis[out.cis.length - 1], "last CI must be identical across calls");
  console.log("  ✓ Transform is deterministic on live payload");

  return out;
}

(async () => {
  console.log(`E2E: AWS IP Ranges → keystone source adapter`);
  const { adapters, ws } = loadAdapters();
  try {
    const feed = await fetchFeed();
    validateFeedShape(feed);
    validateAdapterOutput(feed, adapters);
    console.log("\ne2e-aws-ip-ranges: all assertions passed");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
})().catch(err => {
  console.error("\ne2e-aws-ip-ranges FAILED:", err && err.stack ? err.stack : err);
  process.exit(1);
});
