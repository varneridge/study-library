"""Plan and apply a Zotero migration for one module.

The module must already exist in Study Library, so its weeks and sessions are
in place. Existing records matched by Zotero key are left alone, so edits made
in Study Library are never overwritten and a second run only adds new things.
"""

from __future__ import annotations

import hashlib
import os
import uuid
from dataclasses import dataclass, field

from ..api import Api, ApiError, stamp
from ..blocks import html_to_blocks
from ..keys import key_after
from ..parser import Parsed, parse_title
from .reader import Annotation, Entry, Note

MIME_BY_EXTENSION = {
    ".pdf": "application/pdf",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
TERM_ORDER = {"AT": 0, "WT": 1}


@dataclass
class PlannedReading:
    entry: Entry
    parsed: Parsed
    path: str
    mime: str


@dataclass
class PlannedNote:
    parsed: Parsed
    note: Note


@dataclass
class Plan:
    module_note: PlannedNote | None = None
    session_notes: list[PlannedNote] = field(default_factory=list)
    readings: list[PlannedReading] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class Summary:
    files_uploaded: int = 0
    files_reused: int = 0
    items_added: int = 0
    items_kept: int = 0
    highlights_added: int = 0
    notes_added: int = 0
    week_titles_set: int = 0
    warnings: list[str] = field(default_factory=list)


def build_plan(entries: list[Entry]) -> Plan:
    plan = Plan()
    for entry in entries:
        parsed = parse_title(entry.title)

        if parsed.kind == "module":
            if entry.note is not None:
                plan.module_note = PlannedNote(parsed, entry.note)
            else:
                plan.skipped.append((entry.title, "module overview without a note"))
            continue

        if parsed.kind == "session":
            if entry.note is not None:
                plan.session_notes.append(PlannedNote(parsed, entry.note))
            else:
                plan.skipped.append((entry.title, "week heading without a note"))
            continue

        if parsed.kind == "unmatched":
            plan.skipped.append((entry.title, "title does not follow the (AT1) convention"))
            continue

        if entry.attachment is None or not entry.attachment.path:
            plan.skipped.append((entry.title, "no file found in Zotero storage"))
            continue

        extension = os.path.splitext(entry.attachment.path)[1].lower()
        mime = MIME_BY_EXTENSION.get(extension)
        if mime is None:
            plan.skipped.append((entry.title, f"unsupported file type {extension}"))
            continue

        plan.readings.append(PlannedReading(entry, parsed, entry.attachment.path, mime))

    plan.readings.sort(key=_reading_order)
    plan.session_notes.sort(key=lambda n: (TERM_ORDER[n.parsed.term], n.parsed.week))
    return plan


def _reading_order(reading: PlannedReading) -> tuple:
    parsed = reading.parsed
    return (
        TERM_ORDER[parsed.term],
        parsed.week,
        0 if parsed.kind == "secondary" else 1,
        parsed.order or 0,
        reading.entry.title.lower(),
    )


def format_plan(plan: Plan) -> str:
    lines = []
    if plan.module_note:
        lines.append(f"Module description from '{plan.module_note.parsed.title}'")
    for note in plan.session_notes:
        lines.append(f"{note.parsed.term}{note.parsed.week:<3} week title   {note.parsed.title}")
    for reading in plan.readings:
        parsed = reading.parsed
        flags = []
        if parsed.review:
            flags.append("check title")
        if reading.entry.attachment and reading.entry.attachment.annotations:
            flags.append(f"{len(reading.entry.attachment.annotations)} highlights")
        if reading.entry.notes:
            flags.append(f"{len(reading.entry.notes)} notes")
        suffix = f"  [{', '.join(flags)}]" if flags else ""
        label = "primary" if parsed.kind == "primary" else "reading"
        lines.append(f"{parsed.term}{parsed.week:<3} {label:<12} {parsed.title}{suffix}")
    for title, reason in plan.skipped:
        lines.append(f"skipped        {title}  ({reason})")
    return "\n".join(lines)


# Applying


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _live(rows: dict[str, dict]) -> list[dict]:
    return [row for row in rows.values() if not row.get("deleted")]


class Importer:
    """Builds changes like any other device and pushes them through the API."""

    def __init__(self, api: Api, module_code: str):
        self.api = api
        self.summary = Summary()
        self.changes: list[dict] = []

        state = api.pull_all()
        modules = [m for m in _live(state.get("modules", {})) if m["code"] == module_code]
        if not modules:
            raise LookupError(f"module {module_code} not found. Create it in Study Library first.")
        self.module = sorted(modules, key=lambda m: m["modified_at"])[0]

        self.weeks = {
            (w["term"], w["number"]): w
            for w in _live(state.get("weeks", {}))
            if w["module_id"] == self.module["id"]
        }
        week_ids = {w["id"] for w in self.weeks.values()}
        self.sessions: dict[str, list[dict]] = {}
        for session in sorted(_live(state.get("sessions", {})), key=lambda s: s["position"]):
            if session["week_id"] in week_ids:
                self.sessions.setdefault(session["week_id"], []).append(session)

        self.items_by_key = {i["zotero_key"]: i for i in _live(state.get("items", {})) if i.get("zotero_key")}
        self.files_by_sha = {f["sha256"]: f for f in _live(state.get("files", {}))}
        self.note_keys = {n["zotero_key"] for n in state.get("notes", {}).values() if n.get("zotero_key")}
        self.highlight_keys = {
            h["zotero_key"] for h in state.get("highlights", {}).values() if h.get("zotero_key")
        }
        self.last_position: dict[str, str] = {}
        for link in _live(state.get("week_items", {})):
            if link.get("session_id") is None and link["week_id"] in week_ids:
                current = self.last_position.get(link["week_id"])
                if current is None or link["position"] > current:
                    self.last_position[link["week_id"]] = link["position"]

    def _add(self, table: str, row: dict) -> None:
        row.setdefault("deleted", False)
        row.setdefault("modified_at", stamp())
        self.changes.append({"table": table, "row": row})

    def apply(self, plan: Plan) -> Summary:
        if plan.module_note:
            self._module_description(plan.module_note)
        for note in plan.session_notes:
            self._session_note(note)
        for reading in plan.readings:
            self._reading(reading)
        failures = self.api.push(self.changes)
        if failures:
            raise ApiError(f"{len(failures)} rows were rejected, first: {failures[0]}")
        return self.summary

    # Module and weeks

    def _module_description(self, planned: PlannedNote) -> None:
        if self.module.get("description"):
            return
        blocks = html_to_blocks(planned.note.html, drop_first_if=planned.note.title)
        self.module = {**self.module, "description": blocks,
                       "modified_at": stamp(self.module["modified_at"])}
        self._add("modules", dict(self.module))

    def _week(self, parsed: Parsed) -> dict | None:
        week = self.weeks.get((parsed.term, parsed.week))
        if week is None:
            self.summary.warnings.append(f"no week {parsed.term}{parsed.week} in this module")
        return week

    def _session_note(self, planned: PlannedNote) -> None:
        week = self._week(planned.parsed)
        if week is None:
            return
        if not (week.get("title") or "").strip():
            week.update(title=planned.parsed.title, modified_at=stamp(week["modified_at"]))
            self._add("weeks", dict(week))
            self.summary.week_titles_set += 1

        if planned.note.key in self.note_keys:
            return
        blocks = html_to_blocks(planned.note.html, drop_first_if=planned.note.title)
        if not blocks:
            return
        sessions = self.sessions.get(week["id"], [])
        if not sessions:
            self.summary.warnings.append(
                f"{planned.parsed.term}{planned.parsed.week} has no sessions, so its notes were skipped"
            )
            return
        self._note(blocks, planned.note.key, session_id=sessions[0]["id"])

    # Readings

    def _reading(self, reading: PlannedReading) -> None:
        week = self._week(reading.parsed)
        if week is None:
            return

        existing = self.items_by_key.get(reading.entry.key)
        if existing:
            item_id = existing["id"]
            self.summary.items_kept += 1
        else:
            parsed = reading.parsed
            item_id = str(uuid.uuid4())
            self._add("items", {
                "id": item_id, "kind": parsed.kind, "author": parsed.author, "title": parsed.title,
                "source": parsed.source, "pages": parsed.pages, "year": parsed.year,
                "doc_date": parsed.doc_date, "file_id": self._file(reading),
                "original_file_id": None, "tray_module_id": None, "zotero_key": reading.entry.key,
                "last_page": None, "read_status": "unread",
            })
            position = key_after(self.last_position.get(week["id"]))
            self.last_position[week["id"]] = position
            self._add("week_items", {
                "id": str(uuid.uuid4()), "week_id": week["id"], "item_id": item_id,
                "session_id": None, "position": position,
            })
            self.items_by_key[reading.entry.key] = {"id": item_id}
            self.summary.items_added += 1

        if reading.entry.attachment:
            for annotation in reading.entry.attachment.annotations:
                self._highlight(item_id, annotation)
        for note in reading.entry.notes:
            if note.key in self.note_keys:
                continue
            blocks = html_to_blocks(note.html)
            if blocks:
                self._note(blocks, note.key, item_id=item_id)

    def _file(self, reading: PlannedReading) -> str:
        digest = _sha256(reading.path)
        existing = self.files_by_sha.get(digest)
        if existing:
            self.summary.files_reused += 1
            return existing["id"]
        key = self.api.upload(reading.path, digest, reading.mime)
        file_id = str(uuid.uuid4())
        # Inserting the file row queues its processing.
        self._add("files", {
            "id": file_id, "sha256": digest, "r2_key": key, "mime": reading.mime,
            "bytes": os.path.getsize(reading.path), "original_name": os.path.basename(reading.path),
            "page_count": None, "text_status": "pending",
        })
        self.files_by_sha[digest] = {"id": file_id}
        self.summary.files_uploaded += 1
        return file_id

    def _highlight(self, item_id: str, annotation: Annotation) -> None:
        if annotation.key in self.highlight_keys:
            return
        self._add("highlights", {
            "id": str(uuid.uuid4()), "item_id": item_id, "page": annotation.page_index,
            "rects": annotation.rects, "body": annotation.text, "colour": annotation.color,
            "comment": annotation.comment or None, "question_id": None, "zotero_key": annotation.key,
        })
        self.highlight_keys.add(annotation.key)
        self.summary.highlights_added += 1

    # Notes

    def _note(self, blocks: list[dict], zotero_key: str, **parent) -> None:
        note_id = str(uuid.uuid4())
        self._add("notes", {
            "id": note_id, "session_id": parent.get("session_id"), "item_id": parent.get("item_id"),
            "question_id": None, "zotero_key": zotero_key,
        })
        position = None
        for block in blocks:
            position = key_after(position)
            self._add("note_blocks", {
                "id": block["id"], "note_id": note_id, "position": position, "type": block["type"],
                "content": block, "recording_id": None, "offset_seconds": None, "highlight_id": None,
            })
        self.note_keys.add(zotero_key)
        self.summary.notes_added += 1
