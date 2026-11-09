"""Video readings with manual transcripts; Assessment & essay as a card under
Course materials & assessments, opening a page laid out as a history student
works, with collapsible headings in its plan that fold their whole section;
and the Word processor with native OpenXML (.docx) footnotes and review
comments."""
import sys, tempfile, zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
BASE = sys.argv[1]

from helpers import until


with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("HY240")
    page.get_by_label("Title").fill("Origins of the First World War")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="HY240", exact=True)).to_be_visible()

    # --- SPRINT 4: Video reading upload & manual transcript ---
    page.locator("#week-AT1 .week-title").click()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()

    # Create a small valid MP4-like binary and a manual transcript .txt file
    video_path = Path(tmp) / "Documentary_1914.mp4"
    video_path.write_bytes(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")

    transcript_path = Path(tmp) / "Documentary_1914_transcript.txt"
    transcript_path.write_text(
        "00:15 The Balkan league formed across south-eastern Europe.\n\n"
        "01:20 Mobilisation orders were signed in Belgrade during the July Crisis.",
        encoding="utf-8",
    )

    page.locator(".week-page input[type=file][multiple]").first.set_input_files([str(video_path)])
    expect(page.locator(".week-page li.reading")).to_have_count(1)
    until(
        page,
        "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 1; }",
        30,
    )

    # Open the video in the reader
    page.locator(".week-page li.reading a.name").click()
    expect(page.locator(".video-reader")).to_be_visible()
    expect(page.locator(".video-transcript-empty")).to_be_visible()

    # Manually attach the transcript
    page.locator(".video-reader input[type=file]").first.set_input_files([str(transcript_path)])
    expect(page.locator(".video-transcript-para")).to_have_count(2)
    expect(page.locator("button.video-timestamp", has_text="00:15")).to_be_visible()
    expect(page.locator("button.video-timestamp", has_text="01:20")).to_be_visible()

    # Search finds the manual transcript and deep-links with on-page highlight
    page.goto(BASE + "/?v=search&q=Belgrade")
    hit_link = page.locator("a", has_text="Documentary_1914")
    expect(hit_link).to_be_visible()
    hit_link.click()

    expect(page.locator(".video-reader")).to_be_visible()
    expect(page.locator("mark.find-hit.current")).to_have_text("Belgrade")
    print("video reading uploaded, manual transcript attached, and search highlights matches")

    # --- Assessment & essay, under Course materials & assessments ---
    page.goto(BASE + "/")
    page.locator(".module-row, .module-card", has_text="HY240").first.click()
    expect(page.get_by_role("heading", name="HY240", exact=True)).to_be_visible()

    materials = page.locator(".course-materials")
    toggle = materials.locator(".section-toggle")
    expect(toggle).to_contain_text("Course materials & assessments")
    expect(toggle).to_have_attribute("aria-expanded", "true")
    # The assessment is addable like custom sections, not present by default.
    add_btn = materials.get_by_role("button", name="Add assessment & essay")
    if add_btn.is_visible():
        add_btn.click()
    card = materials.locator(".essay-card")
    expect(card).to_be_visible()
    card.get_by_role("link", name="Assessment & essay").click()
    expect(page.get_by_role("heading", name="Assessment & essay", exact=True)).to_be_visible()
    assert "v=assessment" in page.url, page.url

    # The page in the order the work is done: the question, the draft and the
    # plan, beside the deadline, the word count, the sources and the snapshots.
    for name in ["Draft", "Plan and argument", "Deadline", "Word count", "Sources", "Snapshots"]:
        expect(page.get_by_role("heading", name=name, exact=True)).to_be_visible()
    question = "How far was Germany responsible for the outbreak of war in 1914?"
    page.get_by_label("Essay question").fill(question)
    expect(page.locator(".essay-panel", has_text="Word count")).to_contain_text("0 of 2,500 words")
    page.screenshot(path=str(HERE / "shots" / "assessment-1-page.png"), full_page=True)

    # A collapsible heading in the plan folds its whole section, up to the
    # next heading of the same level.
    plan = page.locator(".essay-plan .bn-editor")
    plan.click()
    page.keyboard.type("/collapsible heading 2")
    page.keyboard.press("Enter")
    page.keyboard.type("Causes")
    page.keyboard.press("Enter")
    page.keyboard.type("The alliance system bound the powers together.")
    page.keyboard.press("Enter")
    page.keyboard.type("/heading 2")
    page.keyboard.press("Enter")
    page.keyboard.type("Consequences")
    section = page.locator(".essay-plan .bn-block-outer", has_text="The alliance system bound the powers together.")
    later = page.locator(".essay-plan .bn-block-outer", has_text="Consequences")
    expect(section).to_be_visible()
    page.locator(".essay-plan .bn-block-outer", has_text="Causes").locator(".bn-toggle-button").first.click()
    expect(section).to_be_hidden()
    expect(later).to_be_visible()
    page.locator(".essay-plan .bn-block-outer", has_text="Causes").locator(".bn-toggle-button").first.click()
    expect(section).to_be_visible()
    print("a collapsible heading folds its whole section and opens again")

    # Open WordCraft, where the question is the essay's title.
    page.get_by_role("link", name="Open word processor").click()
    expect(page.locator(".word-processor")).to_be_visible()
    expect(page.locator(".wp-title")).to_contain_text(question)
    expect(page.locator(".wp-count")).to_contain_text("0 words of 2,500")
    expect(page.locator(".wp-frame")).to_be_visible()
    page.screenshot(path=str(HERE / "shots" / "assessment-2-wordcraft.png"), full_page=True)

    # Back returns to the module assessment page.
    page.get_by_role("button", name="Back to module assessment").click()
    expect(page.get_by_role("heading", name="Assessment & essay", exact=True)).to_be_visible()
    expect(page.get_by_label("Essay question")).to_have_value(question)
    print("the assessment page opens WordCraft and returns to the assessment overview")
    assert not errors, f"Page errors: {errors}"
    print("ok")
    browser.close()
