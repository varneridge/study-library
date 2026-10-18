"""Version 0.13: one theme for the whole app. Light, sepia and dark each
colour every screen, the reader's panels and the pages.

Run after test_sessions.py, which leaves a module with readings."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
shots = str(HERE / "shots" / "themes")

EXPECT = {
    "light": {"paper": "rgb(252, 252, 251)", "chrome": "rgb(247, 247, 245)", "page": "rgb(255, 255, 255)"},
    "sepia": {"paper": "rgb(251, 242, 232)", "chrome": "rgb(247, 236, 224)", "page": "rgb(255, 241, 229)"},
    "dark": {"paper": "rgb(23, 25, 28)", "chrome": "rgb(27, 29, 32)", "page": "rgb(26, 28, 31)"},
}


def bg(page, selector):
    return page.evaluate(f"getComputedStyle(document.querySelector({selector!r})).backgroundColor")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 860})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "/?v=settings")
    expect(page.get_by_role("heading", name="Appearance")).to_be_visible()

    for name in ("Sepia", "Dark", "Light"):
        key = name.lower()
        want = EXPECT[key]
        page.goto(BASE + "/?v=settings")
        page.get_by_role("group", name="Appearance").get_by_role("button", name=name).click()
        expect(page.locator("html")).to_have_attribute("data-theme", key)
        assert bg(page, "body") == want["paper"], (name, bg(page, "body"))
        page.screenshot(path=f"{shots}-{key}-1-settings.png")

        page.goto(BASE + "/")
        page.locator(".module-row").first.click()
        page.locator("#week-AT1 .week-title").click()
        assert bg(page, "body") == want["paper"]
        page.screenshot(path=f"{shots}-{key}-2-week.png")

        # The reader: toolbar, sidebar and the pages all take the theme.
        page.locator("li.reading a.name").first.click()
        page.wait_for_selector(".pdf-page canvas")
        page.wait_for_timeout(600)
        assert bg(page, ".reader-bar") == want["chrome"], (name, bg(page, ".reader-bar"))
        assert bg(page, ".pane.left") == want["chrome"], (name, bg(page, ".pane.left"))
        assert bg(page, ".pdf-page") == want["page"], (name, bg(page, ".pdf-page"))
        page.screenshot(path=f"{shots}-{key}-3-reader.png")

        # Text layout too.
        page.get_by_role("button", name="Appearance").click()
        page.get_by_role("group", name="Layout").get_by_role("button", name="Text").click()
        page.keyboard.press("Escape")
        expect(page.locator(".text-view")).to_be_visible(timeout=15000)
        assert bg(page, ".text-view") == want["page"], (name, bg(page, ".text-view"))
        page.screenshot(path=f"{shots}-{key}-4-text.png")
        page.get_by_role("button", name="Appearance").click()
        page.get_by_role("group", name="Layout").get_by_role("button", name="Pages").click()
        page.keyboard.press("Escape")
        print(f"{name}: app, reader toolbar, sidebar, pages and text all match")

    # The reader's Aa sets the same theme for the whole app.
    page.goto(BASE + "/")
    # Recently opened lists notes too; take the first reading.
    page.locator(".recent a.name[href*='v=reader']").first.click()
    page.wait_for_selector(".pdf-page canvas")
    page.get_by_role("button", name="Appearance").click()
    page.get_by_role("group", name="Theme").get_by_role("button", name="Sepia").click()
    page.keyboard.press("Escape")
    page.get_by_role("button", name="Back to the week").click()
    assert bg(page, "body") == EXPECT["sepia"]["paper"]
    print("sepia chosen in the reader colours the week page too")
    page.goto(BASE + "/?v=settings")
    page.get_by_role("group", name="Appearance").get_by_role("button", name="Light").click()
    page.wait_for_timeout(800)

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
