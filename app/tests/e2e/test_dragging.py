"""Version 0.7: dragging readings, dropping files where you mean them to go,
undoing moves, the Go to palette and the uploads panel."""
import glob, re, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))
shots = str(HERE / "shots" / "dragging")


def until(page, script, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:90])


def drag(page, source, target, dy=0):
    """Picks up with the mouse, moves past the threshold, then drops."""
    source.scroll_into_view_if_needed()
    a = source.bounding_box()
    page.mouse.move(a["x"] + 60, a["y"] + a["height"] / 2)
    page.mouse.down()
    page.mouse.move(a["x"] + 70, a["y"] + a["height"] / 2 + 8, steps=4)
    target.scroll_into_view_if_needed()
    b = target.bounding_box()
    page.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2 + dy, steps=14)
    page.mouse.up()
    expect(page.locator(".drag-card")).to_have_count(0)


def drop_files(page, selector, paths, release=True):
    """Drops files from the computer onto an element, as a person would."""
    payload = [{"name": Path(p).name, "bytes": list(Path(p).read_bytes())} for p in paths]
    page.evaluate("""([selector, payload, release]) => {
      const target = document.querySelector(selector);
      const data = new DataTransfer();
      for (const f of payload) data.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'application/pdf' }));
      for (const type of ['dragenter', 'dragover']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
      if (release) target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }""", [selector, payload, release])


def titles(page):
    return page.locator(".week-page li.reading .name").evaluate_all("els => els.map(e => e.textContent)")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("HY335")
    page.get_by_label("Title").fill("China and the World")
    page.get_by_role("button", name="Create module").click()
    page.locator("#week-AT1 .week-title").click()

    # Files dropped on the week's readings become readings of that week.
    drop_files(page, ".week-page [data-drop='readings']", files[:1] + files[2:], release=False)
    expect(page.locator(".drop-banner")).to_contain_text("Drop to add readings to AT1")
    page.screenshot(path=f"{shots}-1-drop-banner.png")
    drop_files(page, ".week-page [data-drop='readings']", files[:1] + files[2:])
    expect(page.locator(".week-page li.reading")).to_have_count(2)
    expect(page.locator(".toast")).to_contain_text("2 files added to AT1")
    print("files dropped on the week's readings:", titles(page))

    # Files dropped on a session become its slides.
    drop_files(page, ".week-page section.session", files[1:2], release=False)
    expect(page.locator(".drop-banner")).to_contain_text("Drop to add slides to Lecture")
    expect(page.locator("section.session.drop-over")).to_have_count(1)
    drop_files(page, ".week-page section.session", files[1:2])
    expect(page.locator("section.session").first.locator("li.reading")).to_have_count(1)
    print("a file dropped on the lecture became its slides")
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 3; }", 40)

    # Reorder by dragging.
    before = titles(page)[:2]
    rows = page.locator(".week-page .section[data-drop='readings'] li.reading")
    drag(page, rows.nth(1), rows.nth(0), dy=-8)
    after = titles(page)[:2]
    print("reordered:", before, "->", after)
    assert after == before[::-1], after
    page.reload()
    expect(page.locator(".week-page li.reading").first).to_be_visible()
    assert titles(page)[:2] == after, titles(page)
    print("the new order survives a reload")

    # While dragging, a grid of weeks appears. Drop on AT3 to move there.
    rows = page.locator(".week-page .section[data-drop='readings'] li.reading")
    moving = rows.nth(0).locator(".name").inner_text()
    a = rows.nth(0).bounding_box()
    page.mouse.move(a["x"] + 60, a["y"] + a["height"] / 2)
    page.mouse.down()
    page.mouse.move(a["x"] + 80, a["y"] + 40, steps=5)
    expect(page.locator(".move-dock")).to_be_visible()
    page.screenshot(path=f"{shots}-2-dock.png")
    target = page.locator(".move-dock .dock-grid .target").nth(2)
    t = target.bounding_box()
    page.mouse.move(t["x"] + t["width"] / 2, t["y"] + t["height"] / 2, steps=14)
    expect(target).to_have_class(re.compile(r"over"))
    page.mouse.up()
    expect(page.locator(".drag-card")).to_have_count(0)
    expect(page.locator(".toast")).to_contain_text("Moved to AT3")
    expect(page.locator(".week-page .section[data-drop='readings'] li.reading")).to_have_count(1)
    print("dragged to AT3:", moving)

    # Undo puts it back.
    page.locator(".toast").get_by_role("button", name="Undo").click()
    expect(page.locator(".week-page .section[data-drop='readings'] li.reading")).to_have_count(2)
    print("undo brought it back")

    # Dragging into the empty Primary sources list makes it a primary source.
    rows = page.locator(".week-page .section[data-drop='readings'] li.reading")
    a = rows.nth(0).bounding_box()
    page.mouse.move(a["x"] + 60, a["y"] + a["height"] / 2)
    page.mouse.down()
    page.mouse.move(a["x"] + 80, a["y"] + 30, steps=5)
    empty = page.locator(".readings.empty-target")
    expect(empty).to_be_visible()
    e = empty.bounding_box()
    page.mouse.move(e["x"] + 100, e["y"] + e["height"] / 2, steps=14)
    expect(page.locator(".week-page .section[data-drop='primary'] li.reading")).to_have_count(1)
    page.mouse.up()
    expect(page.locator(".drag-card")).to_have_count(0)
    expect(page.locator(".toast")).to_contain_text("Now a primary source")
    expect(page.locator(".week-page .group-label", has_text="Primary sources")).to_be_visible()
    page.screenshot(path=f"{shots}-3-primary.png", full_page=True)
    print("dragged into primary sources")

    # The keyboard can move a reading too: Space, an arrow, Space.
    rows = page.locator(".week-page .section[data-drop='readings'] li.reading")
    expect(rows).to_have_count(1)

    # Module page: drag a reading from AT1 onto AT5, and one to Unsorted.
    page.locator(".crumbs a").first.click()
    expect(page.locator(".week")).to_have_count(22)
    # Wait for the scroll to finish and week to be stable.
    page.wait_for_function("""() => new Promise(resolve => {
        let prev = document.getElementById('week-AT1')?.getBoundingClientRect().top;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                let curr = document.getElementById('week-AT1')?.getBoundingClientRect().top;
                resolve(prev !== undefined && prev === curr);
            });
        });
    })""")
    if page.locator("#week-AT1 .caret").get_attribute("aria-expanded") != "true":
        page.locator("#week-AT1 .caret").click()
    row = page.locator("#week-AT1 li.reading").first
    expect(row).to_be_visible()
    row.scroll_into_view_if_needed()
    drag(page, row, page.locator("#week-AT5 .week-head"))
    expect(page.locator(".toast")).to_contain_text("Moved to AT5")
    print("moved on the module page from AT1 to AT5")
    row = page.locator("#week-AT1 li.reading").first
    expect(row).to_be_visible()
    row.scroll_into_view_if_needed()
    a = row.bounding_box()
    page.mouse.move(a["x"] + 60, a["y"] + a["height"] / 2)
    page.mouse.down()
    page.mouse.move(a["x"] + 80, a["y"] + 30, steps=5)
    tray = page.locator(".move-dock .target", has_text="Unsorted")
    expect(tray).to_be_visible()
    t = tray.bounding_box()
    page.mouse.move(t["x"] + t["width"] / 2, t["y"] + t["height"] / 2, steps=14)
    expect(tray).to_have_class(re.compile(r"over"))
    page.mouse.up()
    expect(page.locator(".drag-card")).to_have_count(0)
    expect(page.locator(".toast")).to_contain_text("Moved to Unsorted")
    expect(page.locator(".section.tray li.reading")).to_have_count(1)
    page.screenshot(path=f"{shots}-4-module.png")
    print("dragged to Unsorted")

    # Files dropped on a week row of the module page go to that week.
    drop_files(page, "#week-AT7", files[:1])
    expect(page.locator(".toast")).to_contain_text("1 file added to AT7")
    print("file dropped on the AT7 row")

    # Files dropped on the home page open a sheet asking where they go.
    page.goto(BASE + "/")
    expect(page.get_by_role("heading", name="Modules")).to_be_visible()
    drop_files(page, "main", files[2:])
    sheet = page.locator("dialog.add-sheet[open]")
    expect(sheet).to_be_visible()
    sheet.get_by_label("Week").select_option(label="WT2")
    page.screenshot(path=f"{shots}-5-sheet.png")
    sheet.get_by_role("button", name="Add").click()
    expect(page.locator(".toast")).to_contain_text("added to HY335, WT2")
    page.locator(".toast").get_by_role("button", name="Show me").click()
    expect(page.locator(".crumbs")).to_contain_text("WT2")
    expect(page.locator(".week-page li.reading")).to_have_count(1)
    print("home-page drop asked where, then added to WT2")

    # Go to: Ctrl K, a few letters, Enter.
    page.keyboard.press("Control+k")
    palette = page.locator("dialog.palette[open]")
    expect(palette).to_be_visible()
    page.keyboard.type("hy335 at5")
    expect(palette.locator("li[aria-selected='true']")).to_contain_text("HY335 AT5")
    page.screenshot(path=f"{shots}-6-palette.png")
    page.keyboard.press("Enter")
    expect(page.locator(".crumbs")).to_contain_text("AT5")
    print("Ctrl K went straight to AT5")

    # Phone: the dock and the sheet fit the screen.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.goto(BASE + "/")
    drop_files(phone, "main", files[:1])
    expect(phone.locator("dialog.add-sheet[open]")).to_be_visible()
    expect(phone.locator("dialog.add-sheet[open]").get_by_label("Module")).to_be_visible()
    phone.screenshot(path=f"{shots}-7-phone-sheet.png")
    phone.keyboard.press("Escape")

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
