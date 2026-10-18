"""Working out what a reading is: its authors, year, title, source and pages.

Everything is worked out on this machine or from Crossref's free public
records. No language model is used. Four ways are tried, most trustworthy
first:

1. A DOI printed in the PDF, looked up with Crossref.
2. A JSTOR cover page, which states the citation in fixed lines.
3. The title set largest on the first page, with the names beneath it. If
   Crossref has a work with that title, its full record is used.
4. The PDF's own title and author fields, when they look real.

Authors come back in one standard form: "Surname, I. J.", with two authors
joined by "and" and longer lists by commas and a final "and".
"""
from __future__ import annotations

import logging
import re
from difflib import SequenceMatcher

import requests

log = logging.getLogger(__name__)

DOI = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>]+)", re.I)
YEAR = re.compile(r"\b(1[5-9]\d\d|20[0-4]\d)\b")
PAGES = re.compile(r"pp?\.\s*(\d+)\s*[-\u2013]\s*(\d+)")

def initials(given: str) -> str:
    parts = [p for p in re.split(r"[\s.]+", given or "") if p]
    out = []
    for part in parts:
        # Hyphenated given names keep their hyphen: Jean-Paul becomes J.-P.
        out.append("-".join(f"{piece[0].upper()}." for piece in part.split("-") if piece))
    return " ".join(out)


def format_authors(authors: list[dict]) -> str | None:
    names = []
    for a in authors:
        family = (a.get("family") or "").strip()
        if not family:
            continue
        given = initials(a.get("given") or "")
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
    # Shouting titles from some cover pages become title case.
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
    """A Crossref record in the standard form."""
    year = None
    for key in ("published-print", "issued", "published-online"):
        parts = (work.get(key) or {}).get("date-parts") or [[None]]
        if parts[0] and parts[0][0]:
            year = parts[0][0]
            break
    container = (work.get("container-title") or [None])[0]
    volume, issue = work.get("volume"), work.get("issue")
    source = container
    if container and volume:
        source = f"{container} {volume}" + (f" ({issue})" if issue else "")
    if work.get("type") == "book-chapter" and container:
        source = f"in {container}"
    pages = work.get("page")
    if pages and "-" in pages:
        first, last = pages.split("-", 1)
        pages = compress_pages(first, last)
    title = clean_title((work.get("title") or [""])[0])
    if not title:
        return None
    return {
        "author": format_authors([{"family": a.get("family"), "given": a.get("given")} for a in work.get("author") or []]),
        "year": year, "title": title, "source": source, "pages": pages,
    }


def from_crossref(doi: str) -> dict | None:
    try:
        response = requests.get(f"https://api.crossref.org/works/{doi}", timeout=15, headers=HEADERS)
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
        if title_matches((work.get("title") or [""])[0], title):
            return from_work(work)
    return None


def from_jstor(text: str) -> dict | None:
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
    journal = re.sub(r",?\s*\(.*$", "", source_line).strip()
    journal = re.sub(r",?\s*Vol\.\s*(\d+),?\s*No\.\s*(\d+)", r" \1 (\2)", journal)
    if not title:
        return None
    return {
        "author": format_authors([split_name(n) for n in names if n.strip()]),
        "year": int(year.group(1)) if year else None,
        "title": title,
        "source": journal or None,
        "pages": compress_pages(pages.group(1), pages.group(2)) if pages else None,
    }


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
    body = sorted(size for size, _, _ in lines)[len(lines) // 2]
    top = [(i, l) for i, l in enumerate(lines) if l[2] < 0.6 and len(l[1]) > 3 and not re.search(r"https?://|www\.|doi|©|copyright", l[1], re.I)]
    if not top:
        return None
    largest = max(l[0] for _, l in top)
    # A title has to stand out from the body text.
    if largest < body * 1.25:
        return None
    picked = [i for i, l in top if abs(l[0] - largest) < 0.6]
    first, last = picked[0], picked[0]
    while last + 1 < len(lines) and abs(lines[last + 1][0] - largest) < 0.6:
        last += 1
    title = clean_title(" ".join(lines[k][1] for k in range(first, last + 1)))
    if len(title) < 8 or len(title) > 250:
        return None
    authors = []
    for size, line, _ in lines[last + 1:last + 4]:
        candidate = re.sub(r"[\d*\u2020\u2021]+$", "", line).strip()
        if size >= body * 0.9 and NAME.match(candidate) and len(candidate) < 90:
            names = re.split(r"\s*,\s*|\s+and\s+|\s*&\s*", re.sub(r"^by\s+", "", candidate, flags=re.I))
            authors = [split_name(n) for n in names if n.strip()]
            break
    return {"author": format_authors(authors), "year": None, "title": title, "source": None, "pages": None}


def from_metadata(meta: dict) -> dict | None:
    title = clean_title(meta.get("title") or "")
    junk = re.compile(r"^(microsoft word|untitled|document\d*|scan|\d+$)|\.(docx?|pdf|indd)$", re.I)
    if not title or junk.search(title) or len(title) < 6:
        return None
    author = (meta.get("author") or "").strip()
    authors = [split_name(a) for a in re.split(r";|\s+and\s+|&", author) if a.strip()] if author else []
    return {"author": format_authors(authors), "year": None, "title": title, "source": None, "pages": None}


def identify(text: str, meta: dict, lines: list | None = None, online: bool = True) -> tuple[dict | None, str | None]:
    """Returns the citation found and how it was found."""
    doi = DOI.search(text)
    if doi and online:
        found = from_crossref(doi.group(1).rstrip(".,;)]"))
        if found:
            return found, "crossref"
    found = from_jstor(text)
    if found:
        return found, "jstor"
    laid_out = from_layout(lines or [], text)
    if laid_out:
        if online:
            record = search_crossref(laid_out["title"], laid_out["author"])
            if record:
                return record, "crossref-title"
        return laid_out, "layout"
    found = from_metadata(meta)
    if found:
        if online:
            record = search_crossref(found["title"], found["author"])
            if record:
                return record, "crossref-title"
        return found, "metadata"
    return None, None
