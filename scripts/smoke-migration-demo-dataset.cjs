const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
registerTypeScript();
const { materializeMigrationDemoDataset } = require("../app/lib/cmdb/migration-demo-dataset.ts");
const { buildStructuredStagingPayloadFromText } = require("../app/lib/cmdb/import-staging.ts");

const source = JSON.parse(fs.readFileSync(path.join(root, "outputs/company-stress-fixtures/microsoft/microsoft-workflow.json"), "utf8"));
const first = materializeMigrationDemoDataset(source, {
  namespace: "microsoft-demo-a",
  className: "cmdb_ci_linux_server",
  count: 500,
  generatedAt: "2026-07-22T18:00:00.000Z",
});
const second = materializeMigrationDemoDataset(source, {
  namespace: "microsoft-demo-b",
  className: "cmdb_ci_server",
  count: 500,
  generatedAt: "2026-07-22T18:00:00.000Z",
});

assert.equal(first.dataset.cis.length, 500);
assert.equal(first.manifest.counts.unique_source_identifiers, 500);
assert.equal(new Set(first.dataset.cis.map(ci => ci.id)).size, 500);
assert.equal(new Set(first.dataset.cis.map(ci => ci.serial_number)).size, 500);
assert.equal(new Set(first.dataset.cis.map(ci => ci.fqdn)).size, 500);
assert.equal(new Set(first.dataset.cis.map(ci => ci.ip_address)).size, 500);
assert.ok(first.dataset.cis.every(ci => ci.className === "cmdb_ci_linux_server"));
assert.ok(first.dataset.cis.every(ci => ci.id && ci.name && ci.serial_number && ci.support_group && ci.owned_by));
assert.ok(first.dataset.relationships.every(rel => first.dataset.cis.some(ci => ci.id === rel.source) && first.dataset.cis.some(ci => ci.id === rel.target)));
assert.equal(first.manifest.safety.operation_is_not_predeclared, true);
assert.equal(first.manifest.safety.exact_packet_hash_authorization_required, true);

const firstIds = new Set(first.dataset.cis.flatMap(ci => [ci.id, ci.name, ci.serial_number, ci.fqdn]));
assert.ok(second.dataset.cis.every(ci => !firstIds.has(ci.id) && !firstIds.has(ci.name) && !firstIds.has(ci.serial_number) && !firstIds.has(ci.fqdn)), "fresh namespaces do not reuse CI identities");
assert.ok(second.dataset.cis.every(ci => ci.className === "cmdb_ci_server"), "the requested canonical class is retained for ServiceNow validation");

const structured = buildStructuredStagingPayloadFromText(JSON.stringify(first.dataset), "json", "microsoft-demo-a");
assert.equal(structured.cis.length, 500);
assert.equal(structured.relationships.length, first.dataset.relationships.length);
assert.equal(new Set(structured.cis.map(ci => ci.source_identifier)).size, 500);
assert.throws(() => materializeMigrationDemoDataset(source, { namespace: "x", count: 1 }), /namespace/);
assert.throws(() => materializeMigrationDemoDataset(source, { namespace: "valid-demo", className: "Linux Srv", count: 1 }), /canonical/);
assert.throws(() => materializeMigrationDemoDataset(source, { namespace: "valid-demo", count: 501 }), /source contains only 500/);

console.log("migration demo dataset smoke passed");

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
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename,
    }).outputText;
    module._compile(output, filename);
  };
}
