"""Working out what a reading is: its authors, year, title, source and pages.

Everything is worked out on this machine or from Crossref's free public
records. No language model is used. Five ways are tried, most trustworthy
first:

1. A DOI printed in the PDF, looked up with Crossref.
2. A structured cover sheet or header: JSTOR articles and books, CLA/LSE
   digitisation sheets, Taylor & Francis, Wilson Center, or FRUS.
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
        r"^(.+?)\s*\((\d{4})\)\s*(.+?),\s*([A-Za-z\s&'-]+),\s*(\d+)(?::(\d+))?,\s*(?:pp\.\s*)?(\d+[-–]\d+)",
        cite,
    )
    doi_match = re.search(r"(?:DOI:|https?://doi\.org/)\s*(10\.\S+)", text, re.I)
    doi = f"https://doi.org/{doi_match.group(1).rstrip('.,;)]')}" if doi_match else None

    if cm:
        raw_author, year, title, journal, vol, iss, raw_pages = cm.groups()
        names = re.split(r",\s*(?=[A-Z])|\s+and\s+", raw_author)
        first, last = re.split(r"[-–]", raw_pages)
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


def identify(text: str, meta: dict, lines: list | None = None, online: bool = True, doc=None) -> tuple[dict | None, str | None]:
    """Returns the citation found and how it was found."""
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
