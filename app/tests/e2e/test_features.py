"""Version 0.4: find in a reading, search, recently opened, the reader's
themes and contents, recordings, the notes menus, and the week views.

Run after test_sessions.py, which leaves the module, readings, highlights,
notes and recording this test uses."""
import io, sys, time
from pathlib import Path
import fitz
from PIL import Image
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
shots = str(HERE / "shots" / "features")


def until(page, script, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:90])


def figure_pdf() -> Path:
    """Three pages with a contents list and a coloured map on page one."""
    path = HERE / "files-extra" / "(AT2) Westad, O. A. (2005) 'The Global Cold War', pp. 1-3.pdf"
    path.parent.mkdir(exist_ok=True)
    picture = Image.new("RGB", (300, 200), (200, 60, 40))
    for x in range(300):
        for y in range(80, 120):
            picture.putpixel((x, y), (30, 120, 200))
    buffer = io.BytesIO()
    picture.save(buffer, format="PNG")
    doc = fitz.open()
    for n in range(3):
        page = doc.new_page()
        page.insert_text((72, 72), f"Chapter {n + 1}. The Third World and the superpowers.", fontsize=14)
        for line in range(2, 30):
            page.insert_text((72, 72 + line * 18), f"Line {line} on page {n + 1} about decolonisation and intervention.", fontsize=11)
        if n == 0:
            page.insert_image(fitz.Rect(72, 300, 372, 500), stream=buffer.getvalue())
    doc.set_toc([[1, "Introduction", 1], [1, "Revolutions", 2], [2, "Cuba", 3]])
    doc.save(path)
    return path



def page_colour(page, name):
    """Picks the theme from the reader's Appearance panel."""
    group = page.get_by_role("group", name="Theme")
    if not group.is_visible():
        page.get_by_role("button", name="Appearance").click()
    group.get_by_role("button", name=name).click()
    page.keyboard.press("Escape")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # Recently opened, from the readings opened in the sessions test.
    page.goto(BASE + "/")
    expect(page.get_by_role("heading", name="Recently opened")).to_be_visible()
    chen = page.locator(".recent li", has_text="Chen")
    expect(chen).to_be_visible()
    expect(chen.locator(".where")).to_have_text("HY319 AT1")
    page.screenshot(path=f"{shots}-1-home.png", full_page=True)
    print("recently opened lists", page.locator(".recent li").count(), "readings")

    # Find inside a reading.
    chen.locator(".name").click()
    page.wait_for_selector(".textLayer span")
    page.keyboard.press("Control+f")
    page.get_by_label("Find in this reading").fill("Cold War in Asia")
    expect(page.locator(".find-bar .count-at")).to_contain_text(" of ")
    total = page.locator(".find-bar .count-at").inner_text()
    expect(page.locator("mark.find-hit").first).to_be_visible()
    expect(page.locator("mark.find-hit.current")).to_have_count(1)
    first = int(total.split(" of ")[0])
    page.keyboard.press("Enter")
    expect(page.locator(".find-bar .count-at")).to_contain_text(f"{first % int(total.split(' of ')[1].split(',')[0]) + 1} of")
    page.screenshot(path=f"{shots}-2-find.png")
    print("find in reading:", total)
    page.get_by_role("button", name="Close find").click()
    expect(page.locator("mark.find-hit")).to_have_count(0)

    # Page jump and the end of the reading.
    page.get_by_label("Go to page").fill("3")
    page.keyboard.press("Enter")
    expect(page.get_by_label("Go to page")).to_have_value("3")
    expect(page.locator(".pages-at .of")).to_have_text("/ 3")
    expect(page.locator(".end-card")).to_contain_text("End of the reading")
    print("page jump and end card work")

    # Sepia and dark change the toolbar too.
    page_colour(page, "Dark")
    bar = page.evaluate("getComputedStyle(document.querySelector('.reader-bar')).backgroundColor")
    assert bar == "rgb(27, 29, 32)", bar
    page.screenshot(path=f"{shots}-3-dark.png")
    page_colour(page, "Sepia")
    page.screenshot(path=f"{shots}-4-sepia.png")
    page_colour(page, "Light")
    print("reader toolbar follows the page colour")

    # Search: own words first, grouped, with places.
    page.goto(BASE + "/?v=search")
    box = page.get_by_placeholder("Search readings, notes, highlights and transcripts")
    box.fill("cold war asia")
    expect(page.get_by_role("heading", name="In the readings")).to_be_visible(timeout=10000)
    order = page.locator(".search-page h2").all_inner_texts()
    print("section order:", order)
    assert order.index("Highlights") < order.index("In the readings"), order
    assert order.index("Notes") < order.index("In the readings"), order
    expect(page.locator(".hits .where", has_text="HY319 AT1").first).to_be_visible()
    groups = page.locator("section", has=page.get_by_role("heading", name="In the readings")).locator(".hits > li").count()
    print("reading groups:", groups)
    page.screenshot(path=f"{shots}-5-search.png", full_page=True)

    box.fill('"shaped chinese"')
    expect(page.get_by_role("heading", name="In the readings")).to_be_visible(timeout=10000)
    box.fill('"chinese shaped"')
    expect(page.get_by_text("Nothing matches that yet.")).to_be_visible(timeout=10000)
    box.fill("towards")
    expect(page.get_by_text("Nothing matches that yet.")).to_be_visible(timeout=10000)
    print("phrases and whole-word matching work")

    box.fill("cold war asia")
    expect(page.get_by_role("heading", name="In the readings")).to_be_visible(timeout=10000)
    page.get_by_role("group", name="Show").get_by_role("button", name="Notes").click()
    expect(page.get_by_role("heading", name="In the readings")).to_have_count(0)
    expect(page.get_by_role("heading", name="Notes")).to_be_visible()
    page.get_by_role("group", name="Show").get_by_role("button", name="Everything").click()
    page.locator("section", has=page.get_by_role("heading", name="In the readings")).locator("a.hit-line").first.click()
    expect(page.locator(".find-bar")).to_be_visible()
    expect(page.get_by_label("Find in this reading")).to_have_value("cold war asia")
    expect(page.locator(".find-bar .count-at")).to_contain_text(" of ")
    expect(page.locator("mark.find-hit").first).to_be_visible()
    print("a page hit opens the reader with the words marked:", page.locator(".find-bar .count-at").inner_text())
    page.go_back()

    # Recording controls, and the transcript beside them.
    page.goto(BASE + "/")
    page.locator(".module-row", has_text="HY319").click()
    page.locator("#week-AT1 .week-title").click()
    page.locator("section.session").first.locator(".session-title a").click()
    page.get_by_role("group", name="Playback speed").get_by_role("button", name="1.5×").click()
    until(page, "document.querySelector('audio').playbackRate === 1.5")
    page.get_by_role("button", name="Read the transcript").click()
    expect(page.locator(".moodle-transcript")).to_be_visible()
    page.evaluate("() => { const a = document.querySelector('audio'); a.muted = true; a.currentTime = 0.5; return a.play(); }")
    page.get_by_role("button", name="Forward 15 seconds").click()
    page.evaluate("document.querySelector('audio').pause()")
    expect(page.locator(".session-side .side-readings")).to_be_visible()
    page.screenshot(path=f"{shots}-6-session.png", full_page=True)
    print("speed, skip and the transcript work; readings beside the notes")

    # The trimmed block menu, and citing a reading with @.
    editor = page.locator(".session-notes .bn-editor")
    editor.click()
    page.keyboard.press("Control+End")
    page.keyboard.press("Enter")
    page.keyboard.type("/")
    menu = page.locator(".bn-suggestion-menu")
    expect(menu).to_be_visible()
    items = menu.locator(".bn-suggestion-menu-item").all_inner_texts()
    print("block menu:", [i.split("\n")[0] for i in items])
    assert any("Heading 1" in i for i in items) and not any("Code" in i for i in items), items
    page.screenshot(path=f"{shots}-7-slash.png")
    page.keyboard.press("Escape")
    page.keyboard.press("Backspace")
    page.keyboard.type("See @Chen")
    expect(page.locator(".bn-suggestion-menu", has_text="Chen (2001)")).to_be_visible()
    page.screenshot(path=f"{shots}-8-cite.png")
    page.keyboard.press("Enter")
    expect(editor.locator("a", has_text="Chen (2001)").last).to_be_visible()
    print("@ cites a reading as a link")

    # A PDF with a contents list and a picture: contents panel and dark mode.
    page.locator(".crumbs a").nth(1).click()
    expect(page.locator(".week-nav")).to_be_visible()
    page.wait_for_timeout(500)
    page.locator("body").click(position={"x": 5, "y": 300})
    page.keyboard.press("]")
    expect(page.locator(".crumbs")).to_contain_text("AT2")
    page.locator("input[type=file][accept='.pdf,.pptx,.ppt,.docx,.doc,image/*,.heic,.heif']").first.set_input_files(str(figure_pdf()))
    expect(page.locator("li.reading", has_text="Westad").first).to_be_visible()
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).some(f => (f.original_name || '').includes('Westad')); }", 40)
    page.locator("li.reading a.name", has_text="Westad").first.click()
    page.get_by_role("tab", name="Contents").click()
    expect(page.locator(".contents li")).to_have_count(3)
    page.locator(".contents button", has_text="Cuba").click()
    expect(page.get_by_label("Go to page")).to_have_value("3")
    page.locator(".contents button", has_text="Introduction").click()
    page_colour(page, "Dark")
    until(page, "document.querySelector('.pdf-page[data-page=\"0\"] .page-pictures').width > 0", 15)
    kept = page.evaluate("""() => {
      const c = document.querySelector('.pdf-page[data-page="0"] .page-pictures');
      const ctx = c.getContext('2d');
      const w = c.width, h = c.height;
      const d = ctx.getImageData(Math.floor(w * 0.3), Math.floor(h * 0.45), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    }""")
    print("picture kept in its own colours in dark mode, sample pixel:", kept)
    assert kept[3] > 0 and kept[0] > kept[2], kept
    page.screenshot(path=f"{shots}-9-dark-picture.png")
    page_colour(page, "Light")

    # Week across modules remembers the week chosen.
    page.goto(BASE + "/?v=across")
    page.get_by_role("group", name="Choose a week").get_by_role("button", name="1", exact=True).first.click()
    expect(page.locator(".across-session").first).to_be_visible()
    page.screenshot(path=f"{shots}-10-across.png", full_page=True)
    page.get_by_role("group", name="Choose a week").get_by_role("button", name="3", exact=True).last.click()
    # Opened again, it shows this week while term runs, as the home page does;
    # only in the vacations does it go back to the week last chosen.
    page.goto(BASE + "/")
    heading = page.locator(".this-week h2").inner_text()
    page.goto(BASE + "/?v=across")
    if heading.startswith("This week: "):
        code = heading.split(": ")[1].strip()
        row = 0 if code.startswith("AT") else 1
        picker = page.get_by_role("group", name="Choose a week")
        expect(picker.get_by_role("button", name=code[2:], exact=True).nth(row)).to_have_attribute("aria-pressed", "true")
    else:
        expect(page.get_by_role("group", name="Choose a week").get_by_role("button", name="3", exact=True).last).to_have_attribute("aria-pressed", "true")
    print("across opens on this week")

    # Module page: no carets on empty weeks, summaries in words.
    page.goto(BASE + "/")
    page.locator(".module-row", has_text="HY319").click()
    expect(page.locator(".week")).to_have_count(22)
    expect(page.locator("#week-AT1 button.caret")).to_have_count(1)
    carets = page.locator(".week-head button.caret").count()
    print("weeks with something to open:", carets)
    assert 0 < carets < 22, carets
    page.screenshot(path=f"{shots}-11-module.png")


    # Zotero-style panes: thumbnails, annotation cards and the highlight tool.
    page.goto(BASE + "/")
    page.locator(".recent li", has_text="Chen").locator(".name").click()
    page.wait_for_function("document.querySelectorAll('.pdf-page .textLayer span').length > 3", timeout=15000)
    page.get_by_role("tab", name="Pages").click()
    expect(page.locator(".thumb")).to_have_count(3)
    page.locator(".thumb").nth(2).click()
    expect(page.get_by_label("Go to page")).to_have_value("3")
    expect(page.locator(".thumb.current")).to_have_count(1)
    page.screenshot(path=f"{shots}-17-thumbnails.png")
    page.get_by_role("tab", name="Notes").click()
    before = page.locator(".reading-notes .note-highlight").count()
    page.keyboard.press("h")
    expect(page.get_by_role("button", name="Highlight text")).to_have_attribute("aria-pressed", "true")
    page.evaluate("""() => {
      const span = [...document.querySelectorAll('.pdf-page[data-page="2"] .textLayer span')].find(s => s.textContent.length > 20);
      const r = document.createRange(); r.selectNodeContents(span);
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }""")
    # The highlight joins the notes as a quotation, with no box to fill in.
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(before + 1, timeout=10000)
    expect(page.locator(".floating")).to_have_count(0)
    page.screenshot(path=f"{shots}-18-notes.png")
    # Escape turns the tool off once focus is back on the reading, not the notes.
    page.evaluate("document.activeElement && document.activeElement.blur(); document.getSelection().removeAllRanges()")
    page.wait_for_timeout(300)
    page.keyboard.press("Escape")
    expect(page.get_by_role("button", name="Highlight text")).to_have_attribute("aria-pressed", "false")
    print("thumbnails, the notes tab and the highlight tool work")

    # The shortcuts list opens with ?.
    page.goto(BASE + "/")
    expect(page.get_by_role("heading", name="Modules")).to_be_visible()
    page.keyboard.press("?")
    expect(page.locator("dialog.shortcuts[open]")).to_be_visible()
    page.screenshot(path=f"{shots}-19-shortcuts.png")
    page.keyboard.press("Escape")
    expect(page.locator("dialog.shortcuts[open]")).to_have_count(0)
    print("keyboard shortcuts dialog works")

    # Pictures in notes: paste one, resize it, and see it on the week page.
    page.goto(BASE + "/")
    page.locator(".module-row", has_text="HY319").click()
    page.locator("#week-AT1 .week-title").click()
    page.locator("section.session").first.locator(".session-title a").click()
    editor = page.locator(".session-notes .bn-editor")
    editor.click()
    page.keyboard.press("Control+End")
    page.keyboard.press("Enter")
    picture = Image.new("RGB", (640, 360), (24, 95, 165))
    buffer = io.BytesIO()
    picture.save(buffer, format="PNG")
    page.evaluate("""(bytes) => {
      const file = new File([new Uint8Array(bytes)], 'map.png', { type: 'image/png' });
      const data = new DataTransfer(); data.items.add(file);
      document.querySelector('.session-notes .bn-editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }""", list(buffer.getvalue()))
    image = editor.locator("img[src^='/api/objects/files/']")
    expect(image).to_be_visible(timeout=15000)
    image.hover()
    handle = page.locator(".bn-resize-handle, .bn-visual-media-resize-handle").last
    expect(handle).to_be_visible()
    box = handle.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] - 150, box["y"] + box["height"] / 2, steps=8)
    page.mouse.up()
    width = until(page, """async () => {
      const j = await (await fetch('/api/sync/pull?since=0')).json();
      const b = (j.rows.note_blocks || []).find(r => !r.deleted && r.type === 'image' && r.content.props.previewWidth);
      return b ? b.content.props.previewWidth : null;
    }""")
    print("picture pasted into notes, resized to", width, "px and saved")
    text_x = page.evaluate("document.querySelector('.session-notes .bn-block-content').getBoundingClientRect().left - document.querySelector('.session-notes').getBoundingClientRect().left")
    print("notes start", round(text_x), "px from the column edge")
    assert text_x < 12, text_x
    page.screenshot(path=f"{shots}-20-picture.png", full_page=True)
    page.locator(".crumbs a").nth(1).click()
    expect(page.locator("section.session").first.locator("figure img")).to_be_visible()
    print("the week page shows the picture")

    # Light mode, chosen in Settings, on a device set to dark.
    dark = browser.new_page(viewport={"width": 1280, "height": 900}, color_scheme="dark")
    dark.goto(BASE + "/?v=settings")
    expect(dark.get_by_role("heading", name="Appearance")).to_be_visible()
    before = dark.evaluate("getComputedStyle(document.body).backgroundColor")
    dark.get_by_role("group", name="Appearance").get_by_role("button", name="Light").click()
    until(dark, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.settings || []).some(r => r.id === 'appearance' && r.value === 'light'); }")
    after = dark.evaluate("getComputedStyle(document.body).backgroundColor")
    print("dark device background", before, "then light", after)
    assert after == "rgb(252, 252, 251)", after
    dark.screenshot(path=f"{shots}-21-light-settings.png", full_page=True)
    other = browser.new_page(viewport={"width": 1280, "height": 900}, color_scheme="dark")
    other.goto(BASE + "/")
    until(other, "document.documentElement.dataset.theme === 'light'")
    print("light mode follows to another device")
    dark.get_by_role("group", name="Appearance").get_by_role("button", name="Match this device").click()
    expect(dark.locator("html")).not_to_have_attribute("data-theme", "light")
    # Leave it on Light, the default.
    dark.get_by_role("group", name="Appearance").get_by_role("button", name="Light").click()
    until(dark, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.settings || []).some(r => r.id === 'appearance' && r.value === 'light'); }")
    other.close()

    # Naming a highlight colour.
    page.goto(BASE + "/?v=settings")
    page.get_by_label("Name for green").fill("Evidence")
    page.get_by_role("heading", name="Settings").click()
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.settings || []).some(r => r.value && r.value['#5fb236'] === 'Evidence'); }")
    page.screenshot(path=f"{shots}-16-settings.png", full_page=True)
    page.goto(BASE + "/")
    page.locator(".recent li", has_text="Chen").locator(".name").click()
    page.get_by_role("tab", name="Notes").click()
    expect(page.locator(".reading-notes .quote-tag", has_text="Evidence").first).to_be_visible(timeout=10000)
    print("colour names sync and show in the reader")

    # Phone: margins trimmed and the toolbar slides away.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.goto(BASE + "/")
    phone.locator(".recent .name", has_text="Westad").first.click()
    # Phones open readings as text; this part is about the pages.
    phone.get_by_role("button", name="Show the pages").click()
    phone.wait_for_selector(".pdf-page canvas")
    phone.wait_for_timeout(1500)
    widths = phone.evaluate("() => { const s = document.querySelector('.pdf-slot'); const p = s.querySelector('.pdf-page'); return [s.offsetWidth, p.offsetWidth]; }")
    print("phone page slot and full page widths:", widths)
    assert widths[0] < widths[1], widths
    phone.screenshot(path=f"{shots}-12-phone-reader.png")
    phone.evaluate("document.querySelector('.scroller').scrollTop = 500")
    phone.wait_for_timeout(300)
    phone.evaluate("document.querySelector('.scroller').dispatchEvent(new Event('scroll'))")
    expect(phone.locator(".reader.bar-hidden")).to_have_count(1)
    phone.screenshot(path=f"{shots}-13-phone-scrolled.png")
    phone.evaluate("() => { const s = document.querySelector('.scroller'); s.scrollTop = 200; s.dispatchEvent(new Event('scroll')); }")
    expect(phone.locator(".reader.bar-hidden")).to_have_count(0)
    phone.get_by_role("button", name="More reading actions").click()
    phone.screenshot(path=f"{shots}-14-phone-menu.png")
    phone.keyboard.press("Escape")
    phone.get_by_role("button", name="Sidebar").click()
    phone.screenshot(path=f"{shots}-14b-phone-sidebar.png")
    phone.goto(BASE + "/")
    phone.screenshot(path=f"{shots}-15-phone-home.png", full_page=True)
    print("phone reader trims margins and hides its toolbar")

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
