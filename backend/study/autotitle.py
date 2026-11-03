"""Autonames untitled weeks from the first slide of their slide decks."""

import logging
import os
import tempfile
from typing import NamedTuple
import pymupdf

from study.api import Api, stamp
from study.titles import derive_week_title, extract_slide_title_text

log = logging.getLogger(__name__)


class WeekCandidate(NamedTuple):
    week: dict
    week_id: str
    week_number: int
    term: str
    module_code: str
    item_title: str
    file_r2_key: str


def find_untitled_weeks_with_slides(api: Api) -> list[WeekCandidate]:
    tables = api.pull_all()
    weeks = tables.get("weeks", {})
    sessions = tables.get("sessions", {})
    items = tables.get("items", {})
    week_items = tables.get("week_items", {})
    files = tables.get("files", {})
    modules = tables.get("modules", {})

    candidates: list[WeekCandidate] = []

    # Map session to week
    session_to_week = {s_id: s["week_id"] for s_id, s in sessions.items() if not s.get("deleted")}

    # Map item to week (either via week_items or session)
    item_to_week: dict[str, str] = {}
    for wi in week_items.values():
        if wi.get("deleted"):
            continue
        if wi.get("week_id"):
            item_to_week[wi["item_id"]] = wi["week_id"]
        elif wi.get("session_id") and wi["session_id"] in session_to_week:
            item_to_week[wi["item_id"]] = session_to_week[wi["session_id"]]

    # Look for untitled weeks with active slides
    seen_weeks: set[str] = set()

    for item in items.values():
        if item.get("deleted") or item.get("kind") != "slides":
            continue
        week_id = item_to_week.get(item["id"])
        if not week_id or week_id in seen_weeks:
            continue
        week = weeks.get(week_id)
        if not week or week.get("deleted") or week.get("title"):
            continue
        mod = modules.get(week.get("module_id", ""))
        mod_code = mod.get("code", "") if mod else ""

        file_id = item.get("file_id") or item.get("original_file_id")
        file_row = files.get(file_id) if file_id else None
        if not file_row or not file_row.get("r2_key"):
            continue

        candidates.append(
            WeekCandidate(
                week=week,
                week_id=week_id,
                week_number=week.get("number", 0),
                term=week.get("term", ""),
                module_code=mod_code,
                item_title=item.get("title", ""),
                file_r2_key=file_row["r2_key"],
            )
        )
        seen_weeks.add(week_id)

    return candidates


def autotitle_week_from_file(
    api: Api,
    r2_key: str,
    module_code: str,
) -> str | None:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "deck.pdf")
        api.download(r2_key, path)
        with pymupdf.open(path) as doc:
            if len(doc) == 0:
                return None
            text = extract_slide_title_text(doc[0])
            title = derive_week_title(text, course_codes=[module_code] if module_code else ())
            if not title and len(doc) > 1:
                text1 = extract_slide_title_text(doc[1])
                title = derive_week_title(text1, course_codes=[module_code] if module_code else ())
            return title


def run_autotitle(api: Api, dry_run: bool = False) -> list[tuple[str, str, str]]:
    candidates = find_untitled_weeks_with_slides(api)
    results: list[tuple[str, str, str]] = []
    changes: list[dict] = []

    for c in candidates:
        try:
            title = autotitle_week_from_file(api, c.file_r2_key, c.module_code)
            if title:
                results.append((f"{c.module_code} {c.term}{c.week_number}", title, c.item_title))
                changes.append({
                    "table": "weeks",
                    "row": {
                        **c.week,
                        "title": title,
                        "modified_at": stamp(),
                    },
                    "cols": ["title"],
                })
        except Exception as exc:
            log.warning("failed to autotitle candidate %s: %s", c, exc)

    if not dry_run and changes:
        failures = api.push(changes)
        if failures:
            log.error("sync push failures while autotitling: %s", failures)

    return results


def maybe_autotitle_for_file(api: Api, file_id: str, doc) -> str | None:
    """Called after text extraction or thumbnailing in the processor."""
    try:
        tables = api.pull_all()
        items = tables.get("items", {})
        week_items = tables.get("week_items", {})
        weeks = tables.get("weeks", {})
        modules = tables.get("modules", {})
        sessions = tables.get("sessions", {})

        session_to_week = {s_id: s["week_id"] for s_id, s in sessions.items() if not s.get("deleted")}

        slide_item = None
        for item in items.values():
            if not item.get("deleted") and item.get("kind") == "slides":
                if item.get("file_id") == file_id or item.get("original_file_id") == file_id:
                    slide_item = item
                    break
        if not slide_item:
            return None

        week_id = None
        for wi in week_items.values():
            if not wi.get("deleted") and wi.get("item_id") == slide_item["id"]:
                week_id = wi.get("week_id") or session_to_week.get(wi.get("session_id", ""))
                if week_id:
                    break
        if not week_id:
            return None

        week = weeks.get(week_id)
        if not week or week.get("deleted") or week.get("title"):
            return None

        mod = modules.get(week.get("module_id", ""))
        mod_code = mod.get("code", "") if mod else ""

        if len(doc) == 0:
            return None
        text = extract_slide_title_text(doc[0])
        title = derive_week_title(text, course_codes=[mod_code] if mod_code else ())
        if not title and len(doc) > 1:
            text1 = extract_slide_title_text(doc[1])
            title = derive_week_title(text1, course_codes=[mod_code] if mod_code else ())

        if title:
            api.push([{
                "table": "weeks",
                "row": {
                    **week,
                    "title": title,
                    "modified_at": stamp(),
                },
                "cols": ["title"],
            }])
            log.info("week %s %s%s autonamed: %r", mod_code, week.get("term"), week.get("number"), title)
            return title
    except Exception as exc:
        log.warning("could not check autotitle for file %s: %s", file_id, exc)
    return None


if __name__ == "__main__":
    import sys
    from study.api import api_from_env

    apply_changes = "--apply" in sys.argv
    study_api = api_from_env()
    print("Running week autotitling (dry_run=%s)..." % (not apply_changes))
    discovered = run_autotitle(study_api, dry_run=not apply_changes)
    print("Discovered %d titles:" % len(discovered))
    for week_label, derived_title, source_deck in discovered:
        print("  [%s] %s (from: %s)" % (week_label, derived_title, source_deck))
    if not apply_changes and discovered:
        print("\nPass --apply to save these titles to the library.")

