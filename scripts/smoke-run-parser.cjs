// Regression coverage for migration-run extraction from import responses.
//
// The parser may only accept explicitly run-scoped fields. A staged CI (or any
// other nested record) carrying a valid-looking 32-char sys_id must never be
// promoted to a migration-run id — that exact confusion previously sent a
// staged-CI sys_id to /comprehend and broke the whole run handoff.

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

const { importedRunFromResponse, isSysId } = require("../app/lib/cmdb/run-id.ts");

const runId = "5d69233b2b420b1060aefba6b891bfeb";
const stagedCiId = "9569233b2b420b1060aefba6b891bfed";

function idOf(response) {
  return importedRunFromResponse(response, "fallback").id;
}

// --- Must resolve the run id from run-scoped fields ---

assert.equal(idOf({ migration_run_id: runId }), runId, "top-level migration_run_id");
assert.equal(idOf({ result: { migration_run_id: runId } }), runId, "result envelope");
assert.equal(idOf({ result: [{ migration_run_id: runId }] }), runId, "array inside result");
assert.equal(idOf({ migration_run: runId }), runId, "migration_run string");
assert.equal(idOf({ run: runId }), runId, "run string");
assert.equal(idOf({ migration_run: { sys_id: runId, number: "DMR0001033" } }), runId, "migration_run object");
assert.equal(idOf({ result: { data: { run: { sys_id: runId } } } }), runId, "nested envelopes with run object");
assert.equal(idOf({ run_id: runId }), runId, "run_id");
assert.equal(idOf({ runId: runId }), runId, "runId");
assert.equal(idOf({ result: { migration_run: { value: runId, link: "https://x/api/y" } } }), runId, "reference-field serialization");

// --- The staged-CI trap: the run id must win, the CI id must never leak ---

assert.equal(
  idOf({ result: { migration_run_id: runId, cis: [{ sys_id: stagedCiId }] } }),
  runId,
  "run id beats sibling staged-CI sys_id",
);
assert.equal(
  idOf({ result: { cis: [{ sys_id: stagedCiId }] } }),
  "",
  "staged CI alone yields no run id",
);
assert.equal(
  idOf({ result: [{ sys_id: stagedCiId, number: "DCI0001330" }] }),
  "",
  "bare record with generic sys_id yields no run id",
);
assert.equal(
  idOf({ result: { sys_id: stagedCiId, id: stagedCiId, staged_ci: { sys_id: stagedCiId } } }),
  "",
  "generic sys_id/id keys are never accepted",
);

// --- Reject values that are not real sys_ids ---

assert.equal(idOf({ migration_run_id: "DMR0001033" }), "", "run number is not a sys_id");
assert.equal(idOf({ migration_run_id: "abc123" }), "", "short id rejected");
assert.equal(idOf({}), "", "empty response");

// --- Labels come from run-scoped fields only ---

assert.equal(
  importedRunFromResponse({ migration_run: { sys_id: runId, number: "DMR0001033" } }, "fallback").label,
  "DMR0001033",
  "label from run object number",
);
assert.equal(
  importedRunFromResponse({ result: { migration_run_id: runId, cis: [{ sys_id: stagedCiId, number: "DCI0001330" }] } }, "fallback").label,
  "fallback",
  "staged-CI number never becomes the run label",
);

// --- isSysId sanity ---

assert.equal(isSysId(runId), true);
assert.equal(isSysId("DMR0001033"), false);
assert.equal(isSysId(runId.slice(0, 31)), false);
assert.equal(isSysId(null), false);

console.log("smoke-run-parser: all assertions passed");
