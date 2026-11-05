"""Working out what a reading is: its authors, year, title, source and pages.

Everything is worked out on this machine or from Crossref's free public
records. No language model is used. Five ways are tried, most trustworthy
first:

1. A DOI printed in the PDF, looked up with Crossref.
2. A structured cover sheet or header: JSTOR articles and books, CLA/LSE
   digitisation sheets, Taylor & Francis, Wilson Center, or FRUS.
2b. An ISBN printed in its front matter, looked up with Crossref, Open
   Library or Google Books, all free and needing no key. A whole book is
   tried this way first, since a DOI in its last pages is usually another
   work's, from its bibliography. A short PDF with a book's ISBN is read as a
   chapter of that book, titled from its own first page.
3. The title set largest on the first page, with the names beneath it. If
   Crossref has a work with that title, its full record is used.
4. The PDF's own title and author fields, when they look real.
5. Printed page numbers found in running heads and footers.

Authors come back in one standard form: "Surname, Given", with two authors
joined by "and" and longer lists by commas and a final "and". Full given names
are preserved (initials only when the source itself prints only initials).
"""
from __future__ import annotations

import logging
import re
from difflib import SequenceMatcher

import requests

log = logging.getLogger(__name__)

DOI = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>]+)", re.I)
ISBN = re.compile(r"\b(?:ISBN(?:-1[03])?:?\s*)?((?:97[89][-\s]?)?(?:\d[-\s]?){9}[\dX])\b", re.I)
JSTOR_URL = re.compile(r"https?://(?:www\.)?jstor\.org/stable/(\S+)", re.I)
YEAR = re.compile(r"\b(1[5-9]\d\d|20[0-4]\d)\b")
PAGES = re.compile(r"pp?\.\s*(\d+)\s*[-\u2013]\s*(\d+)")
DATE_FULL = re.compile(
    r"\b(\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b",
    re.I,
)
GENERIC_HEADINGS = re.compile(r"^(?:chapter|part|section)\s+\d+|^(?:introduction|conclusion|preface|foreword|epilogue|overview)$", re.I)


def initials(given: str) -> str:
    """Initials for given names; hyphenated names keep their hyphen."""
    parts = [p for p in re.split(r"[\s.]+", given or "") if p]
    out = []
    for part in parts:
        out.append("-".join(f"{piece[0].upper()}." for piece in part.split("-") if piece))
    return " ".join(out)


def clean_given(given: str) -> str:
    """Normalises whitespace and spacing after periods in given names."""
    if not given:
        return ""
    g = re.sub(r"\.([A-Za-z])", r". \1", given.strip())
    return re.sub(r"\s+", " ", g).strip()


def format_authors(authors: list[dict]) -> str | None:
    """Formats authors in 'Surname, Given' form, preserving full given names."""
    names = []
    for a in authors:
        family = (a.get("family") or "").strip()
        if not family:
            continue
        given = clean_given(a.get("given") or "")
        names.append(f"{family}, {given}" if given else family)
    if not names:
        return None
    if len(names) == 1:
        return names[0]
    return f"{', '.join(names[:-1])} and {names[-1]}"


def split_name(name: str) -> dict:
    """'Arthur Schlesinger, Jr.' or 'Schlesinger, Arthur' as family and given."""
    name = re.sub(r",?\s+(Jr|Sr|III|II)\.?$", "", name.strip())
    if "," in name:
        family, given = [p.strip() for p in name.split(",", 1)]
        return {"family": family, "given": given}
    parts = name.split()
    return {"family": parts[-1], "given": " ".join(parts[:-1])} if parts else {"family": "", "given": ""}


def clean_title(title: str) -> str:
    title = re.sub(r"\s+", " ", title or "").strip().strip(".")
    if title.isupper() and len(title) > 8:
        title = title.title()
    return title


def compress_pages(first: str, last: str) -> str:
    """433-458 becomes 433-58, as reading lists write page ranges."""
    first, last = first.strip(), last.strip()
    if len(first) == len(last) > 2 and first[:-2] == last[:-2]:
        return f"{first}-{last[-2:]}"
    return f"{first}-{last}"


HEADERS = {"User-Agent": "StudyLibrary/0.11 (personal course library)"}


def from_work(work: dict) -> dict | None:
    """A Crossref record in the standard form with Chicago reference fields."""
    year = None
    for key in ("published-print", "issued", "published-online"):
        parts = (work.get(key) or {}).get("date-parts") or [[None]]
        if parts[0] and parts[0][0]:
            year = parts[0][0]
            break

    wtype = work.get("type")
    work_kind = "article"
    if wtype in ("book-chapter", "book-section", "book-part"):
        work_kind = "chapter"
    elif wtype in ("book", "monograph", "edited-book"):
        work_kind = "book"

    container = (work.get("container-title") or [None])[0]
    volume = str(work.get("volume")) if work.get("volume") is not None else None
    issue = str(work.get("issue")) if work.get("issue") is not None else None
    source = container

    pages = work.get("page")
    if pages and "-" in pages:
        first, last = pages.split("-", 1)
        pages = compress_pages(first, last)

    title = clean_title((work.get("title") or [""])[0])
    if not title:
        return None

    raw_doi = work.get("DOI")
    doi = f"https://doi.org/{raw_doi}" if raw_doi else None

    publisher = work.get("publisher") or None
    editors = [{"family": e.get("family"), "given": e.get("given")} for e in work.get("editor") or []]
    editor = format_authors(editors)

    authors = [{"family": a.get("family"), "given": a.get("given")} for a in work.get("author") or []]

    return {
        "work_kind": work_kind,
        "author": format_authors(authors),
        "editor": editor,
        "year": year,
        "title": title,
        "source": source,
        "publisher": publisher,
        "volume": volume,
        "issue": issue,
        "pages": pages,
        "doc_date": None,
        "doi": doi,
    }


def from_crossref(doi: str) -> dict | None:
    clean_doi = doi.rstrip(".,;)]")
    try:
        response = requests.get(f"https://api.crossref.org/works/{clean_doi}", timeout=15, headers=HEADERS)
        if response.status_code != 200:
            return None
        return from_work(response.json()["message"])
    except (requests.RequestException, ValueError, KeyError):
        return None


def _plain(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", re.sub(r"\s+", " ", (text or "").lower())).strip()


def title_matches(found: str, wanted: str) -> bool:
    """Close enough to be the same work: near-identical, or the same main title before a colon."""
    a, b = _plain(found), _plain(wanted)
    if not a or not b:
        return False
    if SequenceMatcher(None, a, b).ratio() >= 0.92:
        return True
    head = _plain(found.split(":")[0])
    return len(head) > 20 and head == _plain(wanted.split(":")[0])


def search_crossref(title: str, author: str | None) -> dict | None:
    """Looks a title up in Crossref and keeps only a record whose title matches."""
    if not title or len(title) < 8 or GENERIC_HEADINGS.match(title):
        return None
    query = f"{title} {author or ''}".strip()
    try:
        response = requests.get(
            "https://api.crossref.org/works", timeout=15, headers=HEADERS,
            params={"query.bibliographic": query, "rows": 5},
        )
        if response.status_code != 200:
            return None
        items = response.json()["message"]["items"]
    except (requests.RequestException, ValueError, KeyError):
        return None
    for work in items:
        if work.get("type") == "book-review":
            continue
        work_title = (work.get("title") or [""])[0]
        if title_matches(work_title, title):
            return from_work(work)
    return None


# ISBNs, labelled or bare. Separators may be spaces, hyphens or the other
# dashes typesetters use, written here as escapes.
ISBN_LABELLED = re.compile(r"\bISBN(?:-?1[03])?[\s:.#]*([0-9][0-9Xx \-\u2010-\u2015]{8,22})", re.I)
ISBN_BARE = re.compile(r"(?<![0-9Xx])(97[89](?:[ \-\u2010-\u2015]?[0-9]){10})(?![0-9])")
# From this many pages a PDF with an ISBN is the whole book.
BOOK_PAGES = 60


def _isbn_digits(raw: str) -> str:
    return re.sub(r"[^0-9X]", "", raw.upper())


def valid_isbn13(digits: str) -> bool:
    return len(digits) == 13 and digits.isdigit() and sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(digits)) % 10 == 0


def valid_isbn10(digits: str) -> bool:
    if len(digits) != 10 or not digits[:9].isdigit() or not (digits[9].isdigit() or digits[9] == "X"):
        return False
    total = sum((10 - i) * int(d) for i, d in enumerate(digits[:9])) + (10 if digits[9] == "X" else int(digits[9]))
    return total % 11 == 0


def isbn13(digits10: str) -> str:
    """An ISBN-10 written as the ISBN-13 that catalogues search by."""
    core = "978" + digits10[:9]
    check = (10 - sum(int(d) * (1 if i % 2 == 0 else 3) for i, d in enumerate(core)) % 10) % 10
    return core + str(check)


def find_isbns(text: str) -> list[str]:
    """Every ISBN in the text as an ISBN-13, labelled ones first, each one
    checked by its check digit so a phone number or page count never counts."""
    found: list[str] = []

    def keep(raw: str) -> None:
        digits = _isbn_digits(raw)
        # A run beginning 978 or 979 is an ISBN-13 or nothing; any other is an ISBN-10.
        if digits.startswith(("978", "979")) and len(digits) >= 13:
            if not valid_isbn13(digits[:13]):
                return
            value = digits[:13]
        elif len(digits) >= 10 and valid_isbn10(digits[:10]):
            value = isbn13(digits[:10])
        else:
            return
        if value not in found:
            found.append(value)

    for match in ISBN_LABELLED.finditer(text or ""):
        keep(match.group(1))
    for match in ISBN_BARE.finditer(text or ""):
        keep(match.group(1))
    return found


def _year_of(value) -> int | None:
    match = YEAR.search(str(value or ""))
    return int(match.group(1)) if match else None


def _book(title: str, subtitle: str | None, names: list[str], publisher: str | None, year: int | None) -> dict | None:
    full = f"{title}: {subtitle}" if subtitle and subtitle.lower() not in (title or "").lower() else title
    full = clean_title(full or "")
    if not full:
        return None
    return {
        "work_kind": "book",
        "author": format_authors([split_name(n) for n in names if n]) if names else None,
        "editor": None,
        "year": year,
        "title": full,
        "source": None,
        "publisher": publisher or None,
        "volume": None,
        "issue": None,
        "pages": None,
        "doc_date": None,
        "doi": None,
    }


def isbn_from_crossref(isbn: str) -> dict | None:
    """Crossref holds most academic presses' books, with their DOIs."""
    try:
        response = requests.get(
            "https://api.crossref.org/works", timeout=15, headers=HEADERS,
            params={"filter": f"isbn:{isbn}", "rows": 5},
        )
        if response.status_code != 200:
            return None
        items = response.json()["message"]["items"]
    except (requests.RequestException, ValueError, KeyError):
        return None
    for work in items:
        # The same ISBN also finds the book's chapters; only the book counts.
        if work.get("type") in ("book", "monograph", "edited-book", "reference-book"):
            record = from_work(work)
            if record:
                record["work_kind"] = "book"
                return record
    return None


def isbn_from_open_library(isbn: str) -> dict | None:
    try:
        response = requests.get(
            "https://openlibrary.org/api/books", timeout=15, headers=HEADERS,
            params={"bibkeys": f"ISBN:{isbn}", "format": "json", "jscmd": "data"},
        )
        if response.status_code != 200:
            return None
        data = response.json().get(f"ISBN:{isbn}")
    except (requests.RequestException, ValueError, AttributeError):
        return None
    if not data:
        return None
    names = [a.get("name") for a in data.get("authors") or [] if isinstance(a, dict)]
    publishers = data.get("publishers") or []
    publisher = publishers[0].get("name") if publishers and isinstance(publishers[0], dict) else None
    return _book(data.get("title") or "", data.get("subtitle"), names, publisher, _year_of(data.get("publish_date")))


def isbn_from_google_books(isbn: str) -> dict | None:
    try:
        response = requests.get(
            "https://www.googleapis.com/books/v1/volumes", timeout=15, headers=HEADERS,
            params={"q": f"isbn:{isbn}"},
        )
        if response.status_code != 200:
            return None
        items = response.json().get("items") or []
    except (requests.RequestException, ValueError, AttributeError):
        return None
    for entry in items:
        info = entry.get("volumeInfo") or {}
        codes = {_isbn_digits(i.get("identifier", "")) for i in info.get("industryIdentifiers") or []}
        if codes and isbn not in codes and not any(len(c) == 10 and isbn13(c) == isbn for c in codes):
            continue
        return _book(info.get("title") or "", info.get("subtitle"), info.get("authors") or [], info.get("publisher"), _year_of(info.get("publishedDate")))
    return None


def lookup_isbn(isbn: str) -> dict | None:
    """A book's record from the first catalogue that knows its ISBN."""
    for look in (isbn_from_crossref, isbn_from_open_library, isbn_from_google_books):
        record = look(isbn)
        if record:
            return record
    return None


def _same_main_title(a: str, b: str) -> bool:
    return bool(a and b) and (title_matches(a, b) or title_matches(b, a) or _plain(a.split(":")[0]) == _plain(b.split(":")[0]))


def from_isbn(text: str, laid_out: dict | None, page_count: int | None) -> tuple[dict, str] | None:
    """A book's details from the ISBN printed in it. A short PDF carrying a
    book's ISBN is usually a chapter scanned from it, so its own title comes
    from its first page and the book becomes its source."""
    for isbn in find_isbns(text)[:3]:
        book = lookup_isbn(isbn)
        if not book:
            continue
        whole = (
            page_count is None or page_count >= BOOK_PAGES or not laid_out
            or _same_main_title(laid_out.get("title") or "", book["title"])
        )
        if whole:
            return book, "isbn"
        own_author = laid_out.get("author")
        editor = book.get("editor")
        if own_author and book.get("author") and own_author != book["author"]:
            editor = book["author"]
        return {
            **book,
            "work_kind": "chapter",
            "title": laid_out["title"],
            "author": own_author or book.get("author"),
            "editor": editor,
            "source": book["title"],
            "doi": None,
            "pages": laid_out.get("pages"),
        }, "isbn-chapter"
    return None


def from_jstor(text: str) -> dict | None:
    """Extracts citation from a JSTOR journal or book chapter cover sheet."""
    if re.search(r"Chapter Title:", text, re.I) or re.search(r"Book Title:", text, re.I):
        def _line(header: str) -> str | None:
            m = re.search(rf"(?:{header}):\s*([^\n]+)", text, re.I)
            return m.group(1).strip() if m else None

        ch_title = _line("Chapter Title")
        bk_title = _line("Book Title")
        author = _line(r"Chapter Author\(s\)") or _line(r"Author\(s\)")
        editor = _line(r"Book Editor\(s\)") or _line(r"Editor\(s\)")
        publisher = _line("Published by")
        url_match = JSTOR_URL.search(text)
        doi_match = DOI.search(text)
        pages_match = PAGES.search(text) or re.search(r"pp\.\s*(\d+)\s*[-\u2013]\s*(\d+)", text, re.I)
        year_match = re.search(r"(?:Published by|Copyright|©|\bDate:)\s*.*?(\d{4})", text, re.I)

        title = clean_title(ch_title or "")
        book = clean_title(bk_title or "")
        if not title and book:
            title, book = book, None

        authors = []
        if author:
            listed = re.sub(r",?\s+(Jr|Sr|III|II)\.?(?=,|\s+and\s|$)", "", author.strip())
            names = re.split(r",\s*(?=[A-Z])|\s+and\s+", listed)
            authors = [split_name(n) for n in names if n.strip()]

        editors = []
        if editor:
            listed_ed = re.sub(r",?\s+(Jr|Sr|III|II)\.?(?=,|\s+and\s|$)", "", editor.strip())
            ed_names = re.split(r",\s*(?=[A-Z])|\s+and\s+", listed_ed)
            editors = [split_name(n) for n in ed_names if n.strip()]

        pages = compress_pages(pages_match.group(1), pages_match.group(2)) if pages_match else None
        doi = None
        if url_match:
            doi = url_match.group(0).rstrip(".,;)]")
        elif doi_match:
            doi = f"https://doi.org/{doi_match.group(1).rstrip('.,;)]')}"

        if title:
            return {
                "work_kind": "chapter" if book else "book",
                "author": format_authors(authors),
                "editor": format_authors(editors),
                "year": int(year_match.group(1)) if year_match else None,
                "title": title,
                "source": book,
                "publisher": clean_title(publisher or "") or None,
                "volume": None,
                "issue": None,
                "pages": pages,
                "doc_date": None,
                "doi": doi,
            }

    match = re.search(r"Author\(s\):\s*(.+?)\n\s*Source:\s*(.+?)\n", text, re.S)
    if not match:
        return None
    before = text[: match.start()].strip().splitlines()
    title = clean_title(" ".join(line.strip() for line in before[-3:] if line.strip() and "jstor" not in line.lower()))
    listed = re.sub(r",?\s+(Jr|Sr|III|II)\.?(?=,|\s+and\s|$)", "", match.group(1).replace("\n", " ").strip())
    names = re.split(r",\s*(?=[A-Z])|\s+and\s+", listed)
    source_line = re.sub(r"\s+", " ", match.group(2))
    year = YEAR.search(source_line)
    pages = PAGES.search(source_line)
    vol_match = re.search(r"Vol\.\s*(\d+)", source_line, re.I)
    no_match = re.search(r"No\.\s*(\d+)", source_line, re.I)
    volume = vol_match.group(1) if vol_match else None
    issue = no_match.group(1) if no_match else None

    journal = re.sub(r",?\s*\(.*$", "", source_line).strip()
    journal = re.sub(r",?\s*Vol\.\s*\d+.*$", "", journal).strip().rstrip(",")
    url_match = JSTOR_URL.search(text)
    doi = url_match.group(0).rstrip(".,;)]") if url_match else None

    if not title:
        return None
    return {
        "work_kind": "article",
        "author": format_authors([split_name(n) for n in names if n.strip()]),
        "editor": None,
        "year": int(year.group(1)) if year else None,
        "title": title,
        "source": journal or None,
        "publisher": None,
        "volume": volume,
        "issue": issue,
        "pages": compress_pages(pages.group(1), pages.group(2)) if pages else None,
        "doc_date": None,
        "doi": doi,
    }


def from_cla(text: str) -> dict | None:
    """Extracts citation from an LSE or CLA digitisation extract cover sheet."""
    if not re.search(r"(?:extract title|title of extract|copyright licensing agency|higher education licence|course of study:)", text, re.I):
        return None

    def _field(names: list[str]) -> str | None:
        pattern = r"(?:%s):\s*([^\n]+)" % "|".join(names)
        m = re.search(pattern, text, re.I)
        return m.group(1).strip() if m else None

    ch_title = _field(["Extract title", "Title of extract", "Chapter title"])
    bk_title = _field(["Book title", "Title of book", "Title of publication"])
    author = _field(["Extract author", "Author of extract", "Author"])
    publisher = _field(["Publisher", "Name of publisher"])
    isbn = _field(["ISBN", "ISSN", "Online ISBN", "Print ISBN"])
    page_range = _field(["Page range", "Pages", "Page numbers"])
    year_str = _field(["Year of publication", "Date of publication", "Year", "Date"])

    title = clean_title(ch_title or "")
    source = clean_title(bk_title or "")
    if not title and source:
        title, source = source, None
    if not title:
        return None

    authors = []
    if author:
        names = re.split(r",\s*(?=[A-Z])|\s+and\s+|;\s*", author)
        authors = [split_name(n) for n in names if n.strip()]

    pages = None
    if page_range:
        pm = re.search(r"(\d+)\s*[-\u2013]\s*(\d+)", page_range)
        if pm:
            pages = compress_pages(pm.group(1), pm.group(2))
        else:
            pages = page_range

    year = None
    if year_str:
        ym = YEAR.search(year_str)
        if ym:
            year = int(ym.group(1))
    if year is None:
        ym = YEAR.search(text)
        if ym:
            year = int(ym.group(1))

    return {
        "work_kind": "chapter",
        "author": format_authors(authors),
        "editor": None,
        "year": year,
        "title": title,
        "source": source or None,
        "publisher": clean_title(publisher or "") or None,
        "volume": None,
        "issue": None,
        "pages": pages,
        "doc_date": None,
        "doi": isbn,
    }


def from_tandf(text: str) -> dict | None:
    """Extracts citation from a Taylor & Francis cover sheet ('To cite this article:')."""
    m = re.search(r"To cite this article:\s*([^\n]+)", text, re.I)
    if not m:
        return None
    cite = re.sub(r"\s+", " ", m.group(1)).strip()

    cm = re.search(
        r"^(.+?)\s*\((\d{4})\)\s*(.+?),\s*([A-Za-z\s&'-]+),\s*(\d+)(?::(\d+))?,\s*(?:pp\.\s*)?(\d+[-\u2013]\d+)",
        cite,
    )
    doi_match = re.search(r"(?:DOI:|https?://doi\.org/)\s*(10\.\S+)", text, re.I)
    doi = f"https://doi.org/{doi_match.group(1).rstrip('.,;)]')}" if doi_match else None

    if cm:
        raw_author, year, title, journal, vol, iss, raw_pages = cm.groups()
        names = re.split(r",\s*(?=[A-Z])|\s+and\s+", raw_author)
        first, last = re.split(r"[-\u2013]", raw_pages)
        return {
            "work_kind": "article",
            "author": format_authors([split_name(n) for n in names if n.strip()]),
            "editor": None,
            "year": int(year),
            "title": clean_title(title),
            "source": journal.strip(),
            "publisher": None,
            "volume": vol,
            "issue": iss or None,
            "pages": compress_pages(first, last),
            "doc_date": None,
            "doi": doi,
        }

    return None


def from_wilson(text: str) -> dict | None:
    """Extracts primary source metadata from a Wilson Center Digital Archive header."""
    if not re.search(r"(?:History and Public Policy Program|Woodrow Wilson|Wilson Center|Cold War International History)", text, re.I):
        return None

    date_match = DATE_FULL.search(text)
    doc_date = date_match.group(1) if date_match else None
    year = int(YEAR.search(doc_date).group(1)) if doc_date and YEAR.search(doc_date) else None

    title = None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for line in lines[:15]:
        if re.search(r"Digital Archive|Wilson|International History|Woodrow|Scholars", line, re.I):
            continue
        if len(line) > 10 and not re.search(r"https?://|www\.|page \d|document", line, re.I):
            title = clean_title(line)
            break

    if not title:
        return None

    return {
        "work_kind": "primary",
        "author": None,
        "editor": None,
        "year": year,
        "title": title,
        "source": "History and Public Policy Program Digital Archive, Woodrow Wilson International Center for Scholars",
        "publisher": None,
        "volume": None,
        "issue": None,
        "pages": None,
        "doc_date": doc_date,
        "doi": None,
    }


def from_frus(text: str) -> dict | None:
    """Extracts primary source metadata from a Foreign Relations of the United States header."""
    if not re.search(r"Foreign Relations of the United States", text, re.I):
        return None

    date_match = DATE_FULL.search(text)
    doc_date = date_match.group(1) if date_match else None
    year = int(YEAR.search(doc_date).group(1)) if doc_date and YEAR.search(doc_date) else None

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    title = None
    for line in lines[:15]:
        if "foreign relations of the united states" in line.lower():
            continue
        if len(line) > 10 and not re.search(r"https?://|www\.|office of the historian", line, re.I):
            title = clean_title(line)
            break

    if not title:
        return None

    return {
        "work_kind": "primary",
        "author": None,
        "editor": None,
        "year": year,
        "title": title,
        "source": "Foreign Relations of the United States, Office of the Historian, US Department of State",
        "publisher": None,
        "volume": None,
        "issue": None,
        "pages": None,
        "doc_date": doc_date,
        "doi": None,
    }


def extract_printed_pages(doc) -> str | None:
    """Extracts page numbers from running heads/footers across doc."""
    if not doc or len(doc) < 2:
        return None
    try:
        def _get_page_num(page) -> int | None:
            rect = page.rect
            h = rect.height or 1
            for word_tuple in page.get_text("words"):
                y0 = word_tuple[1]
                word = word_tuple[4]
                y_rel = y0 / h
                if (y_rel < 0.12 or y_rel > 0.88) and word.isdigit():
                    num = int(word)
                    if 1 <= num <= 9999:
                        return num
            return None

        p_start = _get_page_num(doc[0]) or _get_page_num(doc[1])
        p_end = _get_page_num(doc[-1])
        if p_start and p_end and p_start <= p_end and (p_end - p_start) < 500:
            return compress_pages(str(p_start), str(p_end))
    except Exception:
        pass
    return None


def first_page_lines(doc) -> list[tuple[float, str, float]]:
    """The first page's lines as (font size, text, distance down the page)."""
    if not len(doc):
        return []
    page = doc[0]
    height = page.rect.height or 1
    out = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            spans = [s for s in line.get("spans", []) if s.get("text", "").strip()]
            if not spans:
                continue
            text = " ".join(s["text"].strip() for s in spans)
            size = max(s.get("size", 0) for s in spans)
            out.append((round(size, 1), text, line["bbox"][1] / height))
    return out


NAME = re.compile(r"^(?:by\s+)?[A-Z][\w.'\u00C0-\u024F-]+(?:\s+[A-Z][\w.'\u00C0-\u024F-]*){1,3}(?:\s*(?:,|and|&)\s*[A-Z][\w.'\u00C0-\u024F-]+(?:\s+[A-Z][\w.'\u00C0-\u024F-]*){1,3})*$")


def from_layout(lines: list[tuple[float, str, float]], text: str) -> dict | None:
    """The title is the largest type in the top part of the first page; the
    names in the line or two beneath it are the authors."""
    if not lines:
        return None
    body = min(size for size, _, _ in lines) if len(lines) < 10 else sorted(size for size, _, _ in lines)[len(lines) // 2]
    top = [(i, l) for i, l in enumerate(lines) if l[2] < 0.6 and len(l[1]) > 3 and not re.search(r"https?://|www\.|doi|©|copyright", l[1], re.I)]
    if not top:
        return None
    largest = max(l[0] for _, l in top)
    if largest < body * 1.25:
        return None
    picked = [i for i, l in top if abs(l[0] - largest) < 0.6]
    first, last = picked[0], picked[0]
    while last + 1 < len(lines) and abs(lines[last + 1][0] - largest) < 0.6:
        last += 1
    title = clean_title(" ".join(lines[k][1] for k in range(first, last + 1)))

    if GENERIC_HEADINGS.match(title):
        if last + 1 < len(lines) and lines[last + 1][0] >= body * 1.15:
            sub = clean_title(lines[last + 1][1])
            title = f"{title}: {sub}"
            last += 1
        else:
            return None

    if len(title) < 8 or len(title) > 250:
        return None

    authors = []
    for size, line, _ in lines[last + 1:last + 4]:
        candidate = re.sub(r"[\d*\u2020\u2021]+$", "", line).strip()
        if size >= body * 0.9 and NAME.match(candidate) and len(candidate) < 90:
            names = re.split(r"\s*,\s*|\s+and\s+|\s*&\s*", re.sub(r"^by\s+", "", candidate, flags=re.I))
            authors = [split_name(n) for n in names if n.strip()]
            break

    return {
        "work_kind": "article",
        "author": format_authors(authors),
        "editor": None,
        "year": None,
        "title": title,
        "source": None,
        "publisher": None,
        "volume": None,
        "issue": None,
        "pages": None,
        "doc_date": None,
        "doi": None,
    }


def from_metadata(meta: dict) -> dict | None:
    title = clean_title(meta.get("title") or "")
    junk = re.compile(r"^(microsoft word|untitled|document\d*|scan|\d+$)|\.(docx?|pdf|indd)$", re.I)
    if not title or junk.search(title) or len(title) < 6:
        return None
    author = (meta.get("author") or "").strip()
    authors = [split_name(a) for a in re.split(r";|\s+and\s+|&", author) if a.strip()] if author else []
    return {
        "work_kind": "article",
        "author": format_authors(authors),
        "editor": None,
        "year": None,
        "title": title,
        "source": None,
        "publisher": None,
        "volume": None,
        "issue": None,
        "pages": None,
        "doc_date": None,
        "doi": None,
    }


def identify(text: str, meta: dict, lines: list | None = None, online: bool = True, doc=None,
             isbn_text: str | None = None) -> tuple[dict | None, str | None]:
    """Returns the citation found and how it was found. isbn_text is the
    front matter as well, where a book prints its ISBN."""
    page_count = len(doc) if doc is not None else None
    isbn_source = isbn_text or text
    # A whole book is named by its ISBN before anything else: a DOI in its
    # last pages is usually another work's, from its bibliography.
    if online and page_count is not None and page_count >= BOOK_PAGES:
        found_book = from_isbn(isbn_source, from_layout(lines or [], text), page_count)
        if found_book:
            return found_book

    doi = DOI.search(text)
    if doi and online:
        found = from_crossref(doi.group(1).rstrip(".,;)]"))
        if found:
            if not found.get("pages") and doc:
                found["pages"] = extract_printed_pages(doc)
            return found, "crossref"

    found = from_jstor(text)
    if found:
        if not found.get("pages") and doc:
            found["pages"] = extract_printed_pages(doc)
        return found, "jstor"

    found = from_cla(text)
    if found:
        if not found.get("pages") and doc:
            found["pages"] = extract_printed_pages(doc)
        return found, "cla"

    found = from_tandf(text)
    if found:
        if not found.get("pages") and doc:
            found["pages"] = extract_printed_pages(doc)
        return found, "tandf"

    found = from_wilson(text)
    if found:
        return found, "wilson"

    found = from_frus(text)
    if found:
        return found, "frus"

    laid_out = from_layout(lines or [], text)
    if online and (page_count is None or page_count < BOOK_PAGES):
        found_isbn = from_isbn(isbn_source, laid_out, page_count)
        if found_isbn:
            record, via = found_isbn
            if via == "isbn-chapter" and not record.get("pages") and doc:
                record["pages"] = extract_printed_pages(doc)
            return record, via

    if laid_out:
        if online:
            record = search_crossref(laid_out["title"], laid_out["author"])
            if record:
                if not record.get("pages") and doc:
                    record["pages"] = extract_printed_pages(doc)
                return record, "crossref-title"
        if not laid_out.get("pages") and doc:
            laid_out["pages"] = extract_printed_pages(doc)
        return laid_out, "layout"

    found = from_metadata(meta)
    if found:
        if online:
            record = search_crossref(found["title"], found["author"])
            if record:
                if not record.get("pages") and doc:
                    record["pages"] = extract_printed_pages(doc)
                return record, "crossref-title"
        if not found.get("pages") and doc:
            found["pages"] = extract_printed_pages(doc)
        return found, "metadata"

    return None, None
