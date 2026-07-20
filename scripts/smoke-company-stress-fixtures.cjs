const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const outputRoot = path.resolve(root, process.argv[2] || "outputs/company-stress-fixtures");
const catalogPath = path.join(outputRoot, "catalog.json");

if (!fs.existsSync(catalogPath)) {
  const generated = spawnSync(process.execPath, [
    path.join(root, "scripts/generate-company-stress-fixtures.mjs"),
    "--output", outputRoot,
    "--tiers", "smoke,workflow",
  ], { cwd: root, encoding: "utf8" });
  if (generated.status !== 0) throw new Error(generated.stderr || generated.stdout || "Stress fixture generation failed");
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function resolveTypeScript(request, parent, isMain, options) {
  if ((request.startsWith("./") || request.startsWith("../")) && parent?.filename) {
    const candidate = path.resolve(path.dirname(parent.filename), request);
    if (!path.extname(candidate) && fs.existsSync(`${candidate}.ts`)) return `${candidate}.ts`;
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

require.extensions[".ts"] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

const { buildStructuredStagingPayloadFromText } = require("../app/lib/cmdb/import-staging.ts");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const gatewayLimit = 10 * 1024 * 1024;
const results = [];
const outputRelative = path.relative(root, outputRoot);
assert(!outputRelative.startsWith(".."), "Stress fixture output must remain inside the repository");
assert(outputRelative === "outputs\\company-stress-fixtures" || outputRelative === "outputs/company-stress-fixtures", "Default generated output must remain under ignored outputs/");

const catalogKeys = new Set(catalog.files.map(entry => `${entry.company_key}:${entry.tier}`));
for (const company of catalog.companies) {
  assert(catalogKeys.has(`${company}:workflow`), `Missing workflow tier for ${company}`);
}

for (const entry of catalog.files) {
  const dataPath = path.join(outputRoot, entry.data_file);
  const expectedPath = path.join(outputRoot, entry.expected_file);
  const text = fs.readFileSync(dataPath, "utf8");
  const source = JSON.parse(text);
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const started = performance.now();
  const payload = buildStructuredStagingPayloadFromText(text, "json", `${entry.company_key}-${entry.tier}`);
  const parseMs = Math.round((performance.now() - started) * 10) / 10;
  assert(payload, `No staging payload for ${entry.data_file}`);
  assert.equal(payload.cis.length, entry.cis, `CI count mismatch for ${entry.data_file}`);
  assert.equal(payload.relationships.length, entry.relationships, `Relationship count mismatch for ${entry.data_file}`);
  assert.equal(source.dataset.company, entry.company, `Mixed company metadata in ${entry.data_file}`);
  assert.equal(expected.company, entry.company, `Golden truth company mismatch in ${entry.expected_file}`);
  assert.equal(expected.records.length, payload.cis.length, `Golden truth row count mismatch in ${entry.expected_file}`);
  assert(payload.cis.every(ci => ci.source_name === `${entry.company_key}-${entry.tier}`), `Mixed source names in ${entry.data_file}`);
  if (entry.tier === "workflow") assert.equal(entry.cis, 500, `Workflow tier must stay at 500 CIs for ${entry.data_file}`);
  assert.equal(expected.counts.mutations.class_alias, Math.round(entry.cis * 0.05), `Missing deterministic class-alias retry group in ${entry.expected_file}`);
  assert(expected.counts.mutations.missing_identifier > 0, `Missing unsupported identity blocker in ${entry.expected_file}`);
  assert(expected.counts.mutations.duplicate_exact > 0, `Missing ambiguous duplicate identity blocker in ${entry.expected_file}`);
  assert(expected.counts.gates.auto > 0 && expected.counts.gates.review > 0 && expected.counts.gates.error > 0, `Expected mixed gate readiness in ${entry.expected_file}`);
  assert(expected.counts.findings.data_quality > expected.counts.findings.class_mismatch, `Health opportunities should rank broad quality before class alias in ${entry.expected_file}`);
  assert(expected.counts.ire_operations.INSERT_OR_UPDATE > 0 && expected.counts.ire_operations.NO_IRE > 0, `Expected mixed relationship/IRE readiness in ${entry.expected_file}`);

  const gatewayBodyBytes = Buffer.byteLength(JSON.stringify({
    sourceType: "file",
    sourceName: `${entry.company_key}-${entry.tier}`,
    runName: `STRESS-${entry.company_key.toUpperCase()}-${entry.tier.toUpperCase()}`,
    sourceFileName: path.basename(dataPath),
    format: "json",
    payload,
  }));
  if (entry.upload_intended) assert(gatewayBodyBytes <= gatewayLimit, `${entry.data_file} expands beyond the 10 MB gateway limit`);
  results.push({
    company: entry.company_key,
    tier: entry.tier,
    cis: payload.cis.length,
    relationships: payload.relationships.length,
    parse_ms: parseMs,
    gateway_body_bytes: gatewayBodyBytes,
    upload_safe: gatewayBodyBytes <= gatewayLimit,
  });
}

console.log(JSON.stringify({ output: outputRoot, validated: results.length, results }, null, 2));
