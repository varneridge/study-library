"""Extracts clean topic and week titles from slide decks."""

import re
import unicodedata
from typing import Iterable

GENERIC_CODE = re.compile(r"\b[A-Z]{2,4}\s?-?\d{3}[A-Z]?\b")
TERM_WEEK = re.compile(r"\b(?:AT|WT|ST)\s?-?\d{1,2}\b", re.IGNORECASE)
NUM = r"(?:\d{1,2}[a-z]?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[ivxlcdm]+)"
UNIT = r"(?:week|wk|lecture|lec|seminar|session|topic|class|unit)"
PREFIX = re.compile(
    rf"^[\s,;:|\-\u2013\u2014]*(?:(?:AT|WT|ST|[A-Z]{{1,4}})[\s,]+)?{UNIT}\.?\s*{NUM}\b[\s:.,;|\-\u2013\u2014]*",
    re.IGNORECASE,
)
SUFFIX = re.compile(rf"[\s,;:|\-\u2013\u2014(]*\b{UNIT}\.?\s*{NUM}\)?\s*$", re.IGNORECASE)
NOISE = re.compile(
    r"(?i)^(?:dr|prof(?:essor)?|mr|mrs|ms)\.?\s"
    r"|@|https?://|www\."
    r"|^\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+\s+\d{4}$"
    r"|^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$"
    r"|^(?:autumn|winter|spring|summer|michaelmas|lent|hilary|trinity)\s+term\b"
    r"|\b(?:module|course)\s+(?:convenor|leader|director|code)\b"
    r"|\blondon\s+school\s+of\s+economics\b"
    r"|\bdepartment\s+of\b"
)
SMALL = {
    "a", "an", "the", "and", "but", "or", "nor", "for", "of", "in", "on",
    "at", "to", "by", "with", "from", "as", "vs", "via", "into", "upon",
}
ACRONYMS = {
    "CSCE", "NATO", "USSR", "USA", "US", "UK", "UN", "EU", "EEC", "GDR",
    "FRG", "PRC", "CCP", "CIA", "KGB", "SALT", "START", "WWI", "WWII",
    "OSCE", "IMF", "OPEC", "ASEAN", "FLN", "PLO", "IRA", "ETA",
}
ROMAN = {"II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII"}
EDGE_PUNCT = " ,;:|\u2013\u2014-\u2022\u00b7*"


def _normalise(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text)
    text = "".join(c for c in text if c == "\n" or unicodedata.category(c)[0] != "C")
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    return [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]


def _is_shouting(s: str) -> bool:
    letters = [c for c in s if c.isalpha()]
    return len(letters) >= 4 and sum(c.isupper() for c in letters) / len(letters) > 0.8


def _letter_ratio(s: str) -> float:
    chars = [c for c in s if not c.isspace()]
    return sum(c.isalpha() for c in chars) / len(chars) if chars else 0.0


def _recase_word(word: str, first: bool, last: bool) -> str:
    m = re.match(r"^(\W*)(.*?)(\W*)$", word)
    if not m:
        return word
    lead, core, trail = m.groups()
    if not core:
        return word
    if core.upper() in ACRONYMS or core.upper() in ROMAN:
        return lead + core.upper() + trail

    apostrophe_match = re.match(r"^([A-Za-z]+)(['\u2019][a-z]+)$", core, re.IGNORECASE)
    if apostrophe_match:
        base, suffix = apostrophe_match.groups()
        if base.upper() in ACRONYMS:
            return lead + base.upper() + suffix.lower() + trail
        return lead + base.capitalize() + suffix.lower() + trail

    low = core.lower()
    if low in SMALL and not first and not last:
        return lead + low + trail
    return lead + "-".join(p[:1].upper() + p[1:] for p in low.split("-")) + trail


def _title_case(s: str) -> str:
    words = s.split()
    out: list[str] = []
    after_colon = False
    for i, w in enumerate(words):
        out.append(_recase_word(w, i == 0 or after_colon, i == len(words) - 1))
        after_colon = w.endswith(":") or w.endswith(" -")
    return " ".join(out)


def extract_slide_title_text(page) -> str:
    """Extracts text from a PyMuPDF page, keeping lines whose spans are close to the largest font size."""
    try:
        data = page.get_text("dict")
    except Exception:
        return page.get_text("text")

    max_size = 0.0
    for b in data.get("blocks", []):
        if b.get("type") != 0:
            continue
        for l in b.get("lines", []):
            for s in l.get("spans", []):
                t = s.get("text", "").strip()
                if t:
                    size = float(s.get("size", 0.0))
                    if size > max_size:
                        max_size = size

    if max_size >= 14.0:
        threshold = max_size * 0.72
        filtered_lines: list[str] = []
        for b in data.get("blocks", []):
            if b.get("type") != 0:
                continue
            for l in b.get("lines", []):
                l_spans = [
                    s.get("text", "")
                    for s in l.get("spans", [])
                    if s.get("text", "").strip() and float(s.get("size", 0.0)) >= threshold
                ]
                if l_spans:
                    filtered_lines.append(" ".join(l_spans))
        if filtered_lines:
            return "\n".join(filtered_lines)

    return page.get_text("text")


def derive_week_title(
    text: str | None,
    course_codes: Iterable[str] = (),
    max_len: int = 140,
) -> str | None:
    """Derives a week topic or title from first slide text, excluding course codes and week numbers."""
    if not text:
        return None

    exact = [
        re.compile(r"\b" + r"\s?".join(map(re.escape, re.findall(r"[A-Za-z]+|\d+", c))) + r"\b", re.IGNORECASE)
        for c in course_codes if c
    ]

    block: list[str] = []
    for raw in _normalise(text):
        line = raw
        for rx in exact:
            line = rx.sub(" ", line)
        line = GENERIC_CODE.sub(" ", line)
        line = TERM_WEEK.sub(" ", line)
        line = PREFIX.sub("", line)
        line = SUFFIX.sub("", line)
        line = re.sub(r"\s+", " ", line).strip(EDGE_PUNCT)
        if not line:
            continue
        if NOISE.search(line) or _letter_ratio(line) < 0.5:
            if block:
                break
            continue
        if block:
            prev = block[-1]
            joined_len = sum(len(b) + 1 for b in block) + len(line)
            style_break = _is_shouting(prev) != _is_shouting(line) and not prev.endswith(",")
            if style_break or joined_len > max_len:
                break
        block.append(line)

    if not block:
        return None

    title = " ".join(block)
    title = re.sub(r"\s+([,;:.!?\u2019\"')\]])", r"\1", title)
    title = re.sub(r"([\u2018\"(\[])\s+", r"\1", title).strip(EDGE_PUNCT)

    # Convert any em dashes or en dashes to hyphens
    title = title.replace("\u2014", " - ").replace("\u2013", " - ")
    title = re.sub(r"\s+", " ", title).strip(EDGE_PUNCT)

    if _is_shouting(title):
        title = _title_case(title)

    return title if 3 <= len(title) <= max_len else None
