"""Read items, files, notes and annotations from a copy of zotero.sqlite.

The live database is locked while Zotero runs, so this always works on a
temporary copy, opened read-only.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass, field

READABLE_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
# Zotero annotation types: 1 is a highlight and 5 is an underline.
HIGHLIGHT_TYPES = {1, 5}


@dataclass
class Annotation:
    key: str
    type: int
    text: str | None
    comment: str | None
    color: str
    page_index: int
    rects: list


@dataclass
class Note:
    key: str
    html: str
    title: str | None


@dataclass
class Attachment:
    item_id: int
    key: str
    content_type: str | None
    path: str | None
    annotations: list[Annotation] = field(default_factory=list)
    notes: list[Note] = field(default_factory=list)


@dataclass
class Entry:
    item_id: int
    key: str
    item_type: str
    title: str
    note: Note | None = None
    attachment: Attachment | None = None
    notes: list[Note] = field(default_factory=list)


class ZoteroLibrary:
    def __init__(self, zotero_dir: str):
        self.zotero_dir = os.path.expanduser(zotero_dir)
        source = os.path.join(self.zotero_dir, "zotero.sqlite")
        if not os.path.exists(source):
            raise FileNotFoundError(f"no zotero.sqlite in {self.zotero_dir}")
        self._tmp = tempfile.TemporaryDirectory()
        copy = os.path.join(self._tmp.name, "zotero.sqlite")
        shutil.copyfile(source, copy)
        self.db = sqlite3.connect(f"file:{copy}?mode=ro", uri=True)
        self.db.row_factory = sqlite3.Row
        self.fields_table = "fieldsCombined" if self._has_table("fieldsCombined") else "fields"
        self.types_table = "itemTypesCombined" if self._has_table("itemTypesCombined") else "itemTypes"
        self.has_annotations = self._has_table("itemAnnotations")
        self.deleted = {row[0] for row in self.db.execute("select itemID from deletedItems")}

    def close(self) -> None:
        self.db.close()
        self._tmp.cleanup()

    def __enter__(self) -> "ZoteroLibrary":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def _has_table(self, name: str) -> bool:
        row = self.db.execute(
            "select 1 from sqlite_master where type = 'table' and name = ?", (name,)
        ).fetchone()
        return row is not None

    # Collections

    def collections_named(self, name: str) -> list[sqlite3.Row]:
        return self.db.execute(
            "select collectionID, collectionName, key from collections where collectionName = ?",
            (name,),
        ).fetchall()

    def collection_entries(self, collection_id: int) -> list[Entry]:
        rows = self.db.execute(
            "select itemID from collectionItems where collectionID = ?", (collection_id,)
        ).fetchall()
        entries = []
        for row in rows:
            if row["itemID"] in self.deleted:
                continue
            entry = self._entry(row["itemID"])
            if entry is not None:
                entries.append(entry)
        return entries

    # Items

    def _entry(self, item_id: int) -> Entry | None:
        row = self.db.execute(
            f"""select i.key, t.typeName from items i
                  join {self.types_table} t on t.itemTypeID = i.itemTypeID
                 where i.itemID = ?""",
            (item_id,),
        ).fetchone()
        if row is None or row["typeName"] == "annotation":
            return None

        item_type = row["typeName"]
        entry = Entry(item_id=item_id, key=row["key"], item_type=item_type, title="")

        if item_type == "note":
            note = self._note(item_id)
            if note is None:
                return None
            entry.note = note
            entry.title = note.title or ""
            return entry

        entry.title = self._title(item_id) or ""

        if item_type == "attachment":
            entry.attachment = self._attachment(item_id)
        else:
            entry.attachment = self._first_readable_child(item_id)
            entry.notes = self._child_notes(item_id)

        if entry.attachment is not None:
            entry.notes.extend(entry.attachment.notes)
        return entry

    def _title(self, item_id: int) -> str | None:
        row = self.db.execute(
            f"""select v.value from itemData d
                  join itemDataValues v on v.valueID = d.valueID
                  join {self.fields_table} f on f.fieldID = d.fieldID
                 where d.itemID = ? and f.fieldName = 'title'""",
            (item_id,),
        ).fetchone()
        return row["value"] if row else None

    def _note(self, item_id: int) -> Note | None:
        row = self.db.execute(
            """select i.key, n.note, n.title from itemNotes n
                 join items i on i.itemID = n.itemID
                where n.itemID = ?""",
            (item_id,),
        ).fetchone()
        if row is None:
            return None
        return Note(key=row["key"], html=row["note"] or "", title=row["title"])

    def _child_notes(self, parent_id: int) -> list[Note]:
        rows = self.db.execute(
            """select i.itemID, i.key, n.note, n.title from itemNotes n
                 join items i on i.itemID = n.itemID
                where n.parentItemID = ?""",
            (parent_id,),
        ).fetchall()
        return [
            Note(key=row["key"], html=row["note"] or "", title=row["title"])
            for row in rows
            if row["itemID"] not in self.deleted
        ]

    def _first_readable_child(self, parent_id: int) -> Attachment | None:
        rows = self.db.execute(
            """select itemID, contentType from itemAttachments
                where parentItemID = ? order by itemID""",
            (parent_id,),
        ).fetchall()
        for row in rows:
            if row["itemID"] in self.deleted or row["contentType"] not in READABLE_TYPES:
                continue
            attachment = self._attachment(row["itemID"])
            if attachment is not None and attachment.path:
                return attachment
        return None

    def _attachment(self, item_id: int) -> Attachment | None:
        row = self.db.execute(
            """select i.key, a.contentType, a.path from itemAttachments a
                 join items i on i.itemID = a.itemID
                where a.itemID = ?""",
            (item_id,),
        ).fetchone()
        if row is None:
            return None
        return Attachment(
            item_id=item_id,
            key=row["key"],
            content_type=row["contentType"],
            path=self._resolve_path(row["key"], row["path"]),
            annotations=self._annotations(item_id),
            notes=self._child_notes(item_id),
        )

    def _resolve_path(self, key: str, path: str | None) -> str | None:
        if not path:
            return None
        if path.startswith("storage:"):
            resolved = os.path.join(self.zotero_dir, "storage", key, path[len("storage:"):])
        elif os.path.isabs(path):
            resolved = path
        else:
            return None
        return resolved if os.path.exists(resolved) else None

    def _annotations(self, attachment_id: int) -> list[Annotation]:
        if not self.has_annotations:
            return []
        rows = self.db.execute(
            """select a.itemID, i.key, a.type, a.text, a.comment, a.color, a.position
                 from itemAnnotations a
                 join items i on i.itemID = a.itemID
                where a.parentItemID = ?
                order by a.sortIndex""",
            (attachment_id,),
        ).fetchall()
        annotations = []
        for row in rows:
            if row["itemID"] in self.deleted or row["type"] not in HIGHLIGHT_TYPES:
                continue
            try:
                position = json.loads(row["position"] or "{}")
            except json.JSONDecodeError:
                continue
            rects = position.get("rects") or []
            if "pageIndex" not in position or not rects:
                continue
            annotations.append(
                Annotation(
                    key=row["key"],
                    type=row["type"],
                    text=row["text"],
                    comment=row["comment"],
                    color=row["color"] or "#ffd400",
                    page_index=int(position["pageIndex"]),
                    rects=rects,
                )
            )
        return annotations
