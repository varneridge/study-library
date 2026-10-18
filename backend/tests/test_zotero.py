import json
import shutil
import sqlite3

import pymupdf
import pytest

from study.zotero.importer import Importer, build_plan
from study.zotero.reader import ZoteroLibrary

SCHEMA = """
create table itemTypes (itemTypeID integer primary key, typeName text);
create table fieldsCombined (fieldID integer primary key, fieldName text);
create table items (itemID integer primary key, itemTypeID int, libraryID int, key text);
create table itemDataValues (valueID integer primary key, value text);
create table itemData (itemID int, fieldID int, valueID int);
create table collections (collectionID integer primary key, collectionName text, key text);
create table collectionItems (collectionID int, itemID int, orderIndex int);
create table itemAttachments (itemID integer primary key, parentItemID int, linkMode int,
                              contentType text, path text);
create table itemNotes (itemID integer primary key, parentItemID int, note text, title text);
create table itemAnnotations (itemID integer primary key, parentItemID int, type int, authorName text,
                              text text, comment text, color text, pageLabel text, sortIndex text,
                              position text, isExternal int);
create table deletedItems (itemID integer primary key);
insert into itemTypes values (1, 'note'), (2, 'attachment'), (3, 'journalArticle'), (4, 'annotation');
insert into fieldsCombined values (1, 'title');
insert into collections values (1, 'HY335', 'COLL0001');
"""


class FakeZotero:
    def __init__(self, root):
        self.root = root
        self.db = sqlite3.connect(root / "zotero.sqlite")
        self.db.executescript(SCHEMA)
        self.next_id = 1

    def _item(self, type_id, key, in_collection=True):
        item_id = self.next_id
        self.next_id += 1
        self.db.execute("insert into items values (?, ?, 1, ?)", (item_id, type_id, key))
        if in_collection:
            self.db.execute("insert into collectionItems values (1, ?, 0)", (item_id,))
        return item_id

    def _title(self, item_id, title):
        self.db.execute("insert into itemDataValues (value) values (?)", (title,))
        value_id = self.db.execute("select last_insert_rowid()").fetchone()[0]
        self.db.execute("insert into itemData values (?, 1, ?)", (item_id, value_id))

    def note(self, key, title, html, parent=None):
        item_id = self._item(1, key, in_collection=parent is None)
        self.db.execute("insert into itemNotes values (?, ?, ?, ?)", (item_id, parent, html, title))
        return item_id

    def pdf(self, key, title, text, parent=None, missing=False, same_as=None):
        item_id = self._item(2, key, in_collection=parent is None)
        if parent is None:
            self._title(item_id, title)
        folder = self.root / "storage" / key
        folder.mkdir(parents=True)
        if same_as:
            shutil.copyfile(self.root / "storage" / same_as / "file.pdf", folder / "file.pdf")
        elif not missing:
            doc = pymupdf.open()
            doc.new_page().insert_text((72, 72), text)
            doc.save(folder / "file.pdf")
        self.db.execute(
            "insert into itemAttachments values (?, ?, 0, 'application/pdf', 'storage:file.pdf')",
            (item_id, parent),
        )
        return item_id

    def article(self, key, title):
        item_id = self._item(3, key)
        self._title(item_id, title)
        return item_id

    def annotation(self, key, parent, kind, text, page=0):
        item_id = self._item(4, key, in_collection=False)
        position = json.dumps({"pageIndex": page, "rects": [[72.0, 700.0, 300.0, 712.0]]})
        self.db.execute(
            "insert into itemAnnotations values (?, ?, ?, '', ?, 'why it matters', '#ffd400', '1', '00000', ?, 0)",
            (item_id, parent, kind, text, position),
        )

    def delete(self, item_id):
        self.db.execute("insert into deletedItems values (?)", (item_id,))

    def save(self):
        self.db.commit()
        self.db.close()


@pytest.fixture
def zotero_dir(tmp_path):
    root = tmp_path / "Zotero"
    root.mkdir()
    fake = FakeZotero(root)
    fake.note("N0000001", "(00) HY335 Overview", "<h1>(00) HY335 Overview</h1><p>Module aims.</p>")
    fake.note("N0000002", "(AT1) 00 Introductory Session",
              "<h1>(AT1) 00 Introductory Session</h1><p>First seminar thoughts.</p>")
    chen = fake.pdf("A0000001", "(AT1) Chen, J. (2001) 'Introduction', in Mao's China and the Cold War, pp. 1-16",
                    "Chen introduction")
    fake.annotation("H0000001", chen, 1, "the Cold War in Asia")
    fake.annotation("H0000002", chen, 4, None)
    fake.note("N0000003", None, "<p>Reading note on Chen.</p>", parent=chen)
    fake.pdf("A0000002", "(AT1) P1 Mao Zedong, 'On the Question of the Differentiation of the Three Worlds', 22 Feb 1974",
             "Three Worlds")
    kirby = fake.article("J0000001", "(AT2) Kirby, W. C. (1997) 'The Internationalization of China', China Quarterly 150, pp. 433-58")
    fake.pdf("A0000003", None, "Kirby text", parent=kirby)
    fake.note("N0000004", None, "<p>Kirby note.</p>", parent=kirby)
    fake.pdf("A0000004", "(AT2) Westad, O. A. (2012) 'Imperialisms', in Restless Empire, ch. 2", "",
             same_as="A0000001")
    gone = fake.pdf("A0000005", "(AT2) Deleted, A. (2000) 'Gone', pp. 1-2", "deleted")
    fake.delete(gone)
    fake.pdf("A0000006", "(AT3) Missing, B. (2000) 'Lost', pp. 1-2", "", missing=True)
    fake.pdf("A0000007", "Random notes", "random")
    fake.save()
    return root


def test_plan(zotero_dir):
    with ZoteroLibrary(str(zotero_dir)) as library:
        entries = library.collection_entries(library.collections_named("HY335")[0]["collectionID"])
    plan = build_plan(entries)

    assert plan.module_note is not None
    assert [n.parsed.title for n in plan.session_notes] == ["Introductory Session"]
    titles = [r.parsed.title for r in plan.readings]
    assert titles == [
        "Introduction",
        "On the Question of the Differentiation of the Three Worlds",
        "The Internationalization of China",
        "Imperialisms",
    ]
    reasons = dict(plan.skipped)
    assert reasons["(AT3) Missing, B. (2000) 'Lost', pp. 1-2"] == "no file found in Zotero storage"
    assert reasons["Random notes"] == "title does not follow the (AT1) convention"
    assert len(plan.skipped) == 2
    chen = plan.readings[0]
    assert [a.key for a in chen.entry.attachment.annotations] == ["H0000001"]


def test_apply_and_rerun(api, module, zotero_dir):
    with ZoteroLibrary(str(zotero_dir)) as library:
        entries = library.collection_entries(library.collections_named("HY335")[0]["collectionID"])
    plan = build_plan(entries)

    summary = Importer(api, "HY335").apply(plan)
    assert summary.items_added == 4
    assert summary.files_uploaded == 3
    assert summary.files_reused == 1
    assert summary.highlights_added == 1
    assert summary.notes_added == 3
    assert summary.week_titles_set == 1

    state = api.pull_all()
    at1 = sorted(
        (link for link in state["week_items"].values() if link["week_id"] == module["weeks"][("AT", 1)]),
        key=lambda link: link["position"],
    )
    assert [(state["items"][l["item_id"]]["kind"], state["items"][l["item_id"]]["title"]) for l in at1] == [
        ("secondary", "Introduction"),
        ("primary", "On the Question of the Differentiation of the Three Worlds"),
    ]
    assert state["weeks"][module["weeks"][("AT", 1)]]["title"] == "Introductory Session"

    highlight = next(iter(state["highlights"].values()))
    assert highlight["page"] == 0
    assert highlight["rects"] == [[72.0, 700.0, 300.0, 712.0]]
    assert highlight["body"] == "the Cold War in Asia"
    assert highlight["comment"] == "why it matters"

    session_notes = [n for n in state["notes"].values() if n["session_id"]]
    assert len(session_notes) == 1
    blocks = [b for b in state["note_blocks"].values() if b["note_id"] == session_notes[0]["id"]]
    assert blocks[0]["content"]["content"][0]["text"] == "First seminar thoughts."
    assert state["modules"]["m1"]["description"][0]["content"][0]["text"] == "Module aims."

    jobs = []
    while (job := api.claim()) is not None:
        jobs.append(job)
    assert [j["priority"] for j in jobs] == [1, 1, 2]
    assert {j["type"] for j in jobs} == {"extract_text"}

    again = Importer(api, "HY335").apply(plan)
    assert again.items_added == 0
    assert again.items_kept == 4
    assert again.highlights_added == 0
    assert again.notes_added == 0
    assert again.files_uploaded == 0
    assert len(api.pull_all()["items"]) == 4
