"""The job search: applications sync like everything else, each file slot
is its own column, files are served under their own names, and the purge
never deletes a stored file an application still uses."""
import hashlib

from study.api import stamp


def _application(modified_at, **fields):
    row = {"id": "a1", "employer": "Kekst CNC", "role": "Summer 2026 Internship", "applied": "2026-02-26",
           "stage": "applied", "next_deadline": None, "notes": None,
           "file_cv": None, "file_cl": None, "file_rd": None, "file_qs": None,
           "modified_at": modified_at, "deleted": False}
    row.update(fields)
    return row


def _push(api, row, cols=None):
    change = {"table": "applications", "row": row}
    if cols:
        change["cols"] = cols
    return api._json("POST", "/api/sync/push", json={"changes": [change]})


def test_an_application_syncs_with_its_file_slots(api):
    result = _push(api, _application(stamp(), file_cv={"state": "saved"}, file_qs={"state": "na"}))
    assert result["failures"] == []
    row = api.pull_all()["applications"]["a1"]
    assert row["employer"] == "Kekst CNC" and row["stage"] == "applied"
    assert row["file_cv"] == {"state": "saved"} and row["file_qs"] == {"state": "na"} and row["file_cl"] is None


def test_a_change_to_one_slot_leaves_the_others_alone(api):
    _push(api, _application("2026-10-08T10:00:00.000Z"))
    # One device attaches the CV; another, with an old copy, marks Qs not required.
    _push(api, _application("2026-10-08T10:01:00.000Z", file_cv={"state": "saved", "key": "files/abc.pdf", "name": "CV.pdf"}),
          cols=["file_cv"])
    _push(api, _application("2026-10-08T10:02:00.000Z", file_qs={"state": "na"}), cols=["file_qs"])
    row = api.pull_all()["applications"]["a1"]
    assert row["file_cv"]["name"] == "CV.pdf"
    assert row["file_qs"] == {"state": "na"}


def test_a_new_application_gets_defaults_for_what_it_leaves_out(api):
    row = {"id": "a2", "applied": "2026-10-08", "modified_at": stamp(), "deleted": False}
    assert _push(api, row)["failures"] == []
    saved = api.pull_all()["applications"]["a2"]
    assert saved["employer"] == "" and saved["role"] == "" and saved["stage"] == "applied"


def test_a_file_is_served_under_its_own_name(api, tmp_path):
    body = b"Samuel Leigh\nAnswers to the application questions.\n"
    sha = hashlib.sha256(body).hexdigest()
    key = api._json("PUT", f"/api/files/{sha}", data=body, headers={"Content-Type": "text/plain"})["key"]
    assert key == f"files/{sha}.txt"
    response = api.session.get(f"{api.base}/api/objects/{key}", params={"name": "Kekst answers.txt"})
    assert response.status_code == 200 and response.content == body
    assert response.headers["content-disposition"] == "inline; filename*=UTF-8''Kekst%20answers.txt"
    # Without a name, the response is as it always was.
    plain = api.session.get(f"{api.base}/api/objects/{key}")
    assert "content-disposition" not in plain.headers


def test_the_purge_keeps_a_file_an_application_uses(api):
    body = b"%PDF-1.4 a role description"
    sha = hashlib.sha256(body).hexdigest()
    key = api._json("PUT", f"/api/files/{sha}", data=body, headers={"Content-Type": "application/pdf"})["key"]
    # The same PDF was also a reading, long since deleted, so its file row
    # is due to be purged with its stored copy.
    api.push([{"table": "files", "row": {
        "id": "f-old", "sha256": sha, "r2_key": key, "mime": "application/pdf", "bytes": len(body), "original_name": None,
        "page_count": 1, "text_status": "ready", "modified_at": "2026-01-01T00:00:00.000Z", "deleted": True}}])
    _push(api, _application(stamp(), file_rd={"state": "saved", "key": key, "name": "Role.pdf"}))
    api._json("POST", "/api/dev/purge")
    assert "f-old" not in api.pull_all().get("files", {})
    assert api.session.get(f"{api.base}/api/objects/{key}").status_code == 200
