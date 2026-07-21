// Smoke tests for the pluggable source-adapter layer. Every adapter is
// deterministic — same input → same output — so this suite exercises the
// two real adapters with fixtures that mirror the actual upstream
// schemas.

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const repoRoot = path.resolve(__dirname, "..");
const ts = require(path.join(repoRoot, "node_modules", "typescript"));

function loadTs(rel) {
  const src = fs.readFileSync(path.join(repoRoot, rel), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText;
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "keystone-adapters-"));
fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ type: "commonjs" }));
// Stub import-staging: source-adapters only uses CSV_PARSER_VERSION and
// types (erased at transpile). Provide a minimal runtime shim.
fs.writeFileSync(path.join(ws, "import-staging.js"), "module.exports = { CSV_PARSER_VERSION: 'keystone-browser-csv-v1' };\n");
const adapterSrc = loadTs("app/lib/cmdb/source-adapters.ts")
  .replace(/require\(["'`]\.\/import-staging["'`]\)/g, "require('./import-staging')");
fs.writeFileSync(path.join(ws, "source-adapters.js"), adapterSrc);
const adapters = require(path.join(ws, "source-adapters.js"));

// ---------- Fixtures ----------
const AWS_FIXTURE = {
  syncToken: "1700000000",
  createDate: "2026-07-21-10-00-00",
  prefixes: [
    { ip_prefix: "3.5.140.0/22",   region: "ap-northeast-2", service: "AMAZON",  network_border_group: "ap-northeast-2" },
    { ip_prefix: "13.107.6.152/31", region: "GLOBAL",         service: "S3",      network_border_group: "GLOBAL" },
  ],
};

const STATUSPAGE_FIXTURE = {
  page: { id: "abc", name: "Cloudflare" },
  components: [
    { id: "cf-www",      name: "Website",              status: "operational",           description: "cloudflare.com website", group_id: "cf-web-services", group: "Web Services" },
    { id: "cf-api",      name: "API",                  status: "operational",           description: "REST API",               group_id: "cf-web-services", group: "Web Services" },
    { id: "cf-web-services", name: "Web Services",     status: "operational",           description: "Web-tier services",      group_id: null,              group: null },
    { id: "cf-dangling", name: "Dangling child",        status: "degraded_performance", description: "child of unstaged group", group_id: "not-in-payload",  group: "Ghost" },
  ],
};

// ---------- 1. Registry surface ----------
{
  assert.ok(Array.isArray(adapters.sourceAdapters), "sourceAdapters export must be an array");
  assert.ok(adapters.sourceAdapters.length >= 3, "expected passthrough + aws + statuspage adapters");
  const ids = adapters.sourceAdapters.map(a => a.id);
  assert.deepEqual(ids.sort(), ["aws-ip-ranges", "passthrough", "statuspage-components"]);
  assert.equal(adapters.getSourceAdapter("aws-ip-ranges").label, "AWS IP Ranges");
  assert.throws(() => adapters.getSourceAdapter("does-not-exist"), /Unknown source adapter/);
  console.log("  ✓ Registry surface (3 adapters, lookup + guard)");
}

// ---------- 2. Detection ----------
{
  assert.equal(adapters.recommendAdapter(AWS_FIXTURE).id, "aws-ip-ranges");
  assert.equal(adapters.recommendAdapter(STATUSPAGE_FIXTURE).id, "statuspage-components");
  assert.equal(adapters.recommendAdapter({ arbitrary: "thing" }).id, "passthrough");
  assert.equal(adapters.recommendAdapter(null).id, "passthrough");
  assert.equal(adapters.recommendAdapter("just a string").id, "passthrough");
  // Statuspage also detects a bare array with group_id shape.
  const bareArray = [{ id: "x", name: "y", status: "operational", group_id: "g" }];
  assert.equal(adapters.recommendAdapter(bareArray).id, "statuspage-components");
  console.log("  ✓ recommendAdapter picks the strongest match, falls back to passthrough");
}

// ---------- 3. AWS transform ----------
{
  const aws = adapters.getSourceAdapter("aws-ip-ranges");
  const out = aws.transform(AWS_FIXTURE, { sourceName: "AWS IP Ranges test" });
  assert.equal(out.cis.length, 2, "one CI per prefix");
  assert.equal(out.relationships.length, 0, "AWS adapter emits no relationships");
  const ci = out.cis[0];
  assert.equal(ci.className, "cmdb_ci_ip_network");
  assert.equal(ci.ci_class, "cmdb_ci_ip_network");
  assert.equal(ci.ip_address, "3.5.140.0/22");
  assert.equal(ci.environment, "ap-northeast-2");
  assert.equal(ci.support_group, "AMAZON");
  assert.equal(ci.source, "AWS");
  assert.ok(ci.id && ci.source_identifier, "id + source_identifier required by StagingCiDraft");
  assert.equal(ci.id, ci.source_identifier, "id and source_identifier must match");
  assert.ok(/aws-prefix-amazon-ap-northeast-2/.test(ci.source_native_key));
  assert.ok(ci.parser_version.includes("aws-ip-ranges"), "parser_version encodes the adapter");
  // Same input → same output. Determinism.
  const again = aws.transform(AWS_FIXTURE, { sourceName: "AWS IP Ranges test" });
  assert.deepEqual(again, out, "transform must be deterministic");
  // Bad shape → SourceAdapterError.
  assert.throws(() => aws.transform({ nope: 1 }, { sourceName: "x" }), /prefixes/i);
  console.log(`  ✓ AWS adapter → ${out.cis.length} cmdb_ci_ip_network CIs, 0 relationships, deterministic`);
}

// ---------- 4. Statuspage transform ----------
{
  const sp = adapters.getSourceAdapter("statuspage-components");
  const out = sp.transform(STATUSPAGE_FIXTURE, { sourceName: "Cloudflare status" });
  assert.equal(out.cis.length, 4, "one CI per component (including dangling child)");
  assert.equal(out.cis[0].className, "cmdb_ci_service");
  assert.equal(out.cis[0].environment, "operational");
  // Two children reference cf-web-services which IS staged; one references
  // a group that is NOT in the payload. Only the two valid ones become
  // relationships — dangling endpoints are dropped.
  assert.equal(out.relationships.length, 2, "only relationships with both endpoints staged");
  const rel = out.relationships[0];
  assert.equal(rel.source, "cf-web-services");
  assert.equal(rel.target, "cf-www");
  assert.equal(rel.source_relationship_type, "group_member");
  // Bare-array shape works too.
  const bare = sp.transform([
    { id: "a", name: "A", status: "operational", group_id: "g" },
    { id: "g", name: "Group", status: "operational" },
  ], { sourceName: "test" });
  assert.equal(bare.cis.length, 2);
  assert.equal(bare.relationships.length, 1);
  console.log(`  ✓ Statuspage adapter → ${out.cis.length} cmdb_ci_service CIs, ${out.relationships.length} relationships, dangling endpoints dropped`);
}

// ---------- 5. Passthrough does not transform ----------
{
  const pt = adapters.getSourceAdapter("passthrough");
  assert.throws(() => pt.transform({ anything: 1 }, { sourceName: "x" }), /does not transform/i);
  console.log("  ✓ Passthrough adapter refuses to transform (caller sends raw payload)");
}

// ---------- 6. Real Fastly-shape and AWS URLs would match ----------
{
  // Simulated Fastly summary (statuspage-format subset)
  const fastly = {
    page: { id: "fastly" },
    components: [{ id: "f1", name: "API and Web Interface", status: "operational" }],
  };
  assert.equal(adapters.recommendAdapter(fastly).id, "statuspage-components", "Fastly summary uses Statuspage schema");
  // AWS
  assert.equal(adapters.recommendAdapter(AWS_FIXTURE).id, "aws-ip-ranges");
  console.log("  ✓ Real upstream schemas route to the correct adapter");
}

fs.rmSync(ws, { recursive: true, force: true });
console.log("\nsmoke-source-adapters: all assertions passed");
