"""Version 0.27: the phone. A tab bar for the main places that steps aside
for the keyboard, a slim top bar with Go to, 44-point targets, fields that
never make iOS zoom, menus and confirmations as sheets, nothing that needs
hover, swiping between weeks, and an installable app."""
import glob, json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))
shots = str(HERE / "shots" / "mobile")


def until(page, script, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:100])


def swipe(page, dx):
    page.evaluate("""(dx) => {
      const el = document.querySelector('.week-page h1') || document.body;
      const at = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [at(200)], changedTouches: [at(200)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [at(200 + dx)], bubbles: true }));
    }""", dx)


with sync_playwright() as p:
    browser = p.chromium.launch()
    desk = browser.new_page(viewport={"width": 1280, "height": 900})
    desk.request.post(BASE + "/api/dev/reset")
    desk.goto(BASE + "/")
    desk.get_by_label("Code").fill("HY319")
    desk.get_by_label("Title").fill("Napoleon and Europe")
    desk.get_by_role("button", name="Create module").click()
    expect(desk.get_by_role("heading", name="HY319")).to_be_visible()
    desk.get_by_role("link", name="Import readings").click()
    desk.locator("input[type=file][accept]").set_input_files(files)
    desk.get_by_role("button", name="Import 3 files").click()
    until(desk, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.items || []).length === 3; }")
    # The tab bar is only for phones.
    expect(desk.locator(".tab-bar")).to_be_hidden()

    phone = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=3)
    errors = []
    phone.on("pageerror", lambda e: errors.append(str(e)))
    phone.goto(BASE + "/")
    # Wait for the library to arrive on this device.
    expect(phone.locator(".module-row").first).to_be_visible(timeout=20000)
    # Until the library arrives the page shows its first-module form, whose
    # field has the cursor and so hides the bar; it comes back once the
    # modules are in.
    expect(phone.locator(".module-row").first).to_be_visible()

    # The tab bar: four labelled places, Home lit, at the foot of the screen.
    bar = phone.locator(".tab-bar")
    expect(bar).to_be_visible()
    assert bar.locator(".tab").all_inner_texts() == ["Home", "This week", "Search", "Settings"], bar.locator(".tab").all_inner_texts()
    expect(bar.locator(".tab.on")).to_have_text("Home")
    box = bar.bounding_box()
    assert abs(box["y"] + box["height"] - 844) < 1, box
    for tab in bar.locator(".tab").all():
        b = tab.bounding_box()
        assert b["height"] >= 44 and b["width"] >= 44, b
    # The top bar keeps the brand, Go to and Jobs; the module links go.
    expect(phone.locator(".topbar .navs")).to_be_hidden()
    expect(phone.locator(".topbar .goto-button")).to_be_visible()
    expect(phone.locator(".topbar a.to-jobs")).to_be_visible()
    # Nothing sits behind the tab bar: the page leaves room for it.
    pad = phone.evaluate("parseFloat(getComputedStyle(document.querySelector('#main')).paddingBottom)")
    assert pad >= box["height"] - 1, (pad, box)
    phone.screenshot(path=f"{shots}-1-home.png")
    print("tab bar: Home, This week, Search, Settings; top bar slimmed to brand, Go to and Jobs")

    # Each tab goes to its place and lights up; pages inside a section keep Home lit.
    bar.get_by_text("This week").tap()
    expect(phone.get_by_role("heading", name="Week across modules")).to_be_visible()
    expect(bar.locator(".tab.on")).to_have_text("This week")
    bar.get_by_text("Search").tap()
    expect(bar.locator(".tab.on")).to_have_text("Search")
    # The keyboard waits for a tap on the field, as in iOS's own search.
    expect(phone.get_by_label("Search", exact=True)).not_to_be_focused()
    bar.get_by_text("Settings").tap()
    expect(phone.get_by_role("heading", name="Settings")).to_be_visible()
    bar.get_by_text("Home").tap()
    phone.locator(".module-row").first.tap()
    expect(bar.locator(".tab.on")).to_have_text("Home")
    print("each tab opens its place; a module page keeps Home lit")

    # The module page lists weeks only, each a full-width target.
    expect(phone.locator(".week-head .session-link").first).to_be_hidden()
    assert phone.locator("#week-AT1 .week-title").bounding_box()["height"] >= 44
    phone.locator("#week-AT1 .week-title").tap()
    expect(phone.locator(".week-page")).to_be_visible()

    # Typing: a field with the cursor puts the tab bar away for the keyboard.
    phone.locator(".question-row.adder textarea").tap()
    expect(bar).to_be_hidden()
    font = phone.evaluate("parseFloat(getComputedStyle(document.activeElement).fontSize)")
    assert font >= 16, font
    phone.keyboard.type("How far was the Napoleonic state new?")
    phone.evaluate("document.activeElement.blur()")
    expect(bar).to_be_visible()
    print("the tab bar steps aside while typing; the field is 16px, so iOS will not zoom")

    # Questions carry no evidence link; the answer is written beneath them.
    phone.wait_for_timeout(800)
    expect(phone.locator(".question-row a.question-open")).to_have_count(0)
    print("questions on a phone: no evidence link")

    # A reading's menu is a sheet from the foot of the screen, with Cancel.
    row = phone.locator(".week-page li.reading").first
    row.get_by_role("button", name="More actions").tap()
    sheet = phone.locator(".menu-panel")
    expect(sheet).to_be_visible()
    s = sheet.bounding_box()
    assert abs(s["y"] + s["height"] - 844) < 2 and s["width"] >= 389, s
    for item in sheet.get_by_role("menuitem").all():
        assert item.bounding_box()["height"] >= 44
    phone.screenshot(path=f"{shots}-2-sheet.png")
    sheet.get_by_role("menuitem", name="Cancel").tap()
    expect(sheet).to_have_count(0)
    # Tapping the dimmed page closes it too.
    row.get_by_role("button", name="More actions").tap()
    phone.locator(".menu-backdrop").tap(position={"x": 195, "y": 100})
    expect(phone.locator(".menu-panel")).to_have_count(0)
    print("menus rise from the foot of the screen, with Cancel, and close on a tap outside")

    # Swipe left for the next week, right to come back.
    swipe(phone, -160)
    expect(phone.locator(".crumbs")).to_contain_text("AT2")
    swipe(phone, 160)
    expect(phone.locator(".crumbs")).to_contain_text("AT1")
    # A mostly vertical drag is a scroll, not a swipe.
    phone.evaluate("""() => { const el = document.querySelector('.week-page h1');
      const at = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [at(200, 500)], changedTouches: [at(200, 500)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [at(120, 300)], bubbles: true })); }""")
    phone.wait_for_timeout(400)
    expect(phone.locator(".crumbs")).to_contain_text("AT1")
    print("swiping moves between weeks; a vertical drag does not")

    # The reader's toolbar: every control a full target, its page box 16px.
    phone.locator(".week-page li.reading a.name").first.tap()
    phone.wait_for_selector(".reader-bar")
    phone.wait_for_timeout(1500)
    expect(phone.locator(".tab-bar")).to_have_count(0)
    small = phone.evaluate("""() => [...document.querySelectorAll('.reader-bar button')].filter(b => b.offsetParent)
      .map(b => b.getBoundingClientRect()).filter(r => r.width < 43.5 || r.height < 43.5).length""")
    assert small == 0, small
    phone.screenshot(path=f"{shots}-3-reader.png")
    print("reader: no tab bar, every toolbar button 44 points")

    # Highlighting with a finger, in text layout: a rough selection docks the
    # colours at the foot of the screen, and Whole sentence widens it.
    if phone.locator(".text-view").count() == 0:
        phone.get_by_role("button", name="Appearance").tap()
        phone.get_by_role("group", name="Layout").get_by_role("button", name="Text").tap()
        phone.keyboard.press("Escape")
    phone.wait_for_selector(".text-view p")
    phone.evaluate("""() => {
      const p = [...document.querySelectorAll('.text-view p')].find(x => (x.textContent || '').split('. ').length > 2);
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let node = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!node || n.data.length > node.data.length) node = n;
      const mid = node.data.indexOf(' ', Math.floor(node.data.length / 3));
      const range = document.createRange(); range.setStart(node, mid + 1); range.setEnd(node, mid + 6);
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    }""")
    bar_ = phone.locator(".touch-bar")
    expect(bar_).to_be_visible(timeout=3000)
    tb = bar_.bounding_box()
    assert abs(tb["y"] + tb["height"] - 844) < 2 and tb["width"] >= 389, tb
    assert phone.locator(".floating").count() == 0
    # The selection stays in view above the bar, not behind it.
    phone.wait_for_timeout(1500)
    gap = phone.evaluate("document.querySelector('.touch-bar').getBoundingClientRect().top - document.getSelection().getRangeAt(0).getBoundingClientRect().bottom")
    assert gap >= 0, gap
    rough = phone.evaluate("document.getSelection().toString()")
    bar_.get_by_role("button", name="Whole sentence").tap()
    sentence = phone.evaluate("document.getSelection().toString()")
    assert len(sentence) > len(rough) and sentence.rstrip().endswith((".", "?", "!", "\u2019", "\"")), (rough, sentence)
    for b_ in bar_.locator(".touch-swatch").all():
        assert b_.bounding_box()["height"] >= 44
    phone.screenshot(path=f"{shots}-4-highlight.png")
    bar_.get_by_role("button", name="Highlight yellow").tap()
    saved = until(phone, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); const h = (j.rows.highlights || []).filter(h => !h.deleted); return h.length ? h[h.length - 1].body : null; }")
    assert saved.strip().endswith((".", "?", "!")) and len(saved) > len(rough) + 10, saved
    print("highlighting by finger: colours docked at the foot, Whole sentence widened", repr(rough), "to", repr(saved[:60] + "..."))

    # Highlight popover on phone is a sheet with dialog semantics, focus management and Escape dismissal
    sheet = phone.locator(".highlight-sheet[role='dialog']")
    expect(sheet).to_be_visible()
    expect(sheet).to_have_attribute("aria-modal", "true")
    expect(sheet).to_have_attribute("aria-label", "Highlight")
    in_dialog = phone.evaluate("Boolean(document.activeElement && document.activeElement.closest('.highlight-sheet'))")
    assert in_dialog, "Focus should move into the highlight sheet"
    phone.keyboard.press("Escape")
    expect(sheet).to_have_count(0)

    # Reopening the highlight sheet by tapping the highlight mark; closing restores focus to the mark
    phone.wait_for_selector(".text-view mark.hl-text")
    hl_mark = phone.locator(".text-view mark.hl-text").first
    hl_mark.focus()
    hl_mark.tap()
    expect(sheet).to_be_visible()
    phone.keyboard.press("Escape")
    expect(sheet).to_have_count(0)
    focused_is_mark = phone.evaluate("Boolean(document.activeElement && document.activeElement.matches('mark.hl-text'))")
    assert focused_is_mark, "Focus should return to the highlight mark after Escape"
    print("mobile highlight popover: sheet with dialog semantics, focus moved in and back, closed with Escape")

    # Go to from the top bar, closed with one tap of Cancel or the backdrop.
    phone.goto(BASE + "/")
    phone.locator(".topbar .goto-button").tap()
    expect(phone.locator("dialog.palette[open]")).to_have_count(1)
    phone.keyboard.press("Escape")
    expect(phone.locator("dialog.palette[open]")).to_have_count(0)

    # Installable: the manifest has its shortcuts, iOS has its icon and title.
    manifest = json.loads(phone.request.get(BASE + "/manifest.webmanifest").text())
    assert [s["name"] for s in manifest["shortcuts"]] == ["This week", "Search", "Job search"], manifest["shortcuts"]
    assert manifest["display"] == "standalone" and manifest["theme_color"] == "#FCFCFB"
    assert phone.request.get(BASE + "/apple-touch-icon.png").ok
    assert phone.locator("meta[name='apple-mobile-web-app-title']").get_attribute("content") == "Library"
    print("installable: shortcuts, a 180-pixel icon and a home-screen title")

    assert not errors, errors
    print("ok")
    browser.close()
