"""Editing, deleting and restoring: modules, weeks, sessions, readings and questions."""
import glob, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))
shots = str(HERE / "shots" / "editing")


def until(page, script, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:90])


def server_rows(page, table):
    return page.evaluate(f"async () => (await (await fetch('/api/sync/pull?since=0')).json()).rows['{table}'] || []")


def create_module(page, code, title):
    page.get_by_label("Code").fill(code)
    page.get_by_label("Title").fill(title)
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name=code, exact=True)).to_be_visible()


def reading_menu(page, text):
    row = page.locator("li.reading", has_text=text).first
    row.get_by_role("button", name="More actions").click()
    return row



def open_module(page, code):
    """The top bar lists the modules except on the home page, which lists them itself."""
    bar = page.locator(".modules-nav").get_by_role("link", name=code)
    if bar.count() and bar.is_visible():
        bar.click()
    else:
        page.locator(".module-row", has_text=code).first.click()


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")

    # Two modules, then put the second first.
    create_module(page, "HY335", "China and the World")
    page.get_by_role("link", name="Study Library").click()
    page.get_by_role("button", name="Add a module").click()
    create_module(page, "HY206", "The International History of the Cold War")
    expect(page.locator(".modules-nav a")).to_have_count(2)
    expect(page.locator(".modules-nav a[aria-current=page]")).to_have_text("HY206")
    page.get_by_role("link", name="Study Library").click()
    page.get_by_role("button", name="Change order").click()
    page.get_by_role("button", name="Move HY206 up").click()
    expect(page.locator(".module-row .code").first).to_have_text("HY206")
    page.screenshot(path=f"{shots}-1-order.png")
    page.get_by_role("button", name="Done").click()
    print("modules reordered")

    # Edit a module and flip a reading week both ways.
    open_module(page, "HY335")
    page.get_by_role("button", name="Edit module").click()
    page.locator(".editor").get_by_label("Title").fill("China and the World since 1949")
    page.get_by_label("About this module").fill("Convenor: Dr Quadri.\n\nAssessed by essay.")
    page.get_by_role("group", name="Reading weeks").get_by_role("button", name="2", exact=True).first.click()
    expect(page.get_by_role("group", name="Reading weeks").get_by_role("button", name="2", exact=True).first).to_have_attribute("aria-pressed", "true")
    page.screenshot(path=f"{shots}-2-module-settings.png", full_page=True)
    page.get_by_role("button", name="Save").click()
    expect(page.get_by_text("China and the World since 1949")).to_be_visible()
    page.get_by_text("About this module").click()
    expect(page.get_by_text("Assessed by essay.")).to_be_visible()
    page.locator("#week-AT2 .week-title").click()
    expect(page.locator("section.session")).to_have_count(0)
    page.get_by_role("button", name="More actions for this week").click()
    page.keyboard.press("ArrowDown")
    expect(page.locator(".menu-panel button[role='menuitem']").first).to_be_focused()
    page.keyboard.press("ArrowDown")
    expect(page.locator(".menu-panel button[role='menuitem']").nth(1)).to_be_focused()
    expect(page.locator(".menu-panel button[role='menuitem']").nth(1)).to_have_text("Make this a teaching week")
    page.keyboard.press("Enter")
    expect(page.locator("section.session")).to_have_count(2)
    print("module edited, reading week toggled")

    # Keyboard: [ goes back a week.
    page.keyboard.press("[")
    expect(page.locator(".crumbs")).to_contain_text("AT1")
    page.keyboard.press("]")
    expect(page.locator(".crumbs")).to_contain_text("AT2")
    page.keyboard.press("[")
    expect(page.locator(".crumbs")).to_contain_text("AT1")
    page.wait_for_timeout(300)

    # Add files to AT1.
    page.locator("input[type=file][accept='.pdf,.pptx,.ppt,.docx,.doc,image/*,.heic,.heif']").first.set_input_files(files)
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 3; }", 40)
    expect(page.locator("li.reading")).to_have_count(3)
    print("3 readings added to AT1")

    # Remove from week sends a reading to Unsorted.
    reading_menu(page, "Kirby")
    page.get_by_role("menuitem", name="Remove from this week").click()
    expect(page.locator("li.reading")).to_have_count(2)
    expect(page.locator(".toast")).to_contain_text("Unsorted")
    page.locator(".crumbs a").first.click()
    expect(page.get_by_role("heading", name="Unsorted")).to_be_visible()
    page.screenshot(path=f"{shots}-3-unsorted.png")
    print("removed reading went to Unsorted")

    # Delete, undo, delete, restore from the bin.
    reading_menu(page, "Kirby")
    page.get_by_role("menuitem", name="Delete reading").click()
    expect(page.get_by_role("heading", name="Unsorted")).to_have_count(0)
    page.screenshot(path=f"{shots}-4-toast.png")
    page.locator(".toast").get_by_role("button", name="Undo").click()
    expect(page.get_by_role("heading", name="Unsorted")).to_be_visible()
    reading_menu(page, "Kirby")
    page.get_by_role("menuitem", name="Delete reading").click()
    expect(page.get_by_role("heading", name="Unsorted")).to_have_count(0)
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.items || []).some(i => i.deleted); }")
    page.get_by_role("link", name="Settings").click()
    expect(page.locator(".bin li")).to_have_count(1)
    page.screenshot(path=f"{shots}-5-bin.png", full_page=True)
    page.locator(".bin li").get_by_role("button", name="Restore").click()
    expect(page.get_by_text("Nothing deleted in the last 90 days.")).to_be_visible()
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.items || []).every(i => !i.deleted); }")
    print("delete, undo and restore all work")

    # Sessions: rename, add, delete; questions: add, reorder, delete.
    open_module(page, "HY335")
    page.locator("#week-AT1 .week-title").click()

    # Week title can be reached and edited from the keyboard
    week_heading = page.locator(".week-page h1.editable")
    expect(week_heading).to_be_visible()
    week_heading.focus()
    page.keyboard.press("Enter")
    page.locator("input[aria-label='Week title']").fill("Sino-Soviet Relations")
    page.keyboard.press("Enter")
    expect(page.locator(".week-page h1")).to_contain_text("Sino-Soviet Relations")

    page.get_by_role("button", name="More actions for Seminar").click()
    page.get_by_role("menuitem", name="Rename").click()
    rename_input = page.locator("input[aria-label='Session name']")
    expect(rename_input).to_be_visible()
    rename_input.fill("Class: Mao and the Three Worlds")
    page.keyboard.press("Enter")
    expect(page.get_by_role("heading", name="Class: Mao and the Three Worlds")).to_be_visible()

    # Questions are typed in place: a list pastes in as one question a line.
    seminar = page.locator("section.session", has_text="Class: Mao")
    seminar.get_by_label("Add a question").fill("1. First question here\n2. Second question here\n3. Third question here")
    seminar.get_by_label("Add a question").press("Enter")
    rows = seminar.locator(".question-row:not(.adder) textarea")
    expect(rows).to_have_count(3)
    expect(rows.first).to_have_value("First question here")
    # Reword in place.
    rows.nth(1).click()
    page.keyboard.press("End")
    page.keyboard.type(" and more")
    # Alt and Down moves the first question down.
    rows.first.click()
    page.keyboard.press("Alt+ArrowDown")
    expect(rows.first).to_have_value("Second question here and more")
    # Enter starts a new question after the one you are in.
    rows.last.click()
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    page.keyboard.type("A fourth question")
    page.keyboard.press("Tab")
    expect(rows).to_have_count(4)
    # Emptying a question and pressing Backspace removes it.
    rows.last.click()
    page.keyboard.press("Control+a")
    page.keyboard.press("Delete")
    page.keyboard.press("Backspace")
    expect(rows).to_have_count(3)
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); const qs = (j.rows.questions || []).filter(q => !q.deleted); return qs.length === 3 && qs.some(q => q.body === 'Second question here and more'); }")
    page.screenshot(path=f"{shots}-6-questions.png", full_page=True)
    print("questions typed, reworded, moved, added with Enter and removed with Backspace, in place")

    page.get_by_role("button", name="More actions for this week").click()
    page.get_by_role("menuitem", name="Add a combined session").click()
    expect(page.locator("section.session")).to_have_count(3)
    page.get_by_role("button", name="More actions for Session").click()
    page.get_by_role("menuitem", name="Delete session").click()
    expect(page.locator("section.session")).to_have_count(2)
    page.screenshot(path=f"{shots}-7-week.png", full_page=True)
    print("sessions and questions edited")

    # A question is deleted in the list, as text is: emptied, then Backspace.
    first = page.locator("ol.questions li:not(.adder) textarea").first
    first.click()
    page.keyboard.press("Control+A")
    page.keyboard.press("Backspace")
    page.keyboard.press("Backspace")
    expect(page.locator("ol.questions li:not(.adder)")).to_have_count(2)

    # Delete a whole module with typed confirmation, then restore it.
    open_module(page, "HY206")
    page.get_by_role("button", name="Edit module").click()
    page.get_by_role("button", name="Delete HY206").click()
    dialog = page.locator("dialog.dialog[open]")
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role("button", name="Delete module")).to_be_disabled()
    dialog.get_by_label("Type HY206 to confirm").fill("HY206")
    page.screenshot(path=f"{shots}-8-dialog.png")
    dialog.get_by_role("button", name="Delete module").click()
    expect(page.locator(".module-row")).to_have_count(1)
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); const ws = (j.rows.weeks || []); return ws.filter(w => w.deleted).length === 22; }")
    page.get_by_role("link", name="Settings").click()
    expect(page.locator(".bin li", has_text="HY206")).to_be_visible()
    page.screenshot(path=f"{shots}-8b-bin.png", full_page=True)
    entries = page.locator(".bin li").all_text_contents()
    print("bin after module delete:", [e.split("Restore")[0] for e in entries])
    page.locator(".bin li", has_text="HY206").get_by_role("button", name="Restore").click()
    page.get_by_role("link", name="Study Library").click()
    expect(page.locator(".module-row")).to_have_count(2)
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.weeks || []).every(w => !w.deleted); }")
    print("module deleted and restored")

    # A second device sees the edits.
    other = browser.new_page(viewport={"width": 390, "height": 844})
    other.goto(BASE + "/")
    expect(other.locator(".module-row .code").first).to_have_text("HY206")
    other.locator(".module-row", has_text="HY335").click()
    expect(other.get_by_text("China and the World since 1949")).to_be_visible()
    other.screenshot(path=f"{shots}-9-phone.png")
    print("second device synced")

    # The new controls at phone width.
    other.get_by_role("button", name="Edit module").click()
    other.screenshot(path=f"{shots}-10-phone-settings.png", full_page=True)
    other.get_by_role("button", name="Cancel").click()
    other.locator("#week-AT1 .week-title").click()
    other.get_by_role("button", name="More actions for Class: Mao and the Three Worlds").click()
    other.screenshot(path=f"{shots}-11-phone-week.png", full_page=True)
    other.keyboard.press("Escape")
    expect(other.get_by_role("menu")).to_have_count(0)
    other.locator("li.reading", has_text="Chen").get_by_role("button", name="More actions").click()
    other.screenshot(path=f"{shots}-12-phone-reading-menu.png")
    other.keyboard.press("Escape")
    other.get_by_role("link", name="Settings").click()
    other.screenshot(path=f"{shots}-13-phone-bin.png", full_page=True)

    # The skip link is the first thing the keyboard reaches.
    page.goto(BASE + "/?v=settings")
    page.wait_for_timeout(500)
    page.keyboard.press("Tab")
    expect(page.get_by_role("link", name="Skip to content")).to_be_focused()

    print("skip link reached first")
    print("page errors:", errors[:5])
    assert not errors
    browser.close()
