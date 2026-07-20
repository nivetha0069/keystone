// Shared run-context resolution used by the dashboard and AI Usage.
//
// This test drives the resolver against a stub `window` so the "URL first,
// then localStorage" priority is frozen in place. If AI Usage forgets the
// localStorage fallback again, this smoke fails loudly instead of the user
// having to paste a sys_id.

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

const runA = "26c8e4082b524b1060aefba6b891bf39"; // the live acceptance run
const runB = "9569233b2b420b1060aefba6b891bfed"; // a valid but different sys_id

// A tiny window stub: JSDOM-free, just enough for the helpers under test.
function stubWindow({ url = "http://localhost:3000/ai-usage", stored = null } = {}) {
  const storage = new Map();
  if (stored !== null) storage.set("cmdb-modernization:last-run-id", stored);
  const state = { url };
  global.window = {
    location: {
      get search() { return new URL(state.url).search; },
      get href() { return state.url; },
    },
    history: {
      replaceState(_state, _title, next) { state.url = new URL(next, state.url).toString(); },
    },
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
  };
  return {
    getUrl: () => state.url,
    getStored: () => storage.get("cmdb-modernization:last-run-id") ?? null,
  };
}

function reload() {
  delete require.cache[require.resolve("../app/lib/cmdb/run-context.ts")];
  delete require.cache[require.resolve("../app/lib/cmdb/run-id.ts")];
  return require("../app/lib/cmdb/run-context.ts");
}

// Test 1 — URL run wins and is exposed by the resolver.
{
  const bag = stubWindow({ url: `http://localhost:3000/ai-usage?run=${runA}` });
  const ctx = reload();
  assert.equal(ctx.readRunFromUrl(), runA, "URL run recognized");
  assert.equal(ctx.resolveActiveRun(), runA);
  ctx.rememberRun(runA);
  assert.equal(bag.getStored(), runA, "URL run gets persisted when remembered");
}

// Test 2 — saved-run fallback when the URL has no run.
{
  stubWindow({ url: "http://localhost:3000/ai-usage", stored: runB });
  const ctx = reload();
  assert.equal(ctx.readRunFromUrl(), "");
  assert.equal(ctx.readSavedRun(), runB, "saved run read from localStorage");
  assert.equal(ctx.resolveActiveRun(), runB, "saved run wins when URL is empty");
}

// Test 3 — no URL run, no saved run → resolver returns "".
{
  stubWindow({ url: "http://localhost:3000/ai-usage" });
  const ctx = reload();
  assert.equal(ctx.resolveActiveRun(), "", "no source → empty");
}

// Test 4 — URL precedence: URL run A beats saved run B.
{
  stubWindow({ url: `http://localhost:3000/ai-usage?run=${runA}`, stored: runB });
  const ctx = reload();
  assert.equal(ctx.resolveActiveRun(), runA, "URL wins over saved");
}

// Invalid saved value is ignored rather than trusted.
{
  stubWindow({ url: "http://localhost:3000/ai-usage", stored: "not-a-sys-id" });
  const ctx = reload();
  assert.equal(ctx.readSavedRun(), "", "invalid saved value rejected");
  assert.equal(ctx.resolveActiveRun(), "");
}

// writeRunToUrl reflects the run in the URL via replaceState (no navigation).
{
  const bag = stubWindow({ url: "http://localhost:3000/ai-usage" });
  const ctx = reload();
  ctx.writeRunToUrl(runA);
  const url = new URL(bag.getUrl());
  assert.equal(url.searchParams.get("run"), runA, "URL now contains the run");
}

// Clearing the URL removes the parameter without other side effects.
{
  const bag = stubWindow({ url: `http://localhost:3000/ai-usage?run=${runA}&other=1` });
  const ctx = reload();
  ctx.writeRunToUrl("");
  const url = new URL(bag.getUrl());
  assert.equal(url.searchParams.get("run"), null);
  assert.equal(url.searchParams.get("other"), "1");
}

console.log("smoke-run-context: all assertions passed");
