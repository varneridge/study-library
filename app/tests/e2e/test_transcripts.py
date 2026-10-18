"""Version 0.9: importing a transcript downloaded from Moodle."""
import os, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[2] / "backend"
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
SOURCE = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "fixtures" / "moodle-transcript.txt"
shots = str(HERE / "shots" / "transcripts")


def until(page, script, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:90])


def process():
    env = {**os.environ, "STUDY_URL": BASE, "PROCESSOR_KEY": "local-processor-key",
           "TRANSCRIBE_BACKEND": "fake", "SUMMARY_BACKEND": "fake"}
    out = subprocess.run([sys.executable, "-m", "study.processor", "--once"], cwd=BACKEND, env=env,
                         capture_output=True, text=True, timeout=180)
    print("processor:", out.stderr.strip().splitlines()[-1])


blocks = SOURCE.read_text(encoding="utf-8").count("SPEAKER ")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("SP335")
    page.get_by_label("Title").fill("Migration and Social Policy")
    page.get_by_role("button", name="Create module").click()
    page.locator("#week-AT1 .week-title").click()
    page.locator("section.session").first.locator(".session-title a").click()

    # Add the file Moodle gives you.
    page.locator("input[type=file][accept^='.txt']").set_input_files(str(SOURCE))
    expect(page.locator(".toast")).to_contain_text("Transcript added")
    panel = page.locator("section.recording.imported")
    expect(panel).to_be_visible()
    print("imported:", page.locator(".toast").inner_text().split("Undo")[0])

    # A turn for each change of speaker, not each line.
    panel.get_by_role("button", name="Read the transcript").click()
    turns = until(page, "document.querySelectorAll('.moodle-transcript').length && [...document.querySelectorAll('.turn')].length")
    print(f"{blocks} speaker blocks in the file, {turns} turns shown")
    meta = panel.locator(".t-meta").inner_text()
    print("summary line:", meta)
    expect(panel.locator(".t-fold")).to_contain_text("short exchanges before the lecture began")
    longest = page.evaluate("Math.max(...[...document.querySelectorAll('.turn')].map(t => t.querySelectorAll('p').length))")
    print("the longest turn is set as", longest, "paragraphs")
    assert longest > 10
    page.screenshot(path=f"{shots}-1-transcript.png")

    # Name the speakers once.
    panel.locator(".t-speakers button", has_text="Speaker 2").click()
    page.get_by_label("Name for Speaker 2").fill("Lucinda Platt")
    page.keyboard.press("Enter")
    panel.locator(".t-speakers button", has_text="Speaker 1").click()
    page.get_by_label("Name for Speaker 1").fill("Isabel Shutes")
    page.keyboard.press("Enter")
    expect(panel.locator(".turn .who", has_text="Lucinda Platt").first).to_be_visible()
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.settings || []).some(r => r.id.startsWith('speakers:') && r.value['SPEAKER 1'] === 'Lucinda Platt'); }")
    print("speakers named and synced")

    # Find within the transcript.
    panel.get_by_label("Find in transcript").fill("methodological nationalism")
    expect(panel.locator(".t-tools")).to_contain_text(" of ")
    print("find:", panel.locator(".t-tools .small.muted").first.inner_text())
    expect(panel.locator("mark.t-hit.current")).to_have_count(1)
    page.screenshot(path=f"{shots}-2-find.png")
    panel.get_by_label("Find in transcript").fill("")

    # Ums can be left out of the reading, and put back.
    tidy = panel.locator(".turn p").first.inner_text()
    panel.get_by_label("Leave out ums and repeats").uncheck()
    raw = panel.locator(".turn p").first.inner_text()
    print("tidied:", tidy[:90])
    print("as said:", raw[:90])
    panel.get_by_label("Leave out ums and repeats").check()

    # No summary is written: nothing waits on the processor.
    expect(panel.locator(".summary")).to_have_count(0)

    # Search finds words in the transcript and opens it at the turn.
    page.goto(BASE + "/?v=search")
    page.get_by_placeholder("Search readings, notes, highlights and transcripts").fill("conquistadors")
    expect(page.get_by_role("heading", name="In recordings")).to_be_visible(timeout=10000)
    hit = page.locator("section", has=page.get_by_role("heading", name="In recordings")).locator("a.hit-line").first
    print("search hit:", hit.inner_text()[:80])
    hit.click()
    expect(page.locator(".moodle-transcript")).to_be_visible()
    page.wait_for_timeout(400)
    page.screenshot(path=f"{shots}-3-from-search.png")
    print("search opened the transcript at the turn")

    # Phone.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.goto(page.url)
    expect(phone.locator(".moodle-transcript")).to_be_visible(timeout=15000)
    phone.screenshot(path=f"{shots}-4-phone.png")

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
