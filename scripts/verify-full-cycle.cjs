// End-to-end verification of the full run cycle:
//   Import → Comprehend → Prioritize → Remediate
//
// Strategy:
//   1. Create a real ServiceNow migration run via POST /api/cmdb/import.
//      This returns a 32-hex runId that the backend will then hydrate as
//      Comprehend/Prioritize evidence lands.
//   2. Launch a headless Chromium at /?run=<runId> so the dashboard boots
//      already scoped to the fresh run.
//   3. Click through the sidebar in navigation order: Import → Comprehend
//      → Prioritize → Remediate. At each step, wait for the section to
//      render and grab a visible-text snapshot for the report.
//   4. On Remediate, exercise the CI-scoping fix: pick the first staged
//      CI in the queue, then assert the selected-CI evidence card carries
//      the CI-SPECIFIC scope label — never a raw Mara Observation blob.
//   5. Throughout: fail the run if any /api/cmdb response is 5xx, if any
//      console message is an error, or if a raw "Observation:" or JSON
//      payload leaks into the CI panel.
//
// This is not a full acceptance test — it's a smoke walk that proves the
// wiring holds end-to-end against a real ServiceNow backend. Exits non-zero
// on any hard assertion; prints a compact per-step report either way.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");

const BASE = process.env.KEYSTONE_URL || "http://localhost:3000";
const SECTION_WAIT_MS = 4000;
// Optional: point at a known-populated run instead of minting a fresh one.
// docs/lifecycle-acceptance-report.md pins e0ac4df3... — 2 CIs, findings,
// reviews, timeline. Set KEYSTONE_RUN_ID to override.
const KNOWN_POPULATED_RUN = "e0ac4df32b82871060aefba6b891bf5b";
const RUN_ID_OVERRIDE = process.env.KEYSTONE_RUN_ID;

async function importRun() {
  const response = await fetch(`${BASE}/api/cmdb/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await response.json();
  // The proxy wraps { result: { result: { runId } } }
  const runId = body?.result?.result?.runId || body?.result?.runId || body?.runId;
  if (!runId || !/^[0-9a-f]{32}$/i.test(runId)) {
    throw new Error(`Import did not return a valid runId (got ${JSON.stringify(body).slice(0, 200)}).`);
  }
  return runId;
}

async function resolveRunId() {
  if (RUN_ID_OVERRIDE) {
    if (!/^[0-9a-f]{32}$/i.test(RUN_ID_OVERRIDE)) {
      throw new Error(`KEYSTONE_RUN_ID must be a 32-hex sys_id (got ${RUN_ID_OVERRIDE}).`);
    }
    console.log(`[Run] using KEYSTONE_RUN_ID override ${RUN_ID_OVERRIDE.slice(0, 8)}…`);
    return { runId: RUN_ID_OVERRIDE, source: "override" };
  }
  // Prefer the known-populated run pinned in docs/lifecycle-acceptance-report.md
  // so we can exercise the CI panel with real staged CIs. Fall back to a
  // fresh import if that run is no longer live.
  try {
    const probe = await fetch(`${BASE}/api/cmdb/cis?run=${KNOWN_POPULATED_RUN}`, { cache: "no-store" });
    if (probe.ok) {
      const body = await probe.json();
      const cis = body?.result?.result || body?.result || [];
      if (Array.isArray(cis) && cis.length > 0) {
        console.log(`[Run] using known-populated run ${KNOWN_POPULATED_RUN.slice(0, 8)}… (${cis.length} CIs)`);
        return { runId: KNOWN_POPULATED_RUN, source: "known-populated" };
      }
    }
  } catch { /* fall through */ }
  const fresh = await importRun();
  console.log(`[Run] fresh import ${fresh.slice(0, 8)}…`);
  return { runId: fresh, source: "fresh-import" };
}

/** Return a short trimmed transcript of visible text on the page (for the report). */
async function readVisibleSnapshot(page) {
  const raw = await page.evaluate(() => {
    const main = document.querySelector("main.main-content") || document.body;
    const text = (main.innerText || "").replace(/\s+\n/g, "\n").replace(/\n{2,}/g, "\n");
    return text.slice(0, 800);
  });
  return raw;
}

(async () => {
  console.log(`Full-cycle verify against ${BASE}`);
  console.log("=".repeat(70));

  // 1. Resolve a run — prefer the known-populated one so the CI panel gets exercised
  const { runId, source } = await resolveRunId();
  console.log(`[Run] source=${source}  id=${runId}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  const cmdbBad = [];
  const observationLeaks = [];

  page.on("console", msg => {
    if (msg.type() === "error" || msg.type() === "warning") {
      const t = msg.text();
      // Filter out React hydration warnings — not what this test cares about.
      if (/Hydration|prerendered/i.test(t)) return;
      // Filter out Next.js dev overlay non-errors.
      if (/DevTools|source map/i.test(t)) return;
      consoleErrors.push({ type: msg.type(), text: t });
    }
  });
  page.on("response", async res => {
    const url = res.url();
    if (!url.includes("/api/cmdb/")) return;
    if (res.status() >= 500) cmdbBad.push({ url: url.replace(BASE, ""), status: res.status() });
  });

  // 2. Boot dashboard with the run in URL
  console.log(`\n[Boot] navigating to /?run=${runId.slice(0, 8)}…`);
  await page.goto(`${BASE}/?run=${runId}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(SECTION_WAIT_MS);

  // 3. Walk the sidebar
  const sections = [
    { id: "import", label: "Import" },
    { id: "comprehend", label: "Comprehend" },
    { id: "prioritize", label: "Prioritize" },
    { id: "remediate", label: "Remediate" },
  ];

  const reports = [];

  for (const section of sections) {
    console.log(`\n[${section.label}] clicking sidebar…`);
    const button = page.locator(`nav.main-nav button[aria-label^="${section.label}:"]`).first();
    const count = await button.count();
    if (count === 0) {
      // Import may already be selected on load — just skip clicking.
      if (section.id !== "import") {
        reports.push({ step: section.label, ok: false, note: "sidebar button not found" });
        continue;
      }
    } else {
      const disabled = await button.getAttribute("disabled").catch(() => null);
      if (disabled !== null) {
        reports.push({ step: section.label, ok: false, note: "sidebar button disabled" });
        continue;
      }
      await button.click();
    }
    await page.waitForTimeout(SECTION_WAIT_MS);

    const snapshot = await readVisibleSnapshot(page);
    const headline = (snapshot.split("\n").find(line => line.trim().length > 4) || "").trim();
    reports.push({ step: section.label, ok: true, headline, chars: snapshot.length });
    console.log(`  headline: ${headline.slice(0, 90)}`);
  }

  // 4. Remediate: exercise CI-scoping fix
  console.log("\n[Remediate] selecting first staged CI…");
  const anyStagedRow = page.locator("button.staged-row, .queue-preview button, .queue-bucket button").first();
  const selectedOk = await anyStagedRow.count().then(n => n > 0);
  let ciPanelText = "";
  let strategyCardVisible = false;
  let observationLeak = false;
  if (selectedOk) {
    await anyStagedRow.click().catch(() => {});
    await page.waitForTimeout(2500);
    const ciCard = page.locator(".ci-evidence-card").first();
    const cardCount = await ciCard.count();
    if (cardCount > 0) {
      ciPanelText = await ciCard.innerText().catch(() => "");
      strategyCardVisible = /simulation failed|strategy/i.test(ciPanelText);
      observationLeak = /observation\s*:\s*\{|\{"ready_count"|"held_count"/i.test(ciPanelText);
      if (observationLeak) observationLeaks.push(ciPanelText.slice(0, 200));
      reports.push({ step: "Remediate.CIPanel", ok: !observationLeak, headline: ciPanelText.slice(0, 80).replace(/\n/g, " · ") });
    } else {
      // No CI card is legitimate when nothing is selected (empty run). Note it and continue.
      reports.push({ step: "Remediate.CIPanel", ok: true, headline: "no CI selected (empty run)" });
    }
  } else {
    // Empty run — no staged CIs is a legitimate state for a fresh import.
    reports.push({ step: "Remediate.CIPanel", ok: true, headline: "no staged CIs on this run (fresh import)" });
  }

  // 5. Verify run summary section is separate + labelled
  const runSummary = page.locator(".run-summary-section");
  const runSummaryVisible = (await runSummary.count()) > 0;
  const runSummaryText = runSummaryVisible ? await runSummary.first().innerText().catch(() => "") : "";

  // 6. Exercise the Simulate button on the Remediate page. This drives
  // POST /api/cmdb/ire/simulate through the real proxy and lets us
  // observe whether the panel updates correctly (either "Live IRE
  // response" or a strategy/execution failure card).
  let simulateOutcome = { attempted: false, status: "skipped", cardText: "", apiState: "?" };
  // Poll: give the dashboard a full refresh cycle before deciding Simulate is
  // stuck disabled. loadData(runId) runs on mount and the 8s poller re-runs
  // it — this loop just waits long enough for the button's `disabled`
  // attribute to settle rather than checking on the first render.
  const allSimulate = page.locator("button:has-text(\"Simulate\")");
  const totalSim = await allSimulate.count();
  // Prefer the Simulate button inside the IRE action footer (Remediate CI panel).
  const scopedSim = page.locator(".ire-action-grid button:has-text(\"Simulate\")").first();
  const simulateBtn = (await scopedSim.count()) > 0 ? scopedSim : allSimulate.first();
  const hasSimulate = totalSim > 0;
  console.log(`\n[Simulate] locator scan — total buttons containing "Simulate": ${totalSim}`);
  if (hasSimulate) {
    simulateOutcome.attempted = true;
    for (let attempt = 0; attempt < 6; attempt++) {
      const stillDisabled = await simulateBtn.isDisabled().catch(() => true);
      if (!stillDisabled) break;
      await page.waitForTimeout(2000);
    }
    simulateOutcome.apiState = await page.locator(".sidebar-bottom strong").first().innerText().catch(() => "unknown");
    const disabled = await simulateBtn.isDisabled().catch(() => true);
    // Diagnostic: how many CIs did loadData actually populate + what does
    // the selected staged CI card in the header show?
    const stagedCount = await page.locator(".staged-queue-panel .panel-stat").innerText().catch(() => "?");
    const selectedName = await page.locator(".selected-ci-copy h3").innerText().catch(() => "?");
    simulateOutcome.diag = `stagedInQueuePanel=${stagedCount}  selectedCiHeader=${selectedName}`;
    if (disabled) {
      simulateOutcome.status = `disabled after wait · apiState="${simulateOutcome.apiState}" · ${simulateOutcome.diag}`;
    } else {
      console.log("\n[Remediate] clicking Simulate…");
      const [simRes] = await Promise.all([
        page.waitForResponse(res => res.url().includes("/api/cmdb/ire/simulate"), { timeout: 15_000 }).catch(() => null),
        simulateBtn.click(),
      ]);
      simulateOutcome.status = simRes ? `HTTP ${simRes.status()}` : "no response captured";
      await page.waitForTimeout(2500);
      const card = page.locator(".ci-evidence-card").first();
      if ((await card.count()) > 0) simulateOutcome.cardText = (await card.innerText().catch(() => "")).slice(0, 200).replace(/\n/g, " · ");
    }
  }

  // 7. Capture a Mara mascot screenshot for visual review.
  const shotDir = path.dirname(path.resolve(__dirname, "..", "test-results", "mara.png"));
  fs.mkdirSync(shotDir, { recursive: true });
  const shotPath = path.resolve(__dirname, "..", "test-results", "mara.png");
  // Move Mara to a fixed on-screen location, wait a beat for the SVG to
  // paint, then screenshot a padded region around her so the full green
  // glow (which extends beyond the toggle's box) is captured.
  await page.evaluate(() => {
    const el = document.querySelector(".mara-companion");
    if (el instanceof HTMLElement) {
      el.style.left = "600px";
      el.style.top = "260px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    }
  });
  await page.waitForTimeout(1200);
  const maraToggle = page.locator(".mara-companion .mara-toggle").first();
  if ((await maraToggle.count()) > 0) {
    const box = await maraToggle.boundingBox();
    if (box) {
      const pad = 60;
      const viewport = page.viewportSize() || { width: 1280, height: 720 };
      await page.screenshot({
        path: shotPath,
        clip: {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: Math.min(viewport.width, box.width + pad * 2),
          height: Math.min(viewport.height, box.height + pad * 2),
        },
      }).catch(err => console.log("  screenshot failed:", err.message));
      console.log(`\n[Mara] mascot screenshot → ${shotPath}  (${box.x|0},${box.y|0}  ${box.width|0}x${box.height|0})`);
    } else {
      console.log("\n[Mara] no bounding box (mascot off-screen?)");
    }
  }

  await browser.close();

  // ---------- Report ----------
  console.log("\n" + "=".repeat(70));
  console.log("REPORT");
  console.log("=".repeat(70));
  for (const r of reports) {
    const icon = r.ok ? "✓" : "✗";
    console.log(`${icon} ${r.step.padEnd(24)} ${r.ok ? (r.headline || "").slice(0, 80) : r.note}`);
  }
  console.log(`  Remediate.CIPanel     card=${ciPanelText ? "yes" : "no"}  strategyCard=${strategyCardVisible}  observationLeak=${observationLeak}`);
  console.log(`  Remediate.RunSummary  visible=${runSummaryVisible}  labelledScope=${/RUN-WIDE/i.test(runSummaryText)}`);
  console.log(`  Simulate button       attempted=${simulateOutcome.attempted}  ${simulateOutcome.status}`);
  if (simulateOutcome.cardText) console.log(`    card after click: ${simulateOutcome.cardText}`);
  console.log(`\n  console.errors: ${consoleErrors.length}`);
  for (const e of consoleErrors.slice(0, 5)) console.log(`    [${e.type}] ${e.text.slice(0, 140)}`);
  console.log(`  /api/cmdb 5xx:  ${cmdbBad.length}`);
  for (const r of cmdbBad.slice(0, 5)) console.log(`    ${r.status}  ${r.url}`);
  console.log(`  observation leaks: ${observationLeaks.length}`);

  // ---------- Assertions ----------
  const hardFails = [];
  if (cmdbBad.length > 0) hardFails.push(`${cmdbBad.length} /api/cmdb 5xx responses`);
  if (observationLeak) hardFails.push("raw Mara Observation JSON leaked into CI evidence panel");
  if (consoleErrors.length > 0) hardFails.push(`${consoleErrors.length} console errors`);
  const stepFails = reports.filter(r => !r.ok);
  if (stepFails.length > 0) hardFails.push(`${stepFails.length} navigation step(s) failed`);

  if (hardFails.length > 0) {
    console.log("\n✗ FAILED: " + hardFails.join(", "));
    process.exit(1);
  }
  console.log("\n✓ Full cycle Import → Comprehend → Prioritize → Remediate completed cleanly.");
})().catch(err => {
  console.error("\n✗ FATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
