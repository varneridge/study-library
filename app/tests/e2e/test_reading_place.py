"""Version 0.18: the reader keeps exactly the place you stopped, and the
text holds still while you read."""
import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
PDF = HERE / "files-citations" / "(AT1) Containment.pdf"
files = sorted(str(p) for p in (HERE / "files").glob("*.pdf"))

TOP_TEXT = """() => {
  const s = document.querySelector('.scroller');
  const inset = parseFloat(getComputedStyle(s).scrollPaddingTop) || 0;
  const top = s.getBoundingClientRect().top + inset + 12;
  const area = s.getBoundingClientRect();
  for (let y = top; y < top + 200; y += 6) {
    for (const x of [area.left + area.width * 0.3, area.left + area.width * 0.5]) {
      const el = document.elementFromPoint(x, y);
      if (el && el.closest('[data-o], .textLayer span')) return el.closest('[data-o], .textLayer span').textContent.trim().slice(0, 60);
    }
  }
  return null;
}"""


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
    desk = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    desk.on("pageerror", lambda e: errors.append(str(e)))
    desk.request.post(BASE + "/api/dev/reset")
    desk.goto(BASE + "/")
    desk.get_by_label("Code").fill("HY206")
    desk.get_by_role("button", name="Create module").click()
    desk.locator("#week-AT1 .week-title").click()
    desk.locator("input[type=file][accept='.pdf,.pptx,.ppt,.docx,.doc,image/*,.heic,.heif']").first.set_input_files(files[:1])
    until(desk, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 1; }", 40)
    desk.locator("li.reading a.name").first.click()
    desk.wait_for_function("document.querySelectorAll('.pdf-page[data-page=\"1\"] .textLayer span').length > 3", timeout=20000)

    # Pages on a laptop: stop part way down page 2, reload, and land on the same line.
    desk.evaluate("""() => { const s = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')].filter(x => x.textContent.trim())[7]; s.scrollIntoView({ block: 'start' }); document.querySelector('.scroller').scrollBy(0, -12); }""")
    desk.wait_for_timeout(1600)
    before = desk.evaluate(TOP_TEXT)
    desk.reload()
    desk.wait_for_function("document.querySelectorAll('.pdf-page[data-page=\"1\"] .textLayer span').length > 3", timeout=20000)
    desk.wait_for_timeout(600)
    after = desk.evaluate(TOP_TEXT)
    print("pages, laptop:", before, "->", after)
    assert before == after, (before, after)

    # Zooming keeps the same line at the top.
    desk.get_by_role("button", name="Zoom in").click()
    desk.wait_for_timeout(500)
    zoomed = desk.evaluate(TOP_TEXT)
    print("after zooming in:", zoomed)
    assert zoomed == before, zoomed
    desk.get_by_role("button", name="Fit to width").click()
    desk.wait_for_timeout(800)
    # Where the laptop finally rests, once that place has reached the server.
    before = desk.evaluate(TOP_TEXT)
    desk.wait_for_timeout(1500)
    until(desk, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.items || []).some(i => i.last_spot && i.last_spot.page === 1 && (i.last_spot.quote || '').startsWith(%r)); }" % before.strip()[:20])

    # Phone, as text: the same place, carried from the laptop.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.on("pageerror", lambda e: errors.append(str(e)))
    phone.goto(desk.url)
    expect(phone.locator(".text-view")).to_be_visible(timeout=20000)
    phone.wait_for_timeout(1200)
    carried = phone.evaluate(TOP_TEXT)
    print("phone, as text, from the laptop's place:", carried)
    # From pages to text the line may read as one earlier here: in text the
    # old line ends on the same row the saved line begins, and the check
    # below looks at the start of that row.
    line_no = lambda t: int(t.split("line ")[1].split(".")[0])
    assert "Page 2" in (carried or "") and abs(line_no(carried) - line_no(before)) <= 1, carried

    # Read on: the text holds still while the place saves and syncs.
    phone.evaluate("document.querySelector('.scroller').scrollBy(0, 700)")
    phone.wait_for_timeout(400)
    held = phone.evaluate("document.querySelector('.scroller').scrollTop")
    line = phone.evaluate(TOP_TEXT)
    phone.wait_for_timeout(4000)
    still = phone.evaluate("document.querySelector('.scroller').scrollTop")
    print(f"text after saving: scrolled to {held}, four seconds later {still}")
    assert abs(still - held) < 2, "the text jumped"

    # Bigger text: the same line stays at the top. A small scroll up brings
    # the toolbar back, as a thumb would.
    phone.evaluate("document.querySelector('.scroller').scrollBy(0, -20)")
    phone.wait_for_timeout(500)
    line = phone.evaluate(TOP_TEXT)
    phone.get_by_role("button", name="Appearance").click()
    phone.get_by_role("button", name="Larger text").click()
    phone.get_by_role("button", name="Larger text").click()
    phone.keyboard.press("Escape")
    phone.wait_for_timeout(600)
    bigger = phone.evaluate(TOP_TEXT)
    print("after larger text:", line, "->", bigger)
    assert bigger == line, (line, bigger)

    # Switching to another app saves at once, without waiting.
    phone.evaluate("document.querySelector('.scroller').scrollBy(0, 500)")
    phone.wait_for_timeout(300)
    gone = phone.evaluate(TOP_TEXT)
    phone.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }""")
    phone.close()
    again = browser.new_page(viewport={"width": 390, "height": 844})
    again.goto(desk.url)
    expect(again.locator(".text-view")).to_be_visible(timeout=20000)
    again.wait_for_timeout(1500)
    back = again.evaluate(TOP_TEXT)
    print("phone closed straight after switching away:", gone, "->", back)
    assert back == gone, (gone, back)

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
