"""Version 0.14: a reading's notes hold its highlights as quotations, in
reading order, with your own writing around them."""
import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
files = sorted(str(p) for p in (HERE / "files").glob("*.pdf"))
shots = str(HERE / "shots" / "reading-notes")


def until(page, script, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:90])


def highlight(page, page_index, line, colour="yellow"):
    page.evaluate("""([p, line]) => {
      const span = [...document.querySelectorAll(`.pdf-page[data-page="${p}"] .textLayer span`)].find(s => s.textContent.includes(`line ${line}.`));
      const r = document.createRange(); r.selectNodeContents(span);
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }""", [page_index, line])
    page.get_by_role("button", name=f"Highlight {colour}").click()
    page.get_by_role("button", name="Done").click()


def click_hl(page, which):
    """Clicks a highlight on the page, as a person would."""
    box = page.locator(".pdf-page .hl").nth(which).bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


def quotes(page):
    return page.locator(".reading-notes .note-highlight .quote").all_inner_texts()


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("HY319")
    page.get_by_role("button", name="Create module").click()
    page.locator("#week-AT1 .week-title").click()
    page.locator("input[type=file][accept='.pdf,.pptx,.ppt,.docx,.doc,image/*,.heic,.heif']").first.set_input_files(files[:1])
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 1; }", 40)
    page.locator("li.reading a.name").first.click()
    page.wait_for_function("document.querySelectorAll('.pdf-page[data-page=\"0\"] .textLayer span').length > 3", timeout=20000)

    # The Notes tab is open, and says what it does.
    expect(page.get_by_role("tab", name="Notes")).to_have_attribute("aria-selected", "true")
    expect(page.locator(".reading-notes .notes-hint")).to_contain_text("Anything you highlight joins these notes")
    page.locator(".reading-notes .bn-editor").click()
    page.keyboard.type("First impressions: a clear introduction.")
    page.wait_for_timeout(600)

    # Highlights arrive as quotations, in reading order, whatever order they were made in.
    highlight(page, 0, 9)
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(1, timeout=10000)
    highlight(page, 0, 3, "green")
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(2, timeout=10000)
    print("quotations:", quotes(page))
    assert "line 3." in quotes(page)[0] and "line 9." in quotes(page)[1]
    texts = page.locator(".reading-notes .bn-editor").inner_text()
    assert texts.index("First impressions") < texts.index("line 3."), "typed note should stay first"
    print("highlights sit in reading order, after what was already written")

    # Write a note about a highlight: the cursor lands beneath its quotation.
    click_hl(page, 0)
    page.get_by_role("button", name="Write a note about this").click()
    page.wait_for_timeout(500)
    page.keyboard.type("Line three sets the scene.")
    page.wait_for_timeout(700)
    texts = page.locator(".reading-notes .bn-editor").inner_text()
    print(texts.replace("\n", " | "))
    assert texts.index("line 3.") < texts.index("Line three sets the scene.") < texts.index("line 9.")

    # A new highlight between them goes after the note written under line 3.
    highlight(page, 0, 5)
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(3, timeout=10000)
    texts = page.locator(".reading-notes .bn-editor").inner_text()
    assert texts.index("Line three sets the scene.") < texts.index("line 5.") < texts.index("line 9."), texts
    print("a new quotation keeps your writing with the quotation it was about")
    page.screenshot(path=f"{shots}-1-notes.png")

    # Recolouring on the page recolours the quotation.
    click_hl(page, -1)
    page.locator(".floating.panel").get_by_role("button", name="Purple").click()
    page.get_by_role("button", name="Done").click()
    until(page, "[...document.querySelectorAll('.reading-notes .note-highlight')].some(q => getComputedStyle(q).borderLeftColor === 'rgb(162, 138, 229)')")
    print("recolouring follows into the notes")

    # A quotation's page link takes the reader to the passage.
    page.locator(".reading-notes .quote-meta button").first.click()
    expect(page.locator(".floating.panel")).to_be_visible()
    page.get_by_role("button", name="Done").click()

    # Removing a quotation from the notes removes the highlight, with undo.
    count = page.locator(".pdf-page .hl").count()
    quote = page.locator(".reading-notes .note-highlight").nth(1)
    quote.click()
    page.keyboard.press("Delete")
    expect(page.locator(".toast")).to_contain_text("Highlight removed from the page too")
    expect(page.locator(".pdf-page .hl")).to_have_count(count - 1)
    page.locator(".toast").get_by_role("button", name="Undo").click()
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(3, timeout=10000)
    print("deleting a quotation removes its highlight, and undo brings both back")

    # Deleting a highlight on the page takes its quotation out of the notes.
    click_hl(page, 0)
    page.locator(".floating.panel").get_by_role("button", name="Delete").click()
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(2, timeout=10000)
    assert "Line three sets the scene." in page.locator(".reading-notes .bn-editor").inner_text()
    print("deleting on the page removes the quotation and keeps what you wrote")

    # A highlight with a comment from before (as the Zotero importer makes)
    # moves into the notes, with its comment written beneath it.
    page.evaluate("""async () => {
      const j = await (await fetch('/api/sync/pull?since=0')).json();
      const h = (j.rows.highlights || []).find(x => !x.deleted);
      const row = { ...h, id: crypto.randomUUID(), page: 1, rects: [[72, 700, 400, 712]], body: 'An older highlight', comment: 'An older comment', modified_at: new Date().toISOString() };
      await fetch('/api/sync/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: [{ table: 'highlights', row }] }) });
    }""")
    page.reload()
    expect(page.locator(".reading-notes .quote", has_text="An older highlight")).to_be_visible(timeout=20000)
    page.wait_for_timeout(1000)
    texts = page.locator(".reading-notes .bn-editor").inner_text()
    assert texts.index("An older highlight") < texts.index("An older comment"), texts
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.highlights || []).some(h => h.body === 'An older highlight' && !h.comment); }")
    print("an old comment moved into the notes beneath its quotation")

    # The same notes on a phone, as text.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.goto(page.url)
    phone.get_by_role("button", name="Sidebar").click()
    expect(phone.locator(".reading-notes .note-highlight")).to_have_count(3, timeout=15000)
    phone.screenshot(path=f"{shots}-2-phone.png")

    # Deleting a quotation on a phone removes its highlight from the page too.
    phone.locator(".reading-notes .note-highlight").first.get_by_role("button", name="Delete quotation").click()
    expect(phone.locator(".toast")).to_contain_text("Highlight removed from the page too")
    expect(phone.locator(".reading-notes .note-highlight")).to_have_count(2, timeout=10000)
    print("deleting a quotation on a phone removes the highlight and quotation")
    phone.close()

    # Deleting all remaining highlights leaves the notes cleanly cleared.
    while page.locator(".pdf-page .hl").count() > 0:
        hl_loc = page.locator(".pdf-page .hl").first
        hl_loc.scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        box = hl_loc.bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.locator(".floating.panel").get_by_role("button", name="Delete").click()
        page.wait_for_timeout(400)
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(0, timeout=10000)
    page.reload()
    page.wait_for_function("document.querySelectorAll('.pdf-page[data-page=\"0\"] .textLayer span').length > 3", timeout=20000)
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(0, timeout=10000)
    print("deleting all highlights clears the notes and does not return on reload")

    print("page errors:", errors[:5])
    assert not errors
    browser.close()

