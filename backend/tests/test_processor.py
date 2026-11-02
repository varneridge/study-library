import hashlib
import shutil

import pymupdf
import pytest

from study.api import stamp
from study.processor.__main__ import Processor
from study.processor.jobs import Context, convert, extract_text, ocr, thumb


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _text_pdf(path, pages=3):
    doc = pymupdf.open()
    for number in range(pages):
        doc.new_page().insert_text((72, 72), f"Page {number + 1}. The Concordat of 1801 restored the Church.")
    doc.save(path)


def _image_pdf(path, text=None):
    source = pymupdf.open()
    page = source.new_page()
    if text:
        page.insert_text((72, 100), text, fontsize=28)
    pix = page.get_pixmap(dpi=200)
    doc = pymupdf.open()
    image_page = doc.new_page(width=page.rect.width, height=page.rect.height)
    image_page.insert_image(image_page.rect, pixmap=pix)
    doc.save(path)


def _add(api, path, file_id, mime="application/pdf"):
    key = api.upload(str(path), _sha(path), mime)
    assert api.push([{"table": "files", "row": {
        "id": file_id, "sha256": _sha(path), "r2_key": key, "mime": mime, "bytes": path.stat().st_size,
        "original_name": path.name, "page_count": None, "text_status": "pending",
        "modified_at": stamp(), "deleted": False}}]) == []
    return key


def test_upload_is_stored_by_hash(api, tmp_path):
    pdf = tmp_path / "a.pdf"
    _text_pdf(pdf)
    key = api.upload(str(pdf), _sha(pdf), "application/pdf")
    assert key == f"files/{_sha(pdf)}.pdf"
    again = api._json("PUT", f"/api/files/{_sha(pdf)}", data=pdf.read_bytes(),
                      headers={"Content-Type": "application/pdf"})
    assert again["existed"] is True


def test_extract_text_marks_ready(api, tmp_path):
    pdf = tmp_path / "a.pdf"
    _text_pdf(pdf, pages=4)
    _add(api, pdf, "f1")
    job = api.claim()
    assert job["type"] == "extract_text"
    extract_text(Context(api=api), job)
    api.complete(job["id"])
    row = api.pull_all()["files"]["f1"]
    assert row["text_status"] == "ready" and row["page_count"] == 4
    assert row.get("thumb_key") is not None and row["thumb_key"].startswith("files/") and row["thumb_key"].endswith(".webp")


def test_thumb_backfill(api, tmp_path):
    pdf = tmp_path / "slides.pdf"
    _text_pdf(pdf, pages=2)
    _add(api, pdf, "f2")
    api._json("POST", "/api/processor/files/f2/thumb", json={"thumb_key": "files/dummy.webp"})
    assert api.pull_all()["files"]["f2"]["thumb_key"] == "files/dummy.webp"
    thumb(Context(api=api), {"payload": {"file_id": "f2"}})
    row = api.pull_all()["files"]["f2"]
    assert row.get("thumb_key") is not None and row["thumb_key"].startswith("files/") and row["thumb_key"].endswith(".webp")
    assert row["thumb_key"] != "files/dummy.webp"


def test_scan_goes_to_ocr(api, tmp_path):
    pdf = tmp_path / "scan.pdf"
    _image_pdf(pdf)
    _add(api, pdf, "f1")
    job = api.claim()
    extract_text(Context(api=api), job)
    api.complete(job["id"])
    assert api.pull_all()["files"]["f1"]["text_status"] == "ocr"
    assert api.claim()["type"] == "ocr"


def test_server_write_beats_a_fast_device_clock(api, tmp_path):
    pdf = tmp_path / "a.pdf"
    _text_pdf(pdf)
    _add(api, pdf, "f1")
    ahead = "2026-12-01T00:00:00.000Z"
    row = api.pull_all()["files"]["f1"]
    api.push([{"table": "files", "row": {**row, "modified_at": ahead}}])
    job = api.claim()
    extract_text(Context(api=api), job)
    after = api.pull_all()["files"]["f1"]
    assert after["text_status"] == "ready"


def test_failures_back_off_then_mark_the_file(api, tmp_path):
    api.push([{"table": "files", "row": {
        "id": "missing", "sha256": "b" * 64, "r2_key": "files/nothing.pdf", "mime": "application/pdf",
        "bytes": 1, "original_name": None, "page_count": None, "text_status": "pending",
        "modified_at": stamp(), "deleted": False}}])
    processor = Processor(api)
    assert processor.run_once() is True
    assert api.claim() is None


@pytest.mark.skipif(shutil.which("ocrmypdf") is None, reason="ocrmypdf not installed")
def test_ocr_end_to_end(api, tmp_path):
    pdf = tmp_path / "scan.pdf"
    _image_pdf(pdf, "Napoleon signed the Concordat")
    old_key = _add(api, pdf, "f1")
    # Read the text, find none, OCR, read again, then work out the citation.
    processed = Processor(api).drain()
    assert processed == 4
    row = api.pull_all()["files"]["f1"]
    assert row["text_status"] == "ready"
    assert row["r2_key"].endswith(".ocr.pdf")
    out = tmp_path / "out.pdf"
    api.download(row["r2_key"], str(out))
    with pymupdf.open(out) as doc:
        assert "Concordat" in doc[0].get_text()
    with pytest.raises(Exception):
        api.download(old_key, str(tmp_path / "gone.pdf"))


@pytest.mark.skipif(shutil.which("soffice") is None, reason="LibreOffice not installed")
def test_convert_end_to_end(api, tmp_path):
    docx = pytest.importorskip("docx")
    source = tmp_path / "slides.docx"
    document = docx.Document()
    document.add_paragraph("Lecture three slides on the origins of Chinese Communist foreign policy, 1921 to 1949.")
    document.save(source)
    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    _add(api, source, "f1", mime)
    api.push([{"table": "items", "row": {
        "id": "i1", "kind": "slides", "author": None, "title": "Lecture three", "source": None,
        "pages": None, "year": None, "doc_date": None, "file_id": "f1", "original_file_id": None,
        "tray_module_id": None, "zotero_key": None, "last_page": None, "read_status": "unread",
        "modified_at": stamp(), "deleted": False}}])

    # Convert, read the text, then look for the citation.
    assert Processor(api).drain() == 3
    state = api.pull_all()
    item = state["items"]["i1"]
    assert item["original_file_id"] == "f1"
    assert state["files"][item["file_id"]]["mime"] == "application/pdf"
    assert state["files"][item["file_id"]]["text_status"] == "ready"
    assert state["files"]["f1"]["text_status"] == "converted"


def test_convert_epub_end_to_end(api, tmp_path):
    import zipfile
    source = tmp_path / "book.epub"
    with zipfile.ZipFile(source, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>""")
        zf.writestr("OEBPS/content.opf", """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test EPUB</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="toc">
    <itemref idref="ch1"/>
  </spine>
</package>""")
        zf.writestr("OEBPS/toc.ncx", """<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="test-123"/></head>
  <docTitle><text>Test EPUB</text></docTitle>
  <navMap>
    <navPoint id="np-1" playOrder="1">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="ch1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>""")
        zf.writestr("OEBPS/ch1.xhtml", """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <h1>Chapter 1</h1>
  <p>To Sherlock Holmes she is always the woman of European history.</p>
</body>
</html>""")

    mime = "application/epub+zip"
    _add(api, source, "f_epub", mime)
    api.push([{"table": "items", "row": {
        "id": "i_epub", "kind": "secondary", "author": "Arthur Conan Doyle", "title": "A Scandal in Bohemia",
        "source": None, "pages": None, "year": 1891, "doc_date": None, "file_id": "f_epub",
        "original_file_id": None, "tray_module_id": None, "zotero_key": None, "last_page": None,
        "read_status": "unread", "modified_at": stamp(), "deleted": False}}])

    # Convert, extract text, and check details.
    assert Processor(api).drain() >= 2
    state = api.pull_all()
    item = state["items"]["i_epub"]
    assert item["original_file_id"] == "f_epub"
    assert state["files"][item["file_id"]]["mime"] == "application/pdf"
    assert state["files"][item["file_id"]]["text_status"] == "ready"
    assert state["files"]["f_epub"]["text_status"] == "converted"
