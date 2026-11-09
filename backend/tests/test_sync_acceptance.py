# filename: backend/tests/test_sync_acceptance.py
"""Acceptance criteria for backend/sync (the common core, the jobs sync and
the study sync).

They need no network, no Google Drive and no Windows: every Windows rule is
enforced by the code rather than the host filesystem, and the Worker is
replaced by a fake that serves tables and objects from memory, so CI on Linux
proves the same thing.

Run: pytest backend/tests/test_sync_acceptance.py
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from study.api import ApiError  # noqa: E402
from sync import common, jobs, study  # noqa: E402

SHA_A = "a" * 64
SHA_B = "b" * 64
PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def app(**overrides) -> dict:
    row = {
        "id": "0f3c9a2e-1111-4222-8333-444455556666", "employer": "Acme", "role": "Analyst",
        "applied": "2026-10-01", "stage": "applied", "next_deadline": None, "notes": None,
        "file_cv": None, "file_cl": None, "file_rd": None, "file_qs": None,
        "deleted": False, "modified_at": "2026-10-01T09:00:00.000Z",
    }
    row.update(overrides)
    return row


# M1: naming is safe on Windows and Google Drive whatever the user typed

@pytest.mark.parametrize("hostile", [
    "../../Windows/System32", "..\\..\\evil", "C:\\Users\\x", "/etc/passwd", "a:b*c?d\"e<f>g|h",
    "CON", "con.txt", "Lpt1", "COM9.pdf", "trailing dot.", "trailing space ", "\x00nul\x1fctrl", ".", "..", "",
])
def test_safe_component_never_escapes_or_produces_an_invalid_windows_name(hostile):
    name = common.safe_component(hostile)
    assert name and name not in {".", ".."}
    assert not any(ch in name for ch in '<>:"/\\|?*') and all(ord(ch) >= 32 for ch in name)
    assert not name.endswith((".", " "))
    assert name.split(".")[0].upper() not in common.WINDOWS_RESERVED
    assert len(name) <= 80


def test_safe_component_keeps_ordinary_names_readable():
    assert common.safe_component("Goldman Sachs") == "Goldman Sachs"
    assert common.safe_component("Société Générale") == "Société Générale"


def test_folder_names_are_unique_and_stable_across_renames():
    first = app(id="11111111-aaaa-4000-8000-000000000001")
    twin = app(id="22222222-bbbb-4000-8000-000000000002")
    assert jobs.app_folder_name(first) != jobs.app_folder_name(twin)
    assert jobs.app_folder_name(first).casefold() != jobs.app_folder_name(twin).casefold()
    renamed = dict(first, employer="Acme Holdings")
    assert jobs.app_folder_name(first).endswith(" [11111111]")
    assert jobs.app_folder_name(renamed).endswith(" [11111111]")  # the id, not the label, is the identity


def test_blank_employer_and_role_still_get_a_usable_folder():
    name = jobs.app_folder_name(app(employer="", role="   "))
    assert name == "Untitled [0f3c9a2e]"


# M2: slot files are named by slot and stored type, never by the uploaded name

def test_slot_file_name_comes_from_slot_and_mime_not_the_users_file_name():
    row = app(file_cv={"state": "saved", "key": f"files/{SHA_A}", "name": "..\\..\\cv.pdf.exe", "mime": PDF, "bytes": 10},
              file_cl={"state": "saved", "key": f"files/{SHA_B}", "name": "letter.docx", "mime": DOCX, "bytes": 10})
    targets = {t.filename: t for t in jobs.slot_targets(row)}
    assert set(targets) == {"CV.pdf", "Cover letter.docx"}
    assert targets["CV.pdf"].original_name == "..\\..\\cv.pdf.exe"  # kept for the index only


def test_unknown_mime_and_unsaved_slots_are_skipped_not_guessed():
    row = app(file_cv={"state": "saved", "key": f"files/{SHA_A}", "name": "x.exe", "mime": "application/x-msdownload", "bytes": 1},
              file_cl={"state": "uploading", "name": "y.pdf", "mime": PDF})
    assert jobs.slot_targets(row) == []


def test_link_slot_becomes_an_internet_shortcut_only_for_http_and_https():
    good = app(file_rd={"state": "saved", "url": "https://careers.example.com/role/42"})
    [target] = jobs.slot_targets(good)
    assert target.filename == "Role description.url"
    assert jobs.url_shortcut(target.url) == "[InternetShortcut]\r\nURL=https://careers.example.com/role/42\r\n"
    for bad in ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "https://x.test/\r\nIconFile=\\\\evil\\a.ico"]:
        assert jobs.slot_targets(app(file_rd={"state": "saved", "url": bad})) == []


@pytest.mark.parametrize("key", ["../secrets", "files/../../x", "a\\b", "/abs", "k?x=1", "k#frag", "k%2e%2e", "with space", ""])
def test_object_keys_are_validated_before_they_reach_a_url(key):
    with pytest.raises(ValueError):
        common.validate_key(key)


def test_digest_in_a_content_key_is_recognised():
    assert common.key_digest(f"files/{SHA_A}") == SHA_A
    assert common.key_digest("files/not-a-digest") is None


# M3: writes are atomic, verified, and never clobber the user's own edits

def test_atomic_write_verifies_and_leaves_nothing_behind_on_mismatch(tmp_path):
    target = tmp_path / "CV.pdf"
    data = b"%PDF-1.7 real bytes"
    good = hashlib.sha256(data).hexdigest()
    assert common.atomic_write_chunks(target, [data[:5], data[5:]], expected_sha256=good) == good
    assert target.read_bytes() == data
    with pytest.raises(common.IntegrityError):
        common.atomic_write_chunks(target, [b"tampered"], expected_sha256=good)
    assert target.read_bytes() == data, "a failed write must not replace a good file"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["CV.pdf"], "temporary files must be removed"


def test_atomic_write_survives_an_interrupted_stream(tmp_path):
    target = tmp_path / "CV.pdf"

    def chunks():
        yield b"half"
        raise ConnectionError("reset")

    with pytest.raises(ConnectionError):
        common.atomic_write_chunks(target, chunks())
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("local, recorded, remote, expected", [
    (None, None, SHA_A, "write"),       # new file
    (SHA_A, SHA_A, SHA_A, "skip"),      # nothing changed
    (SHA_A, None, SHA_A, "skip"),       # identical file already there, manifest lost
    (SHA_A, SHA_A, SHA_B, "write"),     # remote replaced, local untouched since last sync
    (SHA_B, SHA_A, SHA_A, "conflict"),  # user edited the local copy
    (SHA_B, None, SHA_A, "conflict"),   # unknown local file in the way
])
def test_classify_protects_local_edits(local, recorded, remote, expected):
    assert common.classify(local, recorded, remote) == expected


# M4: the index is safe to open in Excel and reflects only live rows

def test_live_applications_drop_deleted_rows():
    tables = {"applications": {"a": app(id="a"), "b": app(id="b", deleted=True)}}
    assert [row["id"] for row in jobs.live_applications(tables)] == ["a"]


def test_index_csv_neutralises_formula_injection_and_round_trips():
    rows = [app(employer="=HYPERLINK(\"http://evil\",\"x\")", role="+1-2", notes="@SUM(A1)")]
    text = jobs.render_index_csv(rows)
    parsed = list(csv.DictReader(io.StringIO(text)))
    assert parsed[0]["Employer"].startswith("'=")
    assert parsed[0]["Role"].startswith("'+")
    assert all(not cell.startswith(("=", "+", "-", "@")) for cell in parsed[0].values())


def test_lock_refuses_a_second_concurrent_run(tmp_path):
    with common.RunLock(tmp_path / "jobs.lock"):
        with pytest.raises(common.AlreadyRunning):
            with common.RunLock(tmp_path / "jobs.lock"):
                pass
    with common.RunLock(tmp_path / "jobs.lock"):  # released cleanly afterwards
        pass


# M5: whole runs against a fake Worker

class FakeApi:
    """Serves tables and objects from memory and counts every fetch."""

    def __init__(self, tables: dict, objects: dict[str, bytes]):
        self.tables = tables
        self.objects = objects
        self.fetches: list[str] = []
        self.fail_next: set[str] = set()

    def pull_all(self):
        return {name: {ident: dict(row) for ident, row in rows.items()} for name, rows in self.tables.items()}

    def object_chunks(self, key: str):
        self.fetches.append(key)
        data = self.objects[key]
        yield data[: len(data) // 2]
        if key in self.fail_next:
            self.fail_next.discard(key)
            raise ApiError("dropped", 404)
        yield data[len(data) // 2:]


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(common, "sleep", lambda _seconds: None)


def blob(text: str) -> tuple[str, bytes]:
    data = text.encode()
    return f"files/{hashlib.sha256(data).hexdigest()}", data


def run_command(module, fake: FakeApi, dest: Path, state: Path, *extra: str) -> tuple[int, str]:
    lines: list[str] = []
    args = module.base_arguments("test", str(dest)).parse_args(["--dest", str(dest), "--state-dir", str(state), *extra])
    code = common.run(module.__name__.rsplit(".", 1)[-1], args, module.build, api_factory=lambda _env: fake,
                      out=lines.append)
    return code, "\n".join(lines)


@pytest.fixture
def jobs_world(tmp_path):
    cv_key, cv = blob("%PDF-1.7 my cv")
    cl_key, cl = blob("cover letter words")
    tables = {"applications": {
        "a1": app(id="a1aaaaaa-0000-4000-8000-000000000001", employer="Acme", role="Analyst",
                  file_cv={"state": "saved", "key": cv_key, "name": "cv.pdf", "mime": PDF, "bytes": len(cv)},
                  file_cl={"state": "saved", "key": cl_key, "name": "cl.docx", "mime": DOCX, "bytes": len(cl)},
                  file_rd={"state": "saved", "url": "https://careers.example.com/42"}),
        "b2": app(id="b2bbbbbb-0000-4000-8000-000000000002", employer="Beta", role="Trainee",
                  file_cv={"state": "saved", "key": cv_key, "name": "cv.pdf", "mime": PDF, "bytes": len(cv)}),
    }, "application_events": {
        "e1": {"id": "e1", "application_id": "a1aaaaaa-0000-4000-8000-000000000001", "stage": "applied",
               "from_stage": None, "at": "2026-10-01T09:00:00.000Z", "kind": "change", "deleted": False},
    }}
    fake = FakeApi(tables, {cv_key: cv, cl_key: cl})
    return fake, tmp_path / "Drive" / "applications", tmp_path / "state", cv


def test_first_run_builds_the_tree_and_fetches_a_shared_file_once(jobs_world):
    fake, dest, state, cv = jobs_world
    code, output = run_command(jobs, fake, dest, state)
    assert code == 0, output
    acme = dest / "Acme - Analyst [a1aaaaaa]"
    assert (acme / "CV.pdf").read_bytes() == cv
    assert (acme / "Cover letter.docx").exists()
    assert (acme / "Role description.url").read_text().startswith("[InternetShortcut]")
    assert "Applied: awaiting response" in (acme / "application.md").read_text()
    assert (dest / "Beta - Trainee [b2bbbbbb]" / "CV.pdf").read_bytes() == cv
    assert (dest / "index.csv").read_bytes().startswith(b"\xef\xbb\xbf")
    assert "Acme" in (dest / "index.md").read_text()
    assert len(fake.fetches) == 2, "the CV shared by two applications should be fetched once"
    assert not list(dest.rglob(".~sync-*")), "no temporary files may be left"


def test_second_run_changes_nothing_and_fetches_nothing(jobs_world):
    fake, dest, state, _ = jobs_world
    run_command(jobs, fake, dest, state)
    fake.fetches.clear()
    before = {p: p.stat().st_mtime_ns for p in dest.rglob("*") if p.is_file()}
    code, output = run_command(jobs, fake, dest, state)
    assert code == 0 and "0 written" in output, output
    assert fake.fetches == []
    assert {p: p.stat().st_mtime_ns for p in dest.rglob("*") if p.is_file()} == before


def test_a_local_edit_is_kept_and_the_new_version_saved_beside_it(jobs_world):
    fake, dest, state, _ = jobs_world
    run_command(jobs, fake, dest, state)
    cv_path = dest / "Acme - Analyst [a1aaaaaa]" / "CV.pdf"
    cv_path.write_bytes(b"my own edits")
    new_key, new_cv = blob("%PDF-1.7 revised cv")
    fake.objects[new_key] = new_cv
    fake.tables["applications"]["a1"]["file_cv"] = {"state": "saved", "key": new_key, "name": "cv2.pdf",
                                                    "mime": PDF, "bytes": len(new_cv)}
    code, output = run_command(jobs, fake, dest, state)
    assert code == 1 and "changed locally" in output
    assert cv_path.read_bytes() == b"my own edits"
    [beside] = [p for p in cv_path.parent.iterdir() if p.name.startswith("CV (from Study Library")]
    assert beside.read_bytes() == new_cv


def test_a_replaced_slot_overwrites_an_untouched_copy(jobs_world):
    fake, dest, state, _ = jobs_world
    run_command(jobs, fake, dest, state)
    new_key, new_cv = blob("%PDF-1.7 revised cv")
    fake.objects[new_key] = new_cv
    fake.tables["applications"]["b2"]["file_cv"] = {"state": "saved", "key": new_key, "name": "cv2.pdf",
                                                    "mime": PDF, "bytes": len(new_cv)}
    assert run_command(jobs, fake, dest, state)[0] == 0
    assert (dest / "Beta - Trainee [b2bbbbbb]" / "CV.pdf").read_bytes() == new_cv


def test_renaming_an_employer_renames_the_folder_and_keeps_extra_files(jobs_world):
    fake, dest, state, _ = jobs_world
    run_command(jobs, fake, dest, state)
    (dest / "Acme - Analyst [a1aaaaaa]" / "my prep.txt").write_text("mine")
    fake.tables["applications"]["a1"]["employer"] = "Acme Holdings"
    assert run_command(jobs, fake, dest, state)[0] == 0
    assert not (dest / "Acme - Analyst [a1aaaaaa]").exists()
    assert (dest / "Acme Holdings - Analyst [a1aaaaaa]" / "my prep.txt").read_text() == "mine"


def test_a_deleted_application_is_moved_aside_not_removed(jobs_world):
    fake, dest, state, _ = jobs_world
    run_command(jobs, fake, dest, state)
    fake.tables["applications"]["b2"]["deleted"] = True
    assert run_command(jobs, fake, dest, state)[0] == 0
    assert not (dest / "Beta - Trainee [b2bbbbbb]").exists()
    assert (dest / "_Deleted" / "Beta - Trainee [b2bbbbbb]" / "CV.pdf").exists()


def test_a_cleared_slot_moves_its_file_to_old(jobs_world):
    fake, dest, state, _ = jobs_world
    run_command(jobs, fake, dest, state)
    fake.tables["applications"]["a1"]["file_cl"] = None
    assert run_command(jobs, fake, dest, state)[0] == 0
    assert (dest / "Acme - Analyst [a1aaaaaa]" / "_Old" / "Cover letter.docx").exists()


def test_an_empty_pull_cannot_sweep_every_folder_aside(jobs_world):
    fake, dest, state, _ = jobs_world
    for number in range(3, 8):
        fake.tables["applications"][f"x{number}"] = app(id=f"{number}0000000-0000-4000-8000-00000000000{number}")
    run_command(jobs, fake, dest, state)
    fake.tables["applications"] = {}
    code, output = run_command(jobs, fake, dest, state)
    assert code == 2 and "--allow-mass-retire" in output
    assert (dest / "Acme - Analyst [a1aaaaaa]").is_dir()


def test_a_failed_download_keeps_the_good_copy_and_does_not_retire_it(jobs_world):
    fake, dest, state, cv = jobs_world
    run_command(jobs, fake, dest, state)
    new_key, new_cv = blob("%PDF-1.7 revised cv")
    fake.objects[new_key] = new_cv
    fake.fail_next.add(new_key)
    fake.tables["applications"]["b2"]["file_cv"] = {"state": "saved", "key": new_key, "name": "cv2.pdf",
                                                    "mime": PDF, "bytes": len(new_cv)}
    code, output = run_command(jobs, fake, dest, state)
    assert code == 1 and "error" in output
    assert (dest / "Beta - Trainee [b2bbbbbb]" / "CV.pdf").read_bytes() == cv
    assert not (dest / "Beta - Trainee [b2bbbbbb]" / "_Old").exists()


def test_a_retryable_failure_is_retried(jobs_world):
    fake, dest, state, cv = jobs_world
    calls = {"n": 0}
    original = fake.object_chunks

    def flaky(key):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ApiError("busy", 503)
        yield from original(key)

    fake.object_chunks = flaky
    assert run_command(jobs, fake, dest, state)[0] == 0
    assert (dest / "Acme - Analyst [a1aaaaaa]" / "CV.pdf").read_bytes() == cv


def test_a_tampered_object_is_refused(jobs_world):
    fake, dest, state, _ = jobs_world
    key = fake.tables["applications"]["a1"]["file_cl"]["key"]
    fake.objects[key] = b"not what the digest says"
    code, output = run_command(jobs, fake, dest, state)
    assert code == 1 and "SHA-256" in output
    assert not (dest / "Acme - Analyst [a1aaaaaa]" / "Cover letter.docx").exists()


def test_dry_run_writes_nothing(jobs_world):
    fake, dest, state, _ = jobs_world
    dest.parent.mkdir(parents=True)
    code, output = run_command(jobs, fake, dest, state, "--dry-run")
    assert code == 0 and "would write" in output
    assert not dest.exists()


def test_inspect_lists_columns_without_values(jobs_world):
    fake, dest, state, _ = jobs_world
    code, output = run_command(jobs, fake, dest, state, "--inspect")
    assert code == 0 and "applications (2 rows)" in output and "employer" in output
    assert "Acme" not in output


def test_a_held_lock_stops_a_second_run(jobs_world):
    fake, dest, state, _ = jobs_world
    with common.RunLock(state / "jobs.lock"):
        code, _ = run_command(jobs, fake, dest, state)
    assert code == 3


def test_a_stale_lock_from_a_dead_process_is_taken_over(tmp_path):
    lock = tmp_path / "jobs.lock"
    lock.write_text("999999999")
    with common.RunLock(lock):
        assert lock.read_text() == str(os.getpid())


def test_env_file_is_read_without_overriding_the_environment(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text('# comment\nSTUDY_URL="https://study.example.com"\nexport CF_ACCESS_CLIENT_ID=abc # note\n'
                   "CF_ACCESS_CLIENT_SECRET=from-file\n")
    for name in ("STUDY_URL", "CF_ACCESS_CLIENT_ID"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CF_ACCESS_CLIENT_SECRET", "from-shell")
    api = common.api_for_sync(env)
    assert api.base == "https://study.example.com"
    assert api.session.headers["CF-Access-Client-Id"] == "abc"
    assert api.session.headers["CF-Access-Client-Secret"] == "from-shell"
    assert "X-Processor-Key" not in api.session.headers


def test_missing_credentials_are_named_but_not_printed(tmp_path, monkeypatch):
    for name in ("STUDY_URL", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CF_ACCESS_CLIENT_ID", "visible-id")
    with pytest.raises(common.SyncError) as caught:
        common.api_for_sync(tmp_path / "missing.env")
    assert "STUDY_URL" in str(caught.value) and "visible-id" not in str(caught.value)


def test_object_chunks_quotes_the_key_and_uses_the_reader_route(monkeypatch):
    from study.api import Api
    api = Api("https://study.example.com")
    seen = {}

    class Response:
        status_code, is_redirect = 200, False

        def iter_content(self, _size):
            yield b"ok"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            seen["closed"] = True

    def request(method, url, **kwargs):
        seen["url"] = url
        return Response()

    monkeypatch.setattr(api.session, "request", request)
    assert b"".join(api.object_chunks("files/abc def")) == b"ok"
    assert seen["url"] == "https://study.example.com/api/objects/files/abc%20def"
    assert seen["closed"]


# M6: the study tree

def study_tables() -> tuple[dict, dict[str, bytes]]:
    reading_key, reading = blob("%PDF-1.7 a reading")
    picture_key, picture = blob("PNGDATA")
    doc = {"type": "doc", "content": [
        {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Lecture notes"}]},
        {"type": "paragraph", "content": [{"type": "text", "text": "Key idea", "marks": [{"type": "bold"}]}]},
        {"type": "bulletList", "content": [{"type": "listItem", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "first point"}]}]}]},
        {"type": "image", "attrs": {"src": f"/api/objects/{picture_key}?name=x.png", "alt": "diagram"}},
    ]}
    tables = {
        "modules": {"m1": {"id": "m1aaaaaa-0000", "code": "PH101", "title": "Ethics", "position": 1}},
        "weeks": {
            "w2": {"id": "w2", "module_id": "m1aaaaaa-0000", "number": 2, "title": "Utilitarianism"},
            "w1": {"id": "w1", "module_id": "m1aaaaaa-0000", "number": 1, "title": "Introduction"},
            "wx": {"id": "wx", "module_id": "gone", "number": 1, "title": "Orphan"},
        },
        "readings": {
            "r1": {"id": "r1", "week_id": "w1", "file_id": "f1", "title": "On Liberty",
                   "citation": {"authors": [{"family": "Mill"}], "year": 1859}},
            "r2": {"id": "r2", "week_id": "w2", "url": "https://plato.stanford.edu/entries/utilitarianism/",
                   "title": "SEP entry"},
            "r3": {"id": "r3", "module_id": "m1aaaaaa-0000", "file_id": "f2", "title": "Odd file"},
            "r4": {"id": "r4", "title": "Nowhere"},
        },
        "files": {
            "f1": {"id": "f1", "r2_key": reading_key, "mime": PDF, "bytes": len(reading)},
            "f2": {"id": "f2", "r2_key": "files/" + "c" * 64, "mime": "application/x-msdownload"},
        },
        "notes": {
            "n1": {"id": "n1", "week_id": "w1", "body": json.dumps(doc)},
            "n2": {"id": "n2", "week_id": "w1", "title": "Seminar", "body": "Plain **markdown**"},
        },
    }
    return tables, {reading_key: reading, picture_key: picture}



def test_study_layout_orders_weeks_and_places_orphans():
    tables, _ = study_tables()
    folders, places = study.layout(tables)
    assert [rel for _, rel in folders] == ["PH101 Ethics [m1aaaaaa]", "PH101 Ethics [m1aaaaaa]/01 Introduction",
                                           "PH101 Ethics [m1aaaaaa]/02 Utilitarianism", "Unsorted"]
    unsorted = next(place for place in places if place.folder == "Unsorted")
    assert [reading["id"] for reading in unsorted.readings] == ["r4"]


def test_reading_names_come_from_the_citation_and_clash_safely():
    assert study.citation_label({"authors": [{"family": "Smith"}, {"family": "Jones"}], "year": "2020"}) == "Smith and Jones 2020"
    assert study.citation_label({"authors": ["A. Smith", "B. Jones", "C. Lee"], "year": 2020}) == "Smith et al. 2020"
    place = study.Place("x", "x", readings=[{"id": "aaaaaaaa1", "title": "Same"}, {"id": "bbbbbbbb2", "title": "SAME"}])
    files = {}
    for reading in place.readings:
        reading["url"] = "https://example.com/" + reading["id"]
    names = [item.filename for item in study.reading_files(place, files)]
    assert names == ["Same [aaaaaaaa].url", "SAME [bbbbbbbb].url"]


def test_rich_text_notes_become_markdown_with_local_pictures():
    tables, _ = study_tables()
    assets = study.NoteAssets()
    text = study.note_markdown(tables["notes"]["n1"], assets)
    assert text.startswith("# Lecture notes\n")
    assert "**Key idea**" in text and "- first point" in text
    [name] = assets.wanted
    assert f"![diagram](<_assets/{name}>)" in text and name.endswith(".png")


def test_study_run_writes_readings_notes_pictures_and_index(tmp_path):
    tables, objects = study_tables()
    fake = FakeApi(tables, objects)
    dest, state = tmp_path / "Drive" / "Study", tmp_path / "state"
    code, output = run_command(study, fake, dest, state)
    assert code == 0, output
    week1 = dest / "PH101 Ethics [m1aaaaaa]" / "01 Introduction"
    assert (week1 / "Readings" / "Mill 1859 - On Liberty.pdf").read_bytes().startswith(b"%PDF")
    assert (dest / "PH101 Ethics [m1aaaaaa]" / "02 Utilitarianism" / "Readings" / "SEP entry.url").exists()
    assert (week1 / "Notes" / "Lecture notes.md").exists()
    assert (week1 / "Notes" / "Seminar.md").read_text() == "# Seminar\n\nPlain **markdown**\n"
    assert len(list((week1 / "Notes" / "_assets").iterdir())) == 1
    index = (dest / "index.md").read_text()
    assert "Odd file (no copy: its file type is not synced)" in index
    assert not list(dest.rglob("*.exe"))
    assert run_command(study, fake, dest, state)[1].count("written") == 1  # only the summary line


def test_study_without_a_modules_table_stops_with_guidance(tmp_path):
    fake = FakeApi({"applications": {}}, {})
    dest = tmp_path / "Drive" / "Study"
    code, output = run_command(study, fake, dest, tmp_path / "state")
    assert code == 2 and "--inspect" in output
