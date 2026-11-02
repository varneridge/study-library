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


from helpers import drag, drop_files, until


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
    expect(page.locator(".drop-banner")).to_contain_text("Drop to add secondary readings to AT1")
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
    empty = page.locator(".week-page .section[data-drop='primary'] .readings.empty-target")
    expect(empty).to_be_visible()
    e = empty.bounding_box()
    page.mouse.move(e["x"] + 100, e["y"] + e["height"] / 2, steps=14)
    expect(page.locator(".week-page .section[data-drop='primary'] li.reading")).to_have_count(1)
    page.mouse.up()
    expect(page.locator(".drag-card")).to_have_count(0)
    expect(page.locator(".toast")).to_contain_text("Now a primary reading.")
    expect(page.locator(".week-page .group-label", has_text="Primary readings")).to_be_visible()
    page.screenshot(path=f"{shots}-3-primary.png", full_page=True)
    print("dragged into primary sources")

    # The keyboard can move a reading too: Space, an arrow, Space.
    rows = page.locator(".week-page .section[data-drop='readings'] li.reading")
    expect(rows).to_have_count(1)

    # Module page: drag a reading from AT1 onto AT5, and one to Unsorted.
    page.locator(".crumbs a").first.click()
    expect(page.locator(".week-card")).to_have_count(22)
    expect(page.locator("#week-AT1")).to_be_visible()
    page.screenshot(path=f"{shots}-4-module.png")

    # Files dropped on a week card of the module page go to that week.
    drop_files(page, "#week-AT5", files[:1])
    expect(page.locator(".toast")).to_contain_text("1 file added to AT5")
    print("file dropped on the AT5 card")
    drop_files(page, "#week-AT7", files[:1])
    expect(page.locator(".toast")).to_contain_text("1 file added to AT7")
    print("file dropped on the AT7 card")

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

    # No dragging by keyboard. A space typed in Edit details stays in the
    # title, Space after clicking a row scrolls the page, and the menu's Move
    # up and Move down move readings on a laptop as on a phone.
    # Still on AT5, where Ctrl K went.
    rows = page.locator(".week-page li.reading")
    expect(rows.first).to_be_visible()
    rows.first.get_by_role("button", name="More actions").click()
    page.get_by_role("menuitem", name="Edit details").click()
    editor = page.locator(".week-page form.editor")
    title_field = editor.get_by_label("Title", exact=True)
    title_field.fill("")
    title_field.press_sequentially("A title with spaces in it")
    expect(title_field).to_have_value("A title with spaces in it")
    expect(page.locator(".move-dock")).to_have_count(0)
    editor.get_by_role("button", name="Save").click()
    expect(page.locator(".week-page li.reading .name", has_text="A title with spaces in it")).to_have_count(1)
    print("a title typed with spaces in Edit details kept them, and nothing was picked up")
    # A row is no longer a focusable drag button, which is what let Space pick it up.
    assert rows.first.evaluate("el => !el.hasAttribute('tabindex') && el.getAttribute('role') !== 'button'"), "a row is still a drag button"
    page.set_viewport_size({"width": 1280, "height": 500})
    page.evaluate("() => { window.scrollTo(0, 0); document.activeElement?.blur(); }")
    before_scroll = page.evaluate("() => window.scrollY")
    page.keyboard.press("Space")
    page.wait_for_timeout(400)
    expect(page.locator(".move-dock")).to_have_count(0)
    assert page.evaluate("() => window.scrollY") > before_scroll, "Space did not scroll the page"
    page.set_viewport_size({"width": 1280, "height": 900})
    print("rows are not drag buttons, and Space scrolls the page")
    order = rows.locator(".name").all_text_contents()
    if len(order) >= 2:
        rows.first.get_by_role("button", name="More actions").click()
        page.get_by_role("menuitem", name="Move down").click()
        expect(rows.first.locator(".name")).to_have_text(order[1])
        rows.nth(1).get_by_role("button", name="More actions").click()
        page.get_by_role("menuitem", name="Move up").click()
        expect(rows.first.locator(".name")).to_have_text(order[0])
    else:
        # One reading here: both are offered on a laptop, and say there is nowhere to go.
        rows.first.get_by_role("button", name="More actions").click()
        page.get_by_role("menuitem", name="Move up").click()
        expect(page.locator(".toast")).to_contain_text("Already at the top.")
        rows.first.get_by_role("button", name="More actions").click()
        page.get_by_role("menuitem", name="Move down").click()
        expect(page.locator(".toast")).to_contain_text("Already at the foot.")
    print("Move up and Move down are in the menu on a laptop, and work")

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
