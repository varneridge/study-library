// Regression checks for the 0.49.1 job card press, from the pre-commit review.
// The cards in both layouts (.jobs .app-card in the desktop grid and .app-card in the list)
// gained a press scale in 0.49.1. These checks hold that press to the same two rules as
// every other pressed control: it must not shrink under reduced motion, and it must not
// compound with a pressed control inside the card.
import { test, expect, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const fixture = pathToFileURL(resolve(__dirname, "fixture-cards.html")).href;

// Holds the pointer down on sel, lets the --dur-1 transition finish, and returns the
// rendered width of measure divided by its layout width, which is the total visual scale.
async function pressedScale(page: Page, sel: string, measure: string): Promise<number> {
  const box = await page.locator(sel).boundingBox();
  if (!box) throw new Error(`${sel} is not visible`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(250);
  const ratio = await page.locator(measure).evaluate((e) => e.getBoundingClientRect().width / (e as HTMLElement).offsetWidth);
  await page.mouse.up();
  return ratio;
}

test.use({ viewport: { width: 1280, height: 900 } });

test.describe("job card press", () => {
  test("a card still gives the standard press when its own surface is tapped", async ({ page }) => {
    await page.goto(fixture);
    expect(await pressedScale(page, "#grid-head", "#grid-card")).toBeCloseTo(0.97, 2);
  });

  for (const [card, inner] of [["#grid-card", "#grid-inner"], ["#list-card", "#list-inner"]]) {
    test(`pressing ${inner} inside ${card} shrinks the control once, not twice`, async ({ page }) => {
      await page.goto(fixture);
      expect(await pressedScale(page, inner, inner)).toBeGreaterThan(0.96);
    });

    test(`${card} does not shrink under reduced motion`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(fixture);
      const box = await page.locator(card).boundingBox();
      await page.mouse.move(box!.x + 8, box!.y + 8);
      await page.mouse.down();
      const scale = await page.locator(card).evaluate((e) => getComputedStyle(e).scale);
      await page.mouse.up();
      expect(scale).toBe("none");
    });
  }
});
