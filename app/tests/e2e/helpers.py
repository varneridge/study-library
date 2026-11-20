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


def open_module(page, code):
    """Opens a module from the home page, which lists every module however
    many there are, since the top bar's module links cannot be relied on."""
    page.get_by_role("link", name="Study Library").click()
    page.locator(".module-row", has_text=code).first.click()
    expect(page.get_by_role("heading", name=code, exact=True)).to_be_visible()


def grab_point(source, low=False):
    """Finds a point on the element that is not a link, button or field, so
    that a press there is plainly on the row itself. With low, the point is
    sought near the row's lower edge first, for drag() below."""
    source.scroll_into_view_if_needed()
    heights = [0.9, 0.8, 0.7, 0.5] if low else [0.5, 0.2, 0.8, 0.08, 0.92]
    point = source.evaluate("""(el, heights) => {
      const r = el.getBoundingClientRect();
      const controls = 'a, button, input, select, textarea, [role=button], [contenteditable=true]';
      for (const fy of heights) {
        for (let x = r.left + 4; x < r.right - 4; x += 6) {
          const y = r.top + r.height * fy;
          const hit = document.elementFromPoint(x, y);
          if (hit && el.contains(hit) && !hit.closest(controls)) return [x, y];
        }
      }
      return null;
    }""", heights)
    assert point, "no part of the element is free of controls to pick it up by"
    return point


def drag(page, source, target, dy=0):
    """Picks a row up with the mouse, steers the dragged card onto the target,
    then drops. dnd-kit judges a drop by where the dragged card is rather than
    by the pointer, and picking a row up redraws the lists around it (an empty
    list shows a place to drop), which moves the rows down after the pointer
    was put down. Aiming the pointer at the target then lands the card that
    much lower, on the row being dragged, and nothing moves. So the card is
    aimed instead, measured once the rows have moved, and the pointer is kept
    on the target row so that its own list, not a neighbouring one, takes the
    drop. Dragging down onto the last row works for any such shift, because
    a card that ends up lower still lands nearest that row."""
    x, y = grab_point(source, low=True)
    page.mouse.move(x, y)
    page.mouse.down()
    x, y = x + 10, y + 8
    page.mouse.move(x, y, steps=4)
    card = page.locator(".drag-card")
    expect(card).to_have_count(1)
    # A target below the fold is brought into view first, as before, since the
    # pointer is clamped to its box and the card is measured after the scroll.
    target.scroll_into_view_if_needed()
    b = target.bounding_box()
    # The card sits in dnd-kit's positioned overlay, whose box is what the drop is judged by.
    cx, cy = card.evaluate("el => { const r = el.parentElement.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }")
    to_x = x + b["x"] + b["width"] / 2 - cx
    to_y = y + b["y"] + b["height"] / 2 + dy - cy
    to_x = min(max(to_x, b["x"] + 4), b["x"] + b["width"] - 4)
    to_y = min(max(to_y, b["y"] + 4), b["y"] + b["height"] - 4)
    page.mouse.move(to_x, to_y, steps=14)
    page.mouse.up()
    expect(card).to_have_count(0)


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


def add_session(page, kind):
    """Adds a lecture or a seminar to the week page that is open, from the
    blank row at the end of its sessions, since a new week starts with none.
    Each one is added after those already there, and is waited for as a card."""
    button = page.get_by_role("button", name="Add a session to this week", exact=True)
    button.wait_for()
    cards = page.locator(".week-session-card")
    count = cards.count()
    button.click()
    page.get_by_role("group", name="Add a session to this week").get_by_role("button", name=f"Add {kind}", exact=True).click()
    expect(cards).to_have_count(count + 1)


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
