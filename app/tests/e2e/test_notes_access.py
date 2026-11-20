"""Version 0.21: getting to lecture and seminar notes quickly. This week
shows each module's week as a card, and a week's session cards open their notes."""
import re, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
shots = str(HERE / "shots" / "notes-access")


from helpers import add_session, open_module, pick_date, save_settings, until


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    # Thursday 8 October 2026: week 2 of Autumn Term at LSE.
    # Time runs on from there, so saved changes still carry fresh times.
    page.clock.install(time="2026-10-08T10:00:00")
    page.clock.resume()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    for n, (code, title) in enumerate([("HY319", "Napoleon and Europe"), ("HY206", "The International History of the Cold War")]):
        if n:
            page.get_by_role("button", name="Add a module").click()
        page.get_by_label("Code").fill(code)
        page.get_by_label("Title").fill(title)
        page.get_by_role("button", name="Create module").click()
        expect(page.locator("h1", has_text=code)).to_be_visible()
        page.get_by_role("link", name="Study Library").click()

    # This week opens on this week, with each module's week as a card. The
    # laptop's top bar has no link to it, so it is opened by its address.
    page.goto(BASE + "/?v=across")
    expect(page.locator("h1", has_text="This week")).to_be_visible()
    expect(page.locator(".when")).to_contain_text("5 to 9 Oct")
    cards = page.locator(".across-week-grid .week-card")
    expect(cards).to_have_count(2)
    print("this week:", [t.replace("\n", " | ") for t in cards.all_inner_texts()])
    page.screenshot(path=f"{shots}-1-this-week.png")
    cards.filter(has_text="HY206").locator(".week-title").click()
    expect(page.locator(".week-page h1")).to_contain_text("AT2")
    # A new week has no sessions, so a seminar is added, and its card opens its notes.
    add_session(page, "seminar")
    seminar = page.locator(".week-session-card[data-label='Seminar']")
    seminar.locator("a.wsc-body").click()
    expect(page.locator("h1", has_text="Seminar")).to_be_visible()
    expect(page).to_have_title(re.compile(r"HY206 AT2 Seminar"))
    print("from This week to the HY206 AT2 week, and on to its seminar notes")

    # Writing there shows on the seminar's card, and the session is remembered.
    page.locator(".session-notes .bn-editor[contenteditable='true']").wait_for()
    page.locator(".session-notes .bn-editor").click()
    page.keyboard.type("The long telegram reframed Soviet intentions.")
    page.wait_for_timeout(1500)
    # The session page has no link to its week, so Back returns there.
    page.go_back()
    expect(seminar.locator(".wsc-preview")).to_contain_text("long telegram")
    print("the seminar's card shows the notes written in it")

    # Any week of a module opens from its card on the module page, and its
    # session card opens the notes.
    open_module(page, "HY319")
    page.locator("#week-AT7 .week-title").click()
    add_session(page, "lecture")
    page.locator(".week-session-card[data-label='Lecture']").locator("a.wsc-body").click()
    expect(page).to_have_title(re.compile(r"HY319 AT7 Lecture"))
    expect(page.locator("h1", has_text="Lecture")).to_be_visible()
    print("module page to the AT7 lecture notes")

    # A week further back shows under notes opened lately in Go to (Ctrl+K).
    page.keyboard.press("Control+k")
    palette = page.locator("dialog.palette")
    expect(palette.locator("li", has_text="HY319 AT7 Lecture").first).to_be_visible()
    print("recently opened in Palette:", palette.locator("li").first.inner_text().replace("\n", " | "))

    # Go to: type a few letters, Enter. Go to lists sessions that exist, and
    # the HY206 AT2 seminar was added above.
    page.keyboard.type("206 at2 sem")
    expect(page.locator("dialog.palette li[aria-selected='true']")).to_contain_text("HY206 AT2 Seminar")
    page.keyboard.press("Enter")
    expect(page).to_have_title(re.compile(r"HY206 AT2 Seminar"))
    expect(page.locator("h1", has_text="Seminar")).to_be_visible()
    print("Ctrl K, '206 at2 sem', Enter: the HY206 AT2 seminar notes")

    # Term dates can be corrected, and the week follows.
    page.goto(BASE + "/?v=settings")
    pick_date(page, page.get_by_label("Autumn Term week 1"), "2026-10-05")
    save_settings(page)
    page.wait_for_timeout(500)
    page.goto(BASE + "/?v=across")
    expect(page.locator(".picker button[aria-pressed='true']")).to_have_text("1")
    print("moving the term start moves the week")
    page.goto(BASE + "/?v=settings")
    expect(page.get_by_label("Autumn Term week 1")).to_contain_text("5 October 2026")
    pick_date(page, page.get_by_label("Autumn Term week 1"), "2026-09-28")
    save_settings(page)
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); const r = (j.rows.settings || []).find(x => x.id === 'term-dates'); return r && r.value['2026'].AT === '2026-09-28'; }")

    # Slides: faint arrows on the slide that fade when left alone.
    import pymupdf
    deck = HERE / "files-citations" / "deck.pdf"
    deck.parent.mkdir(exist_ok=True)
    doc = pymupdf.open()
    for n in range(3):
        doc.new_page(width=720, height=405).insert_text((60, 80), f"Slide {n + 1}: the Concordat", fontsize=28)
    doc.save(deck)
    page.goto(BASE + "/?v=across")
    page.locator(".across-week-grid .week-card", has_text="HY319").locator(".week-title").click()
    # A new week has no sessions, so a lecture is added to take the slides.
    add_session(page, "lecture")
    lecture = page.locator(".week-session-card[data-label='Lecture']").first
    with page.expect_file_chooser() as chooser:
        lecture.get_by_role("button", name="Add slides").click()
    chooser.value.set_files(str(deck))
    page.wait_for_timeout(1500)
    lecture.locator("a.wsc-body").click()
    slide = page.locator(".slide-box")
    expect(slide.locator("canvas")).to_be_visible(timeout=15000)
    arrow = page.get_by_role("button", name="Next slide")
    opacity = lambda: float(arrow.evaluate("e => getComputedStyle(e).opacity"))
    page.mouse.move(5, 5)
    page.wait_for_timeout(2300)
    print("arrow opacity when left alone:", opacity())
    assert opacity() == 0
    box = slide.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.wait_for_timeout(350)
    print("arrow opacity on moving over the slide:", opacity())
    assert opacity() > 0.5
    arrow.click()
    expect(page.locator(".slide-count")).to_have_text("2 / 3")
    page.screenshot(path=f"{shots}-3-slide-arrows.png")
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 3)
    page.wait_for_timeout(2400)
    print("and once the pointer rests:", opacity())
    assert opacity() == 0
    expect(page.get_by_role("button", name="Previous slide")).to_be_enabled()

    # Phone.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.clock.install(time="2026-10-08T10:05:00")
    phone.clock.resume()
    phone.goto(BASE + "/?v=across")
    expect(phone.locator("h1", has_text="This week")).to_be_visible(timeout=15000)
    phone.screenshot(path=f"{shots}-2-phone.png", full_page=True)

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
