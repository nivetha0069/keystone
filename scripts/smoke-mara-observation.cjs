// Smoke tests for parseMaraObservation.
//
// Contract:
//   - The bubble summary must NEVER contain the raw ledger message, `Observation:`
//     prefix, or literal JSON when parsing succeeds or fails.
//   - Malformed / truncated JSON must still produce readable summary + chips.
//   - Missing fields → generic fallback.
//   - `technicalRaw` may contain the raw source (for the collapsed <details>).

const { execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const source = fs.readFileSync(path.join(__dirname, "..", "app", "lib", "cmdb", "mara-observation.ts"), "utf8");
const stripped = source
  .replace(/^export\s+/gm, "")
  // Drop TS-only annotations that make Node stumble.
  .replace(/:\s*[A-Za-z_][A-Za-z0-9_.<>,\s|\[\]?"'&]*(?=\s*[,)={])/g, "")
  .replace(/:\s*Record<string,\s*unknown>/g, "")
  .replace(/\s+as\s+[A-Za-z_][A-Za-z0-9_<>,.\s|\[\]?]*/g, "")
  .replace(/type\s+\w+\s*=\s*[^;]+;/g, "")
  .replace(/\)\s*:\s*[A-Za-z_][A-Za-z0-9_<>,.\s|\[\]?"'&{}]*\s*\{/g, ") {");

// Rather than fight the regex-strip approach, invoke the TypeScript CLI to
// compile the module into a CJS file, then require it.
const outDir = path.join(__dirname, "..", ".smoke");
fs.mkdirSync(outDir, { recursive: true });
execSync(`npx tsc --module commonjs --target es2020 --outDir "${outDir}" --skipLibCheck --esModuleInterop --moduleResolution node ./app/lib/cmdb/mara-observation.ts`, {
  stdio: "inherit",
  cwd: path.join(__dirname, ".."),
});
const compiledJs = path.join(outDir, "mara-observation.js");
const modulePath = path.join(outDir, "mara-observation.cjs");
fs.renameSync(compiledJs, modulePath);
const compiled = require(modulePath);
void stripped; // unused (kept for clarity)

const { parseMaraObservation, MARA_FALLBACK_SUMMARY } = compiled;

function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    process.exit(1);
  }
}

// 1. Valid JSON
{
  const result = parseMaraObservation('Observation: {"ready_count": 8, "held_count": 2, "confidence": 0.85}');
  assert(result.summaryText === "I found 8 records ready for simulation and held 2 for human review.",
    `valid JSON summary: got "${result.summaryText}"`);
  assert(result.chips.includes("8 ready") && result.chips.includes("2 held") && result.chips.includes("85% confidence"),
    `valid JSON chips: ${result.chips.join("|")}`);
  assert(!/Observation:/.test(result.summaryText), "summary must not contain Observation prefix");
  assert(!/\{/.test(result.summaryText), "summary must not contain literal JSON");
}

// 2. Truncated JSON — should still extract via regex
{
  const raw = 'Observation: {"ready_count": 8, "held_count": 2, "records": [{"number": "DCI0001503","source_identifier": "TDW-SVC-EXCH","proposed_class": "cmdb_ci_service","confidence": 0.85,"identification_status": "Pending"';
  const result = parseMaraObservation(raw);
  assert(result.summaryText.includes("8 records ready for simulation"),
    `truncated summary: got "${result.summaryText}"`);
  assert(result.chips.includes("8 ready") && result.chips.includes("2 held"),
    `truncated chips: ${result.chips.join("|")}`);
  assert(!result.summaryText.includes(raw), "truncated summary must not include raw source");
  assert(!result.summaryText.includes("Observation"), "truncated summary must not mention Observation");
}

// 3. Truncated JSON with records — regex record extraction
{
  const raw = 'Observation: {"records": [{"number": "DCI0001503","source_identifier": "TDW-SVC-EXCH","proposed_class": "cmdb_ci_service","confidence": 0.85,"identification_status": "Pending"},{"number": "DCI0001504","source_identifier": "TDW-SVC-DB","proposed_class": "cmdb_ci_db","confidence": 0.92,"identification_status": "Ready"';
  const result = parseMaraObservation(raw);
  assert(result.records.length >= 2, `expected >=2 records, got ${result.records.length}`);
  assert(result.records[0].id === "DCI0001503", `first record id: ${result.records[0].id}`);
  assert(result.records[0].name === "TDW-SVC-EXCH", `first record name: ${result.records[0].name}`);
  assert(result.records[0].confidence === 85, `first record confidence: ${result.records[0].confidence}`);
}

// 4. Malformed JSON (unterminated string) with known key fragments
{
  const raw = 'Observation: {"ready_count": 3, "held_count": 1, unterminated string literal';
  const result = parseMaraObservation(raw);
  assert(result.summaryText.startsWith("I found"), `malformed summary: got "${result.summaryText}"`);
  assert(result.chips.includes("3 ready") && result.chips.includes("1 held"), `malformed chips: ${result.chips.join("|")}`);
}

// 5. Missing fields — generic fallback
{
  const result = parseMaraObservation("Observation: {}");
  assert(result.summaryText === MARA_FALLBACK_SUMMARY, `missing-fields summary: got "${result.summaryText}"`);
  assert(result.chips.length === 0, `missing-fields chips: ${result.chips.join("|")}`);
  assert(result.records.length === 0, `missing-fields records: ${result.records.length}`);
}

// 6. Observation: prefix must be stripped
{
  const result = parseMaraObservation('Observation: {"ready_count": 5}');
  assert(!result.summaryText.includes("Observation"), "prefix stripped");
  assert(result.chips.includes("5 ready"), `prefix chips: ${result.chips.join("|")}`);
}

// 7. Raw JSON absent from bubble text
{
  const raw = '{"ready_count": 8, "held_count": 2}';
  const result = parseMaraObservation(raw);
  assert(!result.summaryText.includes("{") && !result.summaryText.includes("}"),
    `summary must not contain JSON braces: "${result.summaryText}"`);
}

// 8. Empty input → fallback
{
  const result = parseMaraObservation("");
  assert(result.summaryText === MARA_FALLBACK_SUMMARY, "empty input → fallback");
  assert(result.technicalRaw === "" || result.technicalRaw === "(empty)", `technicalRaw for empty: "${result.technicalRaw}"`);
}

// 9. Thought: content stripped
{
  const raw = 'Thought: I should look at this | Observation: {"ready_count": 4}';
  const result = parseMaraObservation(raw);
  assert(!/Thought:/i.test(result.summaryText), "summary must not include Thought:");
  assert(result.chips.includes("4 ready"), `thought chips: ${result.chips.join("|")}`);
}

// 10. technicalRaw is populated with the original source (used inside <details>)
{
  const raw = 'Observation: {"ready_count": 1}';
  const result = parseMaraObservation(raw);
  assert(result.technicalRaw && result.technicalRaw.length > 0, "technicalRaw must be present");
}

console.log("smoke-mara-observation: all assertions passed");
