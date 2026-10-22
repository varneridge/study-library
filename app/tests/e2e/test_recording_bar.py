"""Version 0.15: a recording carries on while you use the rest of the app,
shown in a small bar at the foot of every screen."""
import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
files = sorted(str(p) for p in (HERE / "files").glob("*.pdf"))
shots = str(HERE / "shots" / "recording-bar")


def until(page, script, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:90])


def seconds(text):
    m, s = text.strip().split(":")[-2:]
    return int(m) * 60 + int(s)


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("HY319")
    page.get_by_role("button", name="Create module").click()
    page.locator("#week-AT1 .week-title").click()
    page.locator("input[type=file][accept='.pdf,.pptx,.ppt,.docx,.doc,image/*,.heic,.heif']").first.set_input_files(files[:1])
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 1; }", 40)
    week_url = page.url

    # Start recording in the lecture. On its own page there is no bar.
    page.locator("section.session").first.locator(".session-title a").click()
    page.get_by_role("button", name="Record", exact=True).click()
    expect(page.get_by_role("button", name="Stop recording")).to_be_visible()
    expect(page.locator(".rec-pill")).to_have_count(0)
    expect(page.locator(".rec-hint")).to_contain_text("You can leave this page while it records")

    # Leave: the bar follows, with the session's name, the time and a level.
    page.get_by_role("link", name="Study Library").click()
    bar = page.locator(".rec-pill")
    expect(bar).to_be_visible()
    expect(bar).to_contain_text("HY319 AT1 Lecture")
    first = seconds(bar.locator(".rec-time").inner_text())
    page.wait_for_timeout(2200)
    later = seconds(bar.locator(".rec-time").inner_text())
    assert later > first, (first, later)
    level = page.evaluate("Math.max(...[...document.querySelectorAll('.rec-level i')].map(i => new DOMMatrix(getComputedStyle(i).transform).d))")
    print(f"recording on the home page: {first}s then {later}s, level up to {level:.2f}")
    page.screenshot(path=f"{shots}-1-home.png")

    # A closing tab is asked about first.
    blocked = page.evaluate("(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()")
    assert blocked, "closing the tab should be asked about"
    print("closing the tab mid-recording asks first")

    # Open a reading, moving round the app as a person would.
    page.locator(".module-row").first.click()
    page.locator("#week-AT1 .week-title").click()
    page.locator("li.reading a.name").first.click()
    page.wait_for_selector(".pdf-page canvas")
    expect(bar).to_be_visible()
    page.screenshot(path=f"{shots}-2-reader.png")
    print("the bar sits over the reader too")

    # Pause holds the time still; resume carries on.
    bar.get_by_role("button", name="Pause recording").click()
    expect(bar).to_contain_text("Paused")
    held = seconds(bar.locator(".rec-time").inner_text())
    page.wait_for_timeout(3000)
    assert seconds(bar.locator(".rec-time").inner_text()) == held
    bar.get_by_role("button", name="Resume recording").click()
    expect(bar).to_contain_text("Recording")
    print("pause held the clock at", held, "seconds")

    # Notices sit above the bar.
    page.get_by_role("button", name="Back to the week").first.click()
    page.locator("li.reading .mark").first.click()

    # The name takes you back to the session's notes.
    bar.locator(".rec-where").click()
    expect(page.get_by_role("button", name="Stop recording")).to_be_visible()
    expect(page.locator(".rec-pill")).to_have_count(0)

    # Stop from the bar asks once more, then stops.
    page.get_by_role("link", name="Study Library").click()
    bar.get_by_role("button", name="Stop recording").click()
    expect(bar.get_by_role("button", name="Tap again to stop recording")).to_be_visible()
    page.screenshot(path=f"{shots}-3-confirm.png")
    bar.get_by_role("button", name="Tap again to stop recording").click()
    expect(page.locator(".rec-pill")).to_have_count(0)
    rec = until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); const r = (j.rows.recordings || [])[0]; return r && r.status === 'uploaded' ? r : null; }")
    print(f"stopped and uploaded: {rec['duration_seconds']} seconds recorded, the pause left out")
    assert rec["duration_seconds"] < later + 25

    # Phone: the bar spans the foot of the screen.
    phone = browser.new_page(viewport={"width": 390, "height": 844})
    phone.goto(BASE + "/")
    phone.locator(".module-row").first.click()
    phone.locator("#week-AT1 .week-title").click()
    phone.locator("section.session").first.locator(".session-title a").click()
    phone.get_by_role("button", name="Record", exact=True).click()
    phone.get_by_role("link", name="Study Library").click()
    expect(phone.locator(".rec-pill")).to_be_visible()
    phone.screenshot(path=f"{shots}-4-phone.png")

    # Opening the app on a second device while the phone is recording must not
    # recover or finish the live recording, or queue any processing jobs.
    live_id = until(
        phone,
        "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); const r = (j.rows.recordings || []).find(r => r.status === 'recording'); return r ? r.id : null; }",
    )
    before_status = phone.evaluate("async () => (await (await fetch('/api/status')).json())")
    second_ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    second = second_ctx.new_page()
    second.goto(BASE + "/")
    until(
        second,
        f"async () => {{ const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.recordings || []).some(r => r.id === {live_id!r}); }}",
    )
    second.wait_for_timeout(1200)
    second.reload()
    second.wait_for_timeout(1500)
    second_device_state = phone.evaluate(
        f"""async () => {{
            const pull = await (await fetch('/api/sync/pull?since=0')).json();
            const rec = (pull.rows.recordings || []).find(r => r.id === {live_id!r});
            const status = await (await fetch('/api/status')).json();
            return {{
                status: rec && rec.status,
                new_jobs: (status.queued + status.running) - {before_status['queued'] + before_status['running']},
            }};
        }}"""
    )
    print("cause 1 (second device opens while phone records):", second_device_state)
    second_ctx.close()

    # Stop the phone recording cleanly, then start another recording on the phone
    # and reload mid-lecture to check what happens when a phone tab reloads early.
    phone.locator(".rec-pill").get_by_role("button", name="Stop recording").click()
    phone.locator(".rec-pill").get_by_role("button", name="Tap again to stop recording").click()
    expect(phone.locator(".rec-pill")).to_have_count(0)

    phone.locator(".module-row").first.click()
    phone.locator("#week-AT1 .week-title").click()
    phone.locator("section.session").nth(1).locator(".session-title a").click()
    phone.get_by_role("button", name="Record", exact=True).click()
    reload_id = until(
        phone,
        "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); const r = (j.rows.recordings || []).find(r => r.status === 'recording'); return r ? r.id : null; }",
    )
    phone.wait_for_timeout(2500)
    before_reload_status = phone.evaluate("async () => (await (await fetch('/api/status')).json())")
    phone.reload()
    phone.wait_for_timeout(1500)
    reload_state = phone.evaluate(
        f"""async () => {{
            const pull = await (await fetch('/api/sync/pull?since=0')).json();
            const rec = (pull.rows.recordings || []).find(r => r.id === {reload_id!r});
            const status = await (await fetch('/api/status')).json();
            return {{
                status: rec && rec.status,
                duration: rec && rec.duration_seconds,
                new_jobs: (status.queued + status.running) - {before_reload_status['queued'] + before_reload_status['running']},
            }};
        }}"""
    )
    print("cause 2 (phone reloads mid-lecture):", reload_state)

    assert second_device_state["status"] == "recording", f"second device changed status to {second_device_state['status']}"
    assert second_device_state["new_jobs"] == 0, f"jobs queued while still recording: {second_device_state}"

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
