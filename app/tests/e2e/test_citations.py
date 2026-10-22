"""Version 0.10: readings name themselves from their PDFs."""
import os, subprocess, sys, time
from pathlib import Path
import pymupdf
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[2] / "backend"
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
shots = str(HERE / "shots" / "citations")
FILES = HERE / "files-citations"


def until(page, script, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:90])


def process():
    env = {**os.environ, "STUDY_URL": BASE, "PROCESSOR_KEY": "local-processor-key",
           "TRANSCRIBE_BACKEND": "fake", "SUMMARY_BACKEND": "fake", "IDENTIFY_BACKEND": "none", "IDENTIFY_OFFLINE": "true"}
    out = subprocess.run([sys.executable, "-m", "study.processor", "--once"], cwd=BACKEND, env=env,
                         capture_output=True, text=True, timeout=180)
    print("processor:", out.stderr.strip().splitlines()[-1])


def jstor_pdf(name, title, authors, source):
    FILES.mkdir(exist_ok=True)
    doc = pymupdf.open()
    cover = doc.new_page()
    lines = [title, f"Author(s): {authors}", f"Source: {source}", "Published by: A University Press",
             "Stable URL: https://www.jstor.org/stable/1234567"]
    for i, line in enumerate(lines):
        cover.insert_text((60, 90 + i * 18), line, fontsize=11)
    page = doc.new_page()
    for i in range(30):
        page.insert_text((60, 70 + i * 18), f"Body text line {i} about the Cold War and its origins.", fontsize=11)
    path = FILES / name
    doc.save(path)
    return path


def article_pdf(name):
    """A first page with a large title and the authors beneath, and no cover."""
    FILES.mkdir(exist_ok=True)
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((60, 40), "Journal of Cold War Studies, Vol. 12, No. 3", fontsize=8)
    page.insert_text((60, 120), "The Sino-Soviet Split and the", fontsize=20)
    page.insert_text((60, 146), "Making of the Third World", fontsize=20)
    page.insert_text((60, 180), "Lorenz M. Luthi and Jeremy Friedman", fontsize=11)
    for i in range(25):
        page.insert_text((60, 220 + i * 14), f"Body text line {i} on the dispute between Moscow and Beijing.", fontsize=10)
    path = FILES / name
    doc.save(path)
    return path


unnamed = jstor_pdf("scan_0034.pdf", "The Origins of the Cold War", "Arthur Schlesinger, Jr.",
                    "Foreign Affairs, Vol. 46, No. 1 (Oct., 1967), pp. 22-52")
named = jstor_pdf("(AT1) Leffler (1984) 'Strategy'.pdf",
                  "The American Conception of National Security and the Beginnings of the Cold War, 1945-48",
                  "Melvyn P. Leffler", "The American Historical Review, Vol. 89, No. 2 (Apr., 1984), pp. 346-381")
article = article_pdf("luthi.pdf")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("HY206")
    page.get_by_label("Title").fill("The International History of the Cold War")
    page.get_by_role("button", name="Create module").click()
    page.locator("#week-AT1 .week-title").click()
    page.locator("input[type=file][accept='.pdf,.pptx,.ppt,.docx,.doc,image/*,.heic,.heif']").first.set_input_files([str(unnamed), str(named), str(article)])
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 3; }", 40)
    before = page.locator(".week-page li.reading .name").all_inner_texts()
    print("as added:", before)

    # The processor reads the text, then the cover pages.
    process()
    process()
    # Changes arrive at the next sync. Reloading fetches them now.
    page.reload()

    # A reading with nothing to go on takes its details straight away.
    expect(page.locator(".week-page li.reading", has_text="The Origins of the Cold War")).to_be_visible(timeout=20000)
    print("scan_0034.pdf named itself:", page.locator(".week-page li.reading", has_text="Schlesinger").locator(".name").inner_text().replace("\n", " | "))

    # A reading you named is left alone, with the details offered.
    row = page.locator(".week-page li.reading", has_text="Leffler")
    expect(row.get_by_role("button", name="Details found")).to_be_visible()
    row.get_by_role("button", name="Details found").click()
    expect(row.locator(".compare")).to_contain_text("from the JSTOR cover page")
    page.screenshot(path=f"{shots}-1-compare.png")
    print("offered:", row.locator(".compare .found-title").inner_text())

    # A plain first page is read for its title and authors, and offered,
    # because a layout is a good guess but not a record.
    row = page.locator(".week-page li.reading", has_text="luthi")
    row.get_by_role("button", name="Details found").click()
    expect(row.locator(".compare")).to_contain_text("from the title and names on its first page")
    expect(row.locator(".compare .found-title")).to_contain_text("The Sino-Soviet Split and the Making of the Third World")
    print("read from the first page:", row.locator(".compare .found-title").inner_text())
    row.get_by_role("button", name="Use these details").click()
    expect(page.locator(".week-page li.reading", has_text="The Sino-Soviet Split")).to_be_visible()

    # The module page gathers them for one check.
    page.locator(".crumbs a").first.click()
    page.get_by_role("button", name="Details found for 1 reading").click()
    dialog = page.locator("dialog.review-citations[open]")
    expect(dialog).to_contain_text("The American Conception of National Security")
    page.screenshot(path=f"{shots}-2-review.png")
    dialog.get_by_role("button", name="Use 1 of 1").click()
    expect(page.locator(".toast")).to_contain_text("1 reading updated")
    expect(page.get_by_role("button", name="Details found for 1 reading")).to_have_count(0)
    page.locator("#week-AT1 .week-title").click()
    expect(page.locator(".week-page li.reading", has_text="The American Conception")).to_be_visible()
    print("used from the module review")

    # The editor says where details came from and can put the old ones back.
    row = page.locator(".week-page li.reading", has_text="Schlesinger")
    row.get_by_role("button", name="More actions").click()
    page.get_by_role("menuitem", name="Edit details").click()
    expect(row.locator(".provenance")).to_contain_text("Filled in from the JSTOR cover page")
    page.screenshot(path=f"{shots}-3-editor.png")
    row.get_by_role("button", name="Put back the old details").click()
    expect(page.locator(".week-page li.reading", has_text="scan_0034")).to_be_visible()
    print("put back the old details")

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
