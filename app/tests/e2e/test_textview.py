"""Version 0.12: reading on a phone as text set to fit the screen."""
import sys, time
from pathlib import Path
import pymupdf
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
shots = str(HERE / "shots" / "textview")
FILES = HERE / "files-citations"

PARAS = [
    "The end of the Second World War left two powers with the means and the will to shape the international order. "
    "Neither had planned for the rivalry that followed, and both read the other's caution as cunning.",
    "Historians have long disagreed about where responsibility lies. The orthodox account placed it in Moscow; the revisionists "
    "looked to Washington and to the economic interests that drove American policy abroad after 1945.",
    "Postrevisionist work since the 1980s has tried to hold both views at once, treating the conflict as the product of "
    "misperception, ideology and the security dilemma working on each other over a decade.",
    "This article argues that the decisive years were 1946 and 1947, when the administration in Washington chose containment "
    "and the leadership in Moscow chose consolidation, each believing it was responding to the other.",
    "The argument proceeds in three parts. The first examines the Long Telegram and its reception. The second turns to the "
    "Truman Doctrine. The third follows the Marshall Plan into the Soviet refusal to take part in it.",
    "Throughout, the evidence comes from archives opened since 1991, which allow a closer reading of Soviet intentions "
    "than was possible for the first generations of scholars working on the period.",
]


def wrap(text, width=78):
    words, lines, line = text.split(), [], ""
    for w in words:
        if len(line) + len(w) + 1 > width:
            # Break a long word with a hyphen at the end of a line, as print does.
            if len(w) > 9 and width - len(line) > 5:
                cut = width - len(line) - 2
                lines.append(f"{line} {w[:cut]}-".strip())
                line = w[cut:]
                continue
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    lines.append(line)
    return lines


def article():
    FILES.mkdir(exist_ok=True)
    doc = pymupdf.open()
    for n in range(3):
        page = doc.new_page()
        page.insert_text((60, 40), "Diplomatic History", fontsize=8)
        page.insert_text((540, 40), str(101 + n), fontsize=8)
        y = 80
        if n == 0:
            page.insert_text((60, y), "Choosing Containment, 1946-47", fontsize=18)
            y += 40
        if n == 1:
            page.insert_text((60, y), "The Long Telegram", fontsize=13)
            y += 26
        for k, para in enumerate(PARAS[n * 2:n * 2 + 2]):
            for i, line in enumerate(wrap(para)):
                x = 60 + (18 if i == 0 and (k or n) else 0)
                page.insert_text((x, y), line, fontsize=10.5)
                if n == 0 and k == 0 and i == 0:
                    # A raised footnote number at the end of the first line.
                    page.insert_text((x + pymupdf.get_text_length(line, fontsize=10.5) + 1, y - 4), "1", fontsize=6.5)
                y += 14
            y += 4
        page.insert_text((60, 760), f"{n + 1} On this point see the essays collected in the volume cited above, pp. {10 + n}-{20 + n}.", fontsize=7.5)
        page.insert_text((300, 800), str(101 + n), fontsize=8)
    path = FILES / "(AT1) Containment.pdf"
    doc.save(path)
    return path


pdf = article()

with sync_playwright() as p:
    browser = p.chromium.launch()
    desk = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    desk.on("pageerror", lambda e: errors.append(str(e)))
    desk.request.post(BASE + "/api/dev/reset")
    desk.goto(BASE + "/")
    desk.get_by_label("Code").fill("HY206")
    desk.get_by_role("button", name="Create module").click()
    desk.locator("#week-AT1 .week-title").click()
    desk.locator("input[type=file][accept='.pdf,.pptx,.ppt,.docx,.doc,image/*,.heic,.heif']").first.set_input_files(str(pdf))
    end = time.time() + 40
    while time.time() < end and not desk.evaluate("async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 1; }"):
        time.sleep(0.5)

    # A phone opens the reading as text.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.on("pageerror", lambda e: errors.append(str(e)))
    phone.goto(desk.url)
    phone.locator("li.reading a.name").first.click()
    view = phone.locator(".text-view")
    expect(view).to_be_visible(timeout=20000)
    body = view.locator(".tv-body")
    paras = body.locator("p:not(.note)").count()
    print("paragraphs:", paras, "of", len(PARAS), "| headings:", body.locator("h2").all_inner_texts())
    assert body.locator("h2").all_inner_texts() == ["Choosing Containment, 1946-47", "The Long Telegram"]
    assert paras == len(PARAS), paras
    text = body.inner_text()
    assert "Diplomatic History" not in text, "running head left in"
    assert "admin- istration" not in text and "administration" in text, "hyphen not joined"
    print("page numbers in the text:", body.locator(".pg").all_inner_texts())
    expect(body.locator(".pg")).to_have_count(3)
    # Footnotes and margins are left out of the text unless asked for.
    expect(body.locator("p.note")).to_have_count(0)
    assert "On this point see the essays" not in text
    assert "will to shape" in text, "the footnote number should not break the sentence"
    assert "Diplomatic History" not in text and "101" not in text.split("Choosing")[0]
    width = phone.evaluate("document.querySelector('.text-view').scrollWidth <= document.documentElement.clientWidth")
    assert width, "text wider than the screen"
    phone.screenshot(path=f"{shots}-1-phone.png")

    # Highlight in the text; it shows on the page too.
    phone.evaluate("""() => {
      const spans = [...document.querySelectorAll('.tv-body p:not(.note) [data-o]')];
      const first = spans.find(s => s.textContent.includes('Historians have long disagreed'));
      const r = document.createRange(); r.setStart(first.firstChild, 0); r.setEnd(first.firstChild, 'Historians have long disagreed'.length);
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    }""")
    phone.get_by_role("button", name="Highlight yellow").click()
    expect(body.locator("mark.hl-text")).to_have_count(1)
    phone.get_by_role("button", name="Done").click()
    phone.wait_for_timeout(1500)
    saved = phone.evaluate("async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.highlights || []).map(h => [h.page, h.body, h.rects.length]); }")
    print("highlight saved:", saved)
    phone.screenshot(path=f"{shots}-2-highlight.png")

    # Bigger text.
    before = phone.evaluate("parseFloat(getComputedStyle(document.querySelector('.text-view')).fontSize)")
    phone.get_by_role("button", name="Appearance").click()
    phone.get_by_role("button", name="Larger text").click()
    after = phone.evaluate("parseFloat(getComputedStyle(document.querySelector('.text-view')).fontSize)")
    print(f"text size {before}px -> {after}px")
    assert after > before
    phone.keyboard.press("Escape")

    # Scrolling down hides the toolbar and leaves no band: the text runs to
    # the top, under a thin line showing how far through the reading you are.
    phone.evaluate("document.querySelector('.scroller').scrollBy(0, 400)")
    phone.wait_for_timeout(400)
    phone.evaluate("document.querySelector('.scroller').scrollBy(0, 200)")
    phone.wait_for_timeout(500)
    expect(phone.locator(".reader.bar-hidden")).to_have_count(1)
    gap = phone.evaluate("document.querySelector('.reader-body').getBoundingClientRect().top")
    pct = phone.locator(".reading-progress").get_attribute("aria-valuenow")
    print("with the toolbar away, the reading starts at", gap, "px; progress", pct, "per cent")
    assert gap == 0 and int(pct) > 0
    phone.screenshot(path=f"{shots}-4-progress.png")
    phone.evaluate("document.querySelector('.scroller').scrollBy(0, -300)")
    phone.wait_for_timeout(400)

    # Switch to the pages: the highlight is drawn there too.
    phone.get_by_role("button", name="Show the pages").click()
    expect(phone.locator(".pdf-page .hl").first).to_be_attached(timeout=15000)
    print("the highlight shows on the page")
    phone.get_by_role("button", name="Show as text").click()
    expect(view).to_be_visible()

    # The place is kept: scroll to page 3, reopen, and it opens there.
    phone.evaluate("document.querySelector('.tv-body .pg[data-pg=\"2\"]').scrollIntoView()")
    phone.evaluate("document.querySelector('.scroller').dispatchEvent(new Event('scroll'))")
    phone.wait_for_timeout(3500)
    phone.reload()
    expect(view).to_be_visible(timeout=20000)
    phone.wait_for_timeout(500)
    top = phone.evaluate("document.querySelector('.tv-body .pg[data-pg=\"2\"]').getBoundingClientRect().top")
    print("page 3 marker after reopening sits at", round(top), "px")
    assert top < 300

    # A laptop keeps the pages, with text one click away.
    desk.locator("li.reading a.name").first.click()
    expect(desk.locator(".pdf-page canvas").first).to_be_visible(timeout=20000)
    desk.get_by_role("button", name="Appearance").click()
    desk.get_by_role("group", name="Layout").get_by_role("button", name="Text").click()
    expect(desk.locator(".text-view")).to_be_visible()
    desk.keyboard.press("Escape")
    desk.screenshot(path=f"{shots}-3-desktop.png")
    print("page errors:", errors[:5])
    assert not errors
    browser.close()
