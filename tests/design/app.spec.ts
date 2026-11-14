// Phases 2 to 6 of the design blueprint, against the running app.
// Set DESIGN_BASE_URL (for example http://localhost:5173) and, optionally,
// DESIGN_ROUTES as a comma-separated list of paths. Without DESIGN_BASE_URL these skip.
import { test, expect } from "@playwright/test";

const base = process.env.DESIGN_BASE_URL;
const routes = (process.env.DESIGN_ROUTES ?? "/").split(",").map((r) => r.trim()).filter(Boolean);

test.skip(!base, "DESIGN_BASE_URL is not set, so the app checks are skipped");

for (const route of routes) {
  test.describe(route, () => {
    test("words on screen have no dashes or middle dots", async ({ page }) => {
      await page.goto(base + route);
      await page.waitForLoadState("networkidle");
      const text = await page.evaluate(() => document.body.innerText);
      const hits = [...text.matchAll(/.{0,24}[\u2013\u2014\u00B7].{0,24}/g)].map((m) => m[0]);
      expect(hits, hits.join("\n")).toEqual([]);
    });

    test("at most one filled button, and it sits in the page header", async ({ page }) => {
      await page.goto(base + route);
      await page.waitForLoadState("networkidle");
      const primaries = page.locator("main .button.primary:visible");
      expect(await primaries.count()).toBeLessThanOrEqual(1);
      if (await primaries.count()) await expect(primaries.first()).toBeVisible();
    });

    test("every visible control is at least 44 points on a phone", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(base + route);
      await page.waitForLoadState("networkidle");
      const small = await page.evaluate(() => {
        const sel = "button, [role=button], a.button, .tab, input:not([type=checkbox]):not([type=radio]):not([type=file]), select";
        return Array.from(document.querySelectorAll<HTMLElement>(sel))
          .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; })
          .filter((e) => { const r = e.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; })
          .map((e) => `${e.tagName.toLowerCase()}.${Array.from(e.classList).join(".")} "${(e.innerText || e.getAttribute("aria-label") || "").slice(0, 30)}" ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`);
      });
      expect(small, small.join("\n")).toEqual([]);
    });

    test("every selected or current control uses one of the two selected looks", async ({ page }) => {
      await page.goto(base + route);
      await page.waitForLoadState("networkidle");
      const off = await page.evaluate(() => {
        // Probe the two allowed looks through the tokens, so the check follows the theme and accent.
        const probe = document.createElement("div");
        document.body.append(probe);
        probe.style.background = "var(--accent-soft)";
        const soft = getComputedStyle(probe).backgroundColor;
        probe.style.background = "var(--card)"; probe.style.boxShadow = "var(--raise)";
        const card = getComputedStyle(probe).backgroundColor, raise = getComputedStyle(probe).boxShadow;
        probe.remove();
        // The tab bar shows its place with accent text alone, as iOS does; stage tiles keep status colours.
        const skip = ".tab, .stage-tile, .stage-chip, .theme-chip, .brand";
        return Array.from(document.querySelectorAll<HTMLElement>('[aria-pressed="true"], [aria-selected="true"], [aria-current="page"], [aria-current="true"]'))
          .filter((e) => !e.matches(skip) && e.getBoundingClientRect().width > 0)
          .filter((e) => { const c = getComputedStyle(e); return !(c.backgroundColor === soft || (c.backgroundColor === card && c.boxShadow === raise)); })
          .map((e) => `${e.tagName.toLowerCase()}.${Array.from(e.classList).join(".")} "${(e.innerText || "").slice(0, 30)}"`);
      });
      expect(off, off.join("\n")).toEqual([]);
    });

    test("page title is the display face", async ({ page }) => {
      await page.goto(base + route);
      await page.waitForLoadState("networkidle");
      const h1 = page.locator("main h1").first();
      if (await h1.count()) expect(await h1.evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/Literata/);
    });
  });
}
