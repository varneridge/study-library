"""Version 0.28: a thing offers the same actions wherever it appears. A
session's page does what its row on the week page does, a reading's menu is
the same on every page and in the reader, and Back from slides goes to their
session."""
import glob, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
BASE = sys.argv[1]
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))


def until(page, script, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:100])


def menu_items(page, scope):
    scope.get_by_role("button", name="More actions").first.click()
    items = [t for t in page.locator(".menu-panel [role=menuitem]").all_inner_texts() if t != "Cancel"]
    page.keyboard.press("Escape")
    return items


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("HY319")
    page.get_by_label("Title").fill("Napoleon and Europe")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="HY319")).to_be_visible()
    page.get_by_role("link", name="Import readings").click()
    page.locator("input[type=file][accept]").set_input_files(files[:2])
    page.get_by_role("button", name="Import 2 files").click()
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.items || []).length === 2; }")

    # The lecture's own page adds slides, as its row on the week page does.
    page.goto(BASE + "/")
    page.locator(".module-row").first.click()
    page.locator("#week-AT1 .week-title").click()
    page.locator("section.session").first.locator(".session-title a").click()
    expect(page.get_by_role("heading", name="Lecture")).to_be_visible()
    page.locator("input[type=file][multiple][accept='.pdf,.pptx,.ppt,image/*,.heic,.heif']").set_input_files(files[2:3])
    expect(page.locator(".toast")).to_contain_text("Slides added.")
    slides = page.locator(".side-readings", has=page.locator("h2", has_text="Slides"))
    expect(slides.locator("li.reading")).to_have_count(1)
    # The slides there have the full reading menu.
    deck = menu_items(page, slides)
    assert "Move to another week or module" in deck and "Delete reading" in deck, deck
    print("the lecture page adds slides, and lists them with their menu:", deck[:3])

    # The session's own menu offers what its row on the week page does.
    session_menu = page.get_by_role("button", name="More actions for this lecture")
    session_menu.click()
    items = page.locator(".menu-panel [role=menuitem]").all_inner_texts()
    assert {"Rename", "Make this a seminar", "Delete session"} <= set(items), items
    page.keyboard.press("Escape")
    # Renamed from its title, as a week is.
    page.get_by_role("heading", name="Lecture").click()
    page.get_by_label("Session name").fill("The Consulate")
    page.keyboard.press("Enter")
    expect(page.get_by_role("heading", name="The Consulate")).to_be_visible()
    # On to the next session without going back to the week.
    nav = page.locator("nav[aria-label='Other sessions']")
    expect(nav.get_by_role("link", name="AT1 Seminar →")).to_be_visible()
    print("the session page renames, changes kind, deletes, and goes on to the next session")

    # Slides opened from the lecture go back to the lecture.
    slides.locator("a.name").first.click()
    back = page.get_by_role("button", name="Back to The Consulate")
    expect(back).to_be_visible()
    back.click()
    expect(page.get_by_role("heading", name="The Consulate")).to_be_visible()
    print("Back from slides returns to their session")

    # The reader's menu has the reading's own actions.
    page.goto(BASE + "/")
    page.locator(".module-row").first.click()
    page.locator("#week-AT1 .week-title").click()
    page.locator(".week-page .section[data-drop='readings'] li.reading a.name").first.click()
    page.get_by_role("button", name="More reading actions").click()
    reader = page.locator(".menu-panel [role=menuitem]").all_inner_texts()
    assert {"Edit details", "Move to another week or module", "Download file", "Delete reading"} <= set(reader), reader
    page.get_by_role("menuitem", name="Edit details").click()
    sheet = page.locator("dialog.reader-sheet[open]")
    expect(sheet).to_be_visible()
    sheet.get_by_label("Title").fill("Introduction to Mao's China")
    sheet.get_by_role("button", name="Save").click()
    expect(page.locator("dialog.reader-sheet[open]")).to_have_count(0)
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.items || []).some(i => i.title === \"Introduction to Mao's China\"); }")
    print("the reader edits its reading's details in place:", reader)

    # Every page that lists readings gives them their menu.
    page.goto(BASE + "/")
    page.locator(".module-row").first.click()
    page.locator("#week-AT1 .week-title").click()
    week_url = page.url
    page.goto(BASE + "/")
    page.locator(".module-row").first.click()
    week = page.locator("#week-AT1")
    expect(week.locator("li.reading").first).to_be_visible()
    assert "Edit details" in menu_items(page, week), "module page"
    page.goto(BASE + "/?v=across&term=AT&n=1")
    assert "Edit details" in menu_items(page, page.locator("main")), "week across modules"
    print("readings have their menu on the module page and Week across modules too")

    assert not errors, errors
    print("ok")
    browser.close()
