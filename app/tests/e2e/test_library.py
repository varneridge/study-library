import json, sys, time, glob
from pathlib import Path

HERE = Path(__file__).resolve().parent
(HERE / 'shots').mkdir(exist_ok=True)

def until(page, script, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:80])
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1]
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))
shots = str(HERE / "shots" / "library")


def page_colour(page, name):
    """Picks the theme from the reader's Appearance panel."""
    group = page.get_by_role("group", name="Theme")
    if not group.is_visible():
        page.get_by_role("button", name="Appearance").click()
    group.get_by_role("button", name=name).click()
    page.keyboard.press("Escape")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    expect(page.get_by_text("Add your first module")).to_be_visible()
    page.get_by_label("Code").fill("HY335")
    page.get_by_label("Title").fill("China and the World since 1949")
    page.screenshot(path=f"{shots}-1-new.png")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()
    expect(page.locator(".week")).to_have_count(22)
    print("module created with 22 weeks")

    page.get_by_role("link", name="Import readings").click()
    page.locator("input[type=file][accept]").set_input_files(files)
    expect(page.locator("table.review tbody tr")).to_have_count(3)
    weeks = page.locator("table.review tbody tr td:nth-child(2) select").evaluate_all(
        "els => els.map(e => e.options[e.selectedIndex].text)")
    kinds = page.locator("table.review tbody tr td:nth-child(3) select").evaluate_all(
        "els => els.map(e => e.options[e.selectedIndex].text)")
    print("review weeks", weeks, "types", kinds)
    page.screenshot(path=f"{shots}-2-import.png", full_page=True)
    page.get_by_role("button", name="Import 3 files").click()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()

    # Wait for uploads to finish.
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 3; }", 30)
    print("3 files uploaded and synced")

    page.locator(".week").nth(0).locator(".caret").click()
    expect(page.get_by_text("Chen (2001) ‘Introduction’")).to_be_visible()
    page.screenshot(path=f"{shots}-3-module.png")

    page.locator(".week").nth(0).locator(".week-title").click()
    expect(page.get_by_text("Primary sources")).to_be_visible()
    page.get_by_role("heading", name="AT1", exact=True).click()
    page.locator("input[type=text]").first.fill("Introductory Session")
    page.keyboard.press("Enter")
    expect(page.get_by_role("heading", name="Introductory Session")).to_be_visible()
    page.screenshot(path=f"{shots}-4-week.png")

    page.get_by_role("link", name="Chen, J. (2001) ‘Introduction’, in Mao’s China and the Cold War, pp. 1-16").click()
    page.wait_for_selector(".pdf-page canvas")
    page.wait_for_function("document.querySelectorAll('.textLayer span').length > 10", timeout=15000)
    page.wait_for_function("document.querySelectorAll('.pdf-page[data-page=\"0\"] .textLayer span').length > 3", timeout=15000)
    print("reader rendered with text layer")

    page.evaluate("""() => {
      const span = [...document.querySelectorAll('.pdf-page[data-page="0"] .textLayer span')].find(s => s.textContent.length > 20);
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    }""")
    page.get_by_role("button", name="Highlight yellow").click()
    expect(page.locator(".hl").first).to_be_visible()
    # Writing about a highlight happens in the notes, beneath its quotation.
    page.get_by_role("button", name="Write a note about this").click()
    page.wait_for_timeout(700)
    page.keyboard.type("Sets up the Cold War frame")
    page.screenshot(path=f"{shots}-5-highlight.png")
    server = until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); const h = (j.rows.highlights || [])[0]; const note = (j.rows.note_blocks || []).find(b => !b.deleted && JSON.stringify(b.content).includes('Sets up the Cold War frame')); const quote = (j.rows.note_blocks || []).find(b => !b.deleted && b.type === 'highlight'); return h && note && quote ? h : null; }")
    print("highlight synced, quoted in the notes with the note beneath:", server["page"], server["rects"], server["body"][:40])

    page_colour(page, "Sepia")
    page.get_by_role("tab", name="Notes").click()
    page.screenshot(path=f"{shots}-6-sepia.png")
    page.get_by_role("button", name="Mark as read", exact=True).click()
    expect(page.get_by_role("button", name="Read. Mark as unread")).to_have_attribute("aria-pressed", "true")
    page.get_by_role("button", name="Back to the week").click()
    page.wait_for_timeout(800)
    print("after back url:", page.url)
    print("marks:", page.locator(".reading .mark").evaluate_all("els => els.map(e => e.className)"))
    page.screenshot(path=f"{shots}-6b-back.png")
    expect(page.locator(".reading .mark.read")).to_have_count(1)

    # A second device sees the same data after syncing.
    other = browser.new_page(viewport={"width": 390, "height": 844})
    other.goto(BASE + "/")
    other.locator(".module-row", has_text="HY335").click()
    # The module opens at the week last looked at on the other device.
    expect(other.locator(".week").nth(0).locator(".caret")).to_have_attribute("aria-expanded", "true")
    expect(other.locator(".reading .mark.read")).to_have_count(1)
    expect(other.get_by_text("Introductory Session")).to_be_visible()
    other.screenshot(path=f"{shots}-7-phone.png")
    print("second device synced")

    print("console errors:", [e for e in errors if "favicon" not in e][:5])
    browser.close()
