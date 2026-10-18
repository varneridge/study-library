"""Version 0.19: in text layout a paragraph never breaks mid-sentence.

The test article puts in every printed hazard: a paragraph running over a
page turn with footnotes between, a sentence over a column break, extra
space between lines inside a sentence, a word set larger, a drop capital,
and ragged-right lines that end in a full stop part way through a
paragraph."""
import re, sys, time
from pathlib import Path
import pymupdf
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
FILES = HERE / "files-citations"
shots = str(HERE / "shots" / "paragraphs")
SIZE = 10.5


def write(page, x, y, text, size=SIZE):
    page.insert_text((x, y), text, fontsize=size)


def build():
    FILES.mkdir(exist_ok=True)
    doc = pymupdf.open()

    # Page 1: a drop capital, a sentence with extra space inside it, a larger
    # word mid-sentence, then a paragraph that runs over onto page 2 with
    # footnotes in between.
    p = doc.new_page()
    write(p, 60, 60, "Cold War Studies", 8)
    write(p, 60, 100, "T", 26)
    write(p, 80, 92, "he first paragraph opens with a drop capital, as many books do, and it")
    write(p, 80, 106, "carries on for a while so that the capital sits beside two lines of text.")
    write(p, 60, 140, "The second paragraph has a sentence that is set with more space than")
    write(p, 60, 168, "usual between two of its lines, which can happen when a line holds a")
    write(p, 60, 182, "formula or an accent, and it still has to read as one sentence.")
    write(p, 60, 210, "The third paragraph has one")
    write(p, 196, 210, "EMPHASISED", 14)
    write(p, 290, 210, "word set larger than the rest of its line,")
    write(p, 60, 224, "and the sentence carries on after it to the end.")
    y = 252
    for line in ["The fourth paragraph runs to the foot of the page and does not end there, but",
                 "carries on over the page turn, with the footnotes of this page printed in"]:
        write(p, 60, y, line)
        y += 14
    write(p, 60, 740, "1 A footnote at the foot of the first page, in smaller type.", 7.5)
    write(p, 60, 750, "2 A second footnote, also in smaller type.", 7.5)
    write(p, 300, 800, "101", 8)

    # Page 2: the paragraph goes on, then a two-column part where a sentence
    # breaks across the columns.
    p = doc.new_page()
    write(p, 60, 60, "Cold War Studies", 8)
    write(p, 60, 92, "between the two halves of the same sentence, which must read straight on.")
    left = ["The fifth paragraph is set in two", "columns, and its sentence breaks at", "the foot of the left column and"]
    right = ["goes on at the head of the right", "column without a break in the text.", "Then it ends."]
    for i, line in enumerate(left):
        write(p, 60, 140 + i * 14, line)
    for i, line in enumerate(right):
        write(p, 320, 140 + i * 14, line)
    write(p, 300, 800, "102", 8)

    # Page 3: ragged-right text where short lines end in a full stop part way
    # through a paragraph.
    p = doc.new_page()
    rag = ["The sixth paragraph is ragged.", "Its lines stop where they stop.", "Some end with a full stop.",
           "None of them ends the paragraph,", "which goes on to this last line."]
    for i, line in enumerate(rag):
        write(p, 60, 92 + i * 14, line)
    write(p, 78, 92 + 5 * 14 + 4, "The seventh paragraph starts with an indent, as a new paragraph should.")
    for i, line in enumerate(["Short lines everywhere make the page", "ragged on the right, as some books are."]):
        write(p, 60, 92 + (6 + i) * 14 + 4, line)
    path = FILES / "hazards.pdf"
    doc.save(path)
    return path


pdf = build()

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

    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.on("pageerror", lambda e: errors.append(str(e)))
    phone.goto(desk.url)
    phone.locator("li.reading a.name").first.click()
    expect(phone.locator(".text-view")).to_be_visible(timeout=20000)
    # The page numbers in the text are left out of the comparison.
    paras = phone.locator(".tv-body p:not(.note)").evaluate_all("els => els.map(e => { const c = e.cloneNode(true); c.querySelectorAll('.pg').forEach(m => m.remove()); return c.textContent.replace(/\\s+/g, ' ').trim(); })")
    for i, para in enumerate(paras, 1):
        print(f"{i}. {para}")
    assert len(paras) == 7, len(paras)
    for para in paras:
        assert re.search(r"[.?!]$", para), f"a paragraph breaks mid-sentence: {para[-60:]}"
    assert paras[0].startswith("The first paragraph opens with a drop capital"), paras[0]
    assert "set with more space than usual between" in paras[1]
    assert "has one EMPHASISED word set larger" in paras[2]
    assert "printed in between the two halves" in paras[3]
    assert "breaks at the foot of the left column and goes on at the head" in paras[4]
    assert paras[5].startswith("The sixth paragraph is ragged.") and paras[5].endswith("which goes on to this last line.")
    expect(phone.locator(".tv-body h2")).to_have_count(0)
    phone.screenshot(path=f"{shots}-1-phone.png", full_page=True)
    print("seven paragraphs, none broken mid-sentence")

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
