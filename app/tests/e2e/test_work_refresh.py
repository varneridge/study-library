"""Refresh on Work in hand in Settings asks for the list at once, rather than
waiting for the next minute's poll, so work queued meanwhile appears straight
away. Run like the others: python test_work_refresh.py BASE
"""

import sys

from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1]
VOICE = "bf_emma"


def prepare(page, item, text):
    # Queues one paragraph of Listen audio for a reading, which Work in hand lists as waiting.
    reply = page.request.post(BASE + "/api/listen/prepare", data={"itemId": item, "voice": VOICE, "utterances": [text]})
    assert reply.ok, reply.status


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.request.post(BASE + "/api/dev/reset")
    prepare(page, "refresh-one", "The first reading waits to be prepared.")
    page.goto(BASE + "/?v=settings#section-processor")
    rows = page.locator("#work-list > li")
    expect(rows).to_have_count(1)

    prepare(page, "refresh-two", "The second reading waits to be prepared.")
    button = page.get_by_role("button", name="Refresh work in hand")
    button.click()
    # Five seconds is well inside the minute between polls, so only Refresh can have brought the second row.
    expect(rows).to_have_count(2, timeout=5000)
    expect(button).to_be_enabled()

    # Listen audio now folds inside Processor and speech, and its old link still opens it, with usage loaded through api().
    page.goto(BASE + "/?v=settings#section-listen-audio")
    usage = page.locator("#section-listen-audio-body")
    expect(usage).to_be_visible()
    expect(usage).to_contain_text("Paragraphs waiting to be prepared")

    # On a phone the button keeps a 44-point target, as Send to top does.
    phone = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    phone.goto(BASE + "/?v=settings#section-processor")
    box = phone.get_by_role("button", name="Refresh work in hand").bounding_box()
    assert box and box["height"] >= 44, box

    assert not errors, errors
    print("work in hand: Refresh lists newly queued work at once and keeps its touch target; Listen audio opens from its link")
    browser.close()
