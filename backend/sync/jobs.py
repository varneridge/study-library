# filename: backend/sync/jobs.py
"""Mirrors job applications into the Antigravity Jobs workspace on Google
Drive and, when asked, carries finished work back to Study Library.

Each live application has a folder named in the workspace's own convention,
"YYYY-MM-DD - Employer - Role", so a folder made by new_application.py and one
made by the sync look alike. Before making a folder the sync looks for one the
workspace already has for the same employer and role and adopts it, and an
adopted folder keeps the name its author gave it. The folder holds the four
slot files (CV, cover letter, role description, answers to questions) and an
application.md with the stage, dates, notes and timeline. index.csv and
index.md list every application.

With --push, the final files the workspace generates in each folder are
uploaded into the matching slots, and a dated folder that Study Library has no
application for becomes a new one. With --update-reference, the Application
History table of the career reference document is brought in line with Study
Library, and the rest of that document is left exactly as it was.

Run from backend/:
    python -m sync.jobs [--dest PATH] [--push] [--update-reference [PATH]] [--dry-run] [--verbose]
"""

from __future__ import annotations

import csv
import fnmatch
import io
import re
import sys
import unicodedata
import uuid
from collections.abc import Callable, Hashable
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

import requests

from .common import (
    OLD_DIR, Api, ApiError, IntegrityError, Syncer, SyncError, api_for_sync, atomic_write_chunks, base_arguments,
    csv_cell, disambiguate, ext_for_mime, http_url, key_digest, md_cell, md_link, pick, resolve_dest, run,
    safe_component, sha256_file, tagged, uk_date, url_shortcut, validate_key, with_retries,
)
from study.api import stamp

DEFAULT_DEST = r"G:\My Drive\Antigravity\Jobs\applications"
DEFAULT_REFERENCE = r"G:\My Drive\Antigravity\Jobs\reference\Samuel_Leigh_Career_Reference.md"

# The slots and stages as jobs.ts defines them. Stages are stored by key, so
# only the wording lives here.
SLOTS = [("cv", "CV"), ("cl", "Cover letter"), ("rd", "Role description"), ("qs", "Answers to questions")]
SLOT_LABELS = dict(SLOTS)

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


def deleted_applications(tables: dict[str, dict[str, dict]]) -> list[dict]:
    return [row for row in tables.get("applications", {}).values() if row.get("deleted")]


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


# Dates

_ISO_DAY = re.compile(r"^(\d{4}-\d{2}-\d{2})")
_UK_DAY = re.compile(r"^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})")
_SLASH_DAY = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})")


def parse_day(value) -> date | None:
    """A calendar date from an ISO date or timestamp, or from the British forms
    a person writes by hand, such as "24 Oct 2026" or "24/10/2026"."""
    text = str(value or "").strip()
    try:
        if match := _ISO_DAY.match(text):
            return date.fromisoformat(match.group(1))
        if match := _UK_DAY.match(text):
            return datetime.strptime(f"{match.group(1)} {match.group(2)[:3].title()} {match.group(3)}",
                                     "%d %b %Y").date()
        if match := _SLASH_DAY.match(text):
            return date(int(match.group(3)), int(match.group(2)), int(match.group(1)))
    except ValueError:
        return None
    return None


def parse_moment(value) -> float | None:
    """A POSIX timestamp from an ISO timestamp, taking one without a zone as UTC."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)).timestamp()


def app_day(app: dict) -> date | None:
    return parse_day(pick(app, "applied", "created_at"))


# Matching a Study Library row to a folder or a table row that a person named

MATCH_THRESHOLD = 0.6
# A folder or row more than this far from the application's own date belongs
# to another recruitment cycle, such as last year's attempt at the same role.
MATCH_WINDOW_DAYS = 180

_LEGAL = {"ltd", "limited", "llp", "lp", "plc", "inc", "llc", "corp", "corporation", "co", "company", "group",
          "uk", "the"}
_FILLER = {"a", "an", "and", "the", "of", "in", "for", "to", "at", "on", "with"}
# Words almost every role title has, which count for little as evidence.
_GENERIC = {"programme", "program", "scheme", "role", "position", "job", "opportunity", "entry", "level",
            "junior", "trainee", "team", "division", "department"}
# The kind of programme, which separates applications at one employer: a
# summer internship and a graduate scheme are never the same application.
_KINDS = {"graduate": "graduate", "grad": "graduate", "intern": "internship", "internship": "internship",
          "summer": "internship", "spring": "insight", "insight": "insight", "placement": "placement",
          "industrial": "placement", "apprentice": "apprenticeship", "apprenticeship": "apprenticeship"}
_SUFFIXES = ("ational", "ations", "ation", "ions", "ion", "ings", "ing", "ments", "ment", "ants", "ant", "ents",
             "ent", "ers", "er", "ors", "or", "ists", "ist", "als", "al", "ics", "ic", "ies", "s")


def _words(text) -> list[str]:
    folded = unicodedata.normalize("NFKD", str(text or ""))
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch)).casefold().replace("&", " and ")
    return re.findall(r"[a-z0-9]+", folded)


def _stem(word: str) -> str:
    """A light stem, so that "Consultant" and "Consulting" or "Engineer" and
    "Engineering" count as the same word."""
    changed = True
    while changed:
        changed = False
        for suffix in _SUFFIXES:
            if word.endswith(suffix) and len(word) - len(suffix) >= 3:
                word, changed = word[:-len(suffix)], True
                break
    return word[:5]


def employers_match(a, b) -> bool:
    """Whether two employer names are the same firm, ignoring case, accents,
    punctuation and legal suffixes, and allowing one to be the start of the
    other, as with "Goldman Sachs" and "Goldman Sachs International"."""
    left = [word for word in _words(a) if word not in _LEGAL]
    right = [word for word in _words(b) if word not in _LEGAL]
    if not left or not right:
        return False
    shorter, longer = sorted((left, right), key=len)
    return longer[:len(shorter)] == shorter


def _role_parts(text) -> tuple[set[str], dict[str, float]]:
    kinds: set[str] = set()
    weights: dict[str, float] = {}
    for word in _words(text):
        if word in _FILLER or word.isdigit():
            continue
        if word in _KINDS:
            kinds.add(_KINDS[word])
            continue
        stem = _stem(word)
        weights[stem] = max(weights.get(stem, 0.0), 0.25 if word in _GENERIC else 1.0)
    return kinds, weights


def role_score(a, b) -> float | None:
    """How far two role titles describe the same job, from 0 to 1, or None
    when their kinds of programme contradict each other. Shared words are
    weighed against the shorter title, so a longer workspace name such as
    "Consulting Rotational Programme Analyst" still matches "Rotational
    Consultant". A title with nothing distinctive in it gives no evidence
    either way, so it scores exactly the threshold and the employer decides."""
    kinds_a, words_a = _role_parts(a)
    kinds_b, words_b = _role_parts(b)
    if kinds_a and kinds_b and not kinds_a & kinds_b:
        return None
    if 1.0 not in words_a.values() or 1.0 not in words_b.values():
        return MATCH_THRESHOLD
    shared = sum(min(words_a[stem], words_b[stem]) for stem in words_a.keys() & words_b.keys())
    return shared / min(sum(words_a.values()), sum(words_b.values()))


def match_score(employer_a, role_a, day_a: date | None, employer_b, role_b,
                day_b: date | None) -> tuple[float, int] | None:
    """A score and a distance in days for two descriptions of what may be one
    application, or None when they are not a match. The matching is cautious
    on purpose: a duplicate folder or row is visible and easy to merge by
    hand, whereas a wrong merge silently mixes two applications."""
    if not employers_match(employer_a, employer_b):
        return None
    gap = abs((day_a - day_b).days) if day_a and day_b else None
    if gap is not None and gap > MATCH_WINDOW_DAYS:
        return None
    score = role_score(role_a, role_b)
    if score is None or score < MATCH_THRESHOLD:
        return None
    return score, MATCH_WINDOW_DAYS + 1 if gap is None else gap


def assign(left: dict[Hashable, object], right: dict[Hashable, object],
           scorer: Callable[[object, object], tuple[float, int] | None]) -> dict:
    """Pairs each left item with at most one right item, best scores first
    and the nearest in date breaking ties, so the result does not depend on
    the order the items arrive in."""
    scored = []
    for left_key, left_value in left.items():
        for right_key, right_value in right.items():
            result = scorer(left_value, right_value)
            if result:
                scored.append(((-result[0], result[1], str(left_key), str(right_key)), left_key, right_key))
    scored.sort(key=lambda item: item[0])
    pairs: dict = {}
    claimed: set = set()
    for _, left_key, right_key in scored:
        if left_key not in pairs and right_key not in claimed:
            pairs[left_key] = right_key
            claimed.add(right_key)
    return pairs


# Folders

_DATED = re.compile(r"^(\d{4}-\d{2}-\d{2}) - (.+)$")
# The bracketed id the sync adds when two folders would otherwise share a
# name, which is lower-case hex so that a role such as "Analyst [London]" is
# not mistaken for one.
_TAG = re.compile(r"^(.*?) \[([0-9a-f][0-9a-f-]{7,35})\]$")


@dataclass(frozen=True)
class LocalFolder:
    name: str
    day: date | None
    employer: str
    role: str
    tag: str | None = None


def parse_folder(name: str) -> LocalFolder | None:
    """What a folder name says about its application: the workspace's dated
    form, or an older undated name the sync made with an id tag. Any other
    folder is not an application folder and is left alone."""
    stem, tag = name, None
    if match := _TAG.match(name):
        stem, tag = match.group(1), match.group(2)
    day, label = None, stem
    if match := _DATED.match(stem):
        day, label = parse_day(match.group(1)), match.group(2)
    if day is None and tag is None:
        return None
    employer, _, role = label.partition(" - ")
    return LocalFolder(name, day, employer.strip(), role.strip(), tag)


def folder_ident(app: dict) -> str:
    return f"application:{app['id']}"


def app_folder_name(app: dict, day: date | None = None) -> str:
    """The workspace's name for an application folder. The date is the one
    the folder was first given, which callers pass in, or else the applied
    date, the date the row was made, or today."""
    label = " - ".join(part for part in ((app.get("employer") or "").strip(), (app.get("role") or "").strip()) if part)
    return f"{(day or app_day(app) or date.today()).isoformat()} - {safe_component(label, 60)}"


def existing_folders(root: Path) -> dict[str, str]:
    """The folders at the top of the destination, by their name without case."""
    if not root.is_dir():
        return {}
    return {entry.name.casefold(): entry.name for entry in root.iterdir() if entry.is_dir()}


@dataclass
class FolderPlan:
    """Where each application's folder is going this run (target), where it
    is now when that differs from what the manifest records (current), which
    folders belong to the workspace rather than the sync (adopted), and the
    dated folders no application has claimed (unclaimed)."""
    target: dict[str, str] = field(default_factory=dict)
    current: dict[str, str] = field(default_factory=dict)
    adopted: set[str] = field(default_factory=set)
    unclaimed: list[LocalFolder] = field(default_factory=list)


def plan_folders(apps: list[dict], syncer: Syncer) -> FolderPlan:
    """Decides every application's folder before anything is written.

    A folder already recorded for the application is kept. Otherwise a folder
    carrying the application's id tag is taken back and renamed to the
    convention, and failing that a workspace folder for the same employer and
    role is adopted under the name its author gave it. Only then is a new
    folder named, with the id added if the name is already in use, so the
    sync never writes into a folder that belongs to another application."""
    plan = FolderPlan()
    manifest = syncer.manifest
    adopted_before = set(manifest.extras.get("adopted", []))
    on_disk = existing_folders(syncer.root)
    managed = {rel.casefold() for rel in manifest.folders.values()}
    created: dict[str, str | None] = {}
    unplaced: dict[str, dict] = {}
    for app in apps:
        previous = manifest.folders.get(folder_ident(app))
        if previous and "/" not in previous and previous.casefold() in on_disk:
            if folder_ident(app) in adopted_before:
                plan.target[app["id"]] = previous
                plan.adopted.add(app["id"])
            else:
                created[app["id"]] = previous
                plan.current[app["id"]] = previous
        else:
            unplaced[app["id"]] = app

    candidates = [folder for folder in (parse_folder(name) for key, name in sorted(on_disk.items())
                                        if key not in managed and not name.startswith(("_", ".")))
                  if folder]
    loose = []
    for folder in candidates:
        owners = [ident for ident in unplaced if folder.tag and ident.startswith(folder.tag)]
        if len(owners) == 1:
            created[owners[0]] = folder.name
            plan.current[owners[0]] = folder.name
            del unplaced[owners[0]]
        elif folder.tag is None and folder.day is not None:
            loose.append(folder)

    pairs = assign(unplaced, {folder.name: folder for folder in loose},
                   lambda app, folder: match_score(app.get("employer"), app.get("role"), app_day(app),
                                                   folder.employer, folder.role, folder.day))
    for ident, name in pairs.items():
        plan.target[ident] = name
        plan.adopted.add(ident)
        del unplaced[ident]
    plan.unclaimed = [folder for folder in loose if folder.name not in pairs.values()]
    for ident in unplaced:
        created[ident] = None

    by_id = {app["id"]: app for app in apps}
    names = {}
    for ident, source in created.items():
        parsed = parse_folder(source) if source else None
        names[ident] = app_folder_name(by_id[ident], parsed.day if parsed and parsed.day else
                                       app_day(by_id[ident]) or syncer.today)
    taken = set(on_disk) | {plan.target[ident].casefold() for ident in plan.adopted}
    for ident, name in disambiguate(names.items()).items():
        own = (plan.current.get(ident) or manifest.folders.get(folder_ident(by_id[ident])) or "").casefold()
        for choice in (name, tagged(names[ident], ident[:8]), tagged(names[ident], ident)):
            if choice.casefold() not in taken or choice.casefold() == own:
                break
        plan.target[ident] = choice
        taken.add(choice.casefold())
    return plan


def remember_adoptions(syncer: Syncer, tables: dict, plan: FolderPlan) -> None:
    """Records which folders are the workspace's own, so a later run neither
    renames them nor mistakes them for folders the sync made, and forgets
    what it pushed for rows that are gone."""
    extras = syncer.manifest.extras
    live = {folder_ident(app) for app in live_applications(tables)}
    earlier = {ident for ident in extras.get("adopted", []) if ident in syncer.manifest.folders and ident not in live}
    extras["adopted"] = sorted(earlier | {f"application:{ident}" for ident in plan.adopted})
    known = {row.get("id") for row in tables.get("applications", {}).values()}
    if extras.get("pushed"):
        extras["pushed"] = {ident: slots for ident, slots in extras["pushed"].items() if ident in known}


# Push: final files from the workspace into Study Library

PDF_MIME = "application/pdf"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# In order of preference within each slot, so a PDF beats the Word file it
# was made from, which beats the Markdown draft.
PUSH_PATTERNS: dict[str, tuple[str, ...]] = {
    "cv": ("CV*.pdf",),
    "cl": ("Cover Letter - *.pdf", "Cover Letter - *.docx", "final_letter.md"),
    "rd": ("Role - *.pdf", "Role description.pdf"),
    "qs": ("Answers - *.pdf", "Answers - *.docx", "final_answers.md"),
}
# The app accepts plain text but not Markdown, and Markdown is plain text.
PUSH_MIME = {".pdf": PDF_MIME, ".docx": DOCX_MIME, ".md": "text/plain"}
# A cover letter or answers only exist once an application has gone in, so
# either one marks a new local folder as applied rather than still to apply.
APPLIED_SLOTS = ("cl", "qs")


@dataclass
class Candidate:
    slot: str
    path: Path
    sha: str
    size: int
    mtime: float


def find_candidates(folder: Path, rel: str, syncer: Syncer) -> dict[str, Candidate]:
    """The final file for each slot in one folder: the first pattern that has
    any match, and the newest file within it. Files the sync wrote and has
    not seen edited, copies it saved beside a conflict, and Office lock files
    are never candidates, so nothing the sync mirrored is pushed back."""
    try:
        files = [entry for entry in folder.iterdir() if entry.is_file()
                 and not entry.name.startswith((".", "~$")) and "(from Study Library" not in entry.name]
    except OSError:
        return {}
    found = {}
    for slot, patterns in PUSH_PATTERNS.items():
        for pattern in patterns:
            matches = [entry for entry in files if fnmatch.fnmatchcase(entry.name.casefold(), pattern.casefold())
                       and not syncer.mirrors(f"{rel}/{entry.name}")]
            if matches:
                chosen = max(matches, key=lambda entry: (entry.stat().st_mtime, entry.name))
                stat = chosen.stat()
                found[slot] = Candidate(slot, chosen, sha256_file(chosen), stat.st_size, stat.st_mtime)
                break
    return found


def push_decision(candidate: Candidate, slot, last: dict | None, row_modified: str | None) -> str:
    """Whether a local final file should replace what a slot holds: "same"
    when it already does, "push" when the slot is empty or still holds what
    this sync last put there, "busy" while an upload is in progress, and
    otherwise "push" only if the file is newer than the slot, else "older"."""
    if isinstance(slot, dict) and slot.get("state") == "uploading":
        return "busy"
    if not (isinstance(slot, dict) and slot.get("state") == "saved" and (slot.get("key") or slot.get("url"))):
        return "push"
    last = last or {}
    held = key_digest(slot.get("key")) or (last.get("sha") if slot.get("key") and slot.get("key") == last.get("key")
                                            else None)
    if held == candidate.sha:
        return "same"
    if held is not None and held == last.get("sha"):
        return "push"
    when = parse_moment(pick(slot, "uploaded_at", "at") or row_modified)
    return "push" if when is not None and candidate.mtime > when else "older"


@dataclass
class _Pending:
    app_id: str
    row: dict
    records: dict[str, dict]
    folder: str | None = None


def _upload(api: Api, syncer: Syncer, candidate: Candidate, rel: str) -> dict | None:
    """Uploads one file and returns the slot that refers to it, or None in a
    dry run or when the upload fails, which is reported."""
    mime = PUSH_MIME[candidate.path.suffix.lower()]
    label = SLOT_LABELS[candidate.slot]
    if syncer.dry_run:
        syncer.report.note(f"would upload: {rel} as the {label.lower()}")
        return None
    try:
        key = validate_key(with_retries(lambda: api.upload(str(candidate.path), candidate.sha, mime)))
    except (ApiError, OSError, ValueError, requests.RequestException) as error:
        syncer.report.errors.append(f"{rel}: upload failed: {error}")
        syncer.report.note(f"error: {rel}: upload failed: {error}")
        return None
    syncer.report.note(f"uploaded: {rel} as the {label.lower()}")
    try:
        syncer.seed(key, candidate.path, candidate.sha)
    except (OSError, IntegrityError):
        pass  # the file changed after it was hashed, so the mirror fetches the stored copy instead
    return {"state": "saved", "key": key, "name": candidate.path.name, "mime": mime, "bytes": candidate.size}


def _failed_ids(failures: list) -> set[str] | None:
    """The ids of the rows the Worker refused, or None when a refusal does not
    say which row it was about, in which case every row is taken as refused."""
    ids = set()
    for failure in failures:
        ident = None
        if isinstance(failure, dict):
            ident = failure.get("id") or (failure.get("row") or {}).get("id")
        if not ident:
            return None
        ids.add(ident)
    return ids


def push_changes(tables: dict, syncer: Syncer, plan: FolderPlan, api: Api) -> None:
    """Uploads final files into their slots and creates applications for
    unclaimed dated folders, in one push. Only rows the Worker accepts are
    changed in memory, so the mirror that follows shows what Study Library
    really holds, and only accepted uploads are remembered as pushed."""
    report = syncer.report
    pushed = syncer.manifest.extras.setdefault("pushed", {})
    rows = tables.setdefault("applications", {})
    changes: list[dict] = []
    pending: list[_Pending] = []
    uploads = 0

    for app in sort_applications(live_applications(tables)):
        where = plan.current.get(app["id"]) or plan.target[app["id"]]
        folder = syncer.path(where)
        if not folder.is_dir():
            continue
        slots, records = {}, {}
        for slot, candidate in find_candidates(folder, where, syncer).items():
            rel = f"{where}/{candidate.path.name}"
            decision = push_decision(candidate, app.get(f"file_{slot}"), pushed.get(app["id"], {}).get(slot),
                                     app.get("modified_at"))
            if decision == "older":
                report.note(f"held back: {rel} is older than the {SLOT_LABELS[slot].lower()} Study Library holds")
            elif decision == "busy":
                report.note(f"held back: {rel}, as an upload to that slot is still in progress")
            elif decision == "push":
                uploads += 1
                if data := _upload(api, syncer, candidate, rel):
                    slots[f"file_{slot}"] = data
                    records[slot] = {"sha": candidate.sha, "key": data["key"]}
        if slots:
            moment = stamp(app.get("modified_at"))
            changes.append({"table": "applications", "row": {"id": app["id"], **slots, "modified_at": moment}})
            pending.append(_Pending(app["id"], {**app, **slots, "modified_at": moment}, records))

    gone = deleted_applications(tables)
    for folder in plan.unclaimed:
        if any(match_score(row.get("employer"), row.get("role"), app_day(row), folder.employer, folder.role,
                           folder.day) for row in gone):
            report.note(f"left alone: {folder.name} matches a deleted application, so it is not recreated")
            continue
        candidates = find_candidates(syncer.path(folder.name), folder.name, syncer)
        stage = "applied" if any(slot in candidates for slot in APPLIED_SLOTS) else "to_apply"
        if syncer.dry_run:
            report.note(f"would create application: {folder.name} ({stage_label(stage)})")
            for candidate in candidates.values():
                uploads += 1
                _upload(api, syncer, candidate, f"{folder.name}/{candidate.path.name}")
            continue
        row = {"id": str(uuid.uuid4()), "employer": folder.employer, "role": folder.role, "stage": stage,
               "applied": folder.day.isoformat() if stage == "applied" and folder.day else None,
               "next_deadline": None, "notes": None, **{f"file_{slot}": None for slot, _ in SLOTS},
               "deleted": False, "modified_at": stamp()}
        records = {}
        for slot, candidate in candidates.items():
            uploads += 1
            if data := _upload(api, syncer, candidate, f"{folder.name}/{candidate.path.name}"):
                row[f"file_{slot}"] = data
                records[slot] = {"sha": candidate.sha, "key": data["key"]}
        changes.append({"table": "applications", "row": row})
        pending.append(_Pending(row["id"], row, records, folder.name))

    created = 0
    if changes:
        try:
            failures = with_retries(lambda: api.push(changes))
        except (ApiError, requests.RequestException) as error:
            report.errors.append(f"push to Study Library failed: {error}")
            report.note(f"error: push to Study Library failed: {error}")
            failures, pending = [], []
        refused = _failed_ids(failures)
        for failure in failures:
            report.errors.append(f"push refused: {failure}")
            report.note(f"error: push refused: {failure}")
        keys = {row.get("id"): key for key, row in rows.items()}
        for item in pending:
            if refused is None or item.app_id in refused:
                continue
            rows[keys.get(item.app_id, item.app_id)] = item.row
            if item.records:
                pushed.setdefault(item.app_id, {}).update(item.records)
            if item.folder:
                created += 1
                report.note(f"created application: {item.folder} ({stage_label(item.row['stage'])})")
                plan.target[item.app_id] = item.folder
                plan.adopted.add(item.app_id)
    verb = "to upload" if syncer.dry_run else "uploaded"
    report.note(f"push: {uploads} {verb}, {created} applications created")


# Rendering

INDEX_COLUMNS = ["Employer", "Role", "Stage", "Applied", "Next deadline", "Folder", "Files", "Notes"]


def _folder_of(app: dict, folders: dict[str, str] | None) -> str:
    return (folders or {}).get(app["id"]) or app_folder_name(app)


def render_index_csv(apps: list[dict], folders: dict[str, str] | None = None) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(INDEX_COLUMNS)
    for app in sort_applications(apps):
        files = ", ".join(target.filename for target in slot_targets(app))
        writer.writerow([csv_cell(value) for value in (
            app.get("employer"), app.get("role"), stage_label(app.get("stage")), app.get("applied"),
            app.get("next_deadline"), _folder_of(app, folders), files, app.get("notes"))])
    return buffer.getvalue()


def render_index_md(apps: list[dict], folders: dict[str, str] | None = None) -> str:
    ordered = sort_applications(apps)
    lines = ["# Applications", "", f"{sum(is_open(app) for app in ordered)} open, "
             f"{sum(not is_open(app) for app in ordered)} closed.", "",
             "| Employer | Role | Stage | Next deadline | Applied | Folder |",
             "| --- | --- | --- | --- | --- | --- |"]
    for app in ordered:
        folder = _folder_of(app, folders)
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


# The career reference document

class ReferenceDocError(Exception):
    """The reference document has no Application History table that the sync
    can edit without guessing at its structure."""


_HISTORY = re.compile(r"^(#{1,6})\s*11\.?\s+Application History\b", re.IGNORECASE)
_HEADING = re.compile(r"^(#{1,6})\s")
_FENCE = re.compile(r"^\s*(```|~~~)")
REFERENCE_COLUMNS = ["Employer", "Role", "Stage", "Applied", "Next deadline", "Notes"]
# Recognised header names, tried as whole names first and then as words
# within a longer name. Deadline is tried before the applied date so that a
# header such as "Deadline date" is not taken for the applied date.
COLUMN_ALIASES: dict[str, tuple[str, ...]] = {
    "employer": ("employer", "company", "organisation", "organization", "firm"),
    "role": ("role", "position", "job title", "title", "programme", "program"),
    "stage": ("stage", "status", "outcome"),
    "deadline": ("next deadline", "deadline"),
    "applied": ("applied", "date applied", "applied on", "application date", "date"),
    "notes": ("notes", "note", "comments"),
}
# An empty value in Study Library never blanks these, because the document
# often holds detail typed there by hand. The stage and the next deadline
# always follow Study Library, as they describe where things stand now.
KEEP_WHEN_EMPTY = {"applied", "notes"}


def split_cells(line: str) -> list[str] | None:
    """The cells of a Markdown table row, as raw text, splitting only on pipes
    that are not escaped; or None if the line is not a table row."""
    text = line.strip()
    if not text.startswith("|"):
        return None
    cells, current, index = [], "", 1
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text):
            current += text[index:index + 2]
            index += 2
            continue
        if char == "|":
            cells.append(current.strip())
            current = ""
        else:
            current += char
        index += 1
    if current.strip():
        cells.append(current.strip())
    return cells


def is_separator(line: str) -> bool:
    text = line.strip()
    if "-" not in text or "|" not in text:
        return False
    return all(re.fullmatch(r"\s*:?-+:?\s*", part) for part in text.strip("|").split("|"))


def clean_cell(text: str) -> str:
    """A cell's text without Markdown links, emphasis or escapes, for comparing."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text or "").replace("\\|", "|")
    return re.sub(r"\s+", " ", re.sub(r"[*_`]+", "", text)).strip()


def render_row(cells: list[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def map_columns(header: list[str]) -> dict[str, int]:
    names = [" ".join(re.sub(r"[^a-z0-9]+", " ", clean_cell(cell).casefold()).split()) for cell in header]
    columns: dict[str, int] = {}
    for exact in (True, False):
        for name, aliases in COLUMN_ALIASES.items():
            if name in columns:
                continue
            for alias in aliases:
                found = next((index for index, header_name in enumerate(names) if index not in columns.values()
                              and (header_name == alias if exact else re.search(rf"\b{re.escape(alias)}\b", header_name))),
                             None)
                if found is not None:
                    columns[name] = found
                    break
    return columns


def _history_section(bare: list[str]) -> tuple[int, int]:
    """The first line and the line after the last of the Application History
    section, ignoring anything inside code fences."""
    fenced, start, level = False, None, 0
    for index, line in enumerate(bare):
        if _FENCE.match(line):
            fenced = not fenced
            continue
        if fenced:
            continue
        if start is None:
            if match := _HISTORY.match(line):
                start, level = index, len(match.group(1))
        elif (match := _HEADING.match(line)) and len(match.group(1)) <= level:
            return start, index
    if start is None:
        raise ReferenceDocError("there is no '# 11. Application History' section")
    return start, len(bare)


def _format_day(value, iso: bool) -> str:
    day = parse_day(value)
    if not day:
        return ""
    return day.isoformat() if iso else f"{day.day} {day:%b %Y}"


def _same(name: str, old: str, new: str) -> bool:
    if name in ("applied", "deadline"):
        before, after = parse_day(clean_cell(old)), parse_day(new)
        if before or after:
            return before == after
    return clean_cell(old).casefold() == clean_cell(new).casefold()


def _ending(line: str) -> str:
    return line[len(line.rstrip("\r\n")):]


def update_reference(text: str, apps: list[dict]) -> tuple[str, int, int]:
    """The document with its Application History table brought in line with
    the applications, and the numbers of rows updated and added. Rows are
    matched to applications as folders are, a matched row has its stage,
    dates and notes updated and keeps the employer and role as written, and
    an application with no row gets a new one at the end. Rows for anything
    Study Library does not hold, every other column, and every line outside
    the rows that change are left exactly as they were."""
    lines = text.splitlines(keepends=True)
    bare = [line.rstrip("\r\n") for line in lines]
    newline = "\r\n" if "\r\n" in text else "\n"
    start, end = _history_section(bare)
    header_at = next((index for index in range(start + 1, end - 1) if split_cells(bare[index]) is not None
                      and not is_separator(bare[index]) and is_separator(bare[index + 1])), None)
    if header_at is None:
        if not apps:
            return text, 0, 0
        # The section has no table yet, so one is added after its last line.
        insert_at = max([index + 1 for index in range(start, end) if bare[index].strip()], default=start + 1)
        if insert_at and not _ending(lines[insert_at - 1]):
            lines[insert_at - 1] += newline
        block = ["", render_row(REFERENCE_COLUMNS), render_row(["---"] * len(REFERENCE_COLUMNS))]
        if insert_at < len(lines) and bare[insert_at].strip():
            block.append("")
        lines[insert_at:insert_at] = [line + newline for line in block]
        return update_reference("".join(lines), apps)

    header = split_cells(bare[header_at]) or []
    columns = map_columns(header)
    if "employer" not in columns:
        raise ReferenceDocError("the Application History table has no Employer or Company column, "
                                "so its rows cannot be matched")
    width = len(header)
    body = []
    index = header_at + 2
    while index < end and split_cells(bare[index]) is not None:
        body.append(index)
        index += 1
    cells_of = {index: split_cells(bare[index]) or [] for index in body}

    def cell(cells: list[str], name: str) -> str:
        column = columns.get(name)
        return clean_cell(cells[column]) if column is not None and column < len(cells) else ""

    iso = any(_ISO_DAY.match(cell(cells, name)) for cells in cells_of.values() for name in ("applied", "deadline"))

    def wanted(app: dict) -> dict[str, str]:
        return {"employer": md_cell(app.get("employer")), "role": md_cell(app.get("role")),
                "stage": md_cell(stage_label(app.get("stage"))), "applied": _format_day(app.get("applied"), iso),
                "deadline": _format_day(app.get("next_deadline"), iso), "notes": md_cell(app.get("notes"))}

    by_id = {app["id"]: app for app in apps}
    described = {index: (cell(cells, "employer"), cell(cells, "role"), parse_day(cell(cells, "applied")))
                 for index, cells in cells_of.items()}
    pairs = assign(by_id, described, lambda app, row: match_score(app.get("employer"), app.get("role"),
                                                                  app_day(app), *row))
    updated = 0
    for ident, index in pairs.items():
        cells = cells_of[index] + [""] * max(0, width - len(cells_of[index]))
        values = wanted(by_id[ident])
        changed = False
        for name in ("stage", "applied", "deadline", "notes"):
            column = columns.get(name)
            if column is None or (not values[name] and name in KEEP_WHEN_EMPTY) or _same(name, cells[column], values[name]):
                continue
            cells[column] = values[name]
            changed = True
        if changed:
            lines[index] = render_row(cells) + _ending(lines[index])
            updated += 1

    fresh = sorted((app for app in apps if app["id"] not in pairs),
                   key=lambda app: (app.get("applied") is None, app.get("applied") or "",
                                    (app.get("employer") or "").casefold(), app["id"]))
    if fresh:
        last = body[-1] if body else header_at + 1
        if not _ending(lines[last]):
            lines[last] += newline
        added = []
        for app in fresh:
            cells = [""] * width
            values = wanted(app)
            for name, column in columns.items():
                cells[column] = values[name]
            added.append(render_row(cells) + newline)
        lines[last + 1:last + 1] = added
    return "".join(lines), updated, len(fresh)


def update_reference_file(path: Path, apps: list[dict], syncer: Syncer) -> None:
    """Rewrites the reference document atomically when its table changes,
    after keeping the previous version in an _Old folder beside it (once a
    day), and refuses to write if the file changed while it was being read.
    Every problem is reported rather than stopping the mirror."""
    report = syncer.report
    try:
        raw = path.read_bytes()
        text = raw.decode("utf-8-sig")
    except FileNotFoundError:
        report.errors.append(f"{path}: the reference document was not found")
        return
    except (OSError, UnicodeDecodeError) as error:
        report.errors.append(f"{path}: could not read the reference document: {error}")
        return
    try:
        new_text, updated, added = update_reference(text, apps)
    except ReferenceDocError as error:
        report.errors.append(f"{path.name}: {error}")
        report.note(f"error: {path.name}: {error}")
        return
    if new_text == text:
        report.unchanged += 1
        report.note(f"unchanged: {path.name}", always=False)
        return
    summary = f"{path.name} ({updated} rows updated, {added} added)"
    report.written += 1
    if syncer.dry_run:
        report.note(f"would update: {summary}")
        return
    backup = path.parent / OLD_DIR / f"{path.stem} (before sync {syncer.today.isoformat()}){path.suffix}"
    data = (b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b"") + new_text.encode("utf-8")
    try:
        if not backup.exists():
            backup.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_chunks(backup, [raw])
        if path.read_bytes() != raw:
            report.written -= 1
            report.conflicts.append(f"{path.name}: changed while the sync was reading it, so it was left alone")
            return
        atomic_write_chunks(path, [data])
    except OSError as error:
        report.written -= 1
        report.errors.append(f"{path.name}: {error}")
        return
    report.note(f"updated: {summary}")


# The run

@dataclass
class Options:
    push: bool = False
    api: Api | None = None
    reference: Path | None = None


def build(tables: dict[str, dict[str, dict]], syncer: Syncer, options: Options | None = None) -> None:
    options = options or Options()
    plan = plan_folders(live_applications(tables), syncer)
    if options.push:
        if options.api is None:
            raise SyncError("--push needs a Study Library client")
        push_changes(tables, syncer, plan, options.api)
    apps = live_applications(tables)
    for app in sort_applications(apps):
        ident = folder_ident(app)
        current = plan.current.get(app["id"])
        if current and syncer.manifest.folders.get(ident) != current:
            # A folder found by its id tag is recorded where it is, so that
            # Syncer.folder renames it rather than making a second one.
            syncer.manifest.folders[ident] = current
        folder = syncer.folder(ident, plan.target[app["id"]])
        for target in slot_targets(app):
            rel = f"{folder}/{target.filename}"
            if target.key:
                syncer.put_object(rel, target.key, target.digest, target.bytes)
            else:
                syncer.put_text(rel, url_shortcut(target.url))
        syncer.put_text(f"{folder}/application.md", render_application_md(app, live_events(tables, app["id"])))
    remember_adoptions(syncer, tables, plan)
    # Excel opens a CSV with a byte order mark as UTF-8, so accented employer
    # names are not mangled.
    syncer.put_bytes("index.csv", b"\xef\xbb\xbf" + render_index_csv(apps, plan.target).encode("utf-8"))
    syncer.put_text("index.md", render_index_md(apps, plan.target))
    if options.reference:
        update_reference_file(options.reference, apps, syncer)


def arguments():
    parser = base_arguments("Mirror job applications and their files into the Jobs workspace.", DEFAULT_DEST)
    parser.add_argument("--push", action="store_true",
                        help="also upload final files from each folder into their slots, and create applications "
                             "for dated folders that Study Library does not have")
    parser.add_argument("--update-reference", nargs="?", const=DEFAULT_REFERENCE, default=None, metavar="PATH",
                        help=f"also update the Application History table (default: {DEFAULT_REFERENCE})")
    return parser


def main(argv: list[str] | None = None, api_factory: Callable[[Path], Api] = api_for_sync,
         out: Callable[[str], None] = print) -> int:
    args = arguments().parse_args(argv)
    reference = None
    if args.update_reference:
        # Resolved before anything is pulled, so a wrong path or an unmounted
        # drive stops the run before it has written anything.
        try:
            reference = resolve_dest(args.update_reference, "--update-reference")
        except SyncError as error:
            out(f"Stopped: {error}")
            return 2
    clients: list[Api] = []

    def factory(env: Path) -> Api:
        clients.append(api_factory(env))
        return clients[-1]

    def build_with_options(tables: dict, syncer: Syncer) -> None:
        build(tables, syncer, Options(push=args.push, api=clients[-1] if clients else None, reference=reference))

    return run("jobs", args, build_with_options, api_factory=factory, out=out)


if __name__ == "__main__":
    sys.exit(main())
