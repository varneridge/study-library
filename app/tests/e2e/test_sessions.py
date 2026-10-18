import os, subprocess, sys, time, glob
from pathlib import Path

HERE = Path(__file__).resolve().parent
(HERE / 'shots').mkdir(exist_ok=True)
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1]
shots = str(HERE / "shots" / "sessions")
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))[:2]
BACKEND = str(HERE.parents[2] / "backend")

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
           "TRANSCRIBE_BACKEND": "fake", "SUMMARY_BACKEND": "fake"}
    out = subprocess.run([sys.executable, "-m", "study.processor", "--once"], cwd=BACKEND, env=env,
                         capture_output=True, text=True, timeout=180)
    print("processor:", out.stderr.strip().splitlines()[-1])

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    context = browser.new_context(viewport={"width": 1280, "height": 900}, permissions=["microphone"])
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("HY319")
    page.get_by_label("Title").fill("Napoleon and Europe")
    page.get_by_role("button", name="Create module").click()
    expect(page.locator(".week")).to_have_count(22)
    page.get_by_role("link", name="Import readings").click()
    page.locator("input[type=file][accept]").set_input_files(files)
    page.get_by_role("button", name="Import 2 files").click()
    until(page, "async () => ((await (await fetch('/api/sync/pull?since=0')).json()).rows.files || []).length === 2")
    process()

    # Seminar questions
    page.locator(".week").nth(0).locator(".week-title").click()
    # Typed straight into the seminar, one per line.
    adder = page.locator(".session").nth(1).get_by_label("Add a question")
    adder.fill("1. How far did the Cold War shape Chinese policy?\n2) Was the Three Worlds theory new?")
    adder.press("Enter")
    expect(page.locator(".session").nth(1).locator(".question-row:not(.adder)")).to_have_count(2)
    page.wait_for_timeout(1500)
    page.screenshot(path=f"{shots}-0-week.png", full_page=True)
    print("errors so far:", errors[:3])
    print("questions in db:", page.evaluate("async () => { const r = await fetch('/api/sync/pull?since=0'); const j = await r.json(); return (j.rows.questions || []).map(q => q.body); }"))
    expect(page.locator("ol.questions li:not(.adder)")).to_have_count(2)
    print("questions added:", page.locator("ol.questions li:not(.adder) textarea").evaluate_all("els => els.map(e => e.value)"))

    # Highlight and file it under question 1
    page.get_by_role("link", name="Chen, J. (2001) ‘Introduction’, in Mao’s China and the Cold War, pp. 1-16").click()
    page.wait_for_function("document.querySelectorAll('.pdf-page[data-page=\"0\"] .textLayer span').length > 3", timeout=20000)
    page.wait_for_timeout(300)
    page.evaluate("""() => {
      const span = [...document.querySelectorAll('.pdf-page[data-page="0"] .textLayer span')].find(s => s.textContent.length > 20);
      const r = document.createRange(); r.selectNodeContents(span);
      const s = document.getSelection(); s.removeAllRanges(); s.addRange(r);
    }""")
    page.get_by_role("button", name="Highlight green").click()
    # Highlights are no longer filed under questions.
    expect(page.locator(".floating").get_by_label("File under a seminar question")).to_have_count(0)
    page.get_by_role("button", name="Done").click()
    # The notes are open in the sidebar, with the highlight already quoted.
    if page.locator(".reading-notes").count() == 0:
        page.get_by_role("button", name="Notes on this reading").click()
    expect(page.locator(".reading-notes .note-highlight")).to_have_count(1, timeout=10000)
    page.locator(".reading-notes .bn-editor").click()
    page.keyboard.press("Control+End")
    page.keyboard.type("Chen frames the period through the Cold War in Asia.")
    page.wait_for_timeout(900)
    page.screenshot(path=f"{shots}-1-reader-notes.png")
    page.get_by_role("button", name="Back to the week").click()

    # A question's answer is written beneath it; there is no evidence to file.
    q1 = page.locator(".question-row", has=page.get_by_label("Question 1", exact=True)).first
    expect(q1.locator("a.question-open")).to_have_count(0)
    q1.locator(".question-answer .bn-editor").click()
    page.keyboard.type("Largely, though domestic politics mattered too.")
    page.wait_for_timeout(900)
    page.screenshot(path=f"{shots}-2-question.png", full_page=True)
    print("questions: answered in place, with no evidence link")

    # Session mode with a live recording, from the week page it is already on.
    page.locator(".session").nth(0).locator(".session-title a").click()
    page.get_by_role("button", name="Record", exact=True).click()
    expect(page.locator(".rec-time")).to_be_visible()
    page.locator(".session-notes .bn-editor").click()
    page.keyboard.type("Mao saw the superpowers as the First World.")
    page.wait_for_timeout(2500)
    page.keyboard.press("Enter")
    page.keyboard.type("Third World solidarity as a claim to leadership.")
    page.wait_for_timeout(3000)
    page.get_by_role("button", name="Stop recording").click()
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.recordings || []).some(r => r.status === 'uploaded'); }", 40)
    print("recording uploaded")
    process()
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.recordings || []).some(r => r.status === 'done'); }", 40)
    page.reload()
    expect(page.locator("audio")).to_have_count(1)
    # The transcript is plain text, set as the Moodle transcripts are.
    expect(page.locator(".stamp")).to_have_count(0)
    page.get_by_role("button", name="Read the transcript").click()
    expect(page.locator(".moodle-transcript .turn")).to_have_count(1)
    expect(page.locator(".moodle-transcript")).to_contain_text("Today we look at the Concordat of 1801.")
    expect(page.locator(".moodle-transcript .t-speakers")).to_have_count(0)
    page.screenshot(path=f"{shots}-3-session.png", full_page=True)
    duration = page.evaluate("async () => { const a = document.querySelector('audio'); await new Promise(r => a.readyState >= 1 ? r() : a.addEventListener('loadedmetadata', r)); return a.duration; }")
    print(f"audio duration {duration:.1f}s, transcript as plain text")

    # Search
    page.get_by_role("link", name="Search", exact=True).click()
    page.get_by_placeholder("Search readings, notes, highlights and transcripts").fill("cold war asia")
    expect(page.get_by_role("heading", name="In the readings")).to_be_visible(timeout=10000)
    expect(page.get_by_role("heading", name="Highlights")).to_be_visible()
    expect(page.get_by_role("heading", name="Notes")).to_be_visible()
    page.screenshot(path=f"{shots}-4-search.png", full_page=True)
    page.get_by_placeholder("Search readings, notes, highlights and transcripts").fill("concordat")
    expect(page.get_by_role("heading", name="In recordings")).to_be_visible(timeout=10000)
    print("search found readings, highlights, notes and transcripts")

    # Another device sees the notes
    other = browser.new_page(viewport={"width": 390, "height": 844})
    other.goto(BASE + "/")
    other.locator(".module-row", has_text="HY319").click()
    other.locator(".week").nth(0).locator(".week-title").click()
    expect(other.get_by_text("Mao saw the superpowers as the First World.")).to_be_visible(timeout=15000)
    other.screenshot(path=f"{shots}-5-phone-week.png", full_page=True)
    print("second device sees the lecture notes")
    print("page errors:", errors[:5])
    browser.close()
