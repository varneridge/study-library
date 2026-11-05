"""Covers cropped to their print: a book cover or scanned page in a wide white
border is drawn as its print with a thin margin, a speck of dust does not stop
the crop, and slides and blank pages are drawn whole. These need no Worker."""

import pytest

pymupdf = pytest.importorskip("pymupdf")
Image = pytest.importorskip("PIL.Image")

from study.processor.jobs import print_box, render_slide_thumbnail  # noqa: E402


def make_doc(width, height, boxes):
    doc = pymupdf.open()
    page = doc.new_page(width=width, height=height)
    for box in boxes:
        page.draw_rect(pymupdf.Rect(*box), color=(0, 0, 0), fill=(0.1, 0.1, 0.1))
    return doc


def thumbnail(tmp_path, doc):
    out = tmp_path / "thumb.webp"
    assert render_slide_thumbnail(doc, str(out))
    return Image.open(out).convert("L")


def test_a_cover_in_a_white_border_is_cropped_to_its_print(tmp_path):
    # Print from x 150 to 450 and y 120 to 700 on a 600 by 900 page.
    doc = make_doc(600, 900, [(200, 120, 400, 160), (150, 220, 450, 700)])
    img = thumbnail(tmp_path, doc)
    w, h = img.size
    assert w / h < 0.6, img.size
    box = print_box(img)
    assert box is not None
    assert box[0] <= w * 0.06 and box[2] >= w * 0.94, (box, img.size)
    assert box[1] <= h * 0.06 and box[3] >= h * 0.94, (box, img.size)


def test_a_speck_of_dust_does_not_hold_the_margin(tmp_path):
    doc = make_doc(600, 900, [(150, 120, 450, 700), (20, 20, 26, 26)])
    img = thumbnail(tmp_path, doc)
    w, h = img.size
    assert w / h < 0.6, img.size


def test_a_landscape_slide_is_drawn_whole(tmp_path):
    doc = make_doc(960, 540, [(400, 200, 560, 340)])
    img = thumbnail(tmp_path, doc)
    w, h = img.size
    assert abs(w / h - 960 / 540) < 0.02, img.size


def test_a_blank_page_is_drawn_whole(tmp_path):
    doc = make_doc(600, 900, [])
    img = thumbnail(tmp_path, doc)
    w, h = img.size
    assert abs(w / h - 600 / 900) < 0.02, img.size


def test_print_box_ignores_a_page_with_nothing_on_it():
    blank = Image.new("L", (200, 300), 255)
    assert print_box(blank) is None
