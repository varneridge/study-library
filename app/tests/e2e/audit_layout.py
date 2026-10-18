"""Layout audit. Seeds a realistic week, then visits every screen at four
widths and looks for the faults that make an interface look broken:

- something drawn over a sticky or fixed element (content showing through
  a panel that should cover it),
- text overlapping other text,
- anything wider than the screen,
- buttons too small to tap on a phone.

It saves a screenshot of every screen at every width, and exits with a
failure if it finds a fault. Run it against a local Worker:

    python tests/e2e/audit_layout.py http://127.0.0.1:8790
"""
import json, sys, time
from pathlib import Path
import pymupdf
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
BASE = sys.argv[1]
OUT = HERE / "shots" / "audit"
OUT.mkdir(parents=True, exist_ok=True)
FILES = HERE / "files-citations"
WIDTHS = [(1440, 900, "wide"), (1024, 768, "laptop"), (768, 1024, "tablet"), (390, 844, "phone")]

CHECKS = r"""
(phone) => {
  const faults = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const name = (el) => (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : el.tagName.toLowerCase())
    + (el.textContent ? ` "${el.textContent.trim().slice(0, 40)}"` : '');
  const layered = (el) => el.closest('dialog, .menu-panel, .toast, .rec-pill, .floating, .drop-banner, .move-dock, .bn-suggestion-menu, .bn-toolbar, [data-floating-ui-portal], .mantine-Popover-dropdown');

  // 1. Something drawn over a sticky or fixed element.
  for (const el of document.querySelectorAll('body *')) {
    const pos = getComputedStyle(el).position;
    if ((pos !== 'sticky' && pos !== 'fixed') || !vis(el) || layered(el)) continue;
    const r = el.getBoundingClientRect();
    const xs = [0.15, 0.5, 0.85], ys = [0.2, 0.5, 0.8];
    for (const fx of xs) for (const fy of ys) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const top = document.elementFromPoint(x, y);
      if (!top || el.contains(top) || top.contains(el) || layered(top)) continue;
      // A sticky header may sit under a fixed bar on purpose.
      if (getComputedStyle(top).position === 'fixed' || top.closest('.topbar, .reader-bar')) continue;
      faults.push(`drawn over ${name(el)}: ${name(top)}`);
      break;
    }
  }

  // 1b. A control hidden under a panel that is not a page header. Content
  // may pass under the top bar, the week grid or a transcript's header, but
  // nothing else should cover a button or link.
  const headers = '.topbar, .reader-bar, .jump, .t-head, .pane-tabs';
  for (const el of document.querySelectorAll('button, a[href], input, select, .reading')) {
    if (!vis(el) || layered(el)) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 12), y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    const top = document.elementFromPoint(x, y);
    if (!top || el.contains(top) || top.contains(el) || layered(top) || top.closest(headers)) continue;
    const pin = top.closest('*');
    let cover = top;
    while (cover && !['sticky', 'fixed'].includes(getComputedStyle(cover).position)) cover = cover.parentElement;
    if (cover && !cover.contains(el)) faults.push(`hidden under ${name(cover)}: ${name(el)}`);
  }

  // 2. Text overlapping other text. Content passing under a sticky header
  // is meant to, and lines of one paragraph wrap round each other, so both
  // are left out.
  const pinned = [...document.querySelectorAll('body *')].filter((el) => ['sticky', 'fixed'].includes(getComputedStyle(el).position));
  const underPin = (el) => pinned.some((p) => p.contains(el));
  const texts = [...document.querySelectorAll('body *')].filter((el) =>
    vis(el) && !layered(el) && !underPin(el) && getComputedStyle(el).display !== 'inline'
    && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && !el.closest('.textLayer, .pdf-page, svg'));
  const boxes = texts.map((el) => [el, el.getBoundingClientRect()]);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const [a, ra] = boxes[i], [b, rb] = boxes[j];
    if (a.contains(b) || b.contains(a)) continue;
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 3 && h > 3 && w * h > 0.25 * Math.min(ra.width * ra.height, rb.width * rb.height)) {
      faults.push(`text overlaps: ${name(a)} / ${name(b)}`);
    }
  }

  // 3. Anything wider than the screen.
  const root = document.scrollingElement;
  if (root.scrollWidth > root.clientWidth + 1) faults.push(`page scrolls sideways: ${root.scrollWidth} > ${root.clientWidth}`);
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || layered(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth + 2 && !el.closest('.table-wrap, .navs, .scroller, .pdf-slot, .thumbs, .transcript')) {
      const s = getComputedStyle(el.parentElement);
      if (s.overflowX === 'hidden' || s.overflowX === 'auto' || s.overflowX === 'scroll') continue;
      faults.push(`off the right edge: ${name(el)} (${Math.round(r.right)} > ${innerWidth})`);
      break;
    }
  }

  // 4. Buttons too small to tap on a phone.
  if (phone) {
    for (const el of document.querySelectorAll('button, a, input[type=checkbox], select')) {
      if (!vis(el) || layered(el) || el.closest('.bn-container, .pdf-page, .tv-body, .textLayer')) continue;
      const r = el.getBoundingClientRect();
      // A tick box may look small if its touch area reaches beyond it.
      const box = el.matches('.mark, input[type=checkbox]');
      if (box ? r.width < 20 || r.height < 20 : r.width < 24 || r.height < 24) { faults.push(`too small to tap: ${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`); }
    }
  }
  return [...new Set(faults)];
}
"""


def slides_pdf():
    FILES.mkdir(exist_ok=True)
    doc = pymupdf.open()
    for n in range(4):
        page = doc.new_page(width=960, height=540)
        page.insert_text((60, 90), f"Lecture 1, slide {n + 1}: the shape of the course", fontsize=30)
        for i, line in enumerate(["Who counts as a migrant", "Stocks and flows", "Methodological nationalism", "Reading for next week"]):
            page.insert_text((80, 170 + i * 50), f"• {line}", fontsize=22)
    path = FILES / "Lecture 1 slides.pdf"
    doc.save(path)
    return path


def until(page, script, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        if page.evaluate(script):
            return
        time.sleep(0.5)
    raise AssertionError("timed out: " + script[:80])


def audit(page, label, phone, results, scroll_target=None):
    """Checks a screen at the top, the middle and the end of its scroll."""
    page.wait_for_timeout(500)
    found = set()
    # Step down the page about half a screen at a time, since a sticky panel
    # only collides with what follows it part of the way down.
    span = page.evaluate("([sel]) => { const el = sel ? document.querySelector(sel) : document.scrollingElement; return el ? [el.scrollHeight - el.clientHeight, el.clientHeight] : [0, 1]; }", [scroll_target])
    steps = sorted({0, *range(0, int(span[0]) + 1, max(200, int(span[1] * 0.5))), int(span[0])})[:16]
    for i, top in enumerate(steps):
        page.evaluate("([sel, t]) => { const el = sel ? document.querySelector(sel) : document.scrollingElement; if (el) el.scrollTop = t; }", [scroll_target, top])
        page.wait_for_timeout(150)
        found.update(page.evaluate(CHECKS, phone))
        if i == 0:
            page.screenshot(path=str(OUT / f"{label}.png"))
    page.evaluate("([sel]) => { const el = sel ? document.querySelector(sel) : document.scrollingElement; if (el) el.scrollTop = 0; }", [scroll_target])
    results[label] = sorted(found)


with sync_playwright() as p:
    browser = p.chromium.launch()
    seed = browser.new_page(viewport={"width": 1280, "height": 900})
    seed.request.post(BASE + "/api/dev/reset")
    seed.goto(BASE + "/")
    seed.get_by_label("Code").fill("SP335")
    seed.get_by_label("Title").fill("Migration, Citizenship and the Politics of Belonging in Comparative Perspective")
    seed.get_by_role("button", name="Create module").click()
    seed.locator("#week-AT1 .week-title").click()
    readings = sorted(str(f) for f in (HERE / "files").glob("*.pdf"))
    seed.locator("input[type=file][accept='.pdf,.pptx,.ppt,.docx,.doc,image/*,.heic,.heif']").first.set_input_files(readings)
    seed.locator("section.session").first.get_by_role("button", name="Add slides").click() if False else None
    seed.locator("input[type=file][accept='.pdf,.pptx,.ppt']").set_input_files(str(slides_pdf()))
    until(seed, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 4; }")
    seed.locator("section.session").nth(1).get_by_label("Add a question").fill(
        "1. Who is a migrant, and who decides?\n2. How far does methodological nationalism shape what we know about migration, and what would a transnational approach change in practice?\n3. Are stocks or flows the better measure?")
    seed.locator("section.session").nth(1).get_by_label("Add a question").press("Enter")
    seed.locator("section.session").first.locator(".session-title a").click()
    seed.locator(".session-notes .bn-editor").click()
    lines = ["Lecture opened with the scale of migration: 3.7 per cent of the world's population.",
             "Two definitions: change of residence for 12 months, or citizenship.", "Methodological nationalism: three elements."]
    # Long notes, as a real lecture produces, so the side column has to stay in view.
    for line in lines * 9:
        seed.keyboard.type(line)
        seed.keyboard.press("Enter")
    seed.locator("input[type=file][accept^='.txt']").set_input_files(str(HERE / "fixtures" / "moodle-transcript.txt"))
    seed.wait_for_timeout(1500)
    session_url = seed.url
    seed.get_by_role("link", name="SP335").first.click() if seed.get_by_role("link", name="SP335").count() else None
    seed.close()

    results = {}
    for width, height, tag in WIDTHS:
        phone = width < 500
        # A phone is a touch screen, so it gets touch-sized targets.
        context = browser.new_context(viewport={"width": width, "height": height}, has_touch=phone, is_mobile=phone)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/")
        expect(page.get_by_role("heading", name="Modules")).to_be_visible(timeout=20000)
        until(page, "document.querySelectorAll('.module-row').length > 0")
        audit(page, f"{tag}-01-home", phone, results)
        page.locator(".module-row").first.click()
        page.wait_for_timeout(800)
        audit(page, f"{tag}-02-module", phone, results)
        page.locator("#week-AT1 .week-title").click()
        audit(page, f"{tag}-03-week", phone, results)
        page.locator("section.session").first.locator(".session-title a").click()
        page.wait_for_selector(".slide-box canvas", timeout=20000)
        page.get_by_role("button", name="Read the transcript").click()
        audit(page, f"{tag}-04-lecture", phone, results)
        page.get_by_role("link", name="AT1").first.click()
        page.locator("ol.questions a").nth(1).click()
        audit(page, f"{tag}-05-question", phone, results)
        page.get_by_role("link", name="AT1").first.click()
        page.locator("li.reading a.name").first.click()
        page.wait_for_timeout(1500)
        audit(page, f"{tag}-06-reader", phone, results, ".scroller")
        page.get_by_role("button", name="Back to the week").first.click()
        page.goto(BASE + "/?v=search&q=cold%20war")
        page.wait_for_timeout(1500)
        audit(page, f"{tag}-07-search", phone, results)
        page.goto(BASE + "/?v=across&term=AT&n=1")
        audit(page, f"{tag}-08-across", phone, results)
        page.goto(BASE + "/?v=settings")
        audit(page, f"{tag}-09-settings", phone, results)
        if errors:
            results[f"{tag}-errors"] = errors[:5]
        context.close()
    browser.close()

    total = 0
    for label, faults in results.items():
        if faults:
            total += len(faults)
            print(f"\n{label}")
            for f in faults[:12]:
                print("  -", f)
    print(f"\n{total} faults across {len(results)} screens")
    (OUT / "faults.json").write_text(json.dumps(results, indent=1))
    sys.exit(1 if total else 0)
