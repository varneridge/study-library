"""End-to-end tests for PassageReader, Referenced-in labels, and always-visible essay controls."""
import re, sys, tempfile
from pathlib import Path
import pymupdf
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
BASE = sys.argv[1]

from helpers import until


def make_two_page_pdf(path: Path) -> None:
    doc = pymupdf.open()
    for i in range(2):
        page = doc.new_page()
        page.insert_text(
            (72, 100),
            f"Page {i + 1}: The superpowers intervened in regional conflicts throughout the Cold War.",
            fontsize=12,
        )
        page.insert_text(
            (72, 130),
            f"Second sentence on page {i + 1} discussing archival evidence from Moscow and Washington.",
            fontsize=12,
        )
    doc.save(path)


def select_text_on_page(page, page_index: int) -> None:
    page.wait_for_function(
        f"document.querySelectorAll('.pdf-page[data-page=\"{page_index}\"] .textLayer span').length > 0",
        timeout=20000,
    )
    span = page.locator(f".pdf-page[data-page='{page_index}'] .textLayer span").first
    span.scroll_into_view_if_needed()
    box = span.bounding_box()
    assert box is not None
    page.mouse.move(box["x"] + 2, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + min(box["width"] - 2, 180), box["y"] + box["height"] / 2, steps=8)
    page.mouse.up()


with sync_playwright() as p, tempfile.TemporaryDirectory() as tmp:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("HY320")
    page.get_by_label("Title").fill("Cold War Interventions")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="HY320", exact=True)).to_be_visible()

    # Upload a 2-page PDF reading in AT1
    pdf_path = Path(tmp) / "(AT1) Westad (2005) 'Global Cold War'.pdf"
    make_two_page_pdf(pdf_path)
    page.locator("#week-AT1 .week-title").click()
    page.locator("input[type=file][accept^='.pdf,.epub']").first.set_input_files([str(pdf_path)])
    expect(page.locator(".week-page li.reading")).to_have_count(1)
    until(
        page,
        "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length === 1; }",
        30,
    )

    # Open the essay page and add the reading to it
    page.goto(BASE + "/")
    page.locator(".module-row, .module-card", has_text="HY320").first.click()
    page.locator(".course-materials .section-toggle").click()
    page.locator(".course-materials .assessment-card").first.click()
    expect(page.locator(".essay-page")).to_be_visible()

    page.locator(".essay-ws-add-toggle").click()
    page.get_by_role("checkbox").first.check()
    page.get_by_role("button", name=re.compile(r"^Add \(")).click()
    source_row = page.locator(".essay-ws-source", has_text="Global Cold War")
    expect(source_row).to_be_visible()

    # Source Cite and ••• buttons are always visible (opacity 1 without hover)
    cite_opacity = source_row.locator(".essay-ws-source-cite").evaluate("el => getComputedStyle(el).opacity")
    menu_opacity = source_row.locator(".essay-ws-source-menu").evaluate("el => getComputedStyle(el).opacity")
    assert cite_opacity == "1", cite_opacity
    assert menu_opacity == "1", menu_opacity

    # Cite the reading
    source_row.locator(".essay-ws-source-cite").click()
    expect(page.get_by_role("heading", name="References (1)", exact=True)).to_be_visible()

    # Reference ••• and magnifier are always visible without hover, with magnifier below •••
    ref_tools = page.locator(".essay-ws-ref-tools").first
    tools_opacity = ref_tools.evaluate("el => getComputedStyle(el).opacity")
    assert tools_opacity == "1", tools_opacity
    ref_menu_box = ref_tools.locator(".menu-button").first.bounding_box()
    mag_btn = ref_tools.locator(".essay-ws-ref-passage")
    expect(mag_btn).to_be_visible()
    mag_box = mag_btn.bounding_box()
    assert mag_box["y"] > ref_menu_box["y"], (ref_menu_box, mag_box)
    assert abs((mag_box["x"] + mag_box["width"] / 2) - (ref_menu_box["x"] + ref_menu_box["width"] / 2)) <= 2, (
        ref_menu_box,
        mag_box,
    )

    # Clicking the magnifier opens clean PassageReader (no .pane, no colour picker, no notes)
    with page.expect_popup() as pr_info:
        mag_btn.click()
    pr = pr_info.value
    expect(pr.locator(".reader.passage-mode")).to_be_visible()
    expect(pr.locator(".pane")).to_have_count(0)
    expect(pr.get_by_role("tab", name="Notes")).to_have_count(0)

    # Add two highlights (page 0 and page 1)
    select_text_on_page(pr, 0)
    pr.get_by_role("button", name="Add to passage").click()
    expect(pr.locator(".passage-bar .count-at")).to_have_text("1 of 1")
    expect(pr.locator(".pdf-page .hl")).to_have_count(1)

    select_text_on_page(pr, 1)
    pr.get_by_role("button", name="Add to passage").click()
    expect(pr.locator(".passage-bar .count-at")).to_have_text("2 of 2")
    expect(pr.locator(".pdf-page .hl")).to_have_count(2)

    # Step Previous / Next
    pr.get_by_role("button", name="Previous highlight").click()
    expect(pr.locator(".passage-bar .count-at")).to_have_text("1 of 2")
    pr.get_by_role("button", name="Next highlight").click()
    expect(pr.locator(".passage-bar .count-at")).to_have_text("2 of 2")

    # Remove one highlight from the passage (leaves 1 in passage, both stay in the reading)
    pr.get_by_role("button", name="Remove from passage").click()
    expect(pr.locator(".passage-bar .count-at")).to_have_text("1 of 1")
    expect(pr.locator(".pdf-page .hl")).to_have_count(1)

    # Check 390px touch targets in PassageReader
    pr.set_viewport_size({"width": 390, "height": 844})
    for name in ["Previous highlight", "Next highlight", "Done"]:
        box = pr.get_by_role("button", name=name).bounding_box()
        assert box["width"] >= 44 and box["height"] >= 44, (name, box)

    # Open the reading normally and verify "Referenced in" shows in Notes and Popover
    pr_url = pr.url
    reading_id = re.search(r"id=([^&]+)", pr_url).group(1)
    pr.close()

    page.goto(f"{BASE}/?v=reader&id={reading_id}")
    page.wait_for_function("document.querySelectorAll('.pdf-page .hl').length === 2", timeout=20000)
    page.get_by_role("tab", name="Notes").click()
    expect(page.locator(".quote-referenced").first).to_contain_text("Referenced in")

    hl_box = page.locator(".pdf-page .hl").first.bounding_box()
    page.mouse.click(hl_box["x"] + hl_box["width"] / 2, hl_box["y"] + hl_box["height"] / 2)
    expect(page.locator(".highlight-referenced")).to_contain_text("Referenced in")

    # Check 390px magnifier touch target on essay page
    page.goto(BASE + "/")
    page.locator(".module-row, .module-card", has_text="HY320").first.click()
    page.locator(".course-materials .section-toggle").click()
    page.locator(".course-materials .assessment-card").first.click()
    page.set_viewport_size({"width": 390, "height": 844})
    page.get_by_role("tab", name="References").click()
    mag_mobile = page.locator(".essay-ws-ref-passage").first.bounding_box()
    assert mag_mobile["width"] >= 44 and mag_mobile["height"] >= 44, mag_mobile

    assert not errors, f"Page errors: {errors}"
    print("ok")
    browser.close()
