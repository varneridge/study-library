"""Version 0.8: home progress and next reading, question navigation, recent
searches, first steps on an empty module, and light by default.

Run after test_sessions.py, which leaves the module and questions used here."""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
shots = str(HERE / "shots" / "usability")

with sync_playwright() as p:
    browser = p.chromium.launch()
    # A device set to dark still opens in light, which is the default.
    page = browser.new_page(viewport={"width": 1280, "height": 900}, color_scheme="dark")
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(BASE + "/")
    expect(page.get_by_role("heading", name="Modules")).to_be_visible()
    assert page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(252, 252, 251)"
    print("light by default on a dark device")

    # Home: progress through each module and the next unread reading.
    row = page.locator(".module-item").first
    expect(row.locator(".next-up")).to_contain_text("Next")
    print("home:", row.inner_text().replace("\n", " | "))
    page.screenshot(path=f"{shots}-1-home.png", full_page=True)
    row.locator(".next-up a").first.click()
    expect(page.locator(".reader")).to_be_visible()
    print("Next opens the reading")

    # Questions link to each other, and list the week's readings.
    page.goto(BASE + "/")
    page.locator(".module-row").first.click()
    page.locator("#week-AT1 .week-title").click()
    # A question opens its session, where it is answered.
    page.goto(BASE + "/?v=across&term=AT&n=1")
    page.locator(".across-session .questions a").first.click()
    expect(page.locator(".session-page .question-row").first).to_be_visible()
    page.screenshot(path=f"{shots}-2-question.png", full_page=True)
    print("a question opens its session")

    # Notes say what they can do.
    page.locator(".session-notes .bn-editor[contenteditable='true']").wait_for()
    page.wait_for_timeout(500)
    page.locator(".session-notes .bn-editor").click()
    page.keyboard.press("Control+End")
    page.keyboard.press("Enter")
    # The prompt shows on the empty line once the editor has drawn it.
    page.wait_for_function("""() => [...document.querySelectorAll('.session-notes .bn-block-content')]
      .some(e => getComputedStyle(e, '::after').content.includes('@ to cite'))""", timeout=5000)
    print("notes placeholder explains / and @")

    # Recent searches.
    page.goto(BASE + "/?v=search")
    page.get_by_placeholder("Search readings, notes, highlights and transcripts").fill("cold war")
    expect(page.get_by_role("heading", name="Highlights")).to_be_visible(timeout=10000)
    page.wait_for_timeout(600)
    page.get_by_placeholder("Search readings, notes, highlights and transcripts").fill("")
    expect(page.get_by_role("heading", name="Recent searches")).to_be_visible()
    page.locator(".recent button", has_text="cold war").click()
    expect(page.get_by_role("heading", name="Highlights")).to_be_visible(timeout=10000)
    print("recent searches come back with one click")

    # A new, empty module says how to begin.
    page.goto(BASE + "/")
    page.get_by_role("button", name="Add a module").click()
    page.get_by_label("Code").fill("HY999")
    page.get_by_role("button", name="Create module").click()
    expect(page.locator(".first-steps")).to_contain_text("Add this module's readings")
    page.screenshot(path=f"{shots}-3-first-steps.png")
    page.get_by_role("button", name="Edit module").click()
    page.get_by_role("button", name="Delete HY999").click()
    page.locator("dialog.dialog[open]").get_by_label("Type HY999 to confirm").fill("HY999")
    page.locator("dialog.dialog[open]").get_by_role("button", name="Delete module").click()
    print("an empty module shows its first steps")

    # Phone: home and a question.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.goto(BASE + "/")
    expect(phone.locator(".module-item").first).to_be_visible()
    phone.screenshot(path=f"{shots}-4-phone-home.png", full_page=True)

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
