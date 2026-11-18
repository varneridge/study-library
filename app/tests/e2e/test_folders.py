"""Folders on Library shelves, and the add tiles that replace Add buttons (0.55).

Creates a Library module, adds a shelf from its add tile, makes a folder from
the shelf's New folder tile and names it in place, puts one book in the folder
while a standalone book stays loose on the shelf, opens the folder and comes
back, renames it, and deletes it, checking its book comes back to the shelf and
that Undo restores both. Run like the others: python test_folders.py BASE
"""

import glob, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)

from playwright.sync_api import sync_playwright, expect
from helpers import drop_files, until

BASE = sys.argv[1]
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))[:2]
shots = str(HERE / "shots" / "folders")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    expect(page.get_by_text("Add your first module")).to_be_visible()
    page.get_by_role("button", name="Library").click()
    page.get_by_label("Code").fill("LIB")
    page.get_by_label("Title").fill("Books")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="LIB")).to_be_visible()

    # Home: the add tile for a module, with its full name for screen readers.
    page.get_by_role("link", name="Study Library").click()
    expect(page.get_by_role("button", name="Add a module")).to_be_visible()
    page.screenshot(path=f"{shots}-1-home.png")
    # A case-sensitive whole word: a plain name="LIB" also matches the "Study Library" brand link.
    page.get_by_role("link", name=re.compile(r"\bLIB\b")).first.click()

    # A shelf from the module's add tile, which opens it.
    page.get_by_role("button", name="Add a shelf").click()
    expect(page.get_by_role("heading", name="New shelf")).to_be_visible()
    drop_files(page, "#main h1", files)
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 2; }", 30)
    expect(page.locator(".readings > li.reading")).to_have_count(2)

    # A folder from the New folder tile, named straight away.
    page.get_by_role("button", name="Add a folder to this shelf").click()
    name = page.get_by_label("Folder name")
    expect(name).to_be_focused()
    name.fill("A series")
    page.keyboard.press("Enter")
    expect(page.locator(".folder-tile .folder-name")).to_have_text("A series")
    expect(page.locator(".folder-tile .folder-count")).to_have_text("0 readings")
    page.screenshot(path=f"{shots}-2-empty-folder.png")

    # One book into the folder from its menu; the other stays loose.
    page.locator(".readings > li.reading").first.get_by_role("button", name="More actions").first.click()
    page.get_by_role("menuitem", name="Move to folder").click()
    page.get_by_role("menuitem", name="A series").click()
    expect(page.locator(".folder-tile .folder-count")).to_have_text("1 reading")
    expect(page.locator(".readings > li.reading")).to_have_count(1)
    page.screenshot(path=f"{shots}-3-shelf.png")

    # Inside the folder: its book, and the shelf as the way back.
    page.get_by_role("link", name="Open the folder A series").click()
    expect(page.get_by_role("heading", name="A series")).to_be_visible()
    expect(page.locator(".readings > li.reading")).to_have_count(1)
    page.screenshot(path=f"{shots}-4-inside.png")
    page.locator(".folder-trail a").click()
    expect(page.get_by_role("heading", name="New shelf")).to_be_visible()

    # Renamed from its menu, then deleted: the book comes back, and Undo restores both.
    page.get_by_role("button", name="More actions for the folder A series").click()
    page.get_by_role("menuitem", name="Rename folder").click()
    page.get_by_label("Folder name").fill("Book two of a series")
    page.keyboard.press("Enter")
    expect(page.locator(".folder-tile .folder-name")).to_have_text("Book two of a series")
    page.get_by_role("button", name="More actions for the folder Book two of a series").click()
    page.get_by_role("menuitem", name="Delete folder").click()
    expect(page.locator(".folder-tile")).to_have_count(0)
    expect(page.locator(".readings > li.reading")).to_have_count(2)
    page.get_by_role("button", name="Undo").click()
    expect(page.locator(".folder-tile")).to_have_count(1)
    expect(page.locator(".readings > li.reading")).to_have_count(1)

    # On a phone the add tiles keep their size to touch.
    phone = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    phone.goto(page.url)
    box = phone.get_by_role("button", name="Add a folder to this shelf").bounding_box()
    assert box and box["height"] >= 44 and box["width"] >= 44, box
    phone.screenshot(path=f"{shots}-5-phone.png")

    assert not errors, errors
    print("folders: created, named, filled, opened, renamed, deleted and restored; add tiles work by keyboard and touch")
    browser.close()
