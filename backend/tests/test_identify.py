"""Finding a reading's citation from its first pages."""
from study.processor.identify import (
    compress_pages,
    extract_printed_pages,
    format_authors,
    from_cla,
    from_frus,
    from_jstor,
    from_metadata,
    from_tandf,
    from_wilson,
    identify,
)

COVER = """The Origins of the Cold War
Author(s): Arthur Schlesinger, Jr.
Source: Foreign Affairs, Vol. 46, No. 1 (Oct., 1967), pp. 22-52
Published by: Council on Foreign Relations
Stable URL: https://www.jstor.org/stable/20039280
"""

JSTOR_BOOK = """Chapter Title: China Rejoining the World and Its Fictional Sovereignty, 1912–1949
Chapter Author(s): M. A. Carrai
Book Title: Sovereignty in China
Published by: Cambridge University Press
Stable URL: https://www.jstor.org/stable/j.ctv6zdbwg.7
pp. 109-151
"""

CLA_SHEET = """Course of study: HY335
Title of extract: Constructing a History of CCP Foreign Relations
Title of book: The Genesis of Chinese Communist Foreign Policy
Author of extract: M. H. Hunt
Name of publisher: Columbia University
Page range: 232-250
Date of publication: 1996
ISBN: 9780231103114
"""

TANDF_COVER = """To cite this article: Shu Guang Zhang (2007) Constructing ‘Peaceful Coexistence’: China's Diplomacy toward the Geneva and Bandung Conferences, 1954–55, Cold War History, 7:4, 509-528, DOI: 10.1080/14682740701621846
To link to this article: https://doi.org/10.1080/14682740701621846
"""

WILSON_HEADER = """History and Public Policy Program Digital Archive
Woodrow Wilson International Center for Scholars
On the Question of the Differentiation of the Three Worlds
February 22, 1974
"""

FRUS_HEADER = """Foreign Relations of the United States, 1944, China
Office of the Historian, US Department of State
Decision of the Chinese Communists to Use Chinese Name in Foreign Publicity
September 18, 1944
"""


def test_jstor_cover():
    found = from_jstor(COVER)
    assert found == {
        "work_kind": "article",
        "author": "Schlesinger, Arthur",
        "editor": None,
        "year": 1967,
        "title": "The Origins of the Cold War",
        "source": "Foreign Affairs",
        "publisher": None,
        "volume": "46",
        "issue": "1",
        "pages": "22-52",
        "doc_date": None,
        "doi": "https://www.jstor.org/stable/20039280",
    }


def test_jstor_book_chapter():
    found = from_jstor(JSTOR_BOOK)
    assert found == {
        "work_kind": "chapter",
        "author": "Carrai, M. A.",
        "editor": None,
        "year": None,
        "title": "China Rejoining the World and Its Fictional Sovereignty, 1912–1949",
        "source": "Sovereignty in China",
        "publisher": "Cambridge University Press",
        "volume": None,
        "issue": None,
        "pages": "109-51",
        "doc_date": None,
        "doi": "https://www.jstor.org/stable/j.ctv6zdbwg.7",
    }


def test_cla_digitisation_sheet():
    found = from_cla(CLA_SHEET)
    assert found == {
        "work_kind": "chapter",
        "author": "Hunt, M. H.",
        "editor": None,
        "year": 1996,
        "title": "Constructing a History of CCP Foreign Relations",
        "source": "The Genesis of Chinese Communist Foreign Policy",
        "publisher": "Columbia University",
        "volume": None,
        "issue": None,
        "pages": "232-50",
        "doc_date": None,
        "doi": "9780231103114",
    }


def test_tandf_cover():
    found = from_tandf(TANDF_COVER)
    assert found == {
        "work_kind": "article",
        "author": "Zhang, Shu Guang",
        "editor": None,
        "year": 2007,
        "title": "Constructing ‘Peaceful Coexistence’: China's Diplomacy toward the Geneva and Bandung Conferences, 1954–55",
        "source": "Cold War History",
        "publisher": None,
        "volume": "7",
        "issue": "4",
        "pages": "509-28",
        "doc_date": None,
        "doi": "https://doi.org/10.1080/14682740701621846",
    }


def test_wilson_and_frus_primary_headers():
    wilson = from_wilson(WILSON_HEADER)
    assert wilson["work_kind"] == "primary"
    assert wilson["title"] == "On the Question of the Differentiation of the Three Worlds"
    assert wilson["doc_date"] == "February 22, 1974"
    assert "Woodrow Wilson" in wilson["source"]

    frus = from_frus(FRUS_HEADER)
    assert frus["work_kind"] == "primary"
    assert frus["title"] == "Decision of the Chinese Communists to Use Chinese Name in Foreign Publicity"
    assert frus["doc_date"] == "September 18, 1944"
    assert "Foreign Relations of the United States" in frus["source"]


def test_authors_take_one_form():
    assert format_authors([{"family": "Chen", "given": "Jian"}]) == "Chen, Jian"
    assert format_authors([{"family": "Leffler", "given": "Melvyn P."}, {"family": "Painter", "given": "David"}]) == "Leffler, Melvyn P. and Painter, David"
    assert format_authors([{"family": "A", "given": "Bo"}, {"family": "C", "given": "Di"}, {"family": "E", "given": "Jean-Paul"}]) == "A, Bo, C, Di and E, Jean-Paul"
    assert format_authors([{"family": "Westad", "given": "O. A."}]) == "Westad, O. A."


def test_page_ranges_are_shortened_as_reading_lists_write_them():
    assert compress_pages("433", "458") == "433-58"
    assert compress_pages("99", "105") == "99-105"


def test_pdf_details_are_used_only_when_they_look_real():
    assert from_metadata({"title": "Microsoft Word - essay3.docx"}) is None
    assert from_metadata({"title": "The Global Cold War", "author": "Odd Arne Westad"})["author"] == "Westad, Odd Arne"


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
    assert found["author"] == "Luthi, Lorenz M. and Friedman, Jeremy"


def test_order_of_trust(tmp_path):
    from study.processor.identify import first_page_lines
    found, via = identify(COVER, {"title": "Something else entirely"}, [], online=False)
    assert via == "jstor" and found["title"] == "The Origins of the Cold War"
    doc = _article(tmp_path)
    found, via = identify("no cover here", {}, first_page_lines(doc), online=False)
    assert via == "layout"
    found, via = identify("no cover here", {}, [], online=False)
    assert found is None and via is None


def test_generic_headings_are_guarded():
    from study.processor.identify import from_layout
    lines = [(24.0, "CHAPTER 1", 0.1), (10.0, "Some body text", 0.3)]
    assert from_layout(lines, "") is None
    lines_with_sub = [(24.0, "CHAPTER 1", 0.1), (20.0, "The Opening Moves", 0.15), (10.0, "Some body text", 0.3)]
    found = from_layout(lines_with_sub, "")
    assert found["title"] == "Chapter 1: The Opening Moves"


def test_printed_pages_extraction(tmp_path):
    import pymupdf
    doc = pymupdf.open()
    p1 = doc.new_page()
    p1.insert_text((300, 30), "433", fontsize=9)
    p1.insert_text((60, 200), "Body text page 1", fontsize=11)
    p2 = doc.new_page()
    p2.insert_text((300, 30), "458", fontsize=9)
    p2.insert_text((60, 200), "Body text page 2", fontsize=11)
    assert extract_printed_pages(doc) == "433-58"


def test_crossref_records_are_only_used_when_the_title_matches():
    from study.processor.identify import from_work, title_matches
    assert title_matches("The Sino-Soviet Split: Cold War in the Communist World", "The Sino-Soviet Split") is False
    assert title_matches("The Origins of the Cold War.", "The origins of the cold war")
    work = {
        "title": ["The Origins of the Cold War"],
        "author": [{"family": "Schlesinger", "given": "Arthur"}],
        "issued": {"date-parts": [[1967]]},
        "container-title": ["Foreign Affairs"],
        "volume": "46",
        "issue": "1",
        "page": "22-52",
        "type": "journal-article",
    }
    assert from_work(work) == {
        "work_kind": "article",
        "author": "Schlesinger, Arthur",
        "editor": None,
        "year": 1967,
        "title": "The Origins of the Cold War",
        "source": "Foreign Affairs",
        "publisher": None,
        "volume": "46",
        "issue": "1",
        "pages": "22-52",
        "doc_date": None,
        "doi": None,
    }
