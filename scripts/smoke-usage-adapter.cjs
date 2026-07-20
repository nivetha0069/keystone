// Token-availability contract for the AI Usage adapter.
//
// The previous adapter coerced every missing token field to 0, so a call with
// no telemetry rendered as "Input: 0 / Output: 0 / Total: 0" — indistinguishable
// from a call that had genuinely used zero tokens. This test freezes the fix:
// missing → undefined, explicit 0 → 0, real numbers → themselves, aggregates
// only sum the calls that actually reported tokens.

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

const { normalizeCall, normalizeUsage, computeTotals, optionalTokenCount } = require("../app/lib/cmdb/usage-adapter.ts");

// --- optionalTokenCount: the core rule ---
assert.equal(optionalTokenCount(undefined), undefined, "undefined stays undefined");
assert.equal(optionalTokenCount(null), undefined, "null stays undefined");
assert.equal(optionalTokenCount(""), undefined, "empty string stays undefined");
assert.equal(optionalTokenCount(0), 0, "explicit 0 is preserved");
assert.equal(optionalTokenCount("0"), 0, "explicit '0' string is preserved");
assert.equal(optionalTokenCount(1234), 1234);
assert.equal(optionalTokenCount("1234"), 1234);
assert.equal(optionalTokenCount(-1), undefined, "negative is not a token count");
assert.equal(optionalTokenCount("nan"), undefined);

// Test 5 — missing token values from the task spec
const missing = normalizeCall({
  phase: "Comprehend",
  model: "claude-sonnet-4-6",
  duration_ms: 1660,
  status: "success",
}, 0);
assert.equal(missing.inputTokens, undefined, "missing input stays undefined");
assert.equal(missing.outputTokens, undefined);
assert.equal(missing.totalTokens, undefined);
assert.equal(missing.tokenMetricsAvailable, false, "no token metrics available");
assert.equal(missing.durationMs, 1660, "duration still populated");
assert.equal(missing.status, "success");

// Test 6 — explicit zero must survive
const explicitZero = normalizeCall({ input_tokens: 0, output_tokens: 0, total_tokens: 0, model: "x" }, 1);
assert.equal(explicitZero.inputTokens, 0, "explicit zero preserved");
assert.equal(explicitZero.outputTokens, 0);
assert.equal(explicitZero.totalTokens, 0);
assert.equal(explicitZero.tokenMetricsAvailable, true, "explicit zeros still count as reported");

// Test 7 — real tokens
const real = normalizeCall({ input_tokens: 100, output_tokens: 25, total_tokens: 125, model: "x" }, 2);
assert.equal(real.inputTokens, 100);
assert.equal(real.outputTokens, 25);
assert.equal(real.totalTokens, 125);
assert.equal(real.tokenMetricsAvailable, true);

// Alternate token key shapes the adapter must recognize.
const nested = normalizeCall({
  model: "claude-x",
  usage: { input_tokens: 50, output_tokens: 30, total_tokens: 80 },
}, 3);
assert.equal(nested.inputTokens, 50, "usage.input_tokens recognized");
assert.equal(nested.outputTokens, 30);
assert.equal(nested.totalTokens, 80);

const camelCount = normalizeCall({ model: "y", promptTokenCount: 12, completionTokenCount: 4 }, 4);
assert.equal(camelCount.inputTokens, 12, "promptTokenCount recognized");
assert.equal(camelCount.outputTokens, 4, "completionTokenCount recognized");
assert.equal(camelCount.totalTokens, 16, "total derived from parts when absent");

// A backend total smaller than input+output is corrected upward rather than trusted.
const inconsistentTotal = normalizeCall({ input_tokens: 100, output_tokens: 50, total_tokens: 20, model: "z" }, 5);
assert.equal(inconsistentTotal.totalTokens, 150, "total is at least input+output");

// Test 8 — partial telemetry aggregates
const partial = [missing, real];
const partialTotals = computeTotals(partial);
assert.equal(partialTotals.callCount, 2, "both calls counted");
assert.equal(partialTotals.callsWithTokens, 1, "only the real call had tokens");
assert.equal(partialTotals.inputTokens, 100, "total uses the token-bearing call only");
assert.equal(partialTotals.outputTokens, 25);
assert.equal(partialTotals.totalTokens, 125);
assert.equal(partialTotals.tokenMetricsAvailable, true);

// A run whose calls ALL lack tokens leaves the aggregate undefined —
// the UI must render "Not captured", never "0".
const noneTotals = computeTotals([missing, missing]);
assert.equal(noneTotals.callCount, 2);
assert.equal(noneTotals.callsWithTokens, 0);
assert.equal(noneTotals.inputTokens, undefined, "no tokens → aggregate undefined");
assert.equal(noneTotals.outputTokens, undefined);
assert.equal(noneTotals.totalTokens, undefined);
assert.equal(noneTotals.tokenMetricsAvailable, false);

// normalizeUsage: aggregate is recomputed from calls, not trusted from a
// stray {totals: {totalTokens: 0}} envelope that could resurrect the bug.
const noneUsage = normalizeUsage({
  runId: "abc",
  totals: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
  calls: [
    { phase: "Comprehend", model: "x", duration_ms: 500, status: "success" },
    { phase: "Mara", model: "y", duration_ms: 200, status: "success" },
  ],
}, "abc");
assert.equal(noneUsage.totals.tokenMetricsAvailable, false, "backend zero-totals do not override missing per-call telemetry");
assert.equal(noneUsage.totals.totalTokens, undefined);
assert.equal(noneUsage.totals.callCount, 2);

// Envelope + real data still totals correctly.
const realUsage = normalizeUsage({
  runId: "abc",
  calls: [
    { phase: "Comprehend", model: "x", input_tokens: 100, output_tokens: 25, total_tokens: 125, duration_ms: 500, status: "success" },
    { phase: "Mara", model: "y", input_tokens: 60, output_tokens: 15, total_tokens: 75, duration_ms: 300, status: "success" },
  ],
}, "abc");
assert.equal(realUsage.totals.inputTokens, 160);
assert.equal(realUsage.totals.outputTokens, 40);
assert.equal(realUsage.totals.totalTokens, 200);
assert.equal(realUsage.totals.callsWithTokens, 2);

console.log("smoke-usage-adapter: all assertions passed");
