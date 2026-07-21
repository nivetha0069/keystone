// Quick screenshot helper: boot the dashboard on the populated run, wait
// for it to settle, and dump full-page shots of the key pages into
// test-results/ so we can eyeball the factory styling.

const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("@playwright/test");

const BASE = process.env.KEYSTONE_URL || "http://localhost:3000";
// The run the user was staring at when they hit the strategy failure —
// Exchange Online on cmdb_ci_service, 10 CIs, one BLOCKED bucket.
const RUN = process.env.KEYSTONE_RUN_ID || "e67a61802b528b1060aefba6b891bfd1";

(async () => {
  const outDir = path.resolve(__dirname, "..", "test-results", "factory");
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${BASE}/?run=${RUN}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const sections = ["workspace", "comprehend", "prioritize", "remediate"];
  for (const section of sections) {
    const btn = page.locator(`nav.main-nav button[aria-label^="${section[0].toUpperCase() + section.slice(1)}:"], nav.main-nav button[aria-label*="${section[0].toUpperCase() + section.slice(1)}:"]`).first();
    if ((await btn.count()) > 0) {
      const disabled = await btn.isDisabled().catch(() => true);
      if (!disabled) await btn.click();
    }
    await page.waitForTimeout(2500);
    const shot = path.join(outDir, `${section}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`  ${section} → ${shot}`);
  }

  // On Remediate, click the blocked-bucket item (Exchange Online failed
  // with the strategy error) to prove the StrategyFailureCard renders.
  const blockedRow = page.locator(".queue-bucket.blocked .queue-preview button, .queue-bucket.simulation_failed .queue-preview button").first();
  if ((await blockedRow.count()) > 0) {
    await blockedRow.click().catch(() => {});
    await page.waitForTimeout(3000);
    const sim = page.locator(".ire-action-grid button:has-text(\"Simulate\")").first();
    if ((await sim.count()) > 0 && !(await sim.isDisabled().catch(() => true))) {
      const [res] = await Promise.all([
        page.waitForResponse(r => r.url().includes("/api/cmdb/ire/simulate"), { timeout: 15_000 }).catch(() => null),
        sim.click(),
      ]);
      console.log(`  Simulate on blocked CI → ${res ? res.status() : "no response"}`);
      await page.waitForTimeout(3000);
    }
    const shot = path.join(outDir, "remediate-strategy-failure.png");
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`  strategy-failure card → ${shot}`);
  } else {
    console.log("  (no blocked bucket to exercise)");
  }

  // Also grab a fresh Mara screenshot at the new size, tucked on-screen.
  await page.evaluate(() => {
    const el = document.querySelector(".mara-companion");
    if (el instanceof HTMLElement) {
      el.style.left = "600px";
      el.style.top = "260px";
      el.style.right = "auto";
      el.style.bottom = "auto";
    }
  });
  await page.waitForTimeout(1000);
  const maraBox = await page.locator(".mara-companion .mara-toggle").first().boundingBox();
  if (maraBox) {
    const pad = 80;
    await page.screenshot({
      path: path.join(outDir, "mara.png"),
      clip: {
        x: Math.max(0, maraBox.x - pad),
        y: Math.max(0, maraBox.y - pad),
        width: maraBox.width + pad * 2,
        height: maraBox.height + pad * 2,
      },
    });
    console.log(`  mara → ${path.join(outDir, "mara.png")}`);
  }

  await browser.close();
})();
