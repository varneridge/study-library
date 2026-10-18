"""OCR in 0.27: more languages, pages turned upright and straightened,
two-page book spreads split, and garbled text layers read again. Every scan
here is an image with no text, as a library scanner or a phone makes."""
import hashlib

import pymupdf
from PIL import Image, ImageDraw, ImageFont

from study.api import stamp
from study.processor.__main__ import Processor
from study.processor.jobs import garbled, ocr_languages, split_spreads

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"


def _font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default()


def _page_image(lines, size=(1240, 1754), rotate=0, skew=0.0):
    """A white page with lines of text, as a 150 dpi scan would be."""
    image = Image.new("L", size, 255)
    draw = ImageDraw.Draw(image)
    y = 160
    for line in lines:
        draw.text((120, y), line, fill=0, font=_font(40))
        y += 70
    if skew:
        image = image.rotate(skew, expand=False, fillcolor=255)
    if rotate:
        image = image.rotate(rotate, expand=True, fillcolor=255)
    return image


def _scan_pdf(path, images):
    """A PDF of page images with no text layer at all."""
    doc = pymupdf.open()
    for image in images:
        tmp = path.with_suffix(f".{len(doc)}.png")
        image.save(tmp)
        rect = pymupdf.Rect(0, 0, image.width * 72 / 150, image.height * 72 / 150)
        page = doc.new_page(width=rect.width, height=rect.height)
        page.insert_image(rect, filename=str(tmp))
    doc.save(path)


def _spread(left_lines, right_lines):
    left, right = _page_image(left_lines), _page_image(right_lines)
    spread = Image.new("L", (left.width * 2 + 80, left.height), 255)
    spread.paste(left, (0, 0))
    spread.paste(right, (left.width + 80, 0))
    return spread


def _add(api, path, file_id):
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    key = api.upload(str(path), sha, "application/pdf")
    assert api.push([{"table": "files", "row": {
        "id": file_id, "sha256": sha, "r2_key": key, "mime": "application/pdf", "bytes": path.stat().st_size,
        "original_name": path.name, "page_count": None, "text_status": "pending",
        "modified_at": stamp(), "deleted": False}}]) == []


def test_languages_are_those_installed():
    assert ocr_languages("eng+fra+deu") == "eng+fra+deu"
    assert ocr_languages("eng+xx") == "eng"
    assert ocr_languages("xx") == "eng"


def test_garbled_text_is_told_apart_from_prose():
    prose = ["The Concordat of 1801 restored the Church in France, but on terms the First Consul set. " * 12]
    rubbish = ["Tlie C0nc0rdat 0f l80l r3st0r3d tbe Cbnrcb ~~ ,,, iii ll1l 3e4t ^^ %% {} ;; lI| " * 20]
    assert not garbled(prose)
    assert garbled(rubbish)
    assert not garbled(["Too short to judge."])


def test_a_spread_is_found_and_split(tmp_path):
    path = tmp_path / "spread.pdf"
    _scan_pdf(path, [_spread(["Left page of the chapter."] * 8, ["Right page of the chapter."] * 8)])
    out = tmp_path / "halves.pdf"
    assert split_spreads(str(path), str(out)) == 1
    with pymupdf.open(out) as doc:
        assert len(doc) == 2
        assert all(page.rect.height > page.rect.width for page in doc)
    # An ordinary page is left alone, and nothing is written.
    single = tmp_path / "single.pdf"
    _scan_pdf(single, [_page_image(["One ordinary page."] * 8)])
    assert split_spreads(str(single), str(tmp_path / "unused.pdf")) == 0
    assert not (tmp_path / "unused.pdf").exists()


def test_ocr_splits_turns_and_reads_french(api, tmp_path):
    path = tmp_path / "scan.pdf"
    _scan_pdf(path, [
        _spread(["Napoleon crossed the Alps in May."] * 6, ["The Consulate built the prefects."] * 6),
        # Photographed sideways, and a little crooked.
        _page_image(["The Concordat restored the Church."] * 6, rotate=90, skew=2.5),
        _page_image(["Le Concordat fut signé en été."] * 6),
    ])
    _add(api, path, "f1")
    Processor(api).drain()
    row = api.pull_all()["files"]["f1"]
    assert row["text_status"] == "ready"
    # The spread became two pages: four in all.
    assert row["page_count"] == 4
    found = api._json("GET", "/api/search", params={"q": "prefects"})
    assert found["pages"], found
    turned = api._json("GET", "/api/search", params={"q": "Concordat restored"})
    assert turned["pages"], turned
    french = api._json("GET", "/api/search", params={"q": "signé"})
    assert french["pages"], french


def test_a_garbled_layer_is_read_again(api, tmp_path):
    # A scan whose text layer is rubbish, as a poor scanner's OCR leaves it.
    path = tmp_path / "bad.pdf"
    _scan_pdf(path, [_page_image(["The prefects answered to Paris."] * 8)])
    with pymupdf.open(path) as doc:
        for page in doc:
            # Invisible, as a scanner's text layer is, and many lines of it.
            for row in range(60):
                page.insert_text((20, 20 + row * 9), "Tlie pr3f3cts ~~ ll1l 3e4t ^^ %% {} ;; lI| 0f0f", fontsize=6, render_mode=3)
        doc.save(tmp_path / "bad2.pdf")
    _add(api, tmp_path / "bad2.pdf", "f2")
    Processor(api).drain()
    assert api.pull_all()["files"]["f2"]["text_status"] == "ready"
    found = api._json("GET", "/api/search", params={"q": "prefects answered"})
    assert found["pages"], found


def _reading_for(file_id, item_id):
    return {"table": "items", "row": {
        "id": item_id, "kind": "secondary", "author": None, "title": "Scan", "source": None,
        "pages": None, "year": None, "doc_date": None, "file_id": file_id, "original_file_id": None,
        "tray_module_id": None, "zotero_key": None, "last_page": None, "read_status": "unread",
        "modified_at": stamp(), "deleted": False}}


def _highlight(item_id):
    return {"table": "highlights", "row": {
        "id": f"h-{item_id}", "item_id": item_id, "page": 0, "rects": [[72.0, 700.0, 300.0, 712.0]],
        "body": "a passage", "colour": "#ffd400", "comment": None, "question_id": None,
        "zotero_key": None, "modified_at": stamp(), "deleted": False}}


def _ocr_once_without_splitting(api, monkeypatch, file_id):
    """OCR a scan as an older processor did: no spread splitting."""
    from study.processor import jobs
    monkeypatch.setattr(jobs, "SPLIT_SPREADS", False)
    Processor(api).drain()
    monkeypatch.setattr(jobs, "SPLIT_SPREADS", True)
    row = api.pull_all()["files"][file_id]
    assert row["r2_key"].endswith(".ocr.pdf") and row["page_count"] == 1, row
    return row


def test_a_rescan_rebuilds_a_scan_with_no_highlights(api, tmp_path, monkeypatch):
    path = tmp_path / "spread.pdf"
    _scan_pdf(path, [_spread(["Napoleon crossed the Alps in May."] * 6, ["The Consulate built the prefects."] * 6)])
    _add(api, path, "f1")
    api.push([_reading_for("f1", "i1")])
    _ocr_once_without_splitting(api, monkeypatch, "f1")
    assert api.rescan() == 1
    # Already waiting: a second rescan queues nothing more.
    assert api.rescan() == 0
    Processor(api).drain()
    row = api.pull_all()["files"]["f1"]
    # Rebuilt from its page images: the spread is now two pages.
    assert row["text_status"] == "ready" and row["page_count"] == 2, row


def test_a_rescan_rebuilds_a_scan_with_highlights_too(api, tmp_path, monkeypatch):
    path = tmp_path / "spread.pdf"
    _scan_pdf(path, [_spread(["Le Concordat fut signé en été."] * 6, ["The Consulate built the prefects."] * 6)])
    _add(api, path, "f2")
    api.push([_reading_for("f2", "i2"), _highlight("i2")])
    _ocr_once_without_splitting(api, monkeypatch, "f2")
    assert api.rescan() == 1
    Processor(api).drain()
    row = api.pull_all()["files"]["f2"]
    # Rebuilt as any other scan: split, and its French read.
    assert row["text_status"] == "ready" and row["page_count"] == 2, row
    assert api._json("GET", "/api/search", params={"q": "signé"})["pages"]


def test_a_rescan_leaves_good_text_alone(api, tmp_path):
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_textbox(pymupdf.Rect(72, 72, 520, 760), "The prefects answered to Paris, and the Concordat bound the Church to the state. " * 30, fontsize=11)
    path = tmp_path / "digital.pdf"
    doc.save(path)
    _add(api, path, "f3")
    api.push([_reading_for("f3", "i3")])
    Processor(api).drain()
    before = api.pull_all()["files"]["f3"]["r2_key"]
    assert api.rescan() == 1
    Processor(api).drain()
    row = api.pull_all()["files"]["f3"]
    # Checked, found fine, and not OCR'd.
    assert row["r2_key"] == before and not row["r2_key"].endswith(".ocr.pdf"), row
