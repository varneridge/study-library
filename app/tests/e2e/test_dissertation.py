"""Version 0.31: dissertation modules. Sections you name and order in place
of weeks, each with its readings and its own notes; supervision meetings
with notes and recordings; key dates counting down on the home page; files
named for a section going to it; and a taught module changed into one."""
import glob, shutil, sys, tempfile, time
from datetime import date, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
BASE = sys.argv[1]
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))


def until(page, script, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:100])


ROWS = "async () => (await (await fetch('/api/sync/pull?since=0')).json()).rows"

with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")

    # A new module can be a dissertation: no weeks, one section to start.
    page.get_by_role("button", name="A dissertation, by sections you name").click()
    expect(page.get_by_text("Each week has")).to_have_count(0)
    page.get_by_label("Code").fill("HY300")
    page.get_by_label("Title").fill("Dissertation: the Monroe Doctrine")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="HY300", exact=True)).to_be_visible()
    expect(page.locator(".jump")).to_have_count(0)
    expect(page.locator(".week")).to_have_count(1)
    expect(page.locator(".week .week-code")).to_have_text("Section 1")
    until(page, f"async () => {{ const r = await ({ROWS})(); return (r.modules || []).length === 1 && (r.weeks || []).length === 1; }}")
    rows = page.evaluate(ROWS)
    module = rows["modules"][0]
    assert module["kind"] == "dissertation", module
    assert [w["term"] for w in rows["weeks"]] == ["S"], rows["weeks"]
    print("a new dissertation: no weeks of term, one section to start")

    # Sections are renamed, added and reordered.
    page.get_by_role("button", name="More actions for Section 1").click()
    page.get_by_role("menuitem", name="Rename").click()
    page.get_by_label("Section name").fill("Chapter 2")
    page.keyboard.press("Enter")
    expect(page.locator(".week .week-code")).to_have_text("Chapter 2")
    page.get_by_role("button", name="Add a section").click()
    expect(page.get_by_role("heading", name="Section 2")).to_be_visible()
    page.get_by_role("heading", name="Section 2").click()
    page.get_by_label("Section name").fill("Primary sources")
    page.keyboard.press("Enter")
    expect(page.get_by_role("heading", name="Primary sources")).to_be_visible()
    expect(page.locator(".crumbs")).to_contain_text("HY300 / Primary sources")
    page.get_by_role("button", name="More actions for this section").click()
    page.get_by_role("menuitem", name="Move up").click()
    page.locator(".crumbs a").first.click()
    expect(page.locator(".week .week-code")).to_have_text(["Primary sources", "Chapter 2"])
    print("sections renamed, added and moved:", page.locator(".week .week-code").all_inner_texts())

    # A section's page: its readings, its own notes, and its meetings.
    page.locator(".week", has_text="Chapter 2").locator(".week-title").click()
    page.locator(".week-page input[type=file][multiple]").first.set_input_files(files[:1])
    expect(page.locator(".week-page li.reading")).to_have_count(1)
    notes = page.locator(".section-notes .bn-editor")
    notes.click()
    page.keyboard.type("The argument: Monroe as a statement of weakness, not strength.")
    until(page, f"""async () => {{ const r = await ({ROWS})();
      const note = (r.notes || []).find(n => n.week_id && !n.deleted);
      return note && (r.note_blocks || []).some(b => b.note_id === note.id && JSON.stringify(b.content).includes('statement of weakness')); }}""")
    print("a section has its readings and its own notes")

    page.get_by_role("button", name="Add a meeting").click()
    today = date.today()
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    expect(page.get_by_role("heading", name=f"Supervision, {today.day} {months[today.month - 1]}")).to_be_visible()
    expect(page.get_by_role("button", name="Record", exact=True)).to_be_visible()
    expect(page.locator(".crumbs")).to_contain_text("Chapter 2")
    until(page, f"async () => (((await ({ROWS})()).sessions) || []).some(s => s.kind === 'supervision')")
    print("a supervision meeting: notes, recording and transcripts, as a lecture has")

    # Key dates, on the module page, counting down on the home page.
    page.locator(".crumbs a").first.click()
    page.get_by_role("button", name="Add a date").click()
    page.get_by_label("What").fill("Chapter 2 draft")
    page.get_by_label("When").fill((today + timedelta(days=5)).isoformat())
    page.get_by_role("button", name="Add", exact=True).click()
    expect(page.locator(".key-date-list li")).to_contain_text("in 5 days")
    page.goto(BASE + "/")
    ahead = page.locator(".key-dates-ahead li").first
    expect(ahead).to_contain_text("Chapter 2 draft")
    expect(ahead.locator(".kd-days")).to_have_text("5")
    assert "soon" in (ahead.get_attribute("class") or "")
    # A dissertation has no weeks, so This week leaves it out.
    expect(page.locator(".tw-module", has_text="HY300")).to_have_count(0)
    page.screenshot(path=str(HERE / "shots" / "dissertation-1-home.png"))
    print("key dates count down on the home page; This week leaves the dissertation out")

    # A file named for a section goes to it.
    named = Path(tmp) / "(Chapter 2) Kirby, W. C. (1997) 'The Internationalization of China'.pdf"
    shutil.copy(files[-1], named)
    page.locator(".module-row", has_text="HY300").click()
    page.get_by_role("link", name="Import readings").click()
    page.locator("input[type=file][accept]").last.set_input_files([str(named)])
    page.get_by_role("button", name="Import 1 file").click()
    until(page, f"""async () => {{ const r = await ({ROWS})();
      const week = r.weeks.find(w => w.title === 'Chapter 2');
      const item = (r.items || []).find(i => i.author && i.author.startsWith('Kirby'));
      return item && (r.week_items || []).some(l => l.item_id === item.id && l.week_id === week.id && !l.deleted); }}""", 90)
    print("a file named (Chapter 2) went to Chapter 2")

    # Search finds a section's notes.
    page.goto(BASE + "/?v=search&q=statement%20of%20weakness")
    expect(page.get_by_text("Notes on Chapter 2, HY300")).to_be_visible()
    print("search finds a section's notes")

    # Deleting a section keeps its readings, in Unsorted.
    page.goto(BASE + "/")
    page.locator(".module-row", has_text="HY300").click()
    page.get_by_role("button", name="More actions for Chapter 2").click()
    page.get_by_role("menuitem", name="Delete section").click()
    expect(page.locator(".toast")).to_contain_text("Its readings are in Unsorted.")
    expect(page.locator(".week .week-code")).to_have_text(["Primary sources"])
    expect(page.locator(".tray li.reading")).to_have_count(2)
    print("a deleted section's readings wait in Unsorted")

    # A taught module becomes a dissertation: weeks with something become sections.
    page.goto(BASE + "/")
    page.get_by_role("button", name="Add a module").click()
    page.get_by_label("Code").fill("HY301")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="HY301", exact=True)).to_be_visible()
    page.locator("#week-AT1 .week-title").click()
    page.locator(".week-page input[type=file][multiple]").first.set_input_files(files[:1])
    expect(page.locator(".week-page li.reading")).to_have_count(1)
    page.locator(".crumbs a").first.click()
    page.get_by_role("button", name="Edit module").click()
    page.get_by_role("button", name="Change to a dissertation").click()
    page.locator("dialog[open]").get_by_role("button", name="Change to a dissertation").click()
    expect(page.locator(".toast")).to_contain_text("with 1 section from its weeks")
    expect(page.locator(".jump")).to_have_count(0)
    expect(page.locator(".week .week-code")).to_have_text(["AT1"])
    expect(page.locator(".week li.reading, .week .count").first).to_be_visible()
    print("a taught module changed to a dissertation: AT1 kept as a section, empty weeks gone")

    # The phone shows a section as it shows a week.
    phone = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    phone.on("pageerror", lambda e: errors.append("phone: " + str(e)))
    rows = page.evaluate(ROWS)
    section = next(w for w in rows["weeks"] if w["title"] == "Primary sources")
    phone.goto(BASE + f"/?v=week&id={section['id']}")
    expect(phone.get_by_role("heading", name="Primary sources")).to_be_visible()
    expect(phone.locator(".section-notes")).to_be_visible()

    assert not errors, errors
    print("ok")
    browser.close()
