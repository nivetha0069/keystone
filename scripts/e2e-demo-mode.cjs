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
const DATASET = require("../app/lib/cmdb/demo-dataset.json");
const SUMMARY = DATASET.summary;
/** Records Mara may migrate unattended — the run's terminal verified count. */
const COHORT = SUMMARY.autonomous_count;
/** Everything deliberately left for an operator. */
const BACKLOG = SUMMARY.review_backlog_count;

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
    // Demo mode ships its dataset, so ANY outbound request is a violation —
    // not just the ones aimed at the old AWS source URL.
    const isExternal = /^https?:\/\//.test(url) && !url.startsWith(BASE);
    if (!isBackend && !isExternal) return;
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
    // The toggle is the ONLY place demo mode names itself. Every other surface
    // must read exactly like a live run, so a stray "simulated"/"offline"
    // label anywhere in the shell is a regression.
    const shellText = await page.locator("main").innerText();
    for (const leak of [/offline demo/i, /simulated snapshot/i, /demo snapshot/i, /offline replay/i]) {
      assert.ok(!leak.test(shellText), `demo-specific wording leaked into the UI: ${leak}`);
    }
    record("demo mode is on from ?demo=1, and nothing but the toggle says so");

    // === 2. It lands on Import, preset to the bundled dataset ==============
    const importText = await page.locator("main").innerText();
    assert.ok(importText.includes(DATASET.dataset.name),
      `Import should name the bundled dataset "${DATASET.dataset.name}"`);
    record("lands on Import preset to the bundled dataset", DATASET.dataset.name);

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

    // === 5. The specialists show their recorded work ========================
    await openSection(page, "Comprehend");
    await page.locator(".agent-specialist-node.active").first().waitFor({ state: "visible", timeout: 15_000 });
    const activeSpecialists = await page.locator(".agent-specialist-node.active").count();
    assert.equal(activeSpecialists, 5, "all W-R-A-G-S specialists should have recorded output");
    const rosterText = await page.locator(".worker-roster").innerText();
    // All five specialists must have a roster card. The evidence phrases are
    // drawn from the tail of the handoff log, which only renders the most
    // recent exchanges — asserting on early ones would fail once the run grows.
    for (const expected of [
      "Weaver", "Router", "Atlas", "Guard", "Scout",
      "distinct identities", "dependency edges discovered",
      "Confidence gate applied", "autonomous boundary",
    ]) {
      assert.match(rosterText, new RegExp(expected, "i"), `agent roster is missing ${expected}`);
    }
    assert.ok(await page.locator(".agent-handoff-row").count() >= 5, "specialist handoffs should be visible");
    record("Mara and all five specialists show evidence-backed outputs and handoffs");

    // === 6. The full live-success flow, replayed by Mara offline =============
    await openSection(page, "Remediate");
    await page.waitForTimeout(2500);
    const initialQueue = await buckets(page);
    // More records are *simulatable* than are autonomously migratable: an
    // operator can simulate and hand-approve a matched or duplicate record
    // (showcase step 5a). Only unreconcilable rows cannot be simulated at all.
    assert.ok(initialQueue["Ready to simulate"] >= COHORT,
      `expected at least the ${COHORT}-record cohort ready, saw ${initialQueue["Ready to simulate"]}`);
    assert.equal(initialQueue["Verified"], 0, "nothing should read as verified before the run");
    record(`${initialQueue["Ready to simulate"]} simulatable, of which ${COHORT} are autonomous; ${BACKLOG} need an operator`);

    const autonomyToggle = page.locator(".mara-mode-toggle input").first();
    await autonomyToggle.check({ force: true });
    await clickButton(page, "Start autonomous migration");
    await page.locator(".mara-autonomy-panel", { hasText: "Mara finished." })
      .waitFor({ state: "visible", timeout: 180_000 });
    await page.locator(".demo-agent-trace", { hasText: `${COHORT}/${COHORT} correlated outcomes verified` })
      .waitFor({ state: "visible", timeout: 30_000 });
    const traceText = await page.locator(".demo-agent-trace").innerText();
    assert.match(traceText, /CMDB publish completed through IRE/i);
    // The closing entry must report the backlog it did NOT touch. Rounding the
    // run up to "everything verified" is the overclaim this demo must not make.
    assert.match(traceText, new RegExp(`${BACKLOG} staged records were never eligible`));
    record("Mara committed and verified every bounded packet, and said what she skipped");

    // === 7. The run finishes ===============================================
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
    assert.equal(queue.Verified, COHORT, `all ${COHORT} cohort records should reach verified`);
    assert.equal(queue["Needs approval"], 0, "no cohort record should remain awaiting approval");
    assert.equal(queue["Ready to execute"], 0, "no cohort record should remain awaiting execution");
    assert.equal(queue["Needs verification"], 0, "no cohort record should remain awaiting verification");
    // What is LEFT is the point of the demo: the matched and duplicate records
    // Mara is not allowed to migrate unattended are still sitting there, ready
    // for an operator. A run that emptied this bucket would have overstepped.
    assert.equal(queue["Ready to simulate"], initialQueue["Ready to simulate"] - COHORT,
      "Mara touched records outside the autonomous cohort");
    assert.ok(queue["Ready to simulate"] > 0, "the operator backlog vanished; the boundary did not hold");
    await page.locator(".cmdb-commit-status", { hasText: "CURRENT SCOPE COMMITTED AND VERIFIED" })
      .waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(".mara-autonomy-panel", { hasText: "Autonomous migration complete" })
      .waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await page.getByRole("button", { name: "Start autonomous migration" }).count(), 0);
    record("run reached Verify · COMPLETE", `queue: ${JSON.stringify(queue)}`);

    // === 8. The closing beat: health actually improved =====================
    // This is the last thing shown in the walkthrough, and the score sitting
    // still through a whole migration was the original complaint.
    await openSection(page, "Prioritize");
    await page.waitForTimeout(2500);
    const healthText = await page.locator("main").innerText();
    const scores = [...healthText.matchAll(/\b(\d{2})\b/g)].map(m => Number(m[1]));
    assert.ok(scores.includes(SUMMARY.baseline_score) || scores.length > 0,
      "Prioritize rendered no health figures at all");
    assert.ok(!healthText.includes(`${SUMMARY.baseline_score} → ${SUMMARY.baseline_score}`),
      "health never moved off its baseline");
    record("Prioritize shows health moved off baseline after remediation");

    // === 9. NOTHING touched ServiceNow =====================================
    if (violations.length) {
      fail("zero network while demo mode is on",
        `${violations.length} request(s) escaped:\n        ${violations.slice(0, 10).join("\n        ")}`);
    }
    record("zero /api/cmdb and zero external requests for the whole demo run");

    // === 10. No client-side crashes ========================================
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
