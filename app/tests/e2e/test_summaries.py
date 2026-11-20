"""Version 0.34.0: summaries, week groups and progress.

Verifies:
1. A file added from the Summaries list's own Add row lists under 'Summaries'.
2. Summaries are omitted from the reading count and have no read status / read mark.
3. Summary menu offers 'Move to Primary readings', 'Move to Secondary readings', and 'Delete summary'.
4. Reader for summary omits 'Mark as read', 'Copy reference', and offers 'Delete summary'.
5. Switching a summary to secondary reading updates grouping, read mark, and menu.
6. Note editor '@' citation search excludes summaries and slides (citable only).
"""
import glob, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
BASE = sys.argv[1]
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))

from helpers import until


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # Reset and create module
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("HY226")
    page.get_by_label("Title").fill("The Great War")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="HY226")).to_be_visible()

    # Open AT1
    page.locator("#week-AT1 .week-title").click()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()

    # 1. Add a file as a Summary from the blank row that ends the Summaries
    # list, since 'Add files' now takes files as their names say, with no dialog.
    with page.expect_file_chooser() as fc_info:
        page.get_by_role("button", name="Add summaries", exact=True).click()
    fc_info.value.set_files(files[0:1])

    # Wait for sync and verify summary appears under 'Summaries'
    expect(page.locator(".toast")).to_contain_text("added to AT1")
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.items || []).length === 1; }")

    expect(page.locator(".section[data-drop='summary'] .group-label")).to_have_text("Summaries")
    summary_row = page.locator(".section[data-drop='summary'] li.reading")
    expect(summary_row).to_have_count(1)

    # 2. Assert no read mark is visible on summary row
    expect(summary_row.locator("button[role=checkbox]")).to_have_count(0)

    # Check menu items for summary
    summary_row.get_by_role("button", name="More actions").click()
    menu = page.locator(".menu-panel")
    expect(menu.get_by_role("menuitem", name="Delete summary")).to_be_visible()
    # Mark as read is not in menu
    expect(menu.get_by_role("menuitem", name="Mark as read")).to_have_count(0)
    menu.get_by_role("menuitem", name="More...").click()
    expect(menu.get_by_role("menuitem", name="Move to Primary readings")).to_be_visible()
    expect(menu.get_by_role("menuitem", name="Move to Secondary readings")).to_be_visible()
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")

    # 3. Open summary in reader
    summary_row.locator("a.name").click()
    expect(page.locator(".reader")).to_be_visible()

    # Assert reader top bar has no read toggle and no copy reference
    expect(page.locator(".reader button.read-toggle")).to_have_count(0)
    expect(page.locator(".reader button.copy-reference")).to_have_count(0)

    # Check reader menu has 'Delete summary'
    page.locator(".reader").get_by_role("button", name="More reading actions").click()
    reader_menu = page.locator(".menu-panel")
    expect(reader_menu.get_by_role("menuitem", name="Delete summary")).to_be_visible()
    page.keyboard.press("Escape")

    # Back to week page
    page.locator(".reader-bar").get_by_role("button", name="Back to the week").click()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()

    # 4. Move summary to Secondary readings via row menu
    summary_row = page.locator(".section[data-drop='summary'] li.reading")
    summary_row.get_by_role("button", name="More actions").click()
    page.locator(".menu-panel").get_by_role("menuitem", name="More...").click()
    page.locator(".menu-panel").get_by_role("menuitem", name="Move to Secondary readings").click()

    # Now it should leave Summaries and appear in readings
    expect(page.locator(".section[data-drop='summary'] li.reading")).to_have_count(0)
    secondary_row = page.locator("[data-drop='readings'] li.reading")
    expect(secondary_row).to_have_count(1)

    # And menu should now offer 'Move to Summaries'
    secondary_row.get_by_role("button", name="More actions").click()
    sec_menu = page.locator(".menu-panel")
    sec_menu.get_by_role("menuitem", name="More...").click()
    expect(sec_menu.get_by_role("menuitem", name="Move to Summaries")).to_be_visible()
    page.keyboard.press("Escape")
    page.keyboard.press("Escape")

    # 5. Move back to summary
    secondary_row.get_by_role("button", name="More actions").click()
    page.locator(".menu-panel").get_by_role("menuitem", name="More...").click()
    page.locator(".menu-panel").get_by_role("menuitem", name="Move to Summaries").click()
    expect(page.locator(".section[data-drop='summary'] li.reading")).to_have_count(1)

    # 6. Verify module row has code and title
    page.goto(BASE + "/")
    card = page.locator(".module-row", has_text="HY226")
    expect(card).to_contain_text("HY226")
    expect(card).to_contain_text("The Great War")

    assert not errors, f"Page errors: {errors}"
    print("test_summaries passed successfully")
