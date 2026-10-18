"""Version 0.25: a seminar question's answer is written beneath it, in the
same editor as the notes, on the week page and the session page alike."""
import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
shots = str(HERE / "shots" / "answers")


def until(page, script, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:100])


ANSWER_SAVED = """async (words) => { const j = await (await fetch('/api/sync/pull?since=0')).json();
  const notes = (j.rows.notes || []).filter(n => !n.deleted && n.question_id);
  const blocks = (j.rows.note_blocks || []).filter(b => !b.deleted && notes.some(n => n.id === b.note_id));
  return blocks.some(b => JSON.stringify(b.content).includes(words)); }"""

with sync_playwright() as p:
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

    # Two questions, typed as before.
    page.locator(".question-row.adder textarea").click()
    page.keyboard.type("How far was the Napoleonic state new?")
    page.keyboard.press("Enter")
    page.keyboard.type("Was the Concordat a concession or a tool?")
    page.keyboard.press("Tab")
    rows = page.locator(".question-row:not(.adder)")
    expect(rows).to_have_count(2)

    # No "answered" label and no click-through: each answer is right beneath its question.
    expect(page.get_by_text("answered")).to_have_count(0)
    expect(rows.nth(0).locator(".question-answer .bn-editor")).to_be_visible()
    expect(rows.nth(1).locator(".question-answer .bn-editor")).to_be_visible()
    expect(rows.nth(0).locator("a.question-open")).to_have_count(0)
    print("both questions show an answer editor beneath them; no 'answered' label")

    # Down from the end of a question goes into its answer.
    rows.nth(0).locator("textarea").click()
    page.keyboard.press("End")
    page.keyboard.press("ArrowDown")
    page.keyboard.type("Less than it claimed. The prefects built on the intendants.")
    page.wait_for_timeout(1200)
    until(page, f"async () => ({ANSWER_SAVED})('built on the intendants')")
    # Clicking straight into the second answer works too.
    rows.nth(1).locator(".question-answer .bn-editor").click()
    page.keyboard.type("A tool first, a concession in the wording.")
    page.wait_for_timeout(1200)
    until(page, f"async () => ({ANSWER_SAVED})('a concession in the wording')")
    page.screenshot(path=f"{shots}-1-week.png", full_page=True)
    print("answers typed under both questions and saved")

    # The question is still a question: rewording it leaves the answer alone.
    rows.nth(0).locator("textarea").click()
    page.keyboard.press("End")
    page.keyboard.type(" Discuss.")
    page.keyboard.press("Tab")
    page.wait_for_timeout(900)
    expect(rows.nth(0).locator(".question-answer")).to_contain_text("built on the intendants")

    # The session page shows the same answers, editable there too.
    page.locator("section.session", has_text="Seminar").locator(".session-title a").click()
    srows = page.locator(".question-row:not(.adder)")
    expect(srows.nth(0).locator(".question-answer")).to_contain_text("built on the intendants")
    srows.nth(0).locator(".question-answer .bn-editor").click()
    page.keyboard.press("Control+End")
    page.keyboard.press("Enter")
    page.keyboard.type("Woolf disagrees.")
    page.wait_for_timeout(1200)
    until(page, f"async () => ({ANSWER_SAVED})('Woolf disagrees')")
    page.screenshot(path=f"{shots}-2-session.png", full_page=True)
    print("the session page shows and edits the same answers")

    # A link to a question's page, saved before such pages went, opens its session.
    q = page.evaluate("async () => (await (await fetch('/api/sync/pull?since=0')).json()).rows.questions.find(q => !q.deleted)")
    page.goto(BASE + f"/?v=question&id={q['id']}")
    expect(page.locator(".session-page .question-row").first).to_be_visible()
    assert "v=session" in page.url, page.url
    print("an old question link opens the question's session")

    # On a phone the answer sits beneath its question too.
    phone = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    phone.on("pageerror", lambda e: errors.append("phone: " + str(e)))
    rows_data = page.evaluate("async () => (await (await fetch('/api/sync/pull?since=0')).json()).rows")
    week = next(w for w in rows_data["weeks"] if not w["deleted"] and w["term"] == "AT" and w["number"] == 1)
    phone.goto(BASE + f"/?v=week&id={week['id']}")
    prow = phone.locator(".question-row:not(.adder)").first
    expect(prow.locator(".question-answer")).to_contain_text("Woolf disagrees")
    q = prow.locator("textarea").bounding_box()
    a = prow.locator(".question-answer").bounding_box()
    assert a["y"] >= q["y"] + q["height"] - 1 and a["x"] + a["width"] <= 390, (q, a)
    phone.screenshot(path=f"{shots}-3-phone.png", full_page=True)
    print("phone: the answer sits beneath its question, inside the screen")

    assert not errors, errors
    print("ok")
    browser.close()
