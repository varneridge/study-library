"""Measures how well finding a reading's details works, on the real library.

It is read-only: it pulls every reading and its PDF, runs identify() on each
exactly as the processor does, and compares what it finds with the reading's
current details. It never calls identified() and never pushes anything.

Run it from backend/ in WSL, with the processor's settings:

    set -a; . ./.env; set +a
    ~/.venvs/study/bin/python tools/identify_audit.py

Options: --offline skips Crossref (the DOI and title lookups), and --limit N
looks at the first N readings only.

The PDFs and the full report go in backend/audit/, which Git ignores, because
they hold your reading titles. Only counts are printed, so the printed summary
can be shared without them.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from study.api import api_from_env  # noqa: E402
from study.processor import identify as finder  # noqa: E402

OUT = HERE.parent / "audit"
FIELDS = ("author", "year", "title", "source", "pages")
# Routes that fill in a reading with no author or year without asking.
APPLIED_ROUTES = {"crossref", "crossref-title", "jstor"}


def plain(value) -> str:
    """The Worker's comparison: case and punctuation ignored."""
    return re.sub(r"[^a-z0-9]", "", str(value if value is not None else "").lower())


def similar(a, b) -> float:
    return SequenceMatcher(None, plain(a), plain(b)).ratio()


def surnames(author) -> set[str]:
    names = re.split(r",\s*(?=[A-Z][a-z])|\s+and\s+|&", str(author or ""))
    return {plain(n.split(",")[0]) for n in names if plain(n.split(",")[0])}


def compare(current: dict, found: dict) -> dict:
    """Field by field: agree, conflict, adds (found only) or loses (current only)."""
    fields = {}
    for f in FIELDS:
        mine, theirs = current.get(f), found.get(f)
        if plain(mine) and plain(theirs):
            fields[f] = "agree" if plain(mine) == plain(theirs) else "conflict"
        elif plain(theirs):
            fields[f] = "adds"
        elif plain(mine):
            fields[f] = "loses"
        else:
            fields[f] = "neither"
    return fields


def verdict(current: dict, found: dict | None, fields: dict | None) -> str:
    if not found:
        return "nothing found"
    if all(v in ("agree", "neither") for v in fields.values()):
        return "same as now"
    if plain(current.get("title")) and plain(found.get("title")):
        title_close = similar(current["title"], found["title"]) >= 0.6
        same_people = bool(surnames(current.get("author")) & surnames(found.get("author"))) or not current.get("author") or not found.get("author")
        if not title_close and not same_people:
            return "a different work"
    conflicts = [f for f, v in fields.items() if v == "conflict"]
    adds = [f for f, v in fields.items() if v == "adds"]
    loses = [f for f, v in fields.items() if v == "loses"]
    if not conflicts and adds and not loses:
        return "better: adds only"
    if not conflicts and not adds and loses:
        return "worse: has less than now"
    if conflicts and set(conflicts) <= {"author", "pages", "source", "year"} and not loses:
        return "differs on detail"
    if conflicts and "title" in conflicts:
        return "differs on the title"
    return "mixed: adds some, lacks or differs on others"


def first_doi_page(doc) -> int | None:
    for i in range(min(3, len(doc))):
        if finder.DOI.search(doc[i].get_text("text")):
            return i + 1
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--offline", action="store_true", help="skip Crossref lookups")
    parser.add_argument("--limit", type=int, default=0, help="look at the first N readings only")
    args = parser.parse_args()

    import pymupdf

    api = api_from_env()
    (OUT / "pdfs").mkdir(parents=True, exist_ok=True)
    rows = api.pull_all()
    files = {k: v for k, v in rows.get("files", {}).items() if not v.get("deleted")}
    items = [v for v in rows.get("items", {}).values()
             if not v.get("deleted") and v.get("kind") != "slides" and v.get("file_id") in files]
    items = [i for i in items if files[i["file_id"]].get("mime") == "application/pdf"]
    items.sort(key=lambda i: i["id"])
    if args.limit:
        items = items[: args.limit]

    results = []
    for n, item in enumerate(items, 1):
        file = files[item["file_id"]]
        path = OUT / "pdfs" / f"{file['sha256']}.pdf"
        if not path.exists():
            api.download(file["r2_key"], str(path))
        with pymupdf.open(str(path)) as doc:
            meta = doc.metadata or {}
            text = "\n".join(doc[i].get_text("text") for i in range(min(3, len(doc))))
            lines = finder.first_page_lines(doc)
            doi_page = first_doi_page(doc)
        found, via = finder.identify(text, meta, lines, online=not args.offline)
        current = {f: item.get(f) for f in FIELDS}
        fields = compare(current, found) if found else None
        unnamed = item.get("kind") == "secondary" and not item.get("author") and not item.get("year")
        suggested = item.get("suggested") or None
        results.append({
            "id": item["id"],
            "kind": item.get("kind"),
            "current": current,
            "found": found,
            "via": via,
            "verdict": verdict(current, found, fields),
            "fields": fields,
            "would_apply_without_asking": bool(found and unnamed and via in APPLIED_ROUTES),
            "pending_suggestion": bool(suggested and not suggested.get("applied") and not suggested.get("dismissed")),
            "text_status": file.get("text_status"),
            "first_pages_text": len(text.strip()),
            "doi_on_page": doi_page,
            "looks_like_chapter": bool(re.match(r"\s*in\s", str(item.get("source") or ""), re.I)),
            "pdf_title_field": bool((meta.get("title") or "").strip()),
        })
        print(f"\r{n} of {len(items)} readings looked at", end="", flush=True)
        if not args.offline:
            time.sleep(0.2)  # Polite to Crossref.
    print()

    (OUT / "identify-report.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    write_markdown(results)
    summarise(results)


def write_markdown(results: list[dict]) -> None:
    """The full report, with titles, kept in the ignored audit folder."""
    lines = ["# Finding details: audit report", "", "Private: holds reading titles. Not for Git.", ""]
    for r in sorted(results, key=lambda r: (r["verdict"], r["via"] or "")):
        cur, found = r["current"], r["found"] or {}
        lines.append(f"## {r['verdict']}, by {r['via'] or 'no route'}")
        lines.append("")
        lines.append("| Field | Now | Found | Compared |")
        lines.append("| --- | --- | --- | --- |")
        for f in FIELDS:
            lines.append(f"| {f} | {cur.get(f) or ''} | {found.get(f) or ''} | {(r['fields'] or {}).get(f, '')} |")
        notes = [k for k in ("would_apply_without_asking", "pending_suggestion", "looks_like_chapter") if r[k]]
        lines.append("")
        lines.append(f"Text on the first pages: {r['first_pages_text']} characters. Text status: {r['text_status']}. "
                     f"DOI on page: {r['doi_on_page'] or 'none'}. {', '.join(notes)}")
        lines.append("")
    (OUT / "identify-report.md").write_text("\n".join(lines))


def summarise(results: list[dict]) -> None:
    """Counts only, so this part can be shared."""
    total = len(results)
    print(f"\nReadings looked at: {total}\n")
    print("By verdict:")
    for name, count in Counter(r["verdict"] for r in results).most_common():
        print(f"  {count:4}  {name}")
    print("\nBy route:")
    for name, count in Counter(r["via"] or "nothing found" for r in results).most_common():
        print(f"  {count:4}  {name}")
    print("\nRoute and verdict together:")
    for (via, v), count in sorted(Counter((r["via"] or "none", r["verdict"]) for r in results).items()):
        print(f"  {count:4}  {via:15} {v}")
    raised = [r for r in results if r["found"] and r["verdict"] != "same as now"]
    print("\nThe suspicions:")
    print(f"  {len(raised):4}  would raise Details found (anything differs)")
    print(f"  {sum(r['verdict'] == 'worse: has less than now' for r in results):4}  of those have less than the current name")
    print(f"  {sum(r['verdict'] == 'a different work' for r in results):4}  of those look like a different work")
    print(f"  {sum(r['would_apply_without_asking'] for r in results):4}  would be applied without asking (no author or year yet)")
    print(f"  {sum(r['would_apply_without_asking'] and r['verdict'] == 'a different work' for r in results):4}  of those look like a different work")
    print(f"  {sum(r['pending_suggestion'] for r in results):4}  have a suggestion waiting now")
    dois = [r for r in results if r["via"] == "crossref"]
    print(f"  {len(dois):4}  found by a DOI; {sum(r['doi_on_page'] and r['doi_on_page'] > 1 for r in dois)} of them from a DOI after page 1")
    layout = [r for r in results if r["via"] == "layout"]
    print(f"  {len(layout):4}  guessed from the page layout; {sum(r['verdict'] not in ('same as now', 'better: adds only') for r in layout)} of them no better than now")
    print(f"  {sum(r['first_pages_text'] < 200 for r in results):4}  have almost no text on their first pages (a scan before OCR?)")
    chapters = [r for r in results if r["looks_like_chapter"]]
    print(f"  {len(chapters):4}  look like book chapters; {sum(r['verdict'] in ('same as now', 'better: adds only') for r in chapters)} of them found correctly or better")
    print(f"\nFull report, with titles: {OUT / 'identify-report.md'} (ignored by Git)")


if __name__ == "__main__":
    main()
