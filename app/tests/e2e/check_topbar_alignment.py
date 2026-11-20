"""Regression check for the top bar's alignment with the page below it.

Renders the app's real styles.css and TabBar.css under the markup TopBar
draws (brand, sync, the three-way switch, Open on desktop, Search, Settings)
above a .page.wide, then runs test_topbar.py's own check_alignment measure at
each width that test uses. Usage: python3 check_topbar_alignment.py [src dir]
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "src"
CSS = (SRC / "styles.css").read_text(encoding="utf-8") + "\n" + (SRC / "components" / "TabBar.css").read_text(encoding="utf-8")
GEAR = open(SRC / "components" / "icons.tsx", encoding="utf-8").read().split("settings: <><path d=\"", 1)[1].split("\"", 1)[0]

ICON = '<svg class="icon" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">{}</svg>'
HTML = f"""<!doctype html><html><head><style>{CSS}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<div><header class="topbar">
  <a class="brand" href="/" aria-current="page">Study Library</a>
  <div class="navs"></div>
  <span class="sync menu"><span class="sync-status is-done" role="img" aria-label="Saved">✓</span></span>
  <nav class="side-switch"><a class="side-study" aria-current="true" href="/">Study</a><a class="to-calendar" href="/?v=calendar">Calendar</a><a class="to-jobs" href="/?v=jobs"><span class="wide-only">Job search</span><span class="narrow-only">Jobs</span></a></nav>
  <nav class="topbar-tools">
    <span class="menu open-desktop"><button type="button" class="topbar-btn open-desktop-btn"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M2.5 3h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 14h4M8 11.5V14" fill="none" stroke="currentColor"/></svg><span>Open on desktop</span><span class="open-desktop-chevron">{ICON.format('<path d="m5 7.5 5 5 5-5"/>').replace('18', '14')}</span></button></span>
    <a class="topbar-btn" href="/?v=search" title="Search (/)"><span class="sr-only">Search</span>{ICON.format('<circle cx="8.75" cy="8.75" r="5.25"/><path d="m12.5 12.5 4.5 4.5"/>')}</a>
    <a class="topbar-btn" href="/?v=settings" title="Settings"><span class="sr-only">Settings</span>{ICON.format(f'<path d="{GEAR}"/><circle cx="10" cy="10" r="2.25"/>')}</a>
  </nav>
</header></div>
<main id="main"><div class="page wide"><h1>Modules</h1>{'<p>Row</p>' * 80}</div></main>
</body></html>"""

# The measure from test_topbar.py's check_alignment, unchanged.
MEASURE = """() => {
  const pageEl = document.querySelector('.page');
  const r = pageEl.getBoundingClientRect(), s = getComputedStyle(pageEl);
  const pageTextLeft = r.left + parseFloat(s.paddingLeft), pageTextRight = r.right - parseFloat(s.paddingRight);
  const brand = document.querySelector('.topbar .brand');
  const range = document.createRange(); range.setStart(brand.firstChild, 0); range.setEnd(brand.firstChild, 1);
  const firstLetterLeft = range.getBoundingClientRect().left;
  const parts = document.querySelectorAll('.topbar-tools .topbar-btn:last-child svg > *');
  const rightEdge = Math.max(...Array.from(parts).map(el => el.getBoundingClientRect().right));
  const leftDiff = Math.abs(firstLetterLeft - pageTextLeft), rightDiff = Math.abs(rightEdge - pageTextRight);
  return { ok: leftDiff <= 2 && rightDiff <= 2, leftDiff, rightDiff, pageTextLeft, firstLetterLeft, pageTextRight, rightEdge };
}"""

failed = 0
with sync_playwright() as p:
    browser = p.chromium.launch()
    for w, h in [(768, 1024), (1024, 768), (1280, 800), (1440, 900)]:
        page = browser.new_page(viewport={"width": w, "height": h})
        page.set_content(HTML)
        res = page.evaluate(MEASURE)
        failed += not res["ok"]
        print(("PASS" if res["ok"] else "FAIL"), w, {k: round(v, 2) if isinstance(v, float) else v for k, v in res.items()})
        page.close()
    browser.close()
sys.exit(1 if failed else 0)
