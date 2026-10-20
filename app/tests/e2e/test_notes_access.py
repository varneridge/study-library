"""Version 0.21: getting to lecture and seminar notes quickly."""
import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
shots = str(HERE / "shots" / "notes-access")


def until(page, script, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:90])


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

    # The home page opens on this week, with each session one tap away.
    expect(page.get_by_role("heading", name="This week: AT2")).to_be_visible()
    expect(page.locator(".this-week")).to_contain_text("5 to 9 Oct")
    # Each module also has a Readings box since 0.24; sessions are counted apart.
    sessions = page.locator(".tw-session:not(.tw-readings)")
    expect(page.locator(".tw-readings")).to_have_count(2)
    print("this week:", page.locator(".tw-module").all_inner_texts())
    assert sessions.count() == 4, sessions.count()
    page.screenshot(path=f"{shots}-1-home.png")
    page.locator(".tw-module", has_text="HY206").locator(".tw-session", has_text="Seminar").click()
    expect(page.locator("h1", has_text="Seminar")).to_be_visible()
    expect(page.locator(".crumbs")).to_contain_text("HY206")
    expect(page.locator(".crumbs")).to_contain_text("AT2")
    print("one tap from the home page to the HY206 AT2 seminar notes")

    # Writing there shows on the home page, and the session is remembered.
    page.locator(".session-notes .bn-editor[contenteditable='true']").wait_for()
    page.locator(".session-notes .bn-editor").click()
    page.keyboard.type("The long telegram reframed Soviet intentions.")
    page.wait_for_timeout(1500)
    page.get_by_role("link", name="Study Library").click()
    expect(page.locator(".tw-module", has_text="HY206").locator(".tw-session", has_text="Seminar")).to_contain_text("6 words")
    print("the home page shows how much is written")

    # Any week of a module is one tap from its notes on the module page.
    page.locator(".module-row", has_text="HY319").click()
    page.locator("#week-AT7 .session-link", has_text="Lecture").click()
    expect(page.locator(".crumbs")).to_contain_text("AT7")
    expect(page.locator("h1", has_text="Lecture")).to_be_visible()
    print("module page to AT7 lecture notes in one tap")

    # A week further back shows under notes opened lately.
    page.get_by_role("link", name="Study Library").click()
    # Notes you opened sit in Recently opened, with the readings.
    expect(page.locator("ul.recent li", has_text="Lecture notes").first).to_contain_text("HY319 AT7")
    print("recently opened:", page.locator("ul.recent").inner_text().replace("\n", " | "))

    # Go to: type a few letters, Enter.
    page.keyboard.press("Control+k")
    page.keyboard.type("319 at4 sem")
    expect(page.locator("dialog.palette li[aria-selected='true']")).to_contain_text("HY319 AT4 Seminar")
    page.keyboard.press("Enter")
    expect(page.locator(".crumbs")).to_contain_text("AT4")
    expect(page.locator("h1", has_text="Seminar")).to_be_visible()
    print("Ctrl K, '319 at4 sem', Enter: the AT4 seminar notes")

    # Term dates can be corrected, and the week follows.
    page.goto(BASE + "/?v=settings")
    page.get_by_label("Autumn Term week 1").fill("2026-10-05")
    page.wait_for_timeout(500)
    page.get_by_role("link", name="Study Library").click()
    expect(page.get_by_role("heading", name="This week: AT1")).to_be_visible()
    print("moving the term start moves the week")
    page.goto(BASE + "/?v=settings")
    expect(page.get_by_label("Autumn Term week 1")).to_have_value("2026-10-05")
    page.get_by_label("Autumn Term week 1").fill("2026-09-28")
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); const r = (j.rows.settings || []).find(x => x.id === 'term-dates'); return r && r.value['2026'].AT === '2026-09-28'; }")

    # Slides: faint arrows on the slide that fade when left alone.
    import pymupdf
    deck = HERE / "files-citations" / "deck.pdf"
    deck.parent.mkdir(exist_ok=True)
    doc = pymupdf.open()
    for n in range(3):
        doc.new_page(width=720, height=405).insert_text((60, 80), f"Slide {n + 1}: the Concordat", fontsize=28)
    doc.save(deck)
    page.get_by_role("link", name="Study Library").click()
    page.locator(".tw-module", has_text="HY319").locator(".tw-head").click()
    lecture = page.locator("section.session").first
    with page.expect_file_chooser() as chooser:
        lecture.get_by_role("button", name="Add slides").click()
    chooser.value.set_files(str(deck))
    page.wait_for_timeout(1500)
    lecture.locator(".session-title a").click()
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

    # Questions on the seminar page, typed straight in.
    page.get_by_role("link", name="Study Library").click()
    page.locator(".tw-module", has_text="HY319").locator(".tw-session", has_text="Seminar").click()
    page.get_by_label("Add a question").fill("Why did Napoleon want a Concordat?")
    page.get_by_label("Add a question").press("Enter")
    expect(page.get_by_label("Question 1", exact=True)).to_have_value("Why did Napoleon want a Concordat?")
    expect(page.get_by_label("Add a question")).to_be_focused()
    print("a seminar question typed straight onto the page")

    # Phone.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.clock.install(time="2026-10-08T10:05:00")
    phone.clock.resume()
    phone.goto(BASE + "/")
    expect(phone.get_by_role("heading", name="This week: AT2")).to_be_visible(timeout=15000)
    phone.screenshot(path=f"{shots}-2-phone.png", full_page=True)

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
