"""Shared helpers for browser tests."""
import time
from pathlib import Path
from playwright.sync_api import expect


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


def page_colour(page, name):
    """Picks the theme from the reader's Appearance panel."""
    group = page.get_by_role("group", name="Theme")
    if not group.is_visible():
        page.get_by_role("button", name="Appearance").click()
    group.get_by_role("button", name=name).click()
    page.keyboard.press("Escape")


def drag(page, source, target, dy=0):
    """Picks up with the mouse, moves past the threshold, then drops."""
    source.scroll_into_view_if_needed()
    a = source.bounding_box()
    page.mouse.move(a["x"] + 60, a["y"] + a["height"] / 2)
    page.mouse.down()
    page.mouse.move(a["x"] + 70, a["y"] + a["height"] / 2 + 8, steps=4)
    target.scroll_into_view_if_needed()
    b = target.bounding_box()
    page.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2 + dy, steps=14)
    page.mouse.up()
    expect(page.locator(".drag-card")).to_have_count(0)


def drop_files(page, selector, paths, release=True):
    """Drops files from the computer onto an element, as a person would."""
    payload = [{"name": Path(p).name, "bytes": list(Path(p).read_bytes())} for p in paths]
    page.evaluate("""([selector, payload, release]) => {
      const target = document.querySelector(selector);
      const data = new DataTransfer();
      for (const f of payload) data.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: 'application/pdf' }));
      for (const type of ['dragenter', 'dragover']) target.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
      if (release) target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }""", [selector, payload, release])

def add_files(page, paths, week=None):
    """Adds files from the module page that is open, by dropping them on it,
    as a person would now that the import page has gone. The sheet that asks
    where they go opens with its best guess, the weeks in their names, and
    Add waits until the module's weeks are known."""
    drop_files(page, "#main h1", paths)
    sheet = page.locator("dialog.add-sheet[open]")
    expect(sheet).to_be_visible()
    if week:
        sheet.get_by_label("Week").select_option(label=week)
    add = sheet.get_by_role("button", name="Add", exact=True)
    expect(add).to_be_enabled()
    add.click()
    expect(sheet).to_have_count(0)


def pick_date(page, trigger, iso):
    """Chooses a date in the custom date picker: opens it, steps to the month, clicks the day."""
    import datetime
    d = datetime.date.fromisoformat(iso)
    trigger.click()
    dialog = page.locator(".date-picker-dialog")
    expect(dialog).to_be_visible()
    cell = dialog.locator(f"button[data-iso='{iso}']")
    for _ in range(48):
        if cell.count() and cell.first.is_visible():
            break
        title = dialog.locator(".date-picker-title").inner_text()
        shown = datetime.datetime.strptime(title.strip(), "%B %Y").date()
        later = (d.year, d.month) > (shown.year, shown.month)
        dialog.locator(".date-picker-next" if later else ".date-picker-prev").click()
    cell.first.click()


def save_settings(page):
    """Settings has one Save changes button at the foot."""
    page.get_by_role("button", name="Save changes").click()
    expect(page.locator(".toast")).to_contain_text("Settings saved")
