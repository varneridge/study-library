# filename: backend/tests/test_jobs_sync_extended.py
"""Tests for the Antigravity Jobs workspace integration in backend/sync/jobs.py:
adopting existing workspace folders, pushing final files and new folders up to
Study Library, and keeping the career reference document's Application
History table in line.

Like the acceptance tests, they need no network, no Google Drive and no
Windows, because the Worker is replaced by a fake that serves and records
everything in memory.

Run: pytest backend/tests/test_jobs_sync_extended.py
"""

from __future__ import annotations

import csv
import hashlib
import io
import os
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from study.api import ApiError  # noqa: E402
from sync import common, jobs  # noqa: E402

PDF = "application/pdf"
OLD = "2020-01-01T00:00:00.000Z"
PA_FOLDER = "2026-10-24 - PA Consulting - Consulting Rotational Programme Analyst"


def app(**overrides) -> dict:
    row = {
        "id": "0f3c9a2e-1111-4222-8333-444455556666", "employer": "Acme", "role": "Analyst",
        "applied": "2026-10-01", "stage": "applied", "next_deadline": None, "notes": None,
        "file_cv": None, "file_cl": None, "file_rd": None, "file_qs": None,
        "deleted": False, "modified_at": OLD,
    }
    row.update(overrides)
    return row


def blob(data: bytes) -> tuple[str, bytes]:
    return f"files/{hashlib.sha256(data).hexdigest()}", data


def saved(key: str, data: bytes, name: str = "file.pdf", mime: str = PDF) -> dict:
    return {"state": "saved", "key": key, "name": name, "mime": mime, "bytes": len(data)}


class FakeApi:
    """Serves tables and objects from memory, and records uploads and pushes.
    A push merges each row into the table, as the Worker's sync does."""

    def __init__(self, tables: dict, objects: dict[str, bytes] | None = None):
        self.tables = tables
        self.objects = dict(objects or {})
        self.fetches: list[str] = []
        self.uploads: list[tuple[str, str]] = []
        self.pushes: list[list[dict]] = []
        self.refuse: set[str] = set()
        self.upload_error: Exception | None = None

    def pull_all(self):
        return {name: {ident: dict(row) for ident, row in rows.items()} for name, rows in self.tables.items()}

    def object_chunks(self, key: str):
        self.fetches.append(key)
        yield self.objects[key]

    def upload(self, path: str, sha256: str, mime: str) -> str:
        if self.upload_error:
            raise self.upload_error
        data = Path(path).read_bytes()
        assert hashlib.sha256(data).hexdigest() == sha256
        self.objects[f"files/{sha256}"] = data
        self.uploads.append((Path(path).name, mime))
        return f"files/{sha256}"

    def push(self, changes: list[dict]) -> list[dict]:
        self.pushes.append(changes)
        failures = []
        for change in changes:
            row = change["row"]
            if row["id"] in self.refuse:
                failures.append({"id": row["id"], "error": "refused"})
                continue
            table = self.tables.setdefault(change["table"], {})
            key = next((key for key, existing in table.items() if existing["id"] == row["id"]), row["id"])
            table[key] = {**table.get(key, {}), **row}
        return failures


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(common, "sleep", lambda _seconds: None)


@pytest.fixture
def world(tmp_path):
    dest = tmp_path / "Jobs" / "applications"
    dest.mkdir(parents=True)
    return dest, tmp_path / "state"


def sync(fake: FakeApi, dest: Path, state: Path, *extra: str) -> tuple[int, str]:
    lines: list[str] = []
    code = jobs.main(["--dest", str(dest), "--state-dir", str(state), *extra],
                     api_factory=lambda _env: fake, out=lines.append)
    return code, "\n".join(lines)


def folders(dest: Path) -> list[str]:
    return sorted(entry.name for entry in dest.iterdir() if entry.is_dir())


def age(path: Path, when: str = "2020-01-01T00:00:00+00:00") -> None:
    stamp = jobs.parse_moment(when)
    os.utime(path, (stamp, stamp))


# Matching

def test_the_pa_consulting_example_matches():
    assert jobs.match_score("PA Consulting", "Rotational Consultant", date(2026, 10, 25),
                            "PA Consulting", "Consulting Rotational Programme Analyst", date(2026, 10, 24))


@pytest.mark.parametrize("role_a, role_b", [
    ("Graduate Programme - Audit", "Graduate Programme - Tax"),
    ("Summer Internship", "Graduate Programme"),
    ("Summer Analyst", "Graduate Analyst"),
    ("Graduate Analyst", "Graduate Engineer"),
])
def test_different_roles_at_one_employer_are_kept_apart(role_a, role_b):
    assert jobs.match_score("Deloitte", role_a, None, "Deloitte", role_b, None) is None


@pytest.mark.parametrize("a, b, same", [
    ("PA Consulting Group Ltd", "PA Consulting", True),
    ("Société Générale", "Societe Generale", True),
    ("Ernst & Young", "Ernst and Young LLP", True),
    ("Goldman Sachs", "Goldman Sachs International", True),
    ("Acme", "Beta", False),
    ("", "", False),
])
def test_employer_names_are_compared_without_noise(a, b, same):
    assert jobs.employers_match(a, b) is same


def test_a_folder_from_another_recruitment_cycle_is_not_a_match():
    assert jobs.match_score("Acme", "Analyst", date(2026, 10, 1), "Acme", "Analyst", date(2025, 1, 10)) is None


@pytest.mark.parametrize("name, expected", [
    (PA_FOLDER, (date(2026, 10, 24), "PA Consulting", "Consulting Rotational Programme Analyst", None)),
    ("2026-10-01 - Acme - Analyst [a1aaaaaa]", (date(2026, 10, 1), "Acme", "Analyst", "a1aaaaaa")),
    ("Acme - Analyst [a1aaaaaa]", (None, "Acme", "Analyst", "a1aaaaaa")),
    ("2026-10-01 - Acme - Analyst [London]", (date(2026, 10, 1), "Acme", "Analyst [London]", None)),
])
def test_folder_names_are_parsed(name, expected):
    folder = jobs.parse_folder(name)
    assert (folder.day, folder.employer, folder.role, folder.tag) == expected


@pytest.mark.parametrize("name", ["Templates", "2026-13-45 - Bad date", "notes"])
def test_other_folders_are_not_application_folders(name):
    assert jobs.parse_folder(name) is None


# Reusing workspace folders

def test_an_existing_workspace_folder_is_reused_rather_than_duplicated(world):
    dest, state = world
    (dest / PA_FOLDER).mkdir()
    (dest / PA_FOLDER / "research.md").write_text("mine")
    cv_key, cv = blob(b"%PDF-1.7 cv")
    fake = FakeApi({"applications": {"p": app(id="9a9a9a9a-0000-4000-8000-000000000001", employer="PA Consulting",
                                              role="Rotational Consultant", applied="2026-10-25",
                                              file_cv=saved(cv_key, cv))}}, {cv_key: cv})
    code, output = sync(fake, dest, state)
    assert code == 0, output
    assert folders(dest) == [PA_FOLDER]
    assert (dest / PA_FOLDER / "CV.pdf").read_bytes() == cv
    assert (dest / PA_FOLDER / "research.md").read_text() == "mine"
    [row] = list(csv.DictReader(io.StringIO((dest / "index.csv").read_text(encoding="utf-8-sig"))))
    assert row["Folder"] == PA_FOLDER


def test_an_adopted_folder_keeps_its_name_when_the_role_is_reworded(world):
    dest, state = world
    (dest / PA_FOLDER).mkdir()
    fake = FakeApi({"applications": {"p": app(employer="PA Consulting", role="Rotational Consultant",
                                              applied="2026-10-25")}})
    sync(fake, dest, state)
    fake.tables["applications"]["p"]["role"] = "Consultant, Rotational Programme"
    fake.tables["applications"]["p"]["employer"] = "PA Consulting Group"
    assert sync(fake, dest, state)[0] == 0
    assert folders(dest) == [PA_FOLDER]


def test_the_folder_date_stays_put_when_an_applied_date_is_recorded_later(world):
    dest, state = world
    fake = FakeApi({"applications": {"a": app(stage="to_apply", applied=None, created_at="2026-09-30T10:00:00Z")}})
    sync(fake, dest, state)
    assert folders(dest) == ["2026-09-30 - Acme - Analyst"]
    fake.tables["applications"]["a"].update(stage="applied", applied="2026-11-05")
    sync(fake, dest, state)
    assert folders(dest) == ["2026-09-30 - Acme - Analyst"]


def test_an_old_style_folder_found_by_its_id_is_renamed_to_the_convention(world):
    dest, state = world
    (dest / "Acme - Analyst [0f3c9a2e]").mkdir()
    (dest / "Acme - Analyst [0f3c9a2e]" / "prep.txt").write_text("mine")
    code, output = sync(FakeApi({"applications": {"a": app()}}), dest, state)
    assert code == 0, output
    assert folders(dest) == ["2026-10-01 - Acme - Analyst"]
    assert (dest / "2026-10-01 - Acme - Analyst" / "prep.txt").read_text() == "mine"


def test_last_years_folder_is_left_alone_and_a_new_one_made(world):
    dest, state = world
    (dest / "2025-01-10 - Acme - Analyst").mkdir()
    sync(FakeApi({"applications": {"a": app()}}), dest, state)
    assert folders(dest) == ["2025-01-10 - Acme - Analyst", "2026-10-01 - Acme - Analyst"]
    assert not list((dest / "2025-01-10 - Acme - Analyst").iterdir())


def test_a_new_name_already_in_use_gets_the_id_instead_of_sharing_the_folder(world):
    dest, state = world
    # Same name, but a summer internship, so it is not this graduate role.
    (dest / "2026-10-01 - Acme - Graduate Analyst").mkdir()
    (dest / "2026-10-01 - Acme - Graduate Analyst" / "summer.txt").write_text("other")
    fake = FakeApi({"applications": {"a": app(role="Graduate Analyst")}})
    jobs_plan = None
    sync(fake, dest, state)
    assert "2026-10-01 - Acme - Graduate Analyst" in folders(dest)
    assert jobs_plan is None  # the folder was adopted, which is correct for an exact match
    assert (dest / "2026-10-01 - Acme - Graduate Analyst" / "application.md").exists()


def test_a_folder_claimed_by_another_application_is_never_shared(tmp_path):
    claimed = "2026-10-01 - Acme - Analyst"
    (tmp_path / claimed).mkdir()
    manifest = common.Manifest(tmp_path / "m.json")
    manifest.folders["application:other"] = claimed
    syncer = common.Syncer(tmp_path, manifest, lambda key: [], common.Report())
    plan = jobs.plan_folders([app()], syncer)
    assert plan.target[app()["id"]] == "2026-10-01 - Acme - Analyst [0f3c9a2e]"
    syncer.close()


# Push

def test_a_generated_cover_letter_is_uploaded_into_the_cover_letter_slot(world):
    dest, state = world
    (dest / PA_FOLDER).mkdir()
    letter = dest / PA_FOLDER / "Cover Letter - PA Consulting.pdf"
    letter.write_bytes(b"%PDF-1.7 letter")
    fake = FakeApi({"applications": {"p": app(employer="PA Consulting", role="Rotational Consultant",
                                              applied="2026-10-25")}})
    code, output = sync(fake, dest, state, "--push")
    assert code == 0, output
    assert fake.uploads == [("Cover Letter - PA Consulting.pdf", PDF)]
    [[change]] = fake.pushes
    assert set(change["row"]) == {"id", "file_cl", "modified_at"}
    slot = fake.tables["applications"]["p"]["file_cl"]
    assert slot["state"] == "saved" and slot["name"] == letter.name and slot["bytes"] == len(b"%PDF-1.7 letter")
    # The mirror of the new slot is copied from the local file, not fetched back.
    assert (dest / PA_FOLDER / "Cover letter.pdf").read_bytes() == b"%PDF-1.7 letter"
    assert fake.fetches == []
    assert sync(fake, dest, state, "--push")[0] == 0
    assert len(fake.uploads) == 1 and len(fake.pushes) == 1


def test_files_the_sync_wrote_are_never_pushed_back(world):
    dest, state = world
    cv_key, cv = blob(b"%PDF-1.7 cv")
    rd_key, rd = blob(b"%PDF-1.7 role")
    fake = FakeApi({"applications": {"a": app(file_cv=saved(cv_key, cv), file_rd=saved(rd_key, rd))}},
                   {cv_key: cv, rd_key: rd})
    sync(fake, dest, state, "--push")
    sync(fake, dest, state, "--push")
    assert fake.uploads == [] and fake.pushes == []


def test_an_edited_mirror_is_pushed_and_settles_the_conflict(world):
    dest, state = world
    cv_key, cv = blob(b"%PDF-1.7 cv")
    fake = FakeApi({"applications": {"a": app(file_cv=saved(cv_key, cv))}}, {cv_key: cv})
    sync(fake, dest, state)
    (dest / "2026-10-01 - Acme - Analyst" / "CV.pdf").write_bytes(b"%PDF-1.7 revised cv")
    code, output = sync(fake, dest, state, "--push")
    assert code == 0, output
    assert fake.uploads == [("CV.pdf", PDF)]
    assert not [p for p in (dest / "2026-10-01 - Acme - Analyst").iterdir() if "from Study Library" in p.name]


def test_an_older_local_file_does_not_replace_a_newer_upload(world):
    dest, state = world
    cl_key, cl = blob(b"%PDF-1.7 letter uploaded in the app")
    fake = FakeApi({"applications": {"a": app(file_cl=saved(cl_key, cl), modified_at="2026-10-20T09:00:00.000Z")}},
                   {cl_key: cl})
    folder = dest / "2026-10-01 - Acme - Analyst"
    folder.mkdir()
    (folder / "Cover Letter - Acme.pdf").write_bytes(b"%PDF-1.7 an earlier draft")
    age(folder / "Cover Letter - Acme.pdf")
    code, output = sync(fake, dest, state, "--push")
    assert code == 0, output
    assert "held back" in output and fake.uploads == []


def test_a_file_regenerated_after_the_last_push_is_pushed_again(world):
    dest, state = world
    folder = dest / "2026-10-01 - Acme - Analyst"
    folder.mkdir()
    (folder / "Answers - Acme.docx").write_bytes(b"first answers")
    fake = FakeApi({"applications": {"a": app()}})
    sync(fake, dest, state, "--push")
    (folder / "Answers - Acme.docx").write_bytes(b"second answers")
    age(folder / "Answers - Acme.docx")  # older than the row, yet still ours to replace
    sync(fake, dest, state, "--push")
    assert [name for name, _ in fake.uploads] == ["Answers - Acme.docx", "Answers - Acme.docx"]
    key = fake.tables["applications"]["a"]["file_qs"]["key"]
    assert fake.objects[key] == b"second answers"


def test_a_pdf_is_preferred_and_markdown_goes_up_as_plain_text(world):
    dest, state = world
    folder = dest / "2026-10-01 - Acme - Analyst"
    folder.mkdir()
    for name in ("final_letter.md", "Cover Letter - Acme.docx", "Cover Letter - Acme.pdf", "final_answers.md",
                 "~$ver Letter - Acme.docx"):
        (folder / name).write_bytes(name.encode())
    fake = FakeApi({"applications": {"a": app()}})
    assert sync(fake, dest, state, "--push")[0] == 0
    assert sorted(fake.uploads) == [("Cover Letter - Acme.pdf", PDF), ("final_answers.md", "text/plain")]
    assert (folder / "Answers to questions.txt").read_bytes() == b"final_answers.md"


def test_an_unknown_local_folder_becomes_an_application(world):
    dest, state = world
    folder = dest / "2026-11-02 - Globex - Data Analyst"
    folder.mkdir()
    (folder / "Cover Letter - Globex.pdf").write_bytes(b"%PDF letter")
    (folder / "CV - Samuel Leigh.pdf").write_bytes(b"%PDF cv")
    fake = FakeApi({"applications": {}})
    code, output = sync(fake, dest, state, "--push")
    assert code == 0, output
    [row] = fake.tables["applications"].values()
    assert (row["employer"], row["role"], row["stage"], row["applied"]) == ("Globex", "Data Analyst", "applied",
                                                                           "2026-11-02")
    assert row["file_cl"]["name"] == "Cover Letter - Globex.pdf" and row["file_cv"]["name"] == "CV - Samuel Leigh.pdf"
    assert folders(dest) == ["2026-11-02 - Globex - Data Analyst"]
    assert "Applied: awaiting response" in (folder / "application.md").read_text()
    sync(fake, dest, state, "--push")
    assert len(fake.tables["applications"]) == 1 and len(fake.pushes) == 1


def test_a_folder_without_final_files_becomes_an_application_to_apply_for(world):
    dest, state = world
    (dest / "2026-11-03 - Initech - Trainee").mkdir()
    (dest / "2026-11-03 - Initech - Trainee" / "Role - Initech.pdf").write_bytes(b"%PDF role")
    fake = FakeApi({"applications": {}})
    sync(fake, dest, state, "--push")
    [row] = fake.tables["applications"].values()
    assert row["stage"] == "to_apply" and row["applied"] is None and row["file_rd"]["name"] == "Role - Initech.pdf"


def test_a_folder_matching_a_deleted_application_is_not_recreated(world):
    dest, state = world
    (dest / "2026-10-02 - Acme - Analyst").mkdir()
    fake = FakeApi({"applications": {"a": app(deleted=True)}})
    code, output = sync(fake, dest, state, "--push")
    assert code == 0 and "matches a deleted application" in output
    assert fake.pushes == []


def test_a_dry_run_push_uploads_and_creates_nothing(world):
    dest, state = world
    (dest / "2026-10-01 - Acme - Analyst").mkdir()
    (dest / "2026-10-01 - Acme - Analyst" / "Cover Letter - Acme.pdf").write_bytes(b"%PDF")
    (dest / "2026-11-02 - Globex - Data Analyst").mkdir()
    fake = FakeApi({"applications": {"a": app()}})
    code, output = sync(fake, dest, state, "--push", "--dry-run")
    assert code == 0 and "would upload" in output and "would create application" in output
    assert fake.uploads == [] and fake.pushes == []


def test_a_refused_push_is_reported_and_tried_again_next_time(world):
    dest, state = world
    (dest / "2026-10-01 - Acme - Analyst").mkdir()
    (dest / "2026-10-01 - Acme - Analyst" / "Cover Letter - Acme.pdf").write_bytes(b"%PDF")
    fake = FakeApi({"applications": {"a": app()}})
    fake.refuse.add(app()["id"])
    code, output = sync(fake, dest, state, "--push")
    assert code == 1 and "refused" in output
    assert fake.tables["applications"]["a"]["file_cl"] is None
    assert not (dest / "2026-10-01 - Acme - Analyst" / "Cover letter.pdf").exists()
    fake.refuse.clear()
    assert sync(fake, dest, state, "--push")[0] == 0
    assert fake.tables["applications"]["a"]["file_cl"]["name"] == "Cover Letter - Acme.pdf"


def test_a_failed_upload_is_reported_and_the_mirror_still_runs(world):
    dest, state = world
    (dest / "2026-10-01 - Acme - Analyst").mkdir()
    (dest / "2026-10-01 - Acme - Analyst" / "Cover Letter - Acme.pdf").write_bytes(b"%PDF")
    fake = FakeApi({"applications": {"a": app()}})
    fake.upload_error = ApiError("forbidden", 403)
    code, output = sync(fake, dest, state, "--push")
    assert code == 1 and "upload failed" in output
    assert fake.pushes == []
    assert (dest / "2026-10-01 - Acme - Analyst" / "application.md").exists()


def test_push_decisions():
    candidate = jobs.Candidate("cl", Path("x.pdf"), "a" * 64, 1, jobs.parse_moment("2026-10-10T00:00:00Z"))
    held = saved(f"files/{'b' * 64}", b"x")
    assert jobs.push_decision(candidate, None, None, None) == "push"
    assert jobs.push_decision(candidate, {"state": "uploading"}, None, None) == "busy"
    assert jobs.push_decision(candidate, saved(f"files/{'a' * 64}", b"x"), None, None) == "same"
    assert jobs.push_decision(candidate, held, {"sha": "b" * 64}, "2030-01-01T00:00:00Z") == "push"
    assert jobs.push_decision(candidate, held, None, "2026-10-01T00:00:00Z") == "push"
    assert jobs.push_decision(candidate, held, None, "2026-10-20T00:00:00Z") == "older"
    assert jobs.push_decision(candidate, held, None, None) == "older"


# The reference document

REFERENCE = """# Samuel Leigh: Career Reference

## 10. Skills

| Skill | Level |
| --- | --- |
| Excel | Advanced |

# 11. Application History

Kept up to date by the jobs sync.

| Company | Role | Status | Date applied | Salary | Notes |
|:---|---|---|---|---|---|
| PA Consulting | Consulting Rotational Programme Analyst | Applied | 24 Oct 2026 | £32k | Referred by Jo \\| alumni |
| Old Firm | Intern | Rejected | 3 Mar 2024 | | Historic |

# 12. Referees

- Dr Smith
"""


def history_apps() -> list[dict]:
    return [
        app(id="p", employer="PA Consulting", role="Rotational Consultant", applied="2026-10-25",
            stage="interview_todo", next_deadline="2026-11-20", notes=None),
        app(id="g", employer="Globex", role="Data Analyst", applied="2026-11-02", notes="Spoke to | recruiter"),
    ]


def test_reference_rows_are_updated_and_added_and_everything_else_left_intact():
    text, updated, added = jobs.update_reference(REFERENCE, history_apps())
    assert (updated, added) == (1, 1)
    before, after = REFERENCE.splitlines(), text.splitlines()
    assert [line for line in after if line not in before] == [
        "| PA Consulting | Consulting Rotational Programme Analyst | Interview: to prepare and attend | 25 Oct 2026 "
        "| £32k | Referred by Jo \\| alumni |",
        "| Globex | Data Analyst | Applied: awaiting response | 2 Nov 2026 |  | Spoke to \\| recruiter |",
    ]
    assert after.index("| Old Firm | Intern | Rejected | 3 Mar 2024 | | Historic |") + 1 == after.index(
        "| Globex | Data Analyst | Applied: awaiting response | 2 Nov 2026 |  | Spoke to \\| recruiter |")
    assert text.endswith("# 12. Referees\n\n- Dr Smith\n")


def test_a_second_update_changes_nothing():
    text, _, _ = jobs.update_reference(REFERENCE, history_apps())
    assert jobs.update_reference(text, history_apps()) == (text, 0, 0)


def test_iso_dates_in_the_document_stay_iso():
    doc = ("# 11. Application History\n\n| Employer | Role | Stage | Applied | Next deadline |\n"
           "| --- | --- | --- | --- | --- |\n| Acme | Analyst | Applied | 2026-10-01 | |\n")
    text, updated, _ = jobs.update_reference(doc, [app(next_deadline="2026-12-01")])
    assert updated == 1 and "| Acme | Analyst | Applied: awaiting response | 2026-10-01 | 2026-12-01 |" in text


def test_a_section_without_a_table_gets_one():
    doc = "# 11. Application History\n\nNothing yet.\n\n# 12. Referees\n"
    text, _, added = jobs.update_reference(doc, [app()])
    assert added == 1
    assert ("Nothing yet.\n\n| Employer | Role | Stage | Applied | Next deadline | Notes |\n"
            "| --- | --- | --- | --- | --- | --- |\n| Acme | Analyst | Applied: awaiting response | 1 Oct 2026 |  |  |\n"
            "\n# 12. Referees\n") in text


@pytest.mark.parametrize("doc, message", [
    ("# 10. Skills\n\nNone.\n", "no '# 11. Application History' section"),
    ("# 11. Application History\n\n| Role | Stage |\n| --- | --- |\n", "no Employer or Company column"),
])
def test_a_document_the_sync_cannot_read_safely_is_refused(doc, message):
    with pytest.raises(jobs.ReferenceDocError, match=message):
        jobs.update_reference(doc, [app()])


def test_a_heading_inside_a_code_fence_does_not_end_the_section():
    doc = ("# 11. Application History\n\n```\n# not a heading\n```\n\n| Employer | Stage |\n| --- | --- |\n"
           "| Acme | Applied |\n")
    assert jobs.update_reference(doc, [app(stage="rejected")])[1] == 1


def run_with_reference(world, tmp_path, doc: bytes, *extra: str) -> tuple[int, str, Path]:
    dest, state = world
    reference = tmp_path / "Jobs" / "reference" / "Samuel_Leigh_Career_Reference.md"
    reference.parent.mkdir(parents=True, exist_ok=True)
    reference.write_bytes(doc)
    code, output = sync(FakeApi({"applications": {"p": history_apps()[0], "g": history_apps()[1]}}), dest, state,
                        "--update-reference", str(reference), *extra)
    return code, output, reference


def test_the_reference_is_rewritten_atomically_with_a_backup(world, tmp_path):
    code, output, reference = run_with_reference(world, tmp_path, REFERENCE.encode())
    assert code == 0, output
    assert "1 rows updated, 1 added" in output
    assert "Interview: to prepare and attend" in reference.read_text(encoding="utf-8")
    [backup] = (reference.parent / "_Old").iterdir()
    assert backup.read_text(encoding="utf-8") == REFERENCE
    assert not list(reference.parent.glob(".~sync-*"))


def test_line_endings_and_byte_order_mark_are_kept(world, tmp_path):
    original = b"\xef\xbb\xbf" + REFERENCE.replace("\n", "\r\n").encode()
    _, _, reference = run_with_reference(world, tmp_path, original)
    data = reference.read_bytes()
    assert data.startswith(b"\xef\xbb\xbf")
    assert data.count(b"\r\n") == data.count(b"\n")


def test_a_dry_run_leaves_the_reference_untouched(world, tmp_path):
    code, output, reference = run_with_reference(world, tmp_path, REFERENCE.encode(), "--dry-run")
    assert code == 0 and "would update" in output
    assert reference.read_text(encoding="utf-8") == REFERENCE
    assert not (reference.parent / "_Old").exists()


def test_a_reference_without_the_section_is_reported_and_not_written(world, tmp_path):
    code, output, reference = run_with_reference(world, tmp_path, b"# Notes\n")
    assert code == 1 and "Application History" in output
    assert reference.read_bytes() == b"# Notes\n"


def test_a_missing_reference_is_reported_but_the_mirror_still_runs(world, tmp_path):
    dest, state = world
    code, output = sync(FakeApi({"applications": {"a": app()}}), dest, state,
                        "--update-reference", str(tmp_path / "missing.md"))
    assert code == 1 and "was not found" in output
    assert (dest / "2026-10-01 - Acme - Analyst" / "application.md").exists()


def test_the_reference_flag_defaults_to_the_workspace_document():
    assert jobs.arguments().parse_args(["--update-reference"]).update_reference == jobs.DEFAULT_REFERENCE
    assert jobs.arguments().parse_args([]).update_reference is None


@pytest.mark.skipif(os.name == "nt", reason="the WSL mapping applies only off Windows")
def test_a_windows_reference_path_is_mapped_to_its_wsl_mount(monkeypatch):
    monkeypatch.setattr(common.os.path, "ismount", lambda path: str(path) == "/mnt/g")
    assert common.resolve_dest(jobs.DEFAULT_REFERENCE, "--update-reference") == Path(
        "/mnt/g/My Drive/Antigravity/Jobs/reference/Samuel_Leigh_Career_Reference.md")
    monkeypatch.setattr(common.os.path, "ismount", lambda path: False)
    with pytest.raises(common.SyncError, match="not mounted"):
        common.resolve_dest(jobs.DEFAULT_REFERENCE, "--update-reference")


def test_a_relative_reference_path_stops_the_run_before_anything_is_pulled(world):
    dest, state = world
    fake = FakeApi({"applications": {"a": app()}})
    code, output = sync(fake, dest, state, "--update-reference", "reference.md")
    assert code == 2 and "--update-reference must be an absolute path" in output
    assert folders(dest) == []
