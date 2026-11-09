# filename: backend/sync/jobs.py
"""Mirrors job applications into a Google Drive folder.

Each live application gets a folder named after its employer and role, with
the start of its id in brackets so the folder keeps its identity when either
is reworded. The folder holds the four slot files (CV, cover letter, role
description, answers to questions) and an application.md with the stage,
dates, notes and timeline. index.csv and index.md list every application.

Run from backend/: python -m sync.jobs [--dest PATH] [--dry-run] [--verbose]
"""

from __future__ import annotations

import csv
import io
import sys
from dataclasses import dataclass

from .common import (
    Syncer, base_arguments, csv_cell, ext_for_mime, http_url, key_digest, md_cell, md_link,
    run, safe_component, uk_date, url_shortcut, validate_key,
)

DEFAULT_DEST = r"G:\My Drive\Antigravity\Jobs\applications"

# The slots and stages as jobs.ts defines them. Stages are stored by key, so
# only the wording lives here.
SLOTS = [("cv", "CV"), ("cl", "Cover letter"), ("rd", "Role description"), ("qs", "Answers to questions")]

STAGES: dict[str, tuple[str, str]] = {
    "to_apply": ("To apply", "todo"),
    "applied": ("Applied: awaiting response", "waiting"),
    "oa_todo": ("Online test: to complete", "todo"),
    "oa_wait": ("Online test: done, awaiting result", "waiting"),
    "written_todo": ("Written assessment: to complete", "todo"),
    "written_wait": ("Written assessment: done, awaiting result", "waiting"),
    "hirevue_todo": ("Video interview: to record", "todo"),
    "hirevue_wait": ("Video interview: done, awaiting result", "waiting"),
    "interview_todo": ("Interview: to prepare and attend", "todo"),
    "interview_wait": ("Interview: done, awaiting result", "waiting"),
    "ac_todo": ("Assessment centre: to prepare and attend", "todo"),
    "ac_wait": ("Assessment centre: done, awaiting result", "waiting"),
    "final_todo": ("Final interview: to prepare and attend", "todo"),
    "final_wait": ("Final interview: done, awaiting result", "waiting"),
    "offer": ("Offer: to accept or decline", "offer"),
    "accepted": ("Accepted", "offer"),
    "rejected": ("Rejected", "closed"),
    "withdrawn": ("Withdrawn", "closed"),
    "declined": ("Offer declined", "closed"),
    "no_response": ("No response", "closed"),
}


def stage_label(key: str | None) -> str:
    return STAGES.get(key or "", (key or "", "waiting"))[0]


def is_open(app: dict) -> bool:
    return STAGES.get(app.get("stage") or "", ("", "waiting"))[1] != "closed"


@dataclass
class SlotTarget:
    slot: str
    filename: str
    key: str | None = None
    url: str | None = None
    mime: str | None = None
    bytes: int | None = None
    original_name: str | None = None
    digest: str | None = None


def app_folder_name(app: dict) -> str:
    label = " - ".join(part for part in ((app.get("employer") or "").strip(), (app.get("role") or "").strip()) if part)
    return f"{safe_component(label, 70)} [{app['id'][:8]}]"


def slot_targets(app: dict) -> list[SlotTarget]:
    """The files a saved slot becomes. A slot still uploading, of a type the
    app does not accept, with an unsafe key or with a link that is not http
    or https is left out rather than guessed at."""
    targets = []
    for name, label in SLOTS:
        slot = app.get(f"file_{name}")
        if not isinstance(slot, dict) or slot.get("state") != "saved":
            continue
        if slot.get("key"):
            extension = ext_for_mime(slot.get("mime"))
            if not extension:
                continue
            try:
                key = validate_key(slot["key"])
            except ValueError:
                continue
            targets.append(SlotTarget(name, label + extension, key=key, mime=slot.get("mime"),
                                      bytes=slot.get("bytes"), original_name=slot.get("name"), digest=key_digest(key)))
        elif http_url(slot.get("url")):
            targets.append(SlotTarget(name, label + ".url", url=slot["url"]))
    return targets


def live_applications(tables: dict[str, dict[str, dict]]) -> list[dict]:
    return [row for row in tables.get("applications", {}).values() if not row.get("deleted")]


def live_events(tables: dict[str, dict[str, dict]], app_id: str) -> list[dict]:
    rows = [row for row in tables.get("application_events", {}).values()
            if row.get("application_id") == app_id and not row.get("deleted")]
    return sorted(rows, key=lambda row: (row.get("at") or "", row.get("id") or ""))


def sort_applications(apps: list[dict]) -> list[dict]:
    """The app's default order: open ones by deadline, soonest first; then open
    ones with no deadline, newest first; then closed ones, newest first."""
    def group(app: dict) -> int:
        return 2 if not is_open(app) else 0 if app.get("next_deadline") else 1

    by_applied = sorted(apps, key=lambda app: ((app.get("employer") or "").casefold(), app["id"]))
    by_applied.sort(key=lambda app: app.get("applied") or "", reverse=True)
    return sorted(by_applied, key=lambda app: (group(app), app.get("next_deadline") or "" if group(app) == 0 else ""))


INDEX_COLUMNS = ["Employer", "Role", "Stage", "Applied", "Next deadline", "Folder", "Files", "Notes"]


def render_index_csv(apps: list[dict]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(INDEX_COLUMNS)
    for app in sort_applications(apps):
        files = ", ".join(target.filename for target in slot_targets(app))
        writer.writerow([csv_cell(value) for value in (
            app.get("employer"), app.get("role"), stage_label(app.get("stage")), app.get("applied"),
            app.get("next_deadline"), app_folder_name(app), files, app.get("notes"))])
    return buffer.getvalue()


def render_index_md(apps: list[dict]) -> str:
    ordered = sort_applications(apps)
    lines = ["# Applications", "", f"{sum(is_open(app) for app in ordered)} open, "
             f"{sum(not is_open(app) for app in ordered)} closed.", "",
             "| Employer | Role | Stage | Next deadline | Applied | Folder |",
             "| --- | --- | --- | --- | --- | --- |"]
    for app in ordered:
        folder = app_folder_name(app)
        lines.append(f"| {md_cell(app.get('employer')) or 'Untitled'} | {md_cell(app.get('role'))} | "
                     f"{md_cell(stage_label(app.get('stage')))} | {uk_date(app.get('next_deadline'))} | "
                     f"{uk_date(app.get('applied'))} | [Open]({md_link(folder + '/application.md')}) |")
    return "\n".join(lines) + "\n"


def render_application_md(app: dict, events: list[dict]) -> str:
    title = " at ".join(part for part in (md_cell(app.get("role")), md_cell(app.get("employer"))) if part) or "Untitled"
    lines = [f"# {title.lstrip('#').strip()}", "",
             f"- **Stage:** {stage_label(app.get('stage'))}",
             f"- **Applied:** {uk_date(app.get('applied')) or 'not recorded'}",
             f"- **Next deadline:** {uk_date(app.get('next_deadline')) or 'none'}", ""]
    targets = slot_targets(app)
    if targets:
        lines += ["## Files", ""]
        for target in targets:
            origin = f" (uploaded as {md_cell(target.original_name)})" if target.original_name else ""
            lines.append(f"- [{target.filename}]({md_link(target.filename)}){origin}")
        lines.append("")
    if events:
        lines += ["## Timeline", ""]
        for event in events:
            change = f"{stage_label(event.get('from_stage'))} to " if event.get("from_stage") else ""
            manual = " (added by hand)" if event.get("kind") == "manual" else ""
            lines.append(f"- {uk_date(event.get('at'))}: {change}{stage_label(event.get('stage'))}{manual}")
        lines.append("")
    notes = (app.get("notes") or "").strip()
    if notes:
        lines += ["## Notes", "", notes, ""]
    return "\n".join(lines)


def build(tables: dict[str, dict[str, dict]], syncer: Syncer) -> None:
    apps = live_applications(tables)
    for app in sort_applications(apps):
        folder = syncer.folder(f"application:{app['id']}", app_folder_name(app))
        for target in slot_targets(app):
            rel = f"{folder}/{target.filename}"
            if target.key:
                syncer.put_object(rel, target.key, target.digest, target.bytes)
            else:
                syncer.put_text(rel, url_shortcut(target.url))
        syncer.put_text(f"{folder}/application.md", render_application_md(app, live_events(tables, app["id"])))
    # Excel opens a CSV with a byte order mark as UTF-8, so accented employer
    # names are not mangled.
    syncer.put_bytes("index.csv", b"\xef\xbb\xbf" + render_index_csv(apps).encode("utf-8"))
    syncer.put_text("index.md", render_index_md(apps))


def main(argv: list[str] | None = None) -> int:
    parser = base_arguments("Mirror job applications and their files into a local folder.", DEFAULT_DEST)
    return run("jobs", parser.parse_args(argv), build)


if __name__ == "__main__":
    sys.exit(main())
