"""Regression check for test_topbar.py's helpers against the app's real CSS.

Lifts check_alignment, check_single_line_and_height, check_minimum_gaps,
check_pills, check_switch, check_tab_order and TOOLS_ORDER out of
test_topbar.py unchanged and runs them on the markup TopBar draws for the
home, module and job search bars, at each width test_topbar.py uses. It needs
no server. The module bar at 768px is left out: there the bar overflows by
about 15px and the module links shrink to nothing, an app layout issue
reported separately rather than asserted here.
Usage: python3 check_topbar_helpers.py [test_topbar.py] [src dir]
"""
import ast, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
HERE = Path(__file__).resolve().parent
TEST = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "test_topbar.py"
SRC = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE.parents[1] / "src"
tree = ast.parse(TEST.read_text(encoding="utf-8"))
want = {"check_alignment", "check_single_line_and_height", "check_minimum_gaps", "check_tab_order", "check_pills", "check_switch"}
nodes = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in want) or (isinstance(n, ast.Assign) and any(getattr(t, "id", "") == "TOOLS_ORDER" for t in n.targets))]
ns = {"expect": expect}; exec(compile(ast.Module(nodes, []), "helpers", "exec"), ns)
CSS = (SRC/"styles.css").read_text(encoding="utf-8") + (SRC/"components"/"TabBar.css").read_text(encoding="utf-8")
GEAR = (SRC/"components"/"icons.tsx").read_text(encoding="utf-8").split('settings: <><path d="',1)[1].split('"',1)[0]
I = '<svg class="icon" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">{}</svg>'
def page_html(kind):
    brand = {"home": '<a class="brand" href="/" aria-current="page">Study Library</a>',
             "module": '<a class="brand" href="/">Study Library</a>',
             "jobs": '<a class="brand" href="/j" aria-current="page">Job search</a>'}[kind]
    navs = ('<div class="navs"><span class="topbar-sep"></span><nav class="modules-nav"><a href="/m1" aria-current="page">HY116</a><a href="/m2">HY240</a><a href="/m3">HY300</a></nav></div>'
            if kind == "module" else ('<div class="navs"></div>' if kind == "home" else ""))
    study, jobs = ('', ' aria-current="true"') if kind == "jobs" else (' aria-current="true"', '')
    bar = "topbar jobs-bar wide" if kind == "jobs" else "topbar"
    pg = "page wide jobs" if kind == "jobs" else "page wide"
    return f"""<!doctype html><html><head><style>{CSS}</style></head><body><a class="skip" href="#main">Skip to content</a>
<div><header class="{bar}">{brand}{navs}
<span class="sync menu"><button type="button" class="topbar-btn sync-indicator" aria-label="Saved">{I.format('<circle cx="10" cy="10" r="6"/>')}</button></span>
<nav class="side-switch"><a class="side-study"{study} href="/">Study</a><a class="to-calendar" href="/c">Calendar</a><a class="to-jobs"{jobs} href="/j"><span class="wide-only">Job search</span><span class="narrow-only">Jobs</span></a></nav>
<nav class="topbar-tools"><span class="menu open-desktop"><button type="button" class="topbar-btn open-desktop-btn"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 3h12v8H2z"/></svg><span>Open on desktop</span><span class="open-desktop-chevron">{I.format('<path d="m5 7.5 5 5 5-5"/>')}</span></button></span>
<a class="topbar-btn" href="/s" title="Search (/)"><span class="sr-only">Search</span>{I.format('<circle cx="8.75" cy="8.75" r="5.25"/>')}</a>
<a class="topbar-btn" href="/st" title="Settings"><span class="sr-only">Settings</span>{I.format(f'<path d="{GEAR}"/>')}</a></nav>
</header></div><main id="main"><div class="{pg}"><h1>Page</h1></div></main></body></html>"""
T = ns["TOOLS_ORDER"]
with sync_playwright() as p:
    b = p.chromium.launch()
    for w, h in [(768, 1024), (1024, 768), (1280, 800), (1440, 900)]:
        for kind, order, pills, brand_cur, side in [
            ("home", [".brand"] + T, 0, True, "study"),
            ("module", [".brand"] + [f".modules-nav a:nth-child({i})" for i in (1, 2, 3)] + T, 1, False, "study"),
            ("jobs", [".brand"] + T, 0, True, "jobs")]:
            if kind == "module" and w == 768:
                continue
            pg = b.new_page(viewport={"width": w, "height": h}); pg.set_content(page_html(kind)); pg.evaluate("document.documentElement.style.setProperty('--topbar-h', document.querySelector('.topbar').offsetHeight + 'px')")
            ns["check_single_line_and_height"](pg); ns["check_alignment"](pg, is_jobs=(kind == "jobs")); ns["check_minimum_gaps"](pg)
            ns["check_pills"](pg, expected_pill_count=pills, brand_current=brand_cur); ns["check_switch"](pg, side)
            ns["check_tab_order"](pg, order)
            pg.close()
        print("PASS", w, "home and jobs" if w == 768 else "home, module and jobs")
    print("not checked: module bar at 768px (known overflow, see report)")
    b.close()
