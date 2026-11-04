"""Sprint 4 & 5: Video readings with manual transcripts, collapsible
Assessment & essay section, and dedicated Word processor with native
OpenXML (.docx) footnotes and review comments."""
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

    # --- SPRINT 5: Collapsible Assessment & essay section + Word processor ---
    page.goto(BASE + "/")
    page.locator(".module-row, .module-card", has_text="HY240").first.click()
    expect(page.get_by_role("heading", name="HY240", exact=True)).to_be_visible()

    toggle = page.locator(".assessment-section .section-toggle")
    expect(toggle).to_be_visible()
    expect(toggle).to_have_attribute("aria-expanded", "false")
    toggle.click()
    expect(toggle).to_have_attribute("aria-expanded", "true")

    # Open the dedicated Word processor
    page.locator(".assessment-section").get_by_role("link", name="Open word processor").first.click()
    expect(page.locator(".word-processor")).to_be_visible()

    # Set essay title and type body text
    title_input = page.get_by_label("Essay title")
    title_input.fill("July Crisis Historiography Essay")

    body_box = page.get_by_label("Essay body")
    body_box.click()
    page.keyboard.type("Austria-Hungary delivered the ultimatum to Serbia.")

    # Insert a native footnote
    page.get_by_role("button", name="Insert footnote").click()
    fn_input = page.get_by_label("Footnote 1 text")
    expect(fn_input).to_be_visible()
    fn_input.fill("Christopher Clark, The Sleepwalkers (London, 2012), p. 412.")
    expect(page.locator("sup.word-fn-ref")).to_have_text("1")

    # Add a review comment
    page.get_by_role("button", name="Add comment").click()
    expect(page.locator(".word-comments-pane")).to_be_visible()
    comment_input = page.get_by_label("Comment text")
    comment_input.fill("Check the Vienna Hoyos mission primary telegrams.")

    # Save snapshot
    page.get_by_role("button", name="Save snapshot").click()
    expect(page.locator(".toast")).to_contain_text("Snapshot saved")

    # Export .docx and inspect the OpenXML package
    with page.expect_download() as dl_info:
        page.get_by_role("button", name="Export .docx").click()
    dl = dl_info.value
    assert dl.suggested_filename == "July Crisis Historiography Essay.docx", dl.suggested_filename
    docx_out = Path(tmp) / dl.suggested_filename
    dl.save_as(str(docx_out))

    with zipfile.ZipFile(docx_out, "r") as zf:
        names = set(zf.namelist())
        assert "word/document.xml" in names, names
        assert "word/footnotes.xml" in names, names
        assert "word/comments.xml" in names, names
        assert "word/commentsExtended.xml" in names, names

        doc_xml = zf.read("word/document.xml").decode("utf-8")
        fn_xml = zf.read("word/footnotes.xml").decode("utf-8")
        com_xml = zf.read("word/comments.xml").decode("utf-8")

        assert "Austria-Hungary delivered the ultimatum" in doc_xml
        assert '<w:footnoteReference w:id="1"/>' in doc_xml
        assert 'w:type="separator" w:id="-1"' in fn_xml
        assert 'w:type="continuationSeparator" w:id="0"' in fn_xml
        assert "<w:footnoteRef/>" in fn_xml
        assert "Christopher Clark, The Sleepwalkers" in fn_xml
        assert "Check the Vienna Hoyos mission primary telegrams." in com_xml

    print("exported .docx verified with native Word footnotes and review comments")
    assert not errors, f"Page errors: {errors}"
    print("ok")
    browser.close()
