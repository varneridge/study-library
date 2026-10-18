"""Version 0.27: photos as readings. Two pictures added together become one
two-page PDF on the device, and the processor reads their text."""
import os, subprocess, sys, tempfile, time
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import pymupdf
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
BASE = sys.argv[1]
BACKEND = HERE.parent.parent.parent / "backend"


def until(page, script, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.5)
    raise AssertionError("timed out: " + script[:100])


def photo(path, lines, rotate=0):
    image = Image.new("RGB", (1500, 2000), (246, 244, 238))
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", 46)
    for i, line in enumerate(lines):
        draw.text((140, 200 + i * 80), line, fill=(30, 30, 30), font=font)
    if rotate:
        image = image.rotate(rotate, expand=True, fillcolor=(246, 244, 238))
    image.save(path, quality=90)


with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
    one, two = Path(tmp) / "IMG_0001.jpg", Path(tmp) / "IMG_0002.jpg"
    photo(one, ["Chapter one: the Consulate."] * 8)
    photo(two, ["The prefects answered to Paris."] * 8, rotate=90)
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("HY319")
    page.get_by_label("Title").fill("Napoleon and Europe")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="HY319")).to_be_visible()
    page.locator("#week-AT1 .week-title").click()
    assert "image/*" in page.locator(".week-page input[type=file][multiple]").first.get_attribute("accept")
    page.locator(".week-page input[type=file][multiple]").first.set_input_files([str(one), str(two)])

    # One reading, not two, made from both pictures.
    expect(page.locator(".week-page li.reading")).to_have_count(1)
    item = until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); const f = (j.rows.files || [])[0]; return f && f.mime === 'application/pdf' && (j.rows.items || []).length === 1 ? f : null; }")
    pdf = page.request.get(BASE + "/api/objects/" + item["r2_key"]).body()
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        assert len(doc) == 2, len(doc)
        # The sideways photo is drawn as the camera saw it; OCR turns it upright.
        assert doc[1].rect.width > doc[1].rect.height
    print("two photos became one two-page PDF reading, made on the device")

    # The processor reads both pages, turning the sideways one upright.
    env = {**os.environ, "STUDY_URL": BASE, "PROCESSOR_KEY": "local-processor-key", "TRANSCRIBE_BACKEND": "fake", "IDENTIFY_OFFLINE": "true"}
    subprocess.run([sys.executable, "-m", "study.processor", "--once"], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=300)
    found = page.request.get(BASE + "/api/search?q=prefects").json()
    assert found["pages"], found
    first = page.request.get(BASE + "/api/search?q=Consulate").json()
    assert first["pages"], first
    print("OCR read both photos, including the one taken sideways")

    # Settings reads every scan again, asking first.
    page.goto(BASE + "/?v=settings")
    page.get_by_role("button", name="Read every scan again").click()
    expect(page.locator("dialog[open]")).to_contain_text("rebuilt from their pages")
    page.locator("dialog[open]").get_by_role("button", name="Read every scan again").click()
    expect(page.locator(".toast")).to_contain_text("1 reading will be checked and read again where it helps.")
    queued = page.request.post(BASE + "/api/rescan").json()["queued"]
    assert queued == 0, queued
    print("Settings queued the reading to be read again, once")

    assert not errors, errors
    print("ok")
    browser.close()
