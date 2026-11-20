"""The desktop window's tab strip: no clipping, an accent on the tab in front, an
icon for each kind of page, typing that goes on after a switch, a top bar that
never blinks, and a switch that is quick. Run under the desktop shell (?sl=desktop)."""
import re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
(HERE / "shots").mkdir(exist_ok=True)
BASE = sys.argv[1]

# What the keyboard does for Ctrl+Tab, sent straight to the window so that the
# time taken can be measured in the page itself, from the press to the frame
# that shows the new tab, and not across the test's own round trips.
CTRL_TAB = "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true }));"
FRAME = "new Promise(requestAnimationFrame)"

SWITCH_MS = """async () => {
  const front = () => [...document.querySelectorAll('main > .sl-pane')].find((pane) => pane.style.display !== 'none');
  const was = front();
  const start = performance.now();
  %s
  while (front() === was) {
    if (performance.now() - start > 2000) return null;
    await %s;
  }
  await %s;
  return performance.now() - start;
}""" % (CTRL_TAB, FRAME, FRAME)

BAR_ACROSS_ONE_SWITCH = """async () => {
  const bar = document.querySelector('.topbar');
  const before = bar.innerText;
  %s
  const seen = [];
  for (let i = 0; i < 10; i++) {
    await %s;
    const now = document.querySelector('.topbar');
    seen.push([now === bar, now.innerText, now.hidden]);
  }
  return { before, seen };
}""" % (CTRL_TAB, FRAME)

BAR_ACROSS_EVERY_TAB = """async (count) => {
  const bar = document.querySelector('.topbar');
  let same = true;
  for (let i = 0; i < count; i++) {
    %s
    await %s;
    await %s;
    same = same && document.querySelector('.topbar') === bar;
  }
  return same;
}""" % (CTRL_TAB, FRAME, FRAME)

SHADOWS = "() => [...document.querySelectorAll('.sl-tab')].map((tab) => [tab.classList.contains('is-active'), getComputedStyle(tab).boxShadow])"

ACCENT = """() => {
  const probe = document.createElement('i');
  probe.style.color = 'var(--accent)';
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}"""

ICONS = """() => [...document.querySelectorAll('.sl-tab')].map((tab) => {
  const icons = tab.querySelectorAll('.sl-tab-title svg');
  return [tab.dataset.kind, icons.length, icons[0] ? icons[0].querySelectorAll('path, rect, circle').length : 0, icons[0] ? icons[0].innerHTML : ''];
})"""

# The row scrolled to its end, with the last tab's edge measured against the box that clips it.
EDGE_ROOM = """() => {
  const list = document.querySelector('.sl-tabs-list');
  list.scrollLeft = list.scrollWidth;
  const tabs = list.querySelectorAll('.sl-tab');
  const box = list.getBoundingClientRect();
  return box.right - tabs[tabs.length - 1].getBoundingClientRect().right;
}"""

# Every tab at least as wide as its icon, with the icon whole and clear of the close button.
CROWDED = """() => [...document.querySelectorAll('.sl-tab')].flatMap((tab) => {
  const box = tab.getBoundingClientRect();
  const icon = tab.querySelector('.sl-tab-title svg').getBoundingClientRect();
  const close = tab.querySelector('.sl-tab-close');
  const bad = [];
  if (!tab.classList.contains('is-pinned') && box.width < 47.5) bad.push('narrower than 3rem');
  if (icon.width < 15 || icon.left < box.left - 0.5 || icon.right > box.right + 0.5) bad.push('icon cut off');
  if (close && getComputedStyle(close).display !== 'none' && icon.right > close.getBoundingClientRect().left + 0.5) bad.push('icon under the close button');
  return bad.length ? [[tab.dataset.kind, Math.round(box.width), bad.join(', ')]] : [];
})"""

ACTIVE_IN_VIEW = """() => {
  const box = document.querySelector('.sl-tabs-list').getBoundingClientRect();
  const tab = document.querySelector('.sl-tab.is-active').getBoundingClientRect();
  return tab.left >= box.left - 0.5 && tab.right <= box.right + 0.5;
}"""


def create_module(page, code):
    page.get_by_label("Code").fill(code)
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name=code, exact=True)).to_be_visible()


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/?sl=desktop")
    expect(page.locator(".sl-tabs")).to_be_visible()
    tabs = page.locator(".sl-tab")
    home = page.locator(".sl-tab.is-pinned .sl-tab-title")

    # Typing goes on after a switch without a click. The cursor is put between
    # the two letters, a new tab takes the window, and Home is clicked again.
    code = page.get_by_label("Code")
    code.fill("AB")
    page.keyboard.press("ArrowLeft")
    page.keyboard.press("Control+t")
    expect(tabs).to_have_count(2)
    expect(page.locator(".sl-tab.is-pinned")).not_to_have_class(re.compile("is-active"))
    home.click()
    expect(page.locator(".sl-tab.is-pinned")).to_have_class(re.compile("is-active"))
    page.keyboard.type("X")
    expect(code).to_have_value("AXB")
    print("typing resumed after a switch: AXB")

    # Two modules, so that the top bar has module links to keep steady, then one
    # tab of each kind: search (made above), calendar and settings.
    create_module(page, "HY335")
    home.click()
    page.get_by_role("button", name="Add a module").click()
    create_module(page, "HY206")
    page.keyboard.press("Control+t")
    page.locator(".topbar a.to-calendar").click()
    page.keyboard.press("Control+t")
    page.locator('.topbar a[title="Settings"]').click()
    expect(tabs).to_have_count(6)
    expect(page.locator(".sl-tab.is-active")).to_have_attribute("data-kind", "settings")
    page.wait_for_timeout(600)

    # One icon for each kind of page, each of them drawn, and different kinds drawn differently.
    icons = page.evaluate(ICONS)
    print("tab kinds:", [i[0] for i in icons])
    assert [i[0] for i in icons] == ["home", "search", "menu", "menu", "calendar", "settings"], icons
    assert all(i[1] == 1 and i[2] > 0 for i in icons), ("each tab shows one drawn icon", icons)
    drawings = {i[0]: i[3] for i in icons}
    assert len(set(drawings.values())) == len(drawings), "two kinds share one drawing"

    # Only the tab in front carries the accent line, along its top.
    page.mouse.move(0, 0)
    page.wait_for_timeout(300)
    accent = page.evaluate(ACCENT)
    shadows = page.evaluate(SHADOWS)
    marked = [s for s in shadows if "inset" in s[1]]
    assert len(marked) == 1 and marked[0][0] and accent in marked[0][1], (accent, shadows)
    print("accent on the tab in front only:", marked[0][1])

    # Nothing is clipped at the right-hand end, and nothing fades while every tab fits.
    room = page.evaluate(EDGE_ROOM)
    print("room beyond the last tab:", room)
    assert room >= 1, room
    assert page.locator(".sl-tabs-list").get_attribute("data-fade") is None, "the row faded though every tab fits"

    # The top bar is the same element across a switch, and its words do not change
    # for a single frame, going from one module's tab to the next and then round every tab.
    tabs.nth(2).locator(".sl-tab-title").click()
    page.wait_for_timeout(400)
    across = page.evaluate(BAR_ACROSS_ONE_SWITCH)
    assert "HY335" in across["before"] and "HY206" in across["before"], across["before"]
    assert all(same and text == across["before"] and not hidden for same, text, hidden in across["seen"]), across
    assert page.evaluate(BAR_ACROSS_EVERY_TAB, 5), "the top bar was replaced during a switch"
    print("top bar steady across 10 frames and every tab")

    # A switch to a tab that is already mounted shows within 100 ms. A first lap
    # brings every tab forward once, so that none is being mounted when timed.
    for _ in range(5):
        page.evaluate(SWITCH_MS)
        page.wait_for_timeout(500)
    times = []
    for _ in range(5):
        ms = page.evaluate(SWITCH_MS)
        assert ms is not None, "no tab came to the front"
        times.append(round(ms))
        page.wait_for_timeout(300)
    print("switch times (ms):", times)
    assert max(times) < 100, times

    # A crowded row: tabs shrink to the width of their icon, each icon stays whole,
    # the edges fade on the sides that have more tabs, and the tab in front is in view.
    page.set_viewport_size({"width": 760, "height": 800})
    for _ in range(12):
        page.keyboard.press("Control+t")
        page.wait_for_timeout(120)
    expect(tabs).to_have_count(18)
    page.wait_for_timeout(500)
    bad = page.evaluate(CROWDED)
    assert not bad, bad
    assert page.evaluate(ACTIVE_IN_VIEW), "the tab in front is out of view"
    fade = page.locator(".sl-tabs-list").get_attribute("data-fade")
    print("crowded row fades:", fade)
    assert fade in ("start", "both"), fade
    page.evaluate("document.querySelector('.sl-tabs-list').scrollLeft = 0")
    expect(page.locator(".sl-tabs-list")).to_have_attribute("data-fade", "end")
    room = page.evaluate(EDGE_ROOM)
    assert room >= 1, room
    tabs.nth(1).locator(".sl-tab-title").click()
    page.wait_for_timeout(300)
    assert page.evaluate(ACTIVE_IN_VIEW), "a tab clicked at the edge is out of view"

    print("page errors:", errors[:5])
    assert not errors
    browser.close()
