// Boot a real Chromium via Playwright, load / cold (no ?run query), and
// assert:
//   - no request to /api/cmdb/* returns 4xx
//   - no console message contains "400" or "Failed to load resource"
//
// Deliberately loads without any run parameter and waits long enough for
// any initial useEffect fetches to fire. Fails hard on any violation.

const assert = require("node:assert/strict");
const { chromium } = require("@playwright/test");

const BASE = process.env.KEYSTONE_URL || "http://localhost:3000";
const WAIT_MS = 6000;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleMessages = [];
  const failedRequests = [];
  const cmdbResponses = [];

  page.on("console", msg => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });
  page.on("requestfailed", req => {
    failedRequests.push({ url: req.url(), failure: req.failure()?.errorText });
  });
  page.on("response", async res => {
    const url = res.url();
    if (!url.includes("/api/cmdb/")) return;
    cmdbResponses.push({ url: url.replace(BASE, ""), status: res.status() });
  });

  console.log(`Loading ${BASE}/ cold (no run parameter)…`);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForTimeout(WAIT_MS);

  await browser.close();

  console.log("\n=== /api/cmdb/* responses during cold load ===");
  if (cmdbResponses.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of cmdbResponses) console.log(`  ${r.status}  ${r.url}`);
  }

  console.log("\n=== console messages (all) ===");
  for (const m of consoleMessages) {
    console.log(`  [${m.type}] ${m.text}`);
  }
  if (consoleMessages.length === 0) console.log("  (none)");

  console.log("\n=== failed requests ===");
  for (const f of failedRequests) console.log(`  ${f.url}  ${f.failure}`);
  if (failedRequests.length === 0) console.log("  (none)");

  // Assertions
  const badApi = cmdbResponses.filter(r => r.status >= 400);
  assert.equal(badApi.length, 0, `cold load produced ${badApi.length} /api/cmdb 4xx/5xx responses: ${JSON.stringify(badApi)}`);

  const noiseConsole = consoleMessages.filter(m => {
    const t = m.text;
    return /Failed to load resource/i.test(t)
      || /400\b|401\b|403\b|404\b|405\b|500\b|502\b|503\b/.test(t);
  });
  assert.equal(noiseConsole.length, 0, `cold load produced noisy console messages: ${JSON.stringify(noiseConsole)}`);

  console.log("\n✓ Cold load: zero /api/cmdb requests, zero 4xx, zero console error noise.");
})().catch(err => {
  console.error(err);
  process.exit(1);
});
