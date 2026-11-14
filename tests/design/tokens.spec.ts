// Phase 1 of the design blueprint: one press, one scrim, one raise, shared motion timings.
// These run against tests/design/fixture.html, which loads app/src/styles.css directly,
// so they need no server, no database and no sync.
import { test, expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const fixture = pathToFileURL(resolve(__dirname, "fixture.html")).href;

async function pressAndRead(page: Page, sel: string) {
  const box = await page.locator(sel).boundingBox();
  if (!box) throw new Error(`${sel} is not visible`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Let the press transition (--dur-1) finish before reading the settled value.
  await page.waitForTimeout(250);
  const s = await page.locator(sel).evaluate((e) => { const c = getComputedStyle(e); return { scale: c.scale, transform: c.transform }; });
  await page.mouse.up();
  return s;
}

test.describe("press", () => {
  for (const sel of ["#primary", "#secondary", "#quiet", "#icon", "#seg-on", "#chip"]) {
    test(`${sel} shrinks once, to the token`, async ({ page }) => {
      await page.goto(fixture);
      const s = await pressAndRead(page, sel);
      expect(s.transform).toBe("none");
      expect(s.scale).toBe("0.97");
    });
  }
  test("reduced motion removes the shrink", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(fixture);
    for (const sel of ["#secondary", "#chip"]) expect((await pressAndRead(page, sel)).scale).toBe("none");
  });
});

test.describe("floating surfaces", () => {
  test("every modal backdrop is the same scrim", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture);
    const backdrops = await page.evaluate(() => {
      const out: Record<string, string> = {};
      for (const id of ["d-dialog", "d-sheet", "d-choice"]) {
        const d = document.getElementById(id) as HTMLDialogElement; d.showModal();
        out[id] = getComputedStyle(d, "::backdrop").backgroundColor; d.close();
      }
      out["menu-scrim"] = getComputedStyle(document.getElementById("menu-scrim")!).backgroundColor;
      out["dp-scrim"] = getComputedStyle(document.getElementById("dp-scrim")!).backgroundColor;
      return out;
    });
    expect(new Set(Object.values(backdrops)).size, JSON.stringify(backdrops)).toBe(1);
  });

  test("sheets arrive on --dur-3 and --ease-settle, dialogs and notices on --dur-2", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture);
    const t = await page.evaluate(() => {
      const read = (e: Element) => { const c = getComputedStyle(e); return `${c.animationName} ${c.animationDuration} ${c.animationTimingFunction}`; };
      const sheet = document.getElementById("d-sheet") as HTMLDialogElement; sheet.showModal();
      const a = read(sheet); sheet.close();
      return { sheet: a, toast: read(document.getElementById("toast")!) };
    });
    expect(t.sheet).toBe("sheet-in 0.24s cubic-bezier(0.16, 1, 0.3, 1)");
    expect(t.toast).toBe("toast-in 0.18s cubic-bezier(0.16, 1, 0.3, 1)");
  });
});

test.describe("selected", () => {
  test("a segmented choice and the side switch share one raised look, in light and in dark", async ({ page }) => {
    await page.goto(fixture);
    const read = () => page.evaluate(() => [
      getComputedStyle(document.getElementById("seg-on")!).boxShadow,
      getComputedStyle(document.getElementById("side-on")!).boxShadow,
    ]);
    const [segLight, sideLight] = await read();
    expect(segLight).toBe(sideLight);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.waitForTimeout(250); // box-shadow transitions on .tool, so let it settle
    const [segDark, sideDark] = await read();
    expect(segDark).toBe(sideDark);
    expect(segDark, "the raise follows --ink, so it changes with the theme").not.toBe(segLight);
  });
});

test.describe("phone", () => {
  test("controls are at least 44 points at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture);
    for (const sel of ["#primary", "#secondary", "#quiet", "#icon", "#seg-on", "#chip", "#row"]) {
      const b = await page.locator(sel).boundingBox();
      expect(b!.height, sel).toBeGreaterThanOrEqual(43.5);
    }
  });
});
