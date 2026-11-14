// Page-level design checks from the 0.49.2 pages audit. They run against
// tests/design/fixture-pages.html, which loads app/src/styles.css directly, so they need
// no server, no database and no sync. Each test names the finding it guards.
import { test, expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const fixture = pathToFileURL(resolve(__dirname, "fixture-pages.html")).href;
const phone = { width: 390, height: 844 };

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function box(page: Page, sel: string): Promise<Box> {
  const b = await page.locator(sel).boundingBox();
  if (!b) throw new Error(`${sel} is not visible`);
  return b;
}

test.describe("the foot of a phone screen", () => {
  test("the settings save bar sits above the tab bar, not over it", async ({ page }) => {
    await page.setViewportSize(phone);
    await page.goto(fixture);
    expect(overlaps(await box(page, "#save-bar"), await box(page, "#tabs"))).toBe(false);
  });

  test("a notice never covers the save bar", async ({ page }) => {
    await page.setViewportSize(phone);
    await page.goto(fixture);
    expect(overlaps(await box(page, "#save-bar"), await box(page, "#toast"))).toBe(false);
  });

  test("while recording, the save bar and notices clear the recording bar", async ({ page }) => {
    await page.setViewportSize(phone);
    await page.goto(fixture);
    await page.evaluate(() => { document.body.classList.add("recording-active"); document.getElementById("rec")!.style.display = ""; });
    const rec = await box(page, "#rec"), bar = await box(page, "#save-bar"), toast = await box(page, "#toast");
    expect(overlaps(bar, rec)).toBe(false);
    expect(overlaps(toast, rec)).toBe(false);
    expect(overlaps(toast, bar)).toBe(false);
  });
});

test.describe("touch targets", () => {
  test("every week in the picker is at least 44 points wide on a phone, and the page never scrolls sideways", async ({ page }) => {
    await page.setViewportSize(phone);
    await page.goto(fixture);
    const widths = await page.locator("#picker button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(43.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(phone.width);
  });

  test("the search kinds fit across a phone with nothing hidden off the edge", async ({ page }) => {
    await page.setViewportSize(phone);
    await page.goto(fixture);
    const fit = await page.locator("#kinds").evaluate((e) => e.scrollWidth <= e.clientWidth + 1);
    expect(fit).toBe(true);
  });
});

test.describe("renaming in place", () => {
  for (const viewport of [phone, { width: 1280, height: 900 }]) {
    test(`the title field wears the title's own type at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(fixture);
      const read = (sel: string) => page.locator(sel).evaluate((e) => { const c = getComputedStyle(e); return `${c.fontFamily} ${c.fontSize} ${c.fontWeight}`; });
      expect(await read("#edit1 input")).toBe(await read("#h1"));
      expect(await read("#edit2 input")).toBe(await read("#h2"));
    });
  }
});

test.describe("one look for each meaning", () => {
  test("a dangerous button is a soft red surface, never an outline, in light and dark", async ({ page }) => {
    await page.goto(fixture);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(250);
      const look = await page.locator("#danger").evaluate((e) => { const c = getComputedStyle(e); return { border: c.borderTopColor, bg: c.backgroundColor }; });
      expect(look.border, theme).toBe("rgba(0, 0, 0, 0)");
      expect(look.bg, theme).not.toBe("rgba(0, 0, 0, 0)");
    }
  });

  test("the current settings section uses the selected look", async ({ page }) => {
    await page.goto(fixture);
    const [bg, soft] = await page.evaluate(() => {
      const probe = document.createElement("div"); probe.style.background = "var(--accent-soft)"; document.body.append(probe);
      const s = getComputedStyle(probe).backgroundColor; probe.remove();
      return [getComputedStyle(document.getElementById("nav-on")!).backgroundColor, s];
    });
    expect(bg).toBe(soft);
  });

  test("in sepia, the selected fill still reads against the page", async ({ page }) => {
    await page.goto(fixture);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "sepia"));
    const ratio = await page.evaluate(() => {
      const rgb = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      const lum = (hex: string) => {
        const n = hex.replace("#", ""); const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
          .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      };
      const a = lum(rgb("--accent-soft")), b = lum(rgb("--paper"));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(1.12);
  });
});
