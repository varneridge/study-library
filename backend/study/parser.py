"""Parse titles written in the (AT1) naming convention.

Mirrors web/lib/parse.ts. Both are tested against shared/title-fixtures.json.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

QUOTE = "['\u2018\u2019]"

MODULE_NOTE = re.compile(r"^\(00\)\s+(?P<title>.+)$")
PREFIX = re.compile(
    r"^\((?P<term>AT|WT)(?P<week>\d{1,2})\)\s+"
    r"(?:(?P<session>00)\s+|P(?P<primary>\d+)\s+)?(?P<rest>.+)$"
)
SECONDARY = re.compile(
    rf"^(?P<author>.+?) \((?P<year>\d{{4}})\) {QUOTE}(?P<title>.+?){QUOTE}"
    r"(?:, (?P<source>.+?))?(?:, pp?\. (?P<pages>[\d-]+))?$"
)
PRIMARY = re.compile(
    rf"^(?P<author>[^'\u2018\u2019]+?), {QUOTE}(?P<title>.+){QUOTE}(?:, (?P<detail>.+))?$"
)
TRAILING_DATE = re.compile(r"^(?P<title>.+), (?P<date>\d{1,2} [A-Z][a-z]{2,8}\.? \d{4})$")
DATE_LIKE = re.compile(
    r"^(\d{1,2} )?([A-Z][a-z]{2,8}\.? )?\d{4}$"
)


@dataclass
class Parsed:
    kind: str
    title: str
    review: bool
    term: str | None = None
    week: int | None = None
    order: int | None = None
    author: str | None = None
    year: int | None = None
    source: str | None = None
    pages: str | None = None
    doc_date: str | None = None

    def as_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


def parse_title(raw: str) -> Parsed:
    text = " ".join(raw.split())

    module = MODULE_NOTE.match(text)
    if module:
        return Parsed(kind="module", title=module["title"], review=False)

    prefix = PREFIX.match(text)
    if not prefix:
        return Parsed(kind="unmatched", title=text, review=True)

    term = prefix["term"]
    week = int(prefix["week"])
    rest = prefix["rest"].strip()

    if not 1 <= week <= 11:
        return Parsed(kind="unmatched", title=text, review=True)

    if prefix["session"]:
        return Parsed(kind="session", term=term, week=week, title=rest, review=False)

    if prefix["primary"]:
        return _primary(rest, term, week, int(prefix["primary"]))

    return _secondary(rest, term, week)


def _primary(rest: str, term: str, week: int, order: int) -> Parsed:
    match = PRIMARY.match(rest)
    if match:
        parsed = Parsed(
            kind="primary", term=term, week=week, order=order,
            author=match["author"].strip(), title=match["title"].strip(), review=False,
        )
        detail = match["detail"]
        if detail:
            if DATE_LIKE.match(detail.strip()):
                parsed.doc_date = detail.strip()
            else:
                parsed.source = detail.strip()
        return parsed

    dated = TRAILING_DATE.match(rest)
    if dated:
        return Parsed(
            kind="primary", term=term, week=week, order=order,
            title=dated["title"].strip(), doc_date=dated["date"], review=True,
        )
    return Parsed(kind="primary", term=term, week=week, order=order, title=rest, review=True)


def _secondary(rest: str, term: str, week: int) -> Parsed:
    match = SECONDARY.match(rest)
    if not match:
        return Parsed(kind="secondary", term=term, week=week, title=rest, review=True)
    return Parsed(
        kind="secondary", term=term, week=week,
        author=match["author"].strip(), year=int(match["year"]),
        title=match["title"].strip(),
        source=(match["source"] or "").strip() or None,
        pages=match["pages"], review=False,
    )
