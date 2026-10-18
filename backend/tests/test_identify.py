"""Finding a reading's citation from its first pages."""
from study.processor.identify import compress_pages, format_authors, from_jstor, from_metadata, identify

COVER = """The Origins of the Cold War
Author(s): Arthur Schlesinger, Jr.
Source: Foreign Affairs, Vol. 46, No. 1 (Oct., 1967), pp. 22-52
Published by: Council on Foreign Relations
Stable URL: https://www.jstor.org/stable/20039280
"""


def test_jstor_cover():
    found = from_jstor(COVER)
    assert found == {"author": "Schlesinger, A.", "year": 1967, "title": "The Origins of the Cold War",
                     "source": "Foreign Affairs 46 (1)", "pages": "22-52"}


def test_authors_take_one_form():
    assert format_authors([{"family": "Chen", "given": "Jian"}]) == "Chen, J."
    assert format_authors([{"family": "Leffler", "given": "Melvyn P."}, {"family": "Painter", "given": "David"}]) == "Leffler, M. P. and Painter, D."
    assert format_authors([{"family": "A", "given": "Bo"}, {"family": "C", "given": "Di"}, {"family": "E", "given": "Jean-Paul"}]) == "A, B., C, D. and E, J.-P."


def test_page_ranges_are_shortened_as_reading_lists_write_them():
    assert compress_pages("433", "458") == "433-58"
    assert compress_pages("99", "105") == "99-105"


def test_pdf_details_are_used_only_when_they_look_real():
    assert from_metadata({"title": "Microsoft Word - essay3.docx"}) is None
    assert from_metadata({"title": "The Global Cold War", "author": "Odd Arne Westad"})["author"] == "Westad, O. A."


def _article(tmp_path, header=True):
    import pymupdf
    doc = pymupdf.open()
    page = doc.new_page()
    if header:
        page.insert_text((60, 40), "Journal of Cold War Studies, Vol. 12, No. 3", fontsize=8)
    page.insert_text((60, 120), "The Sino-Soviet Split and the", fontsize=20)
    page.insert_text((60, 146), "Making of the Third World", fontsize=20)
    page.insert_text((60, 180), "Lorenz M. Luthi and Jeremy Friedman", fontsize=11)
    for i in range(25):
        page.insert_text((60, 220 + i * 14), f"Body text line {i} on the dispute between Moscow and Beijing in the 1960s.", fontsize=10)
    path = tmp_path / "a.pdf"
    doc.save(path)
    return pymupdf.open(path)


def test_title_and_authors_from_the_first_page(tmp_path):
    from study.processor.identify import first_page_lines, from_layout
    doc = _article(tmp_path)
    found = from_layout(first_page_lines(doc), "")
    assert found["title"] == "The Sino-Soviet Split and the Making of the Third World"
    assert found["author"] == "Luthi, L. M. and Friedman, J."


def test_order_of_trust(tmp_path):
    from study.processor.identify import first_page_lines
    found, via = identify(COVER, {"title": "Something else entirely"}, [], online=False)
    assert via == "jstor" and found["title"] == "The Origins of the Cold War"
    doc = _article(tmp_path)
    found, via = identify("no cover here", {}, first_page_lines(doc), online=False)
    assert via == "layout"
    found, via = identify("no cover here", {}, [], online=False)
    assert found is None and via is None


def test_crossref_records_are_only_used_when_the_title_matches():
    from study.processor.identify import from_work, title_matches
    assert title_matches("The Sino-Soviet Split: Cold War in the Communist World", "The Sino-Soviet Split")  is False
    assert title_matches("The Origins of the Cold War.", "The origins of the cold war")
    work = {"title": ["The Origins of the Cold War"], "author": [{"family": "Schlesinger", "given": "Arthur"}],
            "issued": {"date-parts": [[1967]]}, "container-title": ["Foreign Affairs"], "volume": "46", "issue": "1",
            "page": "22-52", "type": "journal-article"}
    assert from_work(work) == {"author": "Schlesinger, A.", "year": 1967, "title": "The Origins of the Cold War",
                               "source": "Foreign Affairs 46 (1)", "pages": "22-52"}
