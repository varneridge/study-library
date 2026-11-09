# filename: backend/sync/study.py
"""Mirrors the study library into a Google Drive folder.

The tree is one folder per module, one folder per week inside it, and in each
week a Readings folder with the reading files and a Notes folder with each
note as Markdown, pictures beside it in _assets. Readings and notes that
belong to a module but no week sit in the module's own Readings and Notes
folders, and anything with no live module goes under Unsorted.

The study tables are not described in the jobs code, so the field names are
looked up from a short list of likely names (see SCHEMA). Run with --inspect
first to see the tables and columns the Worker actually returns, and adjust
SCHEMA if a name differs.

Run from backend/: python -m sync.study [--dest PATH] [--dry-run] [--verbose]
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass, field

from .common import (
    STUDY_MIME_EXT, Syncer, SyncError, base_arguments, disambiguate, ext_for_mime, http_url, key_digest,
    md_cell, md_link, pick, run, safe_component, url_shortcut, validate_key,
)

DEFAULT_DEST = r"G:\My Drive\Antigravity\study-library\Study"

# Table names, then field names in the order they are tried. A field is read
# from the first name that has a value, so a schema that uses another name
# needs only that name added here.
SCHEMA = {
    "tables": {
        "modules": ["modules"],
        "weeks": ["weeks"],
        "readings": ["items", "readings"],
        "notes": ["notes"],
        "files": ["files"],
        "links": ["week_items", "week_readings", "reading_weeks"],
    },
    "module": {"title": ["title", "name", "label"], "code": ["code", "module_code", "short"],
               "order": ["position", "sort_order", "sort", "order", "number"]},
    "week": {"module": ["module_id", "module"], "number": ["number", "week_number", "week", "index"],
             "title": ["title", "name", "label", "topic"], "order": ["position", "sort_order", "sort", "order"]},
    "reading": {"week": ["week_id", "week"], "module": ["module_id", "module", "tray_module_id"], "file": ["file_id", "original_file_id", "file"],
                "url": ["url", "link", "href"], "title": ["title", "name", "label"],
                "author": ["author"], "year": ["year"],
                "citation": ["citation", "metadata", "meta"], "order": ["position", "sort_order", "sort", "order"]},
    "file": {"key": ["r2_key", "key", "object_key"], "mime": ["mime", "content_type", "type"],
             "bytes": ["bytes", "size"], "sha": ["sha256", "sha", "hash"], "name": ["original_name", "name", "filename"],
             "citation": ["citation", "metadata", "meta"]},
    "note": {"week": ["week_id", "week"], "reading": ["item_id", "reading_id", "reading"], "module": ["module_id", "module"],
             "title": ["title", "name", "label"], "body": ["body", "content", "markdown", "text", "html", "doc"],
             "order": ["position", "sort_order", "sort", "order"]},
    "link": {"week": ["week_id", "week"], "reading": ["item_id", "reading_id", "reading"]},
}

UNSORTED = "Unsorted"
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
_OBJECT_REF = re.compile(r"/api/objects/([A-Za-z0-9][A-Za-z0-9._/-]*)")


def field_of(kind: str, row: dict, name: str, default=None):
    return pick(row, *SCHEMA[kind][name], default=default)


def table(tables: dict[str, dict[str, dict]], kind: str, required: bool = True) -> dict[str, dict]:
    """The live rows of a table, found under any of its expected names."""
    for name in SCHEMA["tables"][kind]:
        if name in tables:
            return {ident: row for ident, row in tables[name].items() if not row.get("deleted")}
    if required:
        raise SyncError(f"no {kind} table among: {', '.join(sorted(tables)) or 'none'}. "
                        "Run with --inspect and adjust SCHEMA in sync/study.py.")
    return {}


def as_dict(value) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip().startswith("{"):
        try:
            parsed = json.loads(value)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def order_key(kind: str, row: dict) -> tuple:
    order = field_of(kind, row, "order")
    try:
        number = float(order)
    except (TypeError, ValueError):
        number = float("inf")
    return number, str(field_of(kind, row, "title", "")).casefold(), row["id"]


# Names

def module_folder_name(module: dict) -> str:
    code, title = field_of("module", module, "code"), field_of("module", module, "title")
    label = " ".join(str(part).strip() for part in (code, title) if part and str(part).strip())
    if code and title and str(title).strip().lower().startswith(str(code).strip().lower()):
        label = str(title).strip()
    return f"{safe_component(label, 70)} [{module['id'][:8]}]"


def week_folder_name(week: dict, ordinal: int) -> str:
    """"03 Introduction", padded so weeks sort in order in Explorer."""
    raw = field_of("week", week, "number")
    try:
        number = int(float(raw))
    except (TypeError, ValueError):
        number = ordinal
    title = field_of("week", week, "title")
    label = str(title).strip() if title and str(title).strip() else f"Week {number}"
    return safe_component(f"{number:02d} {label}", 80)


def _surname(author) -> str:
    if isinstance(author, dict):
        return str(pick(author, "family", "last", "lastName", "surname", "name", default="")).strip()
    text = str(author).strip()
    if "," in text:
        return text.split(",", 1)[0].strip()
    return text.split()[-1] if text.split() else ""


def citation_label(citation: dict) -> str:
    """"Surname 2020", "Smith and Jones 2020" or "Smith et al. 2020"."""
    authors = pick(citation, "authors", "author", "creators", default=[])
    if isinstance(authors, str):
        authors = [part for part in re.split(r";|\band\b", authors) if part.strip()]
    names = [name for name in (_surname(author) for author in authors or []) if name]
    who = names[0] if len(names) == 1 else f"{names[0]} and {names[1]}" if len(names) == 2 else \
        f"{names[0]} et al." if names else ""
    year = str(pick(citation, "year", "issued", "date", default=""))[:4]
    year = year if year.isdigit() else ""
    return " ".join(part for part in (who, year) if part)


def reading_stem(reading: dict, file_row: dict | None) -> str:
    citation = {**as_dict(field_of("file", file_row or {}, "citation")), **as_dict(field_of("reading", reading, "citation"))}
    title = field_of("reading", reading, "title") or citation.get("title")
    if not title and file_row:
        name = str(field_of("file", file_row, "name", ""))
        title = name.rsplit(".", 1)[0] if "." in name else name
    label = citation_label(citation)
    text = f"{label} - {title}" if label and title else (title or label or "Reading")
    return safe_component(str(text), 70, fallback="Reading")


# Notes

@dataclass
class NoteAssets:
    """Pictures a note refers to, collected while it is converted, so each
    can be fetched into the note's _assets folder."""

    wanted: dict[str, str] = field(default_factory=dict)

    def local(self, key: str, mime: str | None = None) -> str | None:
        try:
            validate_key(key)
        except ValueError:
            return None
        extension = ext_for_mime(mime, STUDY_MIME_EXT) if mime else None
        if extension not in IMAGE_EXT:
            suffix = "." + key.rsplit(".", 1)[-1].lower() if "." in key.rsplit("/", 1)[-1] else ""
            # A picture with no known type is named .png; image viewers read
            # the real format from the bytes, and a picture runs nothing.
            extension = suffix if suffix in IMAGE_EXT else ".png"
        stem = key_digest(key) or hashlib.sha256(key.encode()).hexdigest()
        name = f"{stem[:24]}{extension}"
        self.wanted[name] = key
        return f"_assets/{name}"

    def reference(self, src: str | None, key: str | None = None, mime: str | None = None) -> str | None:
        if key:
            return self.local(key, mime)
        src = src or ""
        match = _OBJECT_REF.search(src)
        if match:
            return self.local(match.group(1).split("?")[0], mime)
        if http_url(src):
            return src
        return None


def _inline(nodes: list, assets: NoteAssets) -> str:
    out = []
    for node in nodes or []:
        kind = node.get("type")
        if kind == "text":
            text = node.get("text", "")
            for mark in node.get("marks") or []:
                name = mark.get("type")
                if name in ("bold", "strong"):
                    text = f"**{text}**"
                elif name in ("italic", "em"):
                    text = f"*{text}*"
                elif name == "code":
                    text = f"`{text}`"
                elif name == "strike":
                    text = f"~~{text}~~"
                elif name == "link" and http_url((mark.get("attrs") or {}).get("href")):
                    text = f"[{text}]({mark['attrs']['href']})"
            out.append(text)
        elif kind in ("hardBreak", "hard_break"):
            out.append("  \n")
        elif kind == "image":
            out.append(_image(node, assets))
        else:
            out.append(_inline(node.get("content") or [], assets))
    return "".join(out)


def _image(node: dict, assets: NoteAssets) -> str:
    attrs = node.get("attrs") or {}
    target = assets.reference(attrs.get("src"), attrs.get("key"), attrs.get("mime"))
    alt = md_cell(attrs.get("alt") or attrs.get("title") or "picture").replace("]", ")")
    return f"![{alt}]({md_link(target)})" if target else f"[{alt}: not synced]"


def _block(node: dict, assets: NoteAssets) -> str:
    kind = node.get("type")
    children = node.get("content") or []
    if kind == "heading":
        level = min(max(int((node.get("attrs") or {}).get("level", 2)), 1), 6)
        return "#" * level + " " + _inline(children, assets)
    if kind == "paragraph":
        return _inline(children, assets)
    if kind in ("bulletList", "bullet_list", "orderedList", "ordered_list", "taskList"):
        ordered = kind in ("orderedList", "ordered_list")
        items = []
        for number, item in enumerate(children, start=1):
            marker = f"{number}. " if ordered else "- "
            if item.get("type") == "taskItem":
                marker += "[x] " if (item.get("attrs") or {}).get("checked") else "[ ] "
            body = "\n\n".join(_block(child, assets) for child in item.get("content") or [])
            indent = " " * len(marker.split("[")[0])
            items.append(marker + body.replace("\n", "\n" + indent))
        return "\n".join(items)
    if kind == "blockquote":
        inner = "\n\n".join(_block(child, assets) for child in children)
        return "\n".join("> " + line if line else ">" for line in inner.split("\n"))
    if kind in ("codeBlock", "code_block"):
        language = (node.get("attrs") or {}).get("language") or ""
        return f"```{language}\n{_inline(children, assets)}\n```"
    if kind in ("horizontalRule", "horizontal_rule"):
        return "---"
    if kind == "image":
        return _image(node, assets)
    if kind == "doc" or children and isinstance(children[0], dict) and children[0].get("type") != "text":
        return "\n\n".join(part for part in (_block(child, assets) for child in children) if part.strip())
    return _inline(children, assets)


def note_markdown(note: dict, assets: NoteAssets) -> str:
    """The note as Markdown. A rich-text document is converted, and plain
    Markdown or HTML is kept as written, with picture links pointed at the
    copies in _assets either way."""
    body = field_of("note", note, "body", "")
    document = body if isinstance(body, dict) else as_dict(body) if isinstance(body, str) else {}
    if document.get("type") == "doc":
        text = _block(document, assets)
    else:
        text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False, indent=1)

        def swap(match: re.Match) -> str:
            local = assets.local(match.group(1).split("?")[0])
            return local or match.group(0)

        text = re.sub(_OBJECT_REF.pattern + r"(\?[^\s\"')>]*)?", swap, text)
    title = note_title(note, text)
    if not text.lstrip().startswith("#"):
        text = f"# {title}\n\n{text}"
    return text.rstrip() + "\n"


def note_title(note: dict, text: str = "") -> str:
    title = field_of("note", note, "title")
    if title and str(title).strip():
        return str(title).strip()
    for line in text.splitlines():
        stripped = line.strip().lstrip("#").strip()
        if stripped:
            return stripped[:70]
    return "Note"


# The tree

@dataclass
class Place:
    """Where a group of readings and notes lives, relative to the root."""
    folder: str
    label: str
    readings: list[dict] = field(default_factory=list)
    notes: list[dict] = field(default_factory=list)


def layout(tables: dict[str, dict[str, dict]]) -> tuple[list[tuple[str, str]], list[Place]]:
    """The managed folders (id, path), parents first, and the places that hold
    readings and notes. Pure, so the whole tree can be tested without a disk."""
    modules = table(tables, "modules")
    weeks = table(tables, "weeks", required=False)
    readings = table(tables, "readings", required=False)
    notes = table(tables, "notes", required=False)
    links = table(tables, "links", required=False)

    folders: list[tuple[str, str]] = []
    module_rel: dict[str, str] = {}
    for module in sorted(modules.values(), key=lambda row: order_key("module", row)):
        module_rel[module["id"]] = module_folder_name(module)
        folders.append((f"module:{module['id']}", module_rel[module["id"]]))

    places: dict[str, Place] = {}
    week_rel: dict[str, str] = {}
    by_module: dict[str, list[dict]] = {}
    for week in weeks.values():
        module_id = field_of("week", week, "module")
        if module_id in module_rel:
            by_module.setdefault(module_id, []).append(week)
    for module_id, module_weeks in by_module.items():
        ordered = sorted(module_weeks, key=lambda row: order_key("week", row))
        names = disambiguate((week["id"], week_folder_name(week, ordinal))
                             for ordinal, week in enumerate(ordered, start=1))
        for week in ordered:
            week_rel[week["id"]] = f"{module_rel[module_id]}/{names[week['id']]}"
            folders.append((f"week:{week['id']}", week_rel[week["id"]]))
            places[f"week:{week['id']}"] = Place(week_rel[week["id"]], names[week["id"]])

    def place_for(week_id, module_id) -> Place:
        if week_id in week_rel:
            return places[f"week:{week_id}"]
        if module_id in module_rel:
            return places.setdefault(f"module:{module_id}", Place(module_rel[module_id], "Module"))
        return places.setdefault("unsorted", Place(UNSORTED, UNSORTED))

    weeks_of: dict[str, list[str]] = {}
    for link in links.values():
        reading_id, week_id = field_of("link", link, "reading"), field_of("link", link, "week")
        if reading_id and week_id in week_rel:
            weeks_of.setdefault(reading_id, []).append(week_id)
    for reading in sorted(readings.values(), key=lambda row: order_key("reading", row)):
        own_week = field_of("reading", reading, "week")
        week_ids = sorted(set(weeks_of.get(reading["id"], []) + ([own_week] if own_week in week_rel else [])))
        module_id = field_of("reading", reading, "module")
        if not week_ids:
            place_for(None, module_id).readings.append(reading)
        for week_id in week_ids:
            place_for(week_id, None).readings.append(reading)

    week_of_reading = {reading["id"]: field_of("reading", reading, "week") for reading in readings.values()}
    for note in sorted(notes.values(), key=lambda row: order_key("note", row)):
        week_id = field_of("note", note, "week") or week_of_reading.get(field_of("note", note, "reading"))
        place_for(week_id, field_of("note", note, "module")).notes.append(note)

    if "unsorted" in places:
        folders.append(("unsorted", UNSORTED))
    ordered_places = [places[key] for key in sorted(places, key=lambda key: places[key].folder.casefold())]
    return folders, ordered_places


@dataclass
class ReadingFile:
    reading: dict
    filename: str | None
    key: str | None = None
    url: str | None = None
    digest: str | None = None
    size: int | None = None
    reason: str = ""


def reading_files(place: Place, files: dict[str, dict]) -> list[ReadingFile]:
    """The file each reading in a place becomes, with names made unique
    within the folder. A reading with no usable file keeps a reason, so the
    index can say why it has no copy."""
    planned: list[ReadingFile] = []
    for reading in place.readings:
        file_row = files.get(str(field_of("reading", reading, "file") or ""))
        stem = reading_stem(reading, file_row)
        key = field_of("file", file_row, "key") if file_row else None
        if key:
            extension = ext_for_mime(field_of("file", file_row, "mime"), STUDY_MIME_EXT)
            try:
                validate_key(key)
            except ValueError:
                planned.append(ReadingFile(reading, None, reason="its stored key is not safe"))
                continue
            if not extension:
                planned.append(ReadingFile(reading, None, reason="its file type is not synced"))
                continue
            sha = str(field_of("file", file_row, "sha", "")).lower()
            size = field_of("file", file_row, "bytes")
            # Only enforce exact SHA/size on raw uploaded objects. Converted and OCR'd files
            # have transformed bytes and will differ from the original scan/upload metadata.
            is_raw = key.startswith("raw/") or key == sha
            digest = sha if (is_raw and re.fullmatch(r"[0-9a-f]{64}", sha)) else (key_digest(key) if is_raw else None)
            planned.append(ReadingFile(reading, stem + extension, key=key,
                                       digest=digest,
                                       size=int(size) if (is_raw and isinstance(size, (int, float))) else None))
        elif http_url(field_of("reading", reading, "url")):
            planned.append(ReadingFile(reading, stem + ".url", url=field_of("reading", reading, "url")))
        else:
            planned.append(ReadingFile(reading, None, reason="it has no file or link"))
    names = disambiguate((item.reading["id"], item.filename) for item in planned if item.filename)
    for item in planned:
        if item.filename:
            item.filename = names[item.reading["id"]]
    return planned


@dataclass
class NoteFile:
    note: dict
    filename: str
    markdown: str
    assets: NoteAssets
    title: str


def note_files(place: Place) -> list[NoteFile]:
    """Each note converted once, named from its title (or its first line when
    it has none) and made unique within the folder."""
    converted = []
    for note in place.notes:
        assets = NoteAssets()
        markdown = note_markdown(note, assets)
        converted.append((note, markdown, assets, note_title(note, markdown)))
    names = disambiguate((note["id"], safe_component(title, 70, fallback="Note") + ".md")
                         for note, _, _, title in converted)
    return [NoteFile(note, names[note["id"]], markdown, assets, title) for note, markdown, assets, title in converted]


def build(tables: dict[str, dict[str, dict]], syncer: Syncer) -> None:
    folders, places = layout(tables)
    files = table(tables, "files", required=False)
    for ident, rel in folders:
        syncer.folder(ident, rel)
    index = ["# Study library", ""]
    for place in places:
        index += [f"## {md_cell(place.folder.replace('/', ' / '))}", ""]
        for item in reading_files(place, files):
            title = md_cell(field_of("reading", item.reading, "title") or item.filename or "Reading")
            if not item.filename:
                index.append(f"- {title} (no copy: {item.reason})")
                continue
            rel = f"{place.folder}/Readings/{item.filename}"
            if item.key:
                syncer.put_object(rel, item.key, item.digest, item.size)
            else:
                syncer.put_text(rel, url_shortcut(item.url))
            index.append(f"- [{title}]({md_link(rel)})")
        for item in note_files(place):
            rel = f"{place.folder}/Notes/{item.filename}"
            syncer.put_text(rel, item.markdown)
            for asset_name, key in item.assets.wanted.items():
                syncer.put_object(f"{place.folder}/Notes/_assets/{asset_name}", key, key_digest(key))
            index.append(f"- Note: [{md_cell(item.title)}]({md_link(rel)})")
        index.append("")
    syncer.put_text("index.md", "\n".join(index).rstrip() + "\n")


def main(argv: list[str] | None = None, build_fn: Callable = build) -> int:
    parser = base_arguments("Mirror study modules, weeks, readings and notes into a local folder.", DEFAULT_DEST)
    return run("study", parser.parse_args(argv), build_fn)


if __name__ == "__main__":
    sys.exit(main())
