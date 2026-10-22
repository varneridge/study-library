"""Take top bar screenshots across widths in light and dark."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
shots = HERE / "shots"
shots.mkdir(exist_ok=True)
BASE = sys.argv[1]

WIDTHS = [
    (390, 844, True),
    (768, 1024, False),
    (1024, 768, False),
    (1280, 800, False),
    (1440, 900, False),
]

THEMES = ["light", "dark"]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for w, h, is_mobile in WIDTHS:
        for theme in THEMES:
            page = browser.new_page(
                viewport={"width": w, "height": h},
                is_mobile=is_mobile,
                has_touch=is_mobile,
                color_scheme=theme,
            )
            page.goto(BASE + "/")
            page.evaluate(
                f"""(t) => {{
                    document.documentElement.setAttribute('data-theme', t);
                    localStorage.setItem('theme', t);
                }}""",
                theme,
            )
            page.wait_for_timeout(200)
            page.screenshot(path=str(shots / f"topbar-w{w}-{theme}-home.png"))

            # Navigate to module page if a module exists
            mod = page.locator(".module-row, .modules-nav a").first
            if mod.count() > 0:
                mod.click()
                page.wait_for_timeout(200)
                page.screenshot(path=str(shots / f"topbar-w{w}-{theme}-module.png"))

            if w == 1440:
                page.goto(BASE + "/?v=jobs")
                page.wait_for_timeout(200)
                page.screenshot(path=str(shots / f"topbar-w{w}-{theme}-jobs.png"))

            page.close()
            print(f"Captured top bar at {w}px in {theme}")

    browser.close()
    print("All top bar screenshots captured.")
