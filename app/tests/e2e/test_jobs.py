"""Version 0.23: the job search. Getting there and back, adding and editing
an application in the table, stages and deadlines, the four file slots,
deleting and restoring, the phone cards, and that the study side is as it was."""
import sys, time
from datetime import date, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
shots = str(HERE / "shots" / "jobs")


def until(page, script, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:100])


def server_apps(page):
    return page.evaluate("async () => (await (await fetch('/api/sync/pull?since=0')).json()).rows.applications || []")


def live(page):
    return [a for a in server_apps(page) if not a["deleted"]]


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def push(page, rows, events=None):
    changes = [{"table": "applications", "row": r} for r in rows]
    if events:
        changes.extend([{"table": "application_events", "row": e} for e in events])
    page.request.post(BASE + "/api/sync/push", data={"changes": changes})


def application(id, employer, role, stage, applied, deadline=None, **slots):
    row = {"id": id, "employer": employer, "role": role, "applied": applied, "stage": stage, "next_deadline": deadline,
           "notes": None, "file_cv": None, "file_cl": None, "file_rd": None, "file_qs": None, "modified_at": stamp(), "deleted": False}
    row.update(slots)
    return row


def app_event(id, app_id, stage, at, from_stage=None, kind="change", cleared_deadline=None):
    return {"id": id, "application_id": app_id, "stage": stage, "from_stage": from_stage,
            "at": at, "kind": kind, "cleared_deadline": cleared_deadline,
            "modified_at": stamp(), "deleted": False}


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")

    today = date.today()
    iso = lambda d: d.isoformat()
    push(page, [
        application("kekst", "Kekst CNC", "Summer 2026 Internship", "rejected", "2026-02-26", iso(today - timedelta(days=3)),
                    file_cv={"state": "saved"}, file_cl={"state": "saved"}, file_rd={"state": "saved"}),
        application("pwc", "PwC", "Graduate Strategy", "oa_todo", iso(today - timedelta(days=10)), iso(today + timedelta(days=2))),
        application("castore", "Castore", "Consulting Analyst", "interview_todo", iso(today - timedelta(days=20)), iso(today - timedelta(days=1))),
        application("fast", "Civil Service", "Fast Stream", "applied", iso(today - timedelta(days=5))),
    ], events=[
        app_event("ev-kekst", "kekst", "rejected", "2026-02-26"),
        app_event("ev-pwc", "pwc", "oa_todo", iso(today - timedelta(days=10))),
        app_event("ev-castore", "castore", "interview_todo", iso(today - timedelta(days=20)), from_stage="applied"),
        app_event("ev-fast", "fast", "applied", iso(today - timedelta(days=5))),
    ])

    # The study side, before: its top bar and pages are unchanged but for one link.
    page.goto(BASE + "/")
    assert page.locator(".topbar a.to-jobs").inner_text() == "Job search"
    study_links = [t.strip() for t in page.locator(".topbar nav a, .topbar nav button").all_inner_texts()]
    print("study top bar:", study_links)
    assert study_links[:4] == ["Go to", "Search", "Week across modules", "Settings"], study_links

    # Into the job search.
    page.locator(".topbar a.to-jobs").click()
    expect(page.get_by_role("heading", name="Applications")).to_be_visible()
    assert page.url.endswith("/?v=jobs")
    expect(page.locator(".topbar .brand")).to_have_text("Job search")
    expect(page.locator(".topbar nav")).to_have_count(1)
    assert page.title() == "Job search · Study Library", page.title()
    expect(page.locator(".jobs-summary")).to_contain_text("4 applications. 3 open, 1 overdue, 1 due within a week, 1 closed.")
    print("summary:", page.locator(".jobs-summary").text_content())

    # Default order: by deadline, then open with none, then closed.
    employers = lambda: page.locator("tbody.app .c-employer textarea").evaluate_all("els => els.map(e => e.value)")
    assert employers() == ["Castore", "PwC", "Civil Service", "Kekst CNC"], employers()
    print("order:", employers())

    # Stage chips and deadline states carry colour and words.
    row = lambda name: page.locator(f"tbody.app[data-employer='{name}']")
    expect(row("Castore").locator(".stage-chip")).to_have_class("stage-chip cat-todo")
    expect(row("Castore").locator(".deadline")).to_have_class("deadline state-overdue")
    expect(row("Castore").locator(".deadline-words")).to_have_text("overdue by a day")
    expect(row("PwC").locator(".deadline")).to_have_class("deadline state-soon")
    expect(row("PwC").locator(".deadline-words")).to_have_text("in 2 days")
    expect(row("Civil Service").locator(".stage-chip")).to_have_class("stage-chip cat-waiting")
    # Kekst is closed, so its past deadline is not shown as overdue.
    expect(row("Kekst CNC").locator(".deadline")).to_have_class("deadline state-none")
    expect(row("Kekst CNC").locator(".stage-chip")).to_have_class("stage-chip cat-closed")
    expect(row("Kekst CNC").locator(".c-applied .date-show")).to_have_text("26 Feb 2026")
    page.screenshot(path=f"{shots}-1-table.png", full_page=True)
    print("stage colours and deadline states shown, with words")

    # Add an application: it starts today, awaiting a response, with the cursor in Employer.
    page.get_by_role("button", name="Add application").click()
    first = page.locator("tbody.app").first
    expect(first.locator(".c-employer textarea")).to_be_focused()
    page.keyboard.type("Dragonfly Intelligence")
    page.keyboard.press("Tab")
    page.keyboard.type("Summer 2026 Research Internship")
    page.keyboard.press("Tab")
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.applications || []).some(a => a.employer === 'Dragonfly Intelligence' && a.role === 'Summer 2026 Research Internship'); }")
    new = next(a for a in live(page) if a["employer"] == "Dragonfly Intelligence")
    assert new["stage"] == "applied" and new["applied"] == iso(today), new
    print("added an application, dated today, awaiting a response")

    # Change its stage and set a deadline five days out.
    dragonfly = row("Dragonfly Intelligence")
    dragonfly.locator(".stage-chip").select_option(label="Video interview: to record")
    expect(dragonfly.locator(".stage-chip")).to_have_class("stage-chip cat-todo")
    # From the keyboard, the date is typed and Enter keeps it.
    dragonfly.locator(".c-deadline .date-show").focus()
    page.keyboard.press("Enter")
    expect(dragonfly.locator(".c-deadline input[type=date]")).to_be_focused()
    dragonfly.locator(".c-deadline input[type=date]").fill(iso(today + timedelta(days=5)))
    page.keyboard.press("Enter")
    expect(dragonfly.locator(".deadline-words")).to_have_text("in 5 days")
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.applications || []).some(a => a.employer === 'Dragonfly Intelligence' && a.stage === 'hirevue_todo' && a.next_deadline); }")
    print("stage changed and a deadline set, saved as", next(a for a in live(page) if a["employer"] == "Dragonfly Intelligence")["next_deadline"])

    # An application added and left empty is not kept.
    page.get_by_role("button", name="Add application").click()
    expect(page.locator("tbody.app")).to_have_count(6)
    page.locator(".jobs-summary").click()
    expect(page.locator("tbody.app")).to_have_count(5)
    page.wait_for_timeout(600)
    assert len(live(page)) == 5, [a["employer"] for a in live(page)]
    print("an empty new application was let go")

    # Files: open Details, attach a CV, add a link, mark Qs not required.
    dragonfly = row("Dragonfly Intelligence")
    dragonfly.locator(".c-slot .slot").first.click()
    details = dragonfly.locator(".app-details")
    expect(details).to_be_visible()
    cv = details.locator(".slot-row").nth(0)
    cv.locator("input[type=file]").set_input_files({"name": "Samuel_Leigh_CV.pdf", "mimeType": "application/pdf", "buffer": b"%PDF-1.4\n% a CV\n"})
    expect(cv.locator(".slot-status a")).to_have_text("Samuel_Leigh_CV.pdf")
    expect(dragonfly.locator(".c-slot .slot.attached")).to_have_count(1)
    href = dragonfly.locator(".c-slot .slot.attached").get_attribute("href")
    served = page.request.get(BASE + href)
    assert served.ok and served.body().startswith(b"%PDF") and "Samuel_Leigh_CV.pdf" in served.headers["content-disposition"], served.headers
    rd = details.locator(".slot-row").nth(2)
    rd.get_by_role("button", name="Add link").click()
    rd.locator("input[type=url]").fill("careers.dragonfly.co.uk/research-intern")
    page.keyboard.press("Enter")
    expect(rd.locator(".slot-status a")).to_have_text("careers.dragonfly.co.uk/research-intern")
    qs = details.locator(".slot-row").nth(3)
    qs.get_by_role("button", name="Not required").click()
    expect(dragonfly.locator(".c-slot .slot.na")).to_have_count(1)
    details.get_by_label("Notes on Dragonfly Intelligence").fill("Recruiter: Hannah. HireVue has five questions.")
    page.locator(".jobs-summary").click()
    until(page, """async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); const a = (j.rows.applications || []).find(a => a.employer === 'Dragonfly Intelligence');
      return a && a.file_cv && a.file_cv.name === 'Samuel_Leigh_CV.pdf' && a.file_rd && a.file_rd.url && a.file_qs && a.file_qs.state === 'na' && a.notes; }""")
    page.screenshot(path=f"{shots}-2-details.png", full_page=True)
    print("a CV attached and served under its own name, a link added, Qs not required, notes saved")

    # A file dropped on a slot is attached to it.
    payload = list(b"Cover letter for PwC")
    page.evaluate("""([bytes]) => {
      const target = [...document.querySelectorAll('tbody.app')].find(t => t.querySelector('.c-employer textarea').value === 'PwC').querySelectorAll('.c-slot .slot')[1];
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'PwC cover letter.txt', { type: 'text/plain' }));
      for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }""", [payload])
    expect(row("PwC").locator(".c-slot .slot.attached")).to_have_count(1)
    print("a cover letter dropped on its slot was attached")

    # Filter, find and order.
    page.get_by_role("button", name="Closed 1").click()
    assert employers() == ["Kekst CNC"], employers()
    page.get_by_role("button", name="All 5").click()
    page.keyboard.press("/")
    expect(page.locator(".jobs-find")).to_be_focused()
    page.keyboard.type("strategy")
    assert employers() == ["PwC"], employers()
    page.keyboard.press("Escape")
    page.get_by_label("Order", exact=True).select_option(label="Employer")
    assert employers() == ["Castore", "Civil Service", "Dragonfly Intelligence", "Kekst CNC", "PwC"], employers()
    page.get_by_label("Order", exact=True).select_option(label="Next deadline")
    print("filter, find and order work")

    # Delete, undo, delete again, restore from Recently deleted.
    castore = row("Castore")
    castore.locator(".details-toggle").click()
    castore.get_by_role("button", name="Delete application").click()
    expect(page.locator(".toast")).to_contain_text("Castore deleted.")
    expect(row("Castore")).to_have_count(0)
    until(page, """async () => {
        const j = await (await fetch('/api/sync/pull?since=0')).json();
        const evs = (j.rows.application_events || []).filter(e => e.application_id === 'castore');
        return evs.length > 0 && evs.every(e => e.deleted);
    }""")
    page.locator(".toast").get_by_role("button", name="Undo").click()
    expect(row("Castore")).to_have_count(1)
    # Undo brings it back as it was, with its Details still open.
    expect(row("Castore").locator(".details-toggle")).to_have_attribute("aria-expanded", "true")
    until(page, """async () => {
        const j = await (await fetch('/api/sync/pull?since=0')).json();
        const evs = (j.rows.application_events || []).filter(e => e.application_id === 'castore');
        return evs.length > 0 && evs.every(e => !e.deleted);
    }""")
    row("Castore").get_by_role("button", name="Delete application").click()
    expect(page.locator(".jobs-bin")).to_contain_text("Castore")
    until(page, """async () => {
        const j = await (await fetch('/api/sync/pull?since=0')).json();
        const evs = (j.rows.application_events || []).filter(e => e.application_id === 'castore');
        return evs.length > 0 && evs.every(e => e.deleted);
    }""")
    page.locator(".jobs-bin").get_by_role("button", name="Restore").click()
    expect(row("Castore")).to_have_count(1)
    expect(page.locator(".jobs-bin")).to_have_count(0)
    until(page, """async () => {
        const j = await (await fetch('/api/sync/pull?since=0')).json();
        const evs = (j.rows.application_events || []).filter(e => e.application_id === 'castore');
        return evs.length > 0 && evs.every(e => !e.deleted);
    }""")
    print("delete, undo and restore work")

    # The N key adds one, and dropping a file elsewhere on the page adds nothing to the library.
    page.locator(".jobs-summary").click()
    page.keyboard.press("n")
    expect(page.locator("tbody.app").first.locator(".c-employer textarea")).to_be_focused()
    page.keyboard.press("Escape")
    page.locator(".jobs-summary").click()
    expect(page.locator(".drop-sheet, .drop-mark")).to_have_count(0)

    # Back to the study side, which is as it was.
    page.locator(".topbar nav a", has_text="Study Library").click()
    expect(page.locator(".topbar .brand")).to_have_text("Study Library")
    assert page.url.rstrip("/").endswith(BASE.split("//")[1]) or page.url.endswith("/"), page.url
    expect(page.get_by_role("link", name="Search", exact=True)).to_be_visible()
    # With no modules yet the home page puts the cursor in its form, so leave it first.
    page.evaluate("() => document.activeElement && document.activeElement.blur()")
    page.keyboard.press("/")
    expect(page).to_have_url(BASE + "/?v=search")
    print("back to Study Library, where / still opens search")

    # Each theme gives the chips their own colours.
    for theme in ("sepia", "dark", "light"):
        page.evaluate(f"() => document.documentElement.setAttribute('data-theme', '{theme}')")
        page.goto(BASE + "/?v=jobs")
        page.evaluate(f"() => document.documentElement.setAttribute('data-theme', '{theme}')")
        page.wait_for_timeout(300)
        page.screenshot(path=f"{shots}-3-{theme}.png")

    # On a phone: cards that open to edit, with targets a finger can hit.
    phone = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
    phone.on("pageerror", lambda e: errors.append(str(e)))
    phone.goto(BASE + "/?v=jobs")
    expect(phone.locator(".app-card")).to_have_count(5)
    assert phone.locator(".topbar nav a").inner_text() == "Study Library"
    # Castore is overdue, so it comes first.
    expect(phone.locator(".app-card").first.locator(".card-employer")).to_have_text("Castore")
    phone.screenshot(path=f"{shots}-4-phone.png", full_page=True)
    castore_card = phone.locator(".app-card[data-app='castore']")
    castore_card.locator(".card-head").tap()
    expect(castore_card.locator(".app-fields")).to_be_visible()
    castore_card.get_by_label("Role", exact=True).fill("Consulting Analyst, Retail")
    castore_card.locator(".app-fields").get_by_label("Stage").select_option(label="Interview: done, awaiting result")
    phone.locator(".jobs-summary").tap()
    until(phone, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.applications || []).some(a => a.employer === 'Castore' && a.role === 'Consulting Analyst, Retail' && a.stage === 'interview_wait'); }")
    phone.screenshot(path=f"{shots}-5-phone-open.png", full_page=True)
    # An open card does not repeat itself: the summary lines give way to the form.
    expect(castore_card.locator(".card-meta")).to_be_hidden()
    expect(castore_card.locator(".card-slots")).to_be_hidden()
    # Each file slot has one menu, a sheet on a phone, in place of a row of small buttons.
    cv = castore_card.locator(".slot-row").first
    expect(cv.locator(".slot-actions > button.quiet")).to_have_count(0)
    cv.get_by_role("button", name="Change the cv").tap()
    sheet = phone.locator(".menu-panel")
    expect(sheet).to_be_visible()
    sheet.get_by_role("menuitem", name="Not required").tap()
    expect(cv.locator(".slot-status")).to_have_text("Not required")
    until(phone, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.applications || []).some(a => a.employer === 'Castore' && a.file_cv && a.file_cv.state === 'na'); }")
    # Done, at the foot of the card, closes it.
    castore_card.get_by_role("button", name="Done", exact=True).tap()
    expect(castore_card.locator(".app-fields")).to_have_count(0)
    expect(castore_card.locator(".card-meta")).to_be_visible()
    print("phone card: no repetition, one sheet per file slot, Done at the foot")
    small = phone.evaluate("""() => [...document.querySelectorAll('.jobs button, .jobs a[href], .jobs select, .jobs input')]
      .filter(e => e.offsetParent && e.type !== 'file').map(e => [e.className || e.tagName, e.getBoundingClientRect()])
      .filter(([, r]) => r.height < 43.5).map(([c, r]) => c + ' ' + Math.round(r.width) + 'x' + Math.round(r.height))""")
    assert not small, small
    print("phone: cards open to edit, and every control is at least 44 pixels high")

    assert not errors, errors
    print("ok")
    browser.close()
