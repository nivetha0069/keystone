// Backend-state cohort predicates for the migration run.
//
// The dashboard uses these to decide when to poll, when to offer the manual
// Start/Retry analysis button, and when to hold silent (terminal). Getting a
// state into the wrong cohort caused the redundant `/comprehend` POST after a
// fresh import — this test freezes the current classification so the bug can
// not silently return.

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

const { isDraftRunState, isTerminalRunState, isActiveRunState } = require("../app/lib/cmdb/run-lifecycle.ts");

// Draft: manual Start/Retry analysis is offered.
assert.equal(isDraftRunState("draft"), true);
assert.equal(isDraftRunState("reset"), true);
assert.equal(isDraftRunState("analyzing"), false);
assert.equal(isDraftRunState("awaiting_approval"), false);
assert.equal(isDraftRunState(undefined), false);

// Terminal: polling stops, no automatic /comprehend.
for (const state of [
  "awaiting_approval", "simulated", "approved", "committed",
  "complete", "completed", "failed", "error",
]) {
  assert.equal(isTerminalRunState(state), true, `terminal: ${state}`);
  assert.equal(isActiveRunState(state), false, `not active: ${state}`);
  assert.equal(isDraftRunState(state), false, `not draft: ${state}`);
}

// Active: keep polling. ServiceNow /import flips a fresh run into `analyzing`,
// so this cohort must NOT trigger a redundant Comprehend start.
for (const state of ["ingesting", "analyzing", "routing", "atlas", "scout", "weaver", "sentry", "mara"]) {
  assert.equal(isActiveRunState(state), true, `active: ${state}`);
  assert.equal(isDraftRunState(state), false, `not draft: ${state}`);
  assert.equal(isTerminalRunState(state), false, `not terminal: ${state}`);
}

assert.equal(isActiveRunState(undefined), false, "no state → not active");
assert.equal(isActiveRunState(""), false, "empty state → not active");

console.log("smoke-run-lifecycle: all assertions passed");
