"""Version 0.14: a reading's notes hold its highlights as quotations, in
reading order, with your own writing around them. A highlight's comment is
written in its quotation's card and stays on the highlight's own row."""
import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
files = sorted(str(p) for p in (HERE / "files").glob("*.pdf"))
shots = str(HERE / "shots" / "reading-notes")


from helpers import until


def highlight(page, page_index, line, colour="yellow"):
    # A person starts a highlight on the page, which takes the cursor out of
    # the notes; a scripted selection does not, so it is moved out here.
    page.evaluate("document.activeElement && document.activeElement.blur()")
    page.evaluate("""([p, line]) => {
      const span = [...document.querySelectorAll(`.pdf-page[data-page="${p}"] .textLayer span`)].find(s => s.textContent.includes(`line ${line}.`));
      const r = document.createRange(); r.selectNodeContents(span);
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }""", [page_index, line])
    # A highlight is made in one step and leaves nothing open to close.
    page.get_by_role("button", name=f"Highlight {colour}").click()


def click_hl(page, which):
    """Clicks a highlight on the page, as a person would."""
    box = page.locator(".pdf-page .hl").nth(which).bounding_box()
    page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


def card(page, line):
    """The quotation card in the notes for the highlight of a line."""
    return page.locator(".reading-notes .note-highlight", has=page.locator(".quote", has_text=f"line {line}."))


def click_hl_of(page, line):
    """Clicks, on the page, the highlight whose quotation shows this line."""
    hid = card(page, line).get_attribute("data-highlight-id")
    mark = page.locator(f".pdf-page .hl[data-id='{hid}']").first
    mark.scroll_into_view_if_needed()
    box = mark.bounding_box()
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
    page.locator("input[type=file][accept^='.pdf,.epub']").first.set_input_files(files[:1])
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 1; }", 40)
    page.locator("li.reading a.name").first.click()
    page.wait_for_function("document.querySelectorAll('.pdf-page[data-page=\"0\"] .textLayer span').length > 3", timeout=20000)

    # The sidebar opens on the contents until a tab is chosen; the Notes tab
    # is one click away, and says what it does.
    expect(page.get_by_role("tab", name="Contents")).to_have_attribute("aria-selected", "true")
    page.get_by_role("tab", name="Notes").click()
    expect(page.get_by_role("tab", name="Notes")).to_have_attribute("aria-selected", "true")

    # Note editor carries screen-reader label
    expect(page.locator(".note-editor[aria-label='Reading notes']")).to_be_visible()
    expect(page.locator(".bn-editor[aria-label='Reading notes']")).to_be_visible()

    page.locator(".reading-notes .bn-editor").click()
    page.keyboard.type("First impressions: a clear introduction.")
    page.wait_for_timeout(600)

    # Highlights arrive as quotations, in reading order, whatever order they were made in.
    highlight(page, 0, 9)
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(1, timeout=10000)

    # Highlight reached and operable from the keyboard
    hl_btn = page.locator(".pdf-page .hl[role='button']").first
    expect(hl_btn).to_be_visible()
    hl_btn.focus()
    page.keyboard.press("Enter")
    expect(page.locator("div[role='dialog'][aria-label='Highlight']")).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.locator("div[role='dialog'][aria-label='Highlight']")).to_have_count(0)
    highlight(page, 0, 3, "green")
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(2, timeout=10000)
    print("quotations:", quotes(page))
    assert "line 3." in quotes(page)[0] and "line 9." in quotes(page)[1]
    texts = page.locator(".reading-notes .bn-editor").inner_text()
    assert texts.index("First impressions") < texts.index("line 3."), "typed note should stay first"
    print("highlights sit in reading order, after what was already written")

    # Write a note about a highlight: the cursor lands in its quotation's card,
    # and what is written there is saved as the highlight's comment.
    click_hl_of(page, 3)
    page.get_by_role("button", name="Write a note about this").click()
    comment3 = card(page, 3).get_by_label("Comment on this highlight")
    expect(comment3).to_be_focused(timeout=10000)
    page.keyboard.type("Line three sets the scene.")
    expect(comment3).to_have_value("Line three sets the scene.")
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.highlights || []).some(h => !h.deleted && h.comment === 'Line three sets the scene.'); }")
    print("writing about a highlight fills its card's comment, saved on the highlight")

    # A new highlight between them takes its place in reading order, and the
    # comment stays in the card of the quotation it was about.
    highlight(page, 0, 5)
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(3, timeout=10000)
    q = quotes(page)
    order = [next(i for i, t in enumerate(q) if f"line {n}." in t) for n in (3, 5, 9)]
    assert order == sorted(order), q
    expect(comment3).to_have_value("Line three sets the scene.")
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
    # The quotation's text, not its comment field, so the card itself is chosen.
    quote.locator(".quote").click()
    page.keyboard.press("Delete")
    expect(page.locator(".toast")).to_contain_text("Highlight removed from the page too")
    expect(page.locator(".pdf-page .hl")).to_have_count(count - 1)
    page.locator(".toast").get_by_role("button", name="Undo").click()
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(3, timeout=10000)
    expect(page.locator(".pdf-page .hl")).to_have_count(3, timeout=10000)
    print("deleting a quotation removes its highlight, and undo brings both back")

    # Ctrl+Z in the notes restores the quotation and brings its highlight back on the page.
    count = page.locator(".pdf-page .hl").count()
    quote = page.locator(".reading-notes .note-highlight").nth(1)
    quote.get_by_role("button", name="Delete quotation").click()
    expect(page.locator(".toast")).to_contain_text("Highlight removed from the page too")
    expect(page.locator(".pdf-page .hl")).to_have_count(count - 1, timeout=10000)
    # The cursor goes in the written notes, where undo belongs, not in a card's comment.
    page.locator(".reading-notes .bn-editor").get_by_text("First impressions").click()
    page.keyboard.press("ControlOrMeta+z")
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(3, timeout=10000)
    expect(page.locator(".pdf-page .hl")).to_have_count(count, timeout=10000)
    print("Ctrl+Z in notes brings quotation and its highlight back on the page")

    # Deleting a highlight on the page takes its quotation, and the comment on
    # it, out of the notes, and keeps what was written in the notes themselves.
    click_hl_of(page, 3)
    page.locator(".floating.panel").get_by_role("button", name="Delete").click()
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(2, timeout=10000)
    expect(card(page, 3)).to_have_count(0)
    assert "First impressions: a clear introduction." in page.locator(".reading-notes .bn-editor").inner_text()
    print("deleting on the page removes the quotation and keeps what you wrote")

    # A highlight with a comment from before (as the Zotero importer makes)
    # joins the notes as a quotation, its comment shown in the card and kept
    # on the highlight's own row.
    page.evaluate("""async () => {
      const j = await (await fetch('/api/sync/pull?since=0')).json();
      const h = (j.rows.highlights || []).find(x => !x.deleted);
      const row = { ...h, id: crypto.randomUUID(), page: 1, rects: [[72, 700, 400, 712]], body: 'An older highlight', comment: 'An older comment', modified_at: new Date().toISOString() };
      await fetch('/api/sync/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: [{ table: 'highlights', row }] }) });
    }""")
    page.reload()
    page.get_by_role("tab", name="Notes").click()
    expect(page.locator(".reading-notes .quote", has_text="An older highlight")).to_be_visible(timeout=20000)
    older = page.locator(".reading-notes .note-highlight", has=page.locator(".quote", has_text="An older highlight"))
    expect(older.get_by_label("Comment on this highlight")).to_have_value("An older comment")
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.highlights || []).some(h => h.body === 'An older highlight' && h.comment === 'An older comment'); }")
    print("an old comment shows in its quotation's card and stays on the highlight")

    # Write a comment directly in a quotation's card in the notes sidebar.
    first_comment = page.locator(".reading-notes .note-highlight").first.get_by_label("Comment on this highlight")
    first_comment.click()
    page.keyboard.type("Direct note under quotation.")
    expect(first_comment).to_have_value("Direct note under quotation.")
    print("a comment can be written straight into a quotation's card in the notes")

    # A background refresh must never move cursor or replace the document while writing in it.
    page.locator(".reading-notes .bn-editor").get_by_text("First impressions").click()
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    page.keyboard.type("Active drafting in progress...")
    page.evaluate("""async () => {
      const j = await (await fetch('/api/sync/pull?since=0')).json();
      const n = (j.rows.notes || []).find(x => !x.deleted);
      if (n) {
        const block = { id: crypto.randomUUID(), note_id: n.id, position: 'z9', type: 'paragraph', content: { id: crypto.randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text: 'Remote note from phone.', styles: {} }], children: [] }, highlight_id: null, modified_at: new Date().toISOString(), deleted: false };
        await fetch('/api/sync/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changes: [{ table: 'note_blocks', row: block }] }) });
        window.dispatchEvent(new Event('online'));
      }
    }""")
    page.wait_for_timeout(300)
    # The user continues typing uninterrupted: the cursor has not moved
    page.keyboard.type(" and continued seamlessly.")
    page.wait_for_timeout(600)
    texts = page.locator(".reading-notes .bn-editor").inner_text()
    assert "Active drafting in progress... and continued seamlessly." in texts, f"document was replaced or cursor moved: {texts}"
    # When leaving the editor, edits are persisted and remote changes integrate safely
    page.locator(".pdf-page").first.click()
    page.wait_for_timeout(500)
    texts = page.locator(".reading-notes .bn-editor").inner_text()
    assert "Active drafting in progress... and continued seamlessly." in texts
    assert "Remote note from phone." in texts
    print("background refresh never moves cursor or replaces document while writing")

    # Clicking empty space below all notes allows typing at the end.
    last_block = page.locator(".reading-notes .bn-block").last
    last_block.scroll_into_view_if_needed()
    editor_box = page.locator(".reading-notes .note-editor").bounding_box()
    last_block_box = last_block.bounding_box()
    page.mouse.click(editor_box["x"] + 20, last_block_box["y"] + last_block_box["height"] + 20)
    page.keyboard.type("Ending thought at the bottom.")
    page.wait_for_timeout(600)
    texts = page.locator(".reading-notes .bn-editor").inner_text()
    assert "Ending thought at the bottom." in texts
    assert texts.index("Active drafting") < texts.index("Ending thought")
    print("clicking below notes allows typing at the end")

    # Deleting an empty line does not accidentally delete the preceding quotation.
    for _ in range(len("Ending thought at the bottom.") + 2):
        page.keyboard.press("Backspace")
    page.wait_for_timeout(400)
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(3)
    print("deleting an empty line does not delete the preceding quotation")

    # Sidebar tabs move with the arrow keys, in their order of Contents, Pages, Notes.
    notes_tab = page.get_by_role("tab", name="Notes")
    notes_tab.focus()
    expect(notes_tab).to_be_focused()
    page.keyboard.press("ArrowLeft")
    pages_tab = page.get_by_role("tab", name="Pages")
    expect(pages_tab).to_be_focused()
    expect(pages_tab).to_have_attribute("aria-selected", "true")
    page.keyboard.press("ArrowRight")
    expect(notes_tab).to_be_focused()
    expect(notes_tab).to_have_attribute("aria-selected", "true")

    # The same notes on a phone, as text.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.goto(page.url)
    phone.wait_for_selector(".reader")
    # If the reading position was restored past 80px, the reader bar slides away.
    # Tapping the reader scroller below the top bar reveals the bar again.
    phone.locator(".scroller").click(position={"x": 50, "y": 100})
    expect(phone.locator(".reader-bar")).to_be_in_viewport()
    phone.get_by_role("button", name="Sidebar").click()
    phone.get_by_role("tab", name="Notes").click()
    expect(phone.locator(".reading-notes .note-highlight")).to_have_count(3, timeout=15000)
    phone.screenshot(path=f"{shots}-2-phone.png")

    # Guard: a quotation's Delete, hidden until hover elsewhere, is fully shown on touch and narrow viewports.
    quote_delete_opacity = phone.locator(".note-highlight .quote-delete").first.evaluate(
        "el => window.getComputedStyle(el).opacity"
    )
    assert quote_delete_opacity == "1", f"Expected quote-delete opacity 1 on touch viewport, got {quote_delete_opacity}"

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
    # The notes must be open, or a count of none would prove nothing.
    page.get_by_role("tab", name="Notes").click()
    expect(page.locator(".reading-notes .bn-editor")).to_be_visible(timeout=10000)
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(0, timeout=10000)
    print("deleting all highlights clears the notes and does not return on reload")

    print("page errors:", errors[:5])
    assert not errors
    browser.close()

