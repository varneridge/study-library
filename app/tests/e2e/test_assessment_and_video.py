"""Video readings with manual transcripts; Assessment & essay as a card under
Course materials & assessments, opening a page laid out as a history student
works, with collapsible headings in its plan that fold their whole section;
and the Word processor with native OpenXML (.docx) footnotes and review
comments."""
import re, sys, tempfile, zipfile
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
    # One dropdown menu in Course materials & assessments offers both Admin and Essay.
    expect(page.get_by_role("button", name="Add syllabus / admin section")).to_have_count(0)
    add_btn = materials.get_by_role("button", name="Add to course materials")
    if add_btn.is_visible():
        add_btn.click()
        page.get_by_role("menuitem", name="Essay").click()
    card = materials.locator(".essay-card").first
    expect(card).to_be_visible()
    # Adding stays on the main module page rather than navigating into the new unit:
    assert "v=assessment" not in page.url, page.url
    card.locator(".week-card-title-link").click()
    expect(page.locator(".essay-page")).to_be_visible()
    assert "v=assessment" in page.url, page.url

    # The workspace is three flush columns, so each begins where the one before it ends, with
    # a hairline between them and no gap, and the side columns follow their planned widths.
    ws = page.locator(".essay-ws").bounding_box()
    rail = page.locator("#essay-pane-rail").bounding_box()
    centre = page.locator("#essay-pane-centre").bounding_box()
    aside = page.locator("#essay-pane-aside").bounding_box()
    assert abs(centre["x"] - (rail["x"] + rail["width"])) <= 1, (rail, centre)
    assert abs(aside["x"] - (centre["x"] + centre["width"])) <= 1, (centre, aside)
    assert abs(rail["width"] - min(max(17 * 16, 0.2 * ws["width"]), 26 * 16)) <= 1.5, (ws, rail)
    assert abs(aside["width"] - min(max(20 * 16, 0.28 * ws["width"]), 36 * 16)) <= 1.5, (ws, aside)
    panes = page.evaluate(
        """() => {
            const style = (selector) => getComputedStyle(document.querySelector(selector));
            return {
                gap: style(".essay-ws").columnGap,
                railLine: style("#essay-pane-rail").borderRightWidth,
                asideLine: style("#essay-pane-aside").borderLeftWidth,
                sticky: [
                    style("#essay-pane-rail").position,
                    style("#essay-pane-aside").position,
                    style(".essay-ws-toolbar").position,
                ],
            };
        }"""
    )
    assert panes == {
        "gap": "0px",
        "railLine": "1px",
        "asideLine": "1px",
        "sticky": ["sticky", "sticky", "sticky"],
    }, panes

    # Preview and Plan are two equal tabs in the segmented control, and Edit in Word is
    # the page's prominent primary button beside them.
    segments = page.locator(".essay-ws-modes [role=tab]")
    expect(segments).to_have_text(["Preview", "Plan"])
    sizes = segments.evaluate_all(
        "nodes => nodes.map((n) => { const r = n.getBoundingClientRect(); return [r.width, r.height]; })"
    )
    widths = [width for width, _ in sizes]
    heights = [height for _, height in sizes]
    assert max(widths) - min(widths) <= 1, sizes
    assert max(heights) - min(heights) <= 0.5, sizes
    expect(page.locator(".essay-ws-modes .button.primary")).to_have_text("Edit in Word")

    # The preview flows in the window: no frame inside it scrolls vertically, so the whole
    # essay is scrolled by the page itself while the side columns stay in view.
    expect(page.locator("#essay-centre-preview [data-zoom-frame], #essay-centre-preview iframe")).to_have_count(0)
    flow = page.evaluate(
        """() => {
            const pages = document.querySelector(".essay-preview-flow");
            return {
                overflowY: getComputedStyle(pages).overflowY,
                fitsItsContent: pages.scrollHeight <= pages.clientHeight + 1,
            };
        }"""
    )
    assert flow == {"overflowY": "hidden", "fitsItsContent": True}, flow
    print("the essay page has three flush columns, three equal mode segments and a preview that flows in the window")

    # The essay's two views are the Preview and Plan tabs and the references are the right-hand
    # column. The title and its menu head the left column, directly above the Brief, with no
    # full-width title row above the three columns and no Saved indicator or Snapshots button.
    for tab in ["Preview", "Plan"]:
        expect(page.get_by_role("tab", name=tab, exact=True)).to_be_visible()
    expect(page.get_by_role("heading", name=re.compile(r"^References \(\d+\)$"))).to_be_visible()
    expect(page.locator(".essay-ws-head")).to_have_count(0)
    expect(page.get_by_role("button", name=re.compile(r"^Snapshots"))).to_have_count(0)
    expect(page.locator(".save-status")).to_have_count(0)
    title_box = page.get_by_label("Essay question").bounding_box()
    brief_box = page.get_by_role("heading", name="Brief", exact=True).bounding_box()
    rail_box = page.locator("#essay-pane-rail").bounding_box()
    assert page.locator("#essay-pane-rail").get_by_label("Essay question").count() == 1
    assert rail_box["y"] <= title_box["y"] < brief_box["y"], (rail_box, title_box, brief_box)
    assert title_box["x"] + title_box["width"] <= rail_box["x"] + rail_box["width"] + 1, (rail_box, title_box)
    question = "How far was Germany responsible for the outbreak of war in 1914?"
    page.get_by_label("Essay question").fill(question)
    expect(page.locator(".essay-ws-brief-count")).to_contain_text("0 words of 2,500")
    page.screenshot(path=str(HERE / "shots" / "assessment-1-page.png"), full_page=True)

    # A collapsible heading in the plan folds its whole section, up to the
    # next heading of the same level.
    page.get_by_role("tab", name="Plan", exact=True).click()
    plan = page.locator(".essay-plan .bn-editor[contenteditable='true']")
    plan.wait_for()
    plan.click()
    page.keyboard.type("/heading 2")
    page.locator(".bn-suggestion-menu").wait_for()
    page.keyboard.press("Enter")
    page.keyboard.type("Causes")
    page.keyboard.press("Enter")
    page.keyboard.type("The alliance system bound the powers together.")
    page.keyboard.press("Enter")
    page.keyboard.type("/heading 2")
    page.locator(".bn-suggestion-menu").wait_for()
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

    # Open WordCraft from the Preview, through the mode bar's Edit in Word, where the question
    # is the essay's title. In a browser it opens in a new tab.
    page.get_by_role("tab", name="Preview", exact=True).click()
    with page.expect_popup() as wp_info:
        page.get_by_role("link", name="Edit in Word", exact=True).click()
    wp = wp_info.value
    expect(wp.locator(".word-processor")).to_be_visible()
    expect(wp.locator(".wp-title")).to_contain_text(question)
    expect(wp.locator(".wp-count")).to_contain_text("0 of 2,500 words")
    expect(wp.locator(".wp-frame")).to_be_visible()
    wp.screenshot(path=str(HERE / "shots" / "assessment-2-wordcraft.png"), full_page=True)

    # Back returns to the module assessment page preview.
    wp.get_by_role("button", name="Back to preview").click()
    expect(wp.locator(".essay-page")).to_be_visible()
    expect(wp.get_by_label("Essay question")).to_have_value(question)

    # Import a multi-paragraph Word document so the end of the draft sits well below the fold.
    docx_path = Path(tmp) / "draft.docx"
    paras = "".join(
        f"<w:p><w:r><w:t>Paragraph {i}: the July Crisis escalated across European capitals.</w:t></w:r></w:p>"
        for i in range(45)
    )
    with zipfile.ZipFile(docx_path, "w") as zf:
        zf.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        zf.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            "</Relationships>",
        )
        zf.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body>{paras}</w:body></w:document>",
        )
    wp.locator("input[type=file][accept^='.docx,']").set_input_files(str(docx_path))
    expect(wp.locator(".essay-sheet-container")).to_contain_text("Paragraph 44")

    # Add a source by hand and cite it directly with one double-click: only one footnote is created,
    # the inline tick appears, no extra "Cited" chip row is rendered, and the Cite button stays
    # available so the same source can be cited again.
    wp.locator(".essay-ws-add-toggle").click()
    wp.get_by_role("button", name="Add by hand").click()
    wp.get_by_label("Title", exact=True).fill("Fischer, Germany's Aims in the First World War")
    wp.get_by_role("button", name="Add source", exact=True).click()
    source_row = wp.locator(".essay-ws-source", has_text="Fischer")
    expect(source_row).to_be_visible()
    cite_btn = source_row.locator(".essay-ws-source-cite")
    source_row.hover()
    cite_btn.dblclick()
    expect(wp.get_by_role("heading", name="References (1)", exact=True)).to_be_visible()
    expect(source_row.locator(".essay-ws-source-cited")).to_be_visible()
    expect(cite_btn).to_be_visible()
    expect(wp.locator(".essay-ws-chip")).to_have_count(0)

    # Citing the same source a second time adds a second footnote, and the Cite button at the top
    # of References opens the SourcePicker to cite from there too.
    cite_btn.click()
    expect(wp.get_by_role("heading", name="References (2)", exact=True)).to_be_visible()
    wp.locator(".essay-ws-refs-cite").click()
    picker = wp.get_by_role("dialog", name="Cite a source")
    expect(picker).to_be_visible()
    picker.get_by_role("button", name="Cite the whole source").first.click()
    expect(wp.get_by_role("heading", name="References (3)", exact=True)).to_be_visible()

    # Scroll to the top, open the reference menu, and click "Show where it is cited":
    # closing the menu must not cancel the smooth scroll to the cited sentence below the fold.
    wp.evaluate("window.scrollTo(0, 0)")
    ref_row = wp.locator(".essay-ws-ref").first
    ref_row.hover()
    ref_row.locator(".menu-button").click()
    wp.get_by_role("menuitem", name="Show where it is cited").click()
    wp.wait_for_timeout(1000)
    expect(wp.locator("mark.essay-sheet-cited")).to_be_in_viewport()

    # On a 390px phone viewport, add a second uncited source and verify the direct cite button
    # is visible without hover and meets the 44px touch-target minimum.
    wp.set_viewport_size({"width": 390, "height": 844})
    wp.get_by_role("tab", name="Brief & sources").click()
    wp.locator(".essay-ws-add-toggle").click()
    wp.get_by_role("button", name="Add by hand").click()
    wp.get_by_label("Title", exact=True).fill("Clark, The Sleepwalkers")
    wp.get_by_role("button", name="Add source", exact=True).click()
    uncited_row = wp.locator(".essay-ws-source", has_text="Clark")
    uncited_cite = uncited_row.locator(".essay-ws-source-cite")
    expect(uncited_cite).to_be_visible()
    cite_box = uncited_cite.bounding_box()
    assert cite_box["width"] >= 44 and cite_box["height"] >= 44, cite_box
    wp.screenshot(path=str(HERE / "shots" / "assessment-3-sources-mobile.png"), full_page=True)

    wp.close()
    print("the assessment page opens WordCraft, cites directly, and jumps to cited sentences")
    assert not errors, f"Page errors: {errors}"
    print("ok")
    browser.close()
