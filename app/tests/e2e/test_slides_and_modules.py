"""Version 0.22: slide decks named for their session, moving a deck and a
reading to another module, the processor's status, and a stale device not
undoing a name found on the server. A session holds one deck."""
import glob, re, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))
shots = str(HERE / "shots" / "slides-modules")


from helpers import add_session, drop_files, until


LECTURE = ".week-page .week-session-card[data-label='Lecture']"
SEMINAR = ".week-page .week-session-card[data-label='Seminar']"


def server(page):
    return page.evaluate("async () => (await (await fetch('/api/sync/pull?since=0')).json()).rows")


def has_deck(title):
    """A script that is true once a live reading of that title is on the server."""
    return f"async () => {{ const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.items || []).some(i => i.title === {title!r} && !i.deleted); }}"


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

    # HY319 AT5 gets a lecture now, so a deck moved there later has a lecture to join.
    page.locator("#week-AT5 .week-title").click()
    add_session(page, "lecture")
    page.locator(".modules-nav a", has_text="HY335").click()
    page.locator("#week-AT1 .week-title").click()

    # A new week has no sessions, so a lecture and a seminar are added, and a
    # deck is dropped on each card.
    add_session(page, "lecture")
    add_session(page, "seminar")
    drop_files(page, LECTURE, files[:1])
    expect(page.locator(".toast")).to_contain_text("Slides added for Lecture")
    drop_files(page, SEMINAR, files[1:2])
    expect(page.locator(".toast")).to_contain_text("Slides added for Seminar")
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.week_items || []).filter(l => l.session_id && !l.deleted).length === 2; }", 40)
    # Slides are named for their place, and the card shows the name.
    until(page, has_deck("HY335 AT1 Lecture slides"))
    until(page, has_deck("HY335 AT1 Seminar slides"))
    expect(page.locator(LECTURE).locator(".wsc-chip")).to_contain_text("HY335 AT1 Lecture slides")
    expect(page.locator(SEMINAR).locator(".wsc-chip")).to_contain_text("HY335 AT1 Seminar slides")
    page.screenshot(path=f"{shots}-1-decks.png")

    # The deck shows on its session page, and downloads under its own name, not its file's.
    page.locator(LECTURE).locator("a.wsc-body").click()
    deck_row = page.locator(".session-side .slides-row li.reading")
    expect(deck_row).to_have_count(1)
    with page.expect_download() as got:
        deck_row.get_by_role("button", name="More actions").click()
        page.get_by_role("menuitem", name="Download file").click()
    saved = got.value.suggested_filename
    assert saved.startswith("HY335 AT1 Lecture slides") and saved.endswith(".pdf"), saved
    print("a deck on each session, named for its place, and the lecture's downloads as", saved)

    # Slide canvas has role="img" with an accessible label.
    slide_canvas = page.locator(".slide-box canvas[role='img']")
    expect(slide_canvas).to_be_visible()
    expect(slide_canvas).to_have_attribute("aria-label", re.compile(r"^Slide 1 of \d+$"))
    # The session page has no link to its week, so Back returns there.
    page.go_back()
    expect(page.locator(LECTURE)).to_be_visible()

    # A deck from before this version still carries its file's name. On a
    # device's first sync it takes its place's name, once; a name you typed is left alone.
    # Wait until the deck's upload has finished, so its file and the file's name are on the server.
    until(page, """async () => { const j = await (await fetch('/api/sync/pull?since=0')).json();
      const d = (j.rows.items || []).find(i => i.title === 'HY335 AT1 Lecture slides' && !i.deleted);
      return d && d.file_id && (j.rows.files || []).some(f => f.id === d.file_id && f.original_name); }""", 40)
    rows = server(page)
    deck = next(i for i in rows["items"] if i["title"] == "HY335 AT1 Lecture slides" and not i["deleted"])
    named = next(i for i in rows["items"] if i["title"] == "HY335 AT1 Seminar slides" and not i["deleted"])
    file_name = next(f for f in rows["files"] if f["id"] == deck["file_id"])["original_name"]
    stem = file_name.rsplit(".", 1)[0]
    # Later than the decks' own times, to the millisecond, so last-write-wins keeps these.
    time.sleep(1.2)
    now = time.time()
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
    page.request.post(BASE + "/api/sync/push", data={"changes": [
        # Whole rows with the changed column named, as the app sends them.
        {"table": "items", "row": {**deck, "title": stem, "modified_at": stamp}, "cols": ["title"]},
        {"table": "items", "row": {**named, "title": "My own name for these", "modified_at": stamp}, "cols": ["title"]},
    ]})
    until(page, f"async () => {{ const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.items || []).some(i => i.id === '{deck['id']}' && i.title === {stem!r}); }}")
    fresh = browser.new_context(viewport={"width": 1280, "height": 900})
    other = fresh.new_page()
    other.on("pageerror", lambda e: errors.append(str(e)))
    other.goto(BASE + "/")
    until(other, f"async () => {{ const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.items || []).some(i => i.id === '{deck['id']}' && i.title === 'HY335 AT1 Lecture slides'); }}", 30)
    other.wait_for_timeout(500)
    kept = next(i for i in server(other)["items"] if i["id"] == named["id"])["title"]
    assert kept == "My own name for these", kept
    fresh.close()
    page.reload()
    print("on a new device, a deck still named for its file took its place's name, and one named by hand kept its name")

    # Moving a deck to another module's week gives it that place's name.
    expect(page.locator(LECTURE)).to_be_visible()
    page.locator(LECTURE).locator("a.wsc-body").click()
    deck_row = page.locator(".session-side .slides-row li.reading")
    expect(deck_row.locator(".name")).to_contain_text("HY335 AT1 Lecture slides")
    deck_row.get_by_role("button", name="More actions").click()
    page.get_by_role("menuitem", name="Move to another week or module").click()
    picker = page.locator(".move-picker")
    picker.get_by_label("Module").select_option(label="HY319 Napoleon and Europe")
    picker.get_by_label("Week").select_option(label="AT5")
    expect(page.locator(".toast")).to_contain_text("Moved to HY319 AT5")
    until(page, has_deck("HY319 AT5 Lecture slides"))
    print("a deck moved to HY319 AT5 took the name HY319 AT5 Lecture slides")

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
    until(page, f"async () => {{ const j = await (await fetch('/api/sync/pull?since=0')).json(); const it = (j.rows.items || []).find(i => i.id === '{item['id']}'); return it && it.last_opened_at; }}", 15)
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
