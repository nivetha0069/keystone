// End-to-end test of demo mode in a real Chromium, driving the real UI.
//
// Every run gets a fresh browser context, so no state leaks between runs — the
// in-app preview browser shares a JS realm across tabs, which made manual
// click-testing report stale demo state.
//
// The load-bearing assertion is NETWORK SILENCE: while demo mode is on, not a
// single request may reach /api/cmdb/* or amazonaws.com. Everything else could
// look right while still talking to ServiceNow, so this is checked continuously
// rather than at the end.
//
// Usage:
//   npm run dev            # in another terminal
//   npm run e2e:demo-mode
//
// Override the target with KEYSTONE_URL. Set HEADED=1 to watch it run.

const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const BASE = process.env.KEYSTONE_URL || "http://localhost:3000";
const HEADED = process.env.HEADED === "1";
const AWS_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json";

const steps = [];
let stepNumber = 0;

function record(name, detail) {
  stepNumber += 1;
  steps.push({ n: stepNumber, name, detail });
  console.log(`  ${String(stepNumber).padStart(2, "0")}. ok   ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, message) {
  console.log(`  ${String(stepNumber + 1).padStart(2, "0")}. FAIL ${name}\n        ${message}`);
  throw new Error(`${name}: ${message}`);
}

/** Click a button by the text it starts with, and assert it was enabled. */
async function clickButton(page, startsWith, { timeout = 15_000 } = {}) {
  const button = page.locator("button", { hasText: startsWith }).first();
  await button.waitFor({ state: "visible", timeout });
  if (await button.isDisabled()) fail(`click "${startsWith}"`, "button is disabled");
  await button.click();
}

/** Read the demo toggle's on/off state from its class. */
const demoIsOn = page => page.evaluate(() =>
  Boolean(document.querySelector(".demo-toggle")?.classList.contains("active")));

/** Current journey chapter headings, e.g. "CHAPTER 4 · COMPLETE". */
const chapters = page => page.evaluate(() =>
  (document.querySelector("main")?.innerText || "").match(/CHAPTER \d · [A-Z ]+/g) || []);

/** The per-bucket counts on the Remediate work queue. */
const buckets = page => page.evaluate(() => Object.fromEntries(
  Array.from(document.querySelectorAll("button"))
    .map(b => b.textContent.trim())
    .filter(x => /^(Ready to simulate|Needs approval|Ready to execute|Needs verification|Verified|Blocked)\d+$/.test(x))
    .map(s => [s.replace(/\d+$/, ""), Number(s.match(/\d+$/)[0])])));

async function openSection(page, label) {
  await page.locator("aside button", { hasText: label }).first().click();
  await page.waitForTimeout(1500);
}

(async () => {
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext();
  const page = await context.newPage();

  // --- Network watch --------------------------------------------------------
  // Recorded for the whole run; asserted against the windows where demo mode
  // was on. A request is a violation only if it left while demo mode was on.
  let demoActive = true;
  const violations = [];
  page.on("request", req => {
    const url = req.url();
    const isBackend = url.includes("/api/cmdb/");
    const isAws = url.includes("amazonaws.com");
    if (!isBackend && !isAws) return;
    if (demoActive) violations.push(url.replace(BASE, ""));
  });

  const consoleErrors = [];
  page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", err => consoleErrors.push(`pageerror: ${err.message}`));

  console.log(`\nE2E · demo mode · ${BASE}\n`);

  try {
    // === 1. Enter demo mode ================================================
    await page.goto(`${BASE}/control-plane?demo=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(4000);
    assert.equal(await demoIsOn(page), true, "demo toggle should read as on");
    record("demo mode is on from ?demo=1");

    // === 2. It lands on Import, preset to the one source ====================
    const urlField = page.locator(".url-intake input").first();
    await urlField.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await urlField.inputValue(), AWS_URL, "import URL should be the one demo source");
    assert.equal(await urlField.evaluate(el => el.readOnly), true, "the demo URL must be read-only");
    record("lands on Import with the one AWS URL, locked", AWS_URL);

    // === 3. Stage it ========================================================
    await clickButton(page, "Land in staging");
    await page.waitForTimeout(3000);
    record("staged the demo import");

    // === 4. The pipeline progresses on the app's own polling ================
    // No clicking: the 8s poll walks intake -> scans -> gate -> IRE/seal.
    await openSection(page, "Agent Workspace");
    const seen = new Set();
    let progressed = false;
    for (let tick = 0; tick < 14; tick++) {
      const current = await chapters(page);
      current.forEach(c => seen.add(c));
      if (current.some(c => /CHAPTER [34] · (COMPLETE|AWAITING DECISION|WORKING)/.test(c))
          && current.some(c => /CHAPTER 1 · COMPLETE/.test(c))) { progressed = true; break; }
      await page.waitForTimeout(4000);
    }
    if (!progressed) fail("pipeline progresses", `chapters never advanced; saw ${[...seen].join(", ")}`);
    record("pipeline progressed without any clicking", [...seen].filter(c => c.includes("CHAPTER 1")).join(""));

    // === 5. The full live-success flow, replayed by Mara offline =============
    await openSection(page, "Remediate");
    await page.waitForTimeout(2500);
    const initialQueue = await buckets(page);
    assert.equal(initialQueue["Ready to simulate"], 600, "all staged records should enter the live-success path");
    record("all 600 staged records are ready for governed simulation");

    const autonomyToggle = page.locator(".mara-mode-toggle input").first();
    await autonomyToggle.check({ force: true });
    await clickButton(page, "Start autonomous migration");
    await page.locator(".mara-autonomy-panel", { hasText: "Mara finished." })
      .waitFor({ state: "visible", timeout: 120_000 });
    record("Mara simulated, committed, and verified every bounded packet");

    // === 6. The run finishes ===============================================
    // Once the run is terminal the dashboard stops polling — by design, in live
    // mode too — so the workspace can still be showing the snapshot it last
    // fetched. "Refresh data" is the affordance for exactly that, so drive it
    // the way an operator would rather than asserting against a stale view.
    await openSection(page, "Agent Workspace");
    await page.waitForTimeout(2000);
    let finalChapters = [];
    for (let tick = 0; tick < 8; tick++) {
      const refresh = page.getByRole("button", { name: "Refresh data" }).first();
      if (await refresh.count()) { await refresh.click(); }
      await page.waitForTimeout(3500);
      finalChapters = await chapters(page);
      if (finalChapters.some(c => /CHAPTER 4 · COMPLETE/.test(c))) break;
    }
    if (!finalChapters.some(c => /CHAPTER 4 · COMPLETE/.test(c))) {
      fail("run reaches Verify complete", `chapters ended at: ${finalChapters.join(", ")}`);
    }
    const queue = await (async () => { await openSection(page, "Remediate"); return buckets(page); })();
    assert.equal(queue.Verified, 600, "all 600 staged records should reach verified");
    assert.equal(queue.Blocked, 0, "the demo golden path should have no blocked records");
    assert.equal(queue["Ready to simulate"], 0, "no staged records should remain unprocessed");
    assert.equal(queue["Needs approval"], 0, "no staged records should remain awaiting approval");
    assert.equal(queue["Ready to execute"], 0, "no staged records should remain awaiting execution");
    assert.equal(queue["Needs verification"], 0, "no staged records should remain awaiting verification");
    record("run reached Verify · COMPLETE", `queue: ${JSON.stringify(queue)}`);

    // === 7. NOTHING touched ServiceNow =====================================
    if (violations.length) {
      fail("zero network while demo mode is on",
        `${violations.length} request(s) escaped:\n        ${violations.slice(0, 10).join("\n        ")}`);
    }
    record("zero /api/cmdb and zero amazonaws.com requests for the whole demo run");

    // === 8. No client-side crashes =========================================
    const realErrors = consoleErrors.filter(e => !/Download the React DevTools|\[HMR\]/i.test(e));
    if (realErrors.length) {
      fail("no console errors", realErrors.slice(0, 5).join("\n        "));
    }
    record("no page errors or console errors during the whole run");

    console.log(`\n  ${steps.length}/${steps.length} steps passed`);
    console.log("  no live mode or ServiceNow request was attempted\n");
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(`\n  E2E FAILED: ${error.message}\n`);
  process.exit(1);
});
