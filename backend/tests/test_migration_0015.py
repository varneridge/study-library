"""Test migration 0015 (module and slide images).

Verifies that adding image_key to modules and thumb_key to files succeeds,
preserves existing rows and triggers, increments the seq counter on update,
and allows inserting and querying the new columns.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "app"
MIGRATIONS = APP / "migrations"


def test_migration_0015(tmp_path: Path) -> None:
    db_path = tmp_path / "test.db"
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row

    # Apply migrations 0001 through 0014
    for mig in sorted(MIGRATIONS.glob("00*.sql")):
        if mig.name < "0015":
            con.executescript(mig.read_text(encoding="utf-8"))

    # Seed an existing module and file
    con.executescript("""
        INSERT INTO modules (id, code, title, position, modified_at)
        VALUES ('m1', 'HY116', 'History', 'a0', '2026-10-01T00:00:00Z');

        INSERT INTO files (id, sha256, r2_key, mime, bytes, text_status, modified_at)
        VALUES ('f1', 'sha1', 'r2-1', 'application/pdf', 1024, 'ready', '2026-10-01T00:00:00Z');
    """)

    # Record seq before migration
    seq_before = con.execute("SELECT value FROM counters WHERE name = 'seq'").fetchone()["value"]

    # Apply migration 0015
    mig_0015 = (MIGRATIONS / "0015_module_and_slide_images.sql").read_text(encoding="utf-8")
    con.executescript(mig_0015)

    # Check columns exist and default to NULL
    row_m = con.execute("SELECT id, code, image_key FROM modules WHERE id = 'm1'").fetchone()
    assert row_m["code"] == "HY116"
    assert row_m["image_key"] is None

    row_f = con.execute("SELECT id, sha256, thumb_key FROM files WHERE id = 'f1'").fetchone()
    assert row_f["sha256"] == "sha1"
    assert row_f["thumb_key"] is None

    # Updating image_key triggers modules_seq_update and advances global seq
    con.execute(
        "UPDATE modules SET image_key = 'pictures/abc.webp', modified_at = '2026-10-02T00:00:00Z' WHERE id = 'm1'"
    )
    con.commit()
    seq_after_m = con.execute("SELECT value FROM counters WHERE name = 'seq'").fetchone()["value"]
    assert seq_after_m > seq_before
    m_seq = con.execute("SELECT seq, image_key FROM modules WHERE id = 'm1'").fetchone()
    assert m_seq["seq"] == seq_after_m
    assert m_seq["image_key"] == "pictures/abc.webp"

    # Updating thumb_key triggers files_seq_update and advances global seq
    con.execute(
        "UPDATE files SET thumb_key = 'thumbs/slide1.webp', modified_at = '2026-10-02T00:00:00Z' WHERE id = 'f1'"
    )
    con.commit()
    seq_after_f = con.execute("SELECT value FROM counters WHERE name = 'seq'").fetchone()["value"]
    assert seq_after_f > seq_after_m
    f_seq = con.execute("SELECT seq, thumb_key FROM files WHERE id = 'f1'").fetchone()
    assert f_seq["seq"] == seq_after_f
    assert f_seq["thumb_key"] == "thumbs/slide1.webp"

    # Inserting a new module with image_key works
    con.execute(
        "INSERT INTO modules (id, code, title, position, image_key, modified_at) VALUES ('m2', 'HY118', 'Empire', 'a1', 'pictures/xyz.webp', '2026-10-02T00:00:00Z')"
    )
    con.commit()
    row_m2 = con.execute("SELECT image_key FROM modules WHERE id = 'm2'").fetchone()
    assert row_m2["image_key"] == "pictures/xyz.webp"

    con.close()
