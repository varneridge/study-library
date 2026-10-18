"""Version 0.24: the UX pass. This week marked on the module and week pages,
week dates, highlight counts on readings, the home page's Readings tile,
Go to closing with one Esc, the import table and its bar, page ranges read
as pages, and the job search reachable from a phone's top bar."""
import glob, sys, time
from datetime import date, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]
files = sorted(glob.glob(str(HERE / "files" / "*.pdf")))
shots = str(HERE / "shots" / "ux")


def until(page, script, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        value = page.evaluate(script)
        if value:
            return value
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:100])


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")

    # Term dates that make this week AT1, whatever today is.
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    year = today.year if today.month >= 8 else today.year - 1
    page.request.post(BASE + "/api/sync/push", data={"changes": [{"table": "settings", "row": {
        "id": "term-dates", "value": {str(year): {"AT": monday.isoformat(), "WT": (monday + timedelta(weeks=15)).isoformat()}},
        "modified_at": stamp(), "deleted": False}}]})

    page.goto(BASE + "/")
    page.get_by_label("Code").fill("HY319")
    page.get_by_label("Title").fill("Napoleon and Europe")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="HY319")).to_be_visible()

    # The import table: names kept short, the Import button always in view,
    # and a page range with no source read as pages.
    page.get_by_role("link", name="Import readings").click()
    page.locator("input[type=file][accept]").set_input_files(files)
    expect(page.locator("table.review tbody tr")).to_have_count(3)
    cell = page.locator("table.review td.file").first.bounding_box()
    assert cell["width"] <= 11 * 16 + 1, cell
    chen = page.locator("table.review tbody tr", has=page.locator(".file-name", has_text="Chen"))
    pages_value = chen.locator("td").nth(8).locator("input").input_value()
    source_value = chen.locator("td").nth(7).locator("input").input_value()
    assert pages_value == "1-16" and source_value.startswith("in Mao"), (source_value, pages_value)
    bar = page.locator(".import-bar")
    assert page.evaluate("getComputedStyle(document.querySelector('.import-bar')).position") == "sticky"
    page.screenshot(path=f"{shots}-1-import.png")
    bar.get_by_role("button", name="Import 3 files").click()
    expect(page.get_by_role("heading", name="HY319")).to_be_visible()
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.items || []).length === 3; }")
    rows = page.evaluate("async () => (await (await fetch('/api/sync/pull?since=0')).json()).rows")
    chen_item = next(i for i in rows["items"] if i["author"] and i["author"].startswith("Chen"))
    assert chen_item["pages"] == "1-16", chen_item
    print("import: names clamped, the bar stays in view, 'pp. 1-16' saved as pages")

    # This week, on the module page.
    page.reload()
    expect(page.locator(".jump button.is-this-week")).to_have_text("AT1")
    expect(page.locator(".jump button.is-this-week")).to_have_attribute("aria-current", "date")
    expect(page.locator("#week-AT1 .this-week-tag")).to_have_text("This week")
    expect(page.locator(".jump button.is-reading-week").first).to_have_css("font-style", "italic")
    page.screenshot(path=f"{shots}-2-module.png")
    print("module page: AT1 marked as this week; reading weeks are italic, not tinted")

    # The week page says when it runs.
    page.locator("#week-AT1 .week-title").click()
    friday = monday + timedelta(days=4)
    expect(page.locator(".crumbs .week-when")).to_contain_text("to")
    expect(page.locator(".crumbs .this-week-tag")).to_have_text("This week")
    print("week page dates:", page.locator(".crumbs .week-when").inner_text())

    # A highlight shows on the reading's row.
    page.locator(".week-page li.reading a.name").first.click()
    page.wait_for_function("document.querySelectorAll('.textLayer span').length > 5", timeout=20000)
    page.evaluate("""() => {
      const span = [...document.querySelectorAll('.textLayer span')].sort((a, b) => b.textContent.length - a.textContent.length)[0];
      const range = document.createRange(); range.selectNodeContents(span);
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    }""")
    page.get_by_role("button", name="Highlight yellow").click()
    expect(page.locator(".hl").first).to_be_visible()
    page.get_by_role("button", name="Back to the week").click()
    expect(page.locator(".week-page li.reading .state.progress").first).to_contain_text("1 highlight")
    print("a reading with a highlight says so on its row")

    # The home page's Readings tile counts the week and opens the next one.
    page.get_by_role("link", name="Study Library").click()
    tile = page.locator(".tw-readings").first
    expect(tile.locator(".tw-state")).to_have_text("0 of 2 read")
    expect(tile.locator(".tw-next")).to_contain_text("Next:")
    page.screenshot(path=f"{shots}-3-home.png")
    tile.click()
    page.wait_for_function("document.querySelectorAll('.textLayer span').length > 5", timeout=20000)
    assert "v=reader" in page.url, page.url
    page.get_by_role("button", name="Mark as read", exact=True).click()
    expect(page.get_by_role("button", name="Read. Mark as unread")).to_have_attribute("aria-pressed", "true")
    page.get_by_role("button", name="Back to the week").click()
    page.get_by_role("link", name="Study Library").click()
    expect(page.locator(".tw-readings .tw-state").first).to_have_text("1 of 2 read")
    print("home: Readings tile counted the week and opened the next reading")

    # Go to closes with one Esc, even after typing.
    page.keyboard.press("Control+k")
    page.keyboard.type("chen")
    expect(page.locator("dialog.palette[open]")).to_have_count(1)
    page.keyboard.press("Escape")
    expect(page.locator("dialog.palette[open]")).to_have_count(0)
    page.get_by_role("link", name="Settings").click()
    expect(page.get_by_role("heading", name="Settings")).to_be_visible()
    print("Go to closed with one Esc")

    # On a phone, Jobs is on the first row and inside the screen.
    phone = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    phone.on("pageerror", lambda e: errors.append("phone: " + str(e)))
    phone.goto(BASE + "/")
    jobs = phone.locator(".topbar a.to-jobs")
    expect(jobs).to_be_visible()
    box = jobs.bounding_box()
    brand = phone.locator(".topbar .brand").bounding_box()
    assert box["x"] + box["width"] <= 390 and abs(box["y"] - brand["y"]) < 20, (box, brand)
    assert jobs.inner_text() == "Jobs"
    tiles = phone.locator(".tw-module").first.locator(".tw-session")
    expect(tiles).to_have_count(3)
    tops = {round(tiles.nth(i).bounding_box()["y"]) for i in range(tiles.count())}
    assert len(tops) == 1, tops
    phone.screenshot(path=f"{shots}-4-phone-home.png")
    jobs.click()
    expect(phone.get_by_role("heading", name="Applications")).to_be_visible()
    print("phone: Jobs on the first row and reachable; this week's tiles sit in one row")

    assert not errors, errors
    print("ok")
    browser.close()
