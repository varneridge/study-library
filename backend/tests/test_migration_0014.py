"""Test migration 0014 (item summaries).

Verifies that rebuilding the items table preserves all existing columns and rows,
maintains seq and counters, preserves indexes and triggers, allows 'summary'
as a valid kind, and rejects unknown kinds.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "app"
MIGRATIONS = APP / "migrations"


def test_migration_0014(tmp_path: Path) -> None:
    db_path = tmp_path / "test.db"
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row

    # Apply migrations 0001 through 0013
    for mig in sorted(MIGRATIONS.glob("00*.sql")):
        if mig.name < "0014":
            con.executescript(mig.read_text(encoding="utf-8"))

    # Seed data across all kinds, columns, and relations
    con.executescript("""
        INSERT INTO modules (id, code, title, position, modified_at) VALUES ('m1', 'HY116', 'History', 'a0', '2026-10-01T00:00:00Z');
        INSERT INTO weeks (id, module_id, term, number, title, modified_at) VALUES ('w1', 'm1', 'AT', 1, 'Intro', '2026-10-01T00:00:00Z');
        INSERT INTO weeks (id, module_id, term, number, title, modified_at) VALUES ('w2', 'm1', 'AT', 2, 'Revolution', '2026-10-01T00:00:00Z');
        INSERT INTO sessions (id, week_id, kind, title, position, modified_at) VALUES ('s1', 'w1', 'lecture', 'Lecture 1', 'a0', '2026-10-01T00:00:00Z');

        INSERT INTO files (id, sha256, r2_key, mime, bytes, text_status, modified_at)
        VALUES ('f1', 'sha1', 'r2-1', 'application/pdf', 1024, 'ready', '2026-10-01T00:00:00Z');

        INSERT INTO items (
            id, kind, author, title, source, pages, year, doc_date, file_id,
            original_file_id, tray_module_id, zotero_key, last_page, read_status,
            modified_at, last_opened_at, suggested, last_spot, work_kind, editor,
            publisher, volume, issue, doi
        ) VALUES (
            'i1', 'secondary', 'Author A', 'Title 1', 'Journal A', '1-20', 2020, '2020-01-01', 'f1',
            NULL, NULL, 'z1', 5, 'read', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z',
            '{"author": "Suggested A"}', '{"page": 5}', 'article', 'Editor A', 'Press A', '10', '2', '10.1000/182'
        ), (
            'i2', 'primary', 'Author P', 'Primary Doc', NULL, NULL, 1919, NULL, NULL,
            NULL, NULL, NULL, 0, 'unread', '2026-10-01T00:00:00Z', NULL, NULL, NULL,
            'primary', NULL, NULL, NULL, NULL, NULL
        ), (
            'i3', 'slides', NULL, 'Slides Deck', NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, 0, 'unread', '2026-10-01T00:00:00Z', NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL
        );

        INSERT INTO week_items (id, week_id, item_id, session_id, position, modified_at)
        VALUES ('wi1', 'w1', 'i1', NULL, 'a0', '2026-10-01T00:00:00Z');
        INSERT INTO week_items (id, week_id, item_id, session_id, position, modified_at)
        VALUES ('wi2', 'w1', 'i3', 's1', 'a1', '2026-10-01T00:00:00Z');
    """)
    con.commit()

    # Capture state before migration 0014
    items_before = con.execute("SELECT * FROM items ORDER BY id").fetchall()
    items_before_dicts = [dict(row) for row in items_before]
    week_items_before = [dict(r) for r in con.execute("SELECT * FROM week_items ORDER BY id").fetchall()]
    files_before = [dict(r) for r in con.execute("SELECT * FROM files ORDER BY id").fetchall()]
    sessions_before = [dict(r) for r in con.execute("SELECT * FROM sessions ORDER BY id").fetchall()]
    weeks_before = [dict(r) for r in con.execute("SELECT * FROM weeks ORDER BY id").fetchall()]
    modules_before = [dict(r) for r in con.execute("SELECT * FROM modules ORDER BY id").fetchall()]
    seq_counter_before = con.execute("SELECT value FROM counters WHERE name = 'seq'").fetchone()[0]

    # Now apply 0014
    mig_0014 = (MIGRATIONS / "0014_item_summaries.sql").read_text(encoding="utf-8")
    con.executescript(mig_0014)

    # 1. Assert integrity check passes and no foreign key violations exist
    integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
    assert integrity == "ok"
    assert con.execute("PRAGMA foreign_key_check").fetchall() == []
    assert con.execute("PRAGMA foreign_key_list('items')").fetchall() == []

    # 2. Assert every existing item row is identical
    items_after = con.execute("SELECT * FROM items ORDER BY id").fetchall()
    items_after_dicts = [dict(row) for row in items_after]
    assert items_after_dicts == items_before_dicts

    # Assert all child and related tables are identical
    assert [dict(r) for r in con.execute("SELECT * FROM week_items ORDER BY id").fetchall()] == week_items_before
    assert [dict(r) for r in con.execute("SELECT * FROM files ORDER BY id").fetchall()] == files_before
    assert [dict(r) for r in con.execute("SELECT * FROM sessions ORDER BY id").fetchall()] == sessions_before
    assert [dict(r) for r in con.execute("SELECT * FROM weeks ORDER BY id").fetchall()] == weeks_before
    assert [dict(r) for r in con.execute("SELECT * FROM modules ORDER BY id").fetchall()] == modules_before

    # 3. Assert global seq counter has not moved during migration
    seq_counter_after = con.execute("SELECT value FROM counters WHERE name = 'seq'").fetchone()[0]
    assert seq_counter_after == seq_counter_before

    # 4. Assert table SQL now contains 'summary'
    table_sql = con.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'").fetchone()[0]
    assert "'summary'" in table_sql

    # 5. Assert inserting a summary item succeeds and advances seq
    con.execute("""
        INSERT INTO items (id, kind, title, modified_at)
        VALUES ('i_sum', 'summary', 'Handout', '2026-10-03T00:00:00Z')
    """)
    con.commit()
    sum_row = con.execute("SELECT * FROM items WHERE id = 'i_sum'").fetchone()
    assert sum_row["kind"] == "summary"
    assert sum_row["seq"] > seq_counter_before

    # 6. Assert invalid kind like 'handout' is rejected
    with pytest.raises(sqlite3.IntegrityError):
        con.execute("""
            INSERT INTO items (id, kind, title, modified_at)
            VALUES ('i_bad', 'handout', 'Bad Kind', '2026-10-03T00:00:00Z')
        """)
        con.commit()

    # 7. Assert triggers and priority updates work
    # files_enqueue: inserting a new pending PDF linked to w1 (AT1) creates extract_text job with priority 1
    con.execute("""
        INSERT INTO files (id, sha256, r2_key, mime, bytes, text_status, modified_at)
        VALUES ('f2', 'sha2', 'r2-2', 'application/pdf', 2048, 'pending', '2026-10-03T00:00:00Z')
    """)
    # Link item to w1
    con.execute("""
        INSERT INTO items (id, kind, title, file_id, modified_at)
        VALUES ('i_prio', 'secondary', 'Prio Item', 'f2', '2026-10-03T00:00:00Z')
    """)
    con.execute("""
        INSERT INTO week_items (id, week_id, item_id, position, modified_at)
        VALUES ('wi_prio', 'w1', 'i_prio', 'a2', '2026-10-03T00:00:00Z')
    """)
    con.commit()

    job = con.execute("SELECT * FROM jobs WHERE json_extract(payload, '$.file_id') = 'f2'").fetchone()
    assert job is not None
    assert job["type"] == "extract_text"

    con.close()
