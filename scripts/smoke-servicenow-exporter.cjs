const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const script = path.resolve(__dirname, "export-servicenow-scope.mjs");

(async () => {
  const exporter = await import(pathToFileURL(script).href);
  const defaults = exporter.parseArgs([]);
  assert.equal(defaults.scope, "x_kest_dotwalkers");
  assert.equal(defaults.outputRoot, path.join("outputs", "servicenow-export"));
  assert.throws(() => exporter.parseArgs(["--limit", "0"]), /integer from 1 to 1000/);

  const sanitized = exporter.sanitizeText(`password = "super-secret"; Authorization: "Bearer abcdefghijklmnop";`, ["abcdefgh"]);
  assert.equal(sanitized.value.includes("super-secret"), false);
  assert.equal(sanitized.value.includes("abcdefghijklmnop"), false);
  assert.ok(sanitized.redactions >= 2);

  const source = fs.readFileSync(script, "utf8");
  assert.match(source, /method: "GET"/);
  assert.doesNotMatch(source, /method: "(?:POST|PUT|PATCH|DELETE)"/);
  assert.match(source, /artifact\("script-includes", "sys_script_include"/);
  assert.match(source, /artifact\("scripted-rest-resources", "sys_ws_operation"/);
  assert.match(source, /artifact\("application-metadata", "sys_metadata"/);
  assert.match(source, /system property values are never requested/i);
  assert.match(source, /summary\.class_counts = countBy/);
  assert.doesNotMatch(source, /artifact\("system-property-metadata"[^\n]+\["value"\]/);

  console.log("smoke-servicenow-exporter: GET-only scope export guards passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
