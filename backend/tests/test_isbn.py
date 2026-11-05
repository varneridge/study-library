"""Books named from the ISBN printed in them: ISBNs found and checked, the
catalogues read, a whole book preferring its ISBN to a stray DOI, and a short
PDF with a book's ISBN read as a chapter of it. No network is used: the
catalogues' answers are stood in for."""

from study.processor import identify as finder
from study.processor.identify import find_isbns, identify, isbn13, lookup_isbn, valid_isbn10, valid_isbn13

BOOK = "9780198784562"


class Answer:
    def __init__(self, data, status=200):
        self.status_code = status
        self._data = data

    def json(self):
        return self._data


def catalogues(monkeypatch, crossref=None, open_library=None, google=None, seen=None):
    def get(url, params=None, timeout=None, headers=None):
        if seen is not None:
            seen.append(url)
        if url == "https://api.crossref.org/works" and "filter" in (params or {}):
            return Answer({"message": {"items": crossref or []}})
        if url.startswith("https://api.crossref.org/works/"):
            return Answer({"message": {"type": "journal-article", "title": ["A different article"], "author": [{"family": "Other", "given": "A."}]}})
        if url == "https://openlibrary.org/api/books":
            return Answer(open_library or {})
        if url == "https://www.googleapis.com/books/v1/volumes":
            return Answer(google or {})
        return Answer({}, 404)
    monkeypatch.setattr(finder.requests, "get", get)


class Pages:
    """Stands in for a PDF of a given length."""
    def __init__(self, count):
        self.count = count

    def __len__(self):
        return self.count


def test_isbns_are_found_checked_and_written_as_isbn_13():
    text = "Printed in Great Britain. ISBN 978-0-19-878456-2 (hbk). ISBN 0-19-285296-5 (pbk). Tel 978 123 456 7890"
    assert find_isbns(text) == [BOOK, isbn13("0192852965")]
    assert valid_isbn13(BOOK) and valid_isbn10("0192852965") and valid_isbn10("080442957X")
    assert not valid_isbn13("9780198784563")
    assert find_isbns("ISBN 978-0-19-878456-3") == []
    assert find_isbns("9791040001232") == ["9791040001232"]


def test_a_book_record_from_open_library(monkeypatch):
    catalogues(monkeypatch, open_library={f"ISBN:{BOOK}": {
        "title": "The Global Cold War", "subtitle": "Third World Interventions and the Making of Our Times",
        "authors": [{"name": "Odd Arne Westad"}], "publishers": [{"name": "Cambridge University Press"}],
        "publish_date": "2005",
    }})
    record = lookup_isbn(BOOK)
    assert record["work_kind"] == "book"
    assert record["title"].startswith("The Global Cold War: Third World Interventions")
    assert record["author"].startswith("Westad")
    assert record["publisher"] == "Cambridge University Press" and record["year"] == 2005


def test_google_books_is_tried_last(monkeypatch):
    catalogues(monkeypatch, google={"items": [{"volumeInfo": {
        "title": "Mao's China and the Cold War", "authors": ["Chen Jian"], "publisher": "University of North Carolina Press",
        "publishedDate": "2001-03-01", "industryIdentifiers": [{"type": "ISBN_13", "identifier": BOOK}],
    }}]})
    record = lookup_isbn(BOOK)
    assert record["title"] == "Mao's China and the Cold War" and record["year"] == 2001


def test_a_whole_book_prefers_its_isbn_to_a_doi_in_its_bibliography(monkeypatch):
    seen = []
    catalogues(monkeypatch, seen=seen, crossref=[{
        "type": "monograph", "title": ["Restless Empire"], "author": [{"family": "Westad", "given": "Odd Arne"}],
        "publisher": "Basic Books", "issued": {"date-parts": [[2012]]}, "DOI": "10.1000/restless",
    }])
    text = "Restless Empire\n... Bibliography ... https://doi.org/10.1080/0000000.2001.123456"
    found, via = identify(text, {}, [], online=True, doc=Pages(400), isbn_text=text + "\nISBN 978-0-19-878456-2")
    assert via == "isbn", (found, via)
    assert found["title"] == "Restless Empire" and found["work_kind"] == "book"
    assert not any(url.startswith("https://api.crossref.org/works/10.") for url in seen)


def test_a_short_pdf_with_a_books_isbn_is_a_chapter_of_it(monkeypatch):
    catalogues(monkeypatch, crossref=[{
        "type": "edited-book", "title": ["The Cambridge History of the Cold War"],
        "editor": [{"family": "Leffler", "given": "Melvyn P."}, {"family": "Westad", "given": "Odd Arne"}],
        "publisher": "Cambridge University Press", "issued": {"date-parts": [[2010]]},
    }])
    monkeypatch.setattr(finder, "from_layout", lambda lines, text: {
        "title": "The Emergence of an American Grand Strategy", "author": "Leffler, Melvyn P.", "pages": "67-89",
    })
    found, via = identify("ISBN 978-0-19-878456-2", {}, [], online=True, doc=Pages(23))
    assert via == "isbn-chapter", (found, via)
    assert found["work_kind"] == "chapter"
    assert found["title"] == "The Emergence of an American Grand Strategy"
    assert found["source"] == "The Cambridge History of the Cold War"
    assert found["author"] == "Leffler, Melvyn P." and found["editor"]
    assert found["pages"] == "67-89" and found["year"] == 2010


def test_nothing_is_looked_up_offline(monkeypatch):
    seen = []
    catalogues(monkeypatch, seen=seen)
    identify("ISBN 978-0-19-878456-2", {}, [], online=False, doc=Pages(300))
    assert seen == []
