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
    # The assessment is a card like the syllabus or a week, not a week itself.
    expect(page.locator(".week")).to_have_count(22)
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

    # Open the dedicated Word processor, where the question is the essay's title.
    page.get_by_role("link", name="Open word processor").click()
    expect(page.locator(".word-processor")).to_be_visible()
    expect(page.get_by_label("Essay title")).to_have_value(question)

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

    # Back on the Assessment & essay page, the draft and the snapshot show.
    page.locator(".word-back").click()
    expect(page.get_by_role("heading", name="Assessment & essay", exact=True)).to_be_visible()
    expect(page.locator(".essay-draft")).to_contain_text("Austria-Hungary delivered the ultimatum")
    expect(page.locator(".essay-snapshot-list li")).to_have_count(1)
    expect(page.get_by_label("Essay question")).to_have_value("July Crisis Historiography Essay")
    print("the assessment page shows the draft's opening and its snapshot")
    assert not errors, f"Page errors: {errors}"
    print("ok")
    browser.close()
