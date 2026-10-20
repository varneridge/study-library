"""Version 0.22: dragging slides between a week's sessions, moving a reading
to another module, the processor's status, and a stale device not undoing
a name found on the server."""
import glob, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))
shots = str(HERE / "shots" / "slides-modules")


def until(page, script, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:90])


def drag(page, source, target, dy=0):
    a = source.bounding_box()
    b = target.bounding_box()
    page.mouse.move(a["x"] + 60, a["y"] + a["height"] / 2)
    page.mouse.down()
    page.mouse.move(a["x"] + 70, a["y"] + a["height"] / 2 + 8, steps=4)
    page.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2 + dy, steps=14)
    page.wait_for_timeout(150)
    page.mouse.up()
    page.wait_for_timeout(500)


def drop_files(page, selector, paths):
    payload = [{"name": Path(p).name, "bytes": list(Path(p).read_bytes())} for p in paths]
    page.evaluate("""([selector, payload]) => {
      const target = document.querySelector(selector);
      const data = new DataTransfer();
      for (const f of payload) data.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'application/pdf' }));
      for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }""", [selector, payload])


def server(page):
    return page.evaluate("async () => (await (await fetch('/api/sync/pull?since=0')).json()).rows")


def session_titles(page, n):
    return page.locator("section.session").nth(n).locator("li.reading .name").evaluate_all("els => els.map(e => e.textContent)")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    for code, title in (("HY335", "China and the World"), ("HY319", "Napoleon and Europe")):
        if code == "HY319":
            page.get_by_role("link", name="Study Library").click()
            page.get_by_role("button", name="Add a module").click()
        page.get_by_label("Code").fill(code)
        page.get_by_label("Title").fill(title)
        page.get_by_role("button", name="Create module").click()
        expect(page.get_by_role("heading", name=code, exact=True)).to_be_visible()
    page.locator(".modules-nav a", has_text="HY335").click()
    page.locator("#week-AT1 .week-title").click()

    # Three slide decks on the lecture.
    lecture = ".week-page section.session"
    drop_files(page, lecture, files)
    expect(page.locator("section.session").first.locator("li.reading")).to_have_count(3)
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.week_items || []).filter(l => l.session_id).length === 3; }", 40)
    print("three decks on the lecture:", session_titles(page, 0))

    # Reorder within the lecture by dragging.
    before = session_titles(page, 0)
    rows = page.locator("section.session").first.locator("li.reading")
    drag(page, rows.nth(2), rows.nth(0), dy=-8)
    after = session_titles(page, 0)
    assert after[0] == before[2], (before, after)
    page.reload()
    expect(page.locator("section.session").first.locator("li.reading .name").first).to_have_text(before[2])
    print("slides reordered within the lecture, and the order holds after a reload")

    # Drag one into the seminar, whose slide list is empty until a drag starts.
    rows = page.locator("section.session").first.locator("li.reading")
    moving = session_titles(page, 0)[1]
    seminar_head = page.locator("section.session").nth(1).locator(".session-head")
    a = rows.nth(1).bounding_box()
    page.mouse.move(a["x"] + 60, a["y"] + a["height"] / 2)
    page.mouse.down()
    page.mouse.move(a["x"] + 70, a["y"] + a["height"] / 2 + 8, steps=4)
    target = page.locator("section.session").nth(1).locator("ul.readings.empty-target")
    expect(target).to_be_visible()
    page.screenshot(path=f"{shots}-1-empty-target.png")
    b = target.bounding_box()
    page.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2, steps=14)
    page.wait_for_timeout(150)
    page.mouse.up()
    page.wait_for_timeout(500)
    expect(page.locator(".toast")).to_contain_text("Slides moved to the seminar")
    assert session_titles(page, 1) == [moving], session_titles(page, 1)
    seminar_id = page.locator("section.session").nth(1).get_attribute("data-session")
    until(page, f"async () => {{ const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.week_items || []).filter(l => !l.deleted && l.session_id === '{seminar_id}').length === 1; }}")
    page.locator(".toast").get_by_role("button", name="Undo").click()
    expect(page.locator("section.session").first.locator("li.reading")).to_have_count(3)
    print("slides dragged into the empty seminar, then undone")

    # Slide canvas has role="img" with an accessible label
    page.locator("section.session").first.locator(".session-title a").click()
    slide_canvas = page.locator(".slide-box canvas[role='img']")
    expect(slide_canvas).to_be_visible()
    expect(slide_canvas).to_have_attribute("aria-label", "Slide 1 of 3")
    page.locator(".crumbs a").nth(1).click()

    # A reading moves to another module, into one of its weeks.
    page.locator(".modules-nav a", has_text="HY335").click()
    page.locator("#week-AT2 .week-title").click()
    drop_files(page, ".week-page [data-drop='readings']", files[2:3])
    row = page.locator(".week-page .section[data-drop='readings'] li.reading").first
    expect(row).to_be_visible()
    name = row.locator(".name").text_content()
    row.get_by_role("button", name="More actions").click()
    page.get_by_role("menuitem", name="Move to another week or module").click()
    picker = page.locator(".move-picker")
    picker.get_by_label("Module").select_option(label="HY319 Napoleon and Europe")
    picker.get_by_label("Week").select_option(label="AT3")
    expect(page.locator(".toast")).to_contain_text("Moved to HY319 AT3")
    expect(page.locator(".week-page .section[data-drop='readings'] li.reading")).to_have_count(0)
    page.screenshot(path=f"{shots}-2-moved-module.png")
    rows = server(page)
    hy319 = next(m for m in rows["modules"] if m["code"] == "HY319")
    at3 = next(w for w in rows["weeks"] if w["module_id"] == hy319["id"] and w["term"] == "AT" and w["number"] == 3)
    until(page, f"async () => {{ const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.week_items || []).some(l => !l.deleted && l.week_id === '{at3['id']}'); }}")
    page.locator(".modules-nav a", has_text="HY319").click()
    page.locator("#week-AT3 .week-title").click()
    expect(page.locator(".week-page li.reading .name").first).to_have_text(name)
    print("a reading moved from HY335 AT2 to HY319 AT3, with its name kept:", name)

    # The processor's status is shown in Settings. No processor runs here,
    # so work waits and Settings says so.
    page.goto(BASE + "/?v=settings")
    expect(page.locator("h2", has_text="Processor")).to_be_visible()
    expect(page.locator("section", has=page.locator("h2", has_text="Processor"))).to_contain_text("waiting")
    print("Settings shows the processor's state:", page.locator("section", has=page.locator("h2", has_text="Processor")).locator("p").first.text_content())

    # A device holding a stale copy of a reading saves its place. A name the
    # server found in the meantime survives, because only the place is sent.
    item = page.evaluate("async () => (await (await fetch('/api/sync/pull?since=0')).json()).rows.items.find(i => !i.deleted && i.kind === 'secondary')")
    page.goto(BASE + f"/?v=reader&id={item['id']}")
    page.wait_for_timeout(2000)
    # From here this device hears nothing from the server, so its copy goes stale.
    page.route("**/api/sync/pull*", lambda route: route.fulfill(json={"cursor": 0, "more": False, "rows": {}}))
    # The rename is stamped a second ahead, so it is newer than anything the
    # reader wrote while opening.
    ahead = time.time() + 1
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ahead)) + f".{int(ahead % 1 * 1000):03d}Z"
    page.request.post(BASE + "/api/sync/push", data={"changes": [{"table": "items", "row": {**item, "author": "Found, A.", "title": "Found on the server", "modified_at": stamp}, "cols": ["author", "title"]}]})
    page.wait_for_timeout(2500)
    page.mouse.move(640, 500)
    page.mouse.wheel(0, 1200)
    page.wait_for_timeout(3000)
    page.unroute("**/api/sync/pull*")
    after = page.evaluate(f"async () => (await (await fetch('/api/sync/pull?since=0')).json()).rows.items.find(i => i.id === '{item['id']}')")
    assert after["title"] == "Found on the server", after["title"]
    assert after["last_spot"] is not None and after["modified_at"] > stamp, after
    assert after["last_page"] == after["last_spot"]["page"] and after["last_opened_at"], after
    print("a place saved by a stale device left the name found on the server alone, page", after["last_page"])

    assert not errors, errors
    print("ok")
    browser.close()
