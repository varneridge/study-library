from study.api import stamp


def _week(title, modified_at, week_id="w1"):
    return {"table": "weeks", "row": {
        "id": week_id, "module_id": "m1", "term": "AT", "number": 3, "title": title,
        "is_reading_week": False, "modified_at": modified_at, "deleted": False}}


def test_last_write_wins(api):
    assert api.push([_week("Origins", "2026-10-06T10:00:00.000Z")]) == []
    assert api.push([_week("Stale", "2026-10-06T09:00:00.000Z")]) == []
    assert api.pull_all()["weeks"]["w1"]["title"] == "Origins"
    assert api.push([_week("Newer", "2026-10-06T11:00:00.000Z")]) == []
    assert api.pull_all()["weeks"]["w1"]["title"] == "Newer"


def test_types_round_trip(api):
    api.push([{"table": "highlights", "row": {
        "id": "h1", "item_id": "i1", "page": 2, "rects": [[72.0, 700.5, 300.0, 712.0]],
        "body": "text", "colour": "#ffd400", "comment": None, "question_id": None,
        "zotero_key": None, "modified_at": stamp(), "deleted": False}}])
    row = api.pull_all()["highlights"]["h1"]
    assert row["rects"] == [[72.0, 700.5, 300.0, 712.0]]
    assert row["deleted"] is False
    assert row["page"] == 2


def test_bad_rows_do_not_block_good_ones(api):
    failures = api.push([
        {"table": "jobs", "row": {"id": "x", "modified_at": stamp()}},
        {"table": "items", "row": {"id": "i9", "kind": "nonsense", "title": "x", "modified_at": stamp()}},
        {"table": "weeks", "row": {"id": "w2", "module_id": "m1", "term": "AT", "number": 1,
                                   "modified_at": "yesterday"}},
        _week("Fine", stamp()),
    ])
    assert len(failures) == 3
    assert api.pull_all()["weeks"]["w1"]["title"] == "Fine"


def test_future_stamps_are_clamped(api):
    api.push([_week("From the future", "2099-01-01T00:00:00.000Z")])
    # The stamp is clamped to at most ten minutes ahead, so edits can win again soon.
    assert api.pull_all()["weeks"]["w1"]["modified_at"] < "2099"


def test_pull_pages_through_everything(api):
    changes = [_week(f"Week {n}", stamp(), week_id=f"w{n}") for n in range(30)]
    api.push(changes)
    result = api._json("GET", "/api/sync/pull", params={"since": 0, "limit": 7})
    assert result["more"] is True
    assert len(result["rows"]["weeks"]) == 7
    assert len(api.pull_all()["weeks"]) == 30


def test_pull_since_cursor_only_returns_new_rows(api):
    api.push([_week("One", stamp())])
    cursor = api._json("GET", "/api/sync/pull", params={"since": 0})["cursor"]
    assert api._json("GET", "/api/sync/pull", params={"since": cursor})["rows"] == {}
    api.push([_week("Two", stamp(), week_id="w2")])
    rows = api._json("GET", "/api/sync/pull", params={"since": cursor})["rows"]
    assert list(rows) == ["weeks"]
    assert [r["id"] for r in rows["weeks"]] == ["w2"]


def _file(file_id, mime="application/pdf"):
    return {"table": "files", "row": {
        "id": file_id, "sha256": "a" * 64, "r2_key": f"files/{file_id}.pdf", "mime": mime,
        "bytes": 10, "original_name": "x.pdf", "page_count": None, "text_status": "pending",
        "modified_at": stamp(), "deleted": False}}


def _item(item_id, file_id):
    return {"table": "items", "row": {
        "id": item_id, "kind": "secondary", "author": None, "title": "T", "source": None,
        "pages": None, "year": None, "doc_date": None, "file_id": file_id, "original_file_id": None,
        "tray_module_id": None, "zotero_key": None, "last_page": None, "read_status": "unread",
        "modified_at": stamp(), "deleted": False}}


def test_jobs_follow_week_order_and_bumping(api, module):
    api.push([_file("f3"), _item("i3", None)])
    api.push([{"table": "week_items", "row": {
        "id": "l3", "week_id": module["weeks"][("AT", 3)], "item_id": "i3", "session_id": None,
        "position": "a0", "modified_at": stamp(), "deleted": False}}])
    api.push([_item("i3", "f3")])
    api.push([_file("f1"), _item("i1", "f1"), {"table": "week_items", "row": {
        "id": "l1", "week_id": module["weeks"][("AT", 1)], "item_id": "i1", "session_id": None,
        "position": "a0", "modified_at": stamp(), "deleted": False}}])

    first = api.claim()
    assert first["payload"]["file_id"] == "f1" and first["priority"] == 1
    api.fail(first["id"], "retry later")

    api._json("POST", "/api/files/f3/bump")
    api.push([_file("f9")])
    second = api.claim()
    assert second["payload"]["file_id"] == "f3" and second["priority"] < 0
    third = api.claim()
    assert third["payload"]["file_id"] == "f9" and third["priority"] is None
    assert api.claim() is None


def test_retry_requeues_a_failed_file(api):
    api.push([_file("f1")])
    api.claim()
    assert api._json("POST", "/api/files/f1/retry")["ok"] is True
    again = api.claim()
    assert again["payload"]["file_id"] == "f1"
    assert api.pull_all()["files"]["f1"]["text_status"] == "pending"


def _reading(modified_at, **fields):
    row = {"id": "i1", "kind": "secondary", "author": None, "title": "scan_0034", "source": None, "pages": None,
           "year": None, "doc_date": None, "file_id": None, "original_file_id": None, "tray_module_id": None,
           "zotero_key": None, "last_page": None, "read_status": "unread", "last_opened_at": None,
           "suggested": None, "last_spot": None, "modified_at": modified_at, "deleted": False}
    row.update(fields)
    return row


def test_a_patch_leaves_other_columns_alone(api):
    # The reading is added, then the processor names it on the server.
    api.push([{"table": "items", "row": _reading("2026-10-08T10:00:00.000Z")}])
    api.push([{"table": "items", "row": _reading("2026-10-08T10:01:00.000Z", author="Chen, J.", title="Introduction")}])
    # A device that never saw the name saves its place a minute later. It
    # still holds the old title, but sends only the place.
    stale = _reading("2026-10-08T10:02:00.000Z", last_page=4, last_spot={"page": 4, "frac": 0.3})
    api._json("POST", "/api/sync/push", json={"changes": [{"table": "items", "row": stale, "cols": ["last_page", "last_spot"]}]})
    row = api.pull_all()["items"]["i1"]
    assert row["title"] == "Introduction" and row["author"] == "Chen, J."
    assert row["last_page"] == 4 and row["last_spot"] == {"page": 4, "frac": 0.3}


def test_a_whole_row_without_cols_still_replaces_it(api):
    api.push([{"table": "items", "row": _reading("2026-10-08T10:00:00.000Z", title="One")}])
    api.push([{"table": "items", "row": _reading("2026-10-08T10:01:00.000Z")}])
    assert api.pull_all()["items"]["i1"]["title"] == "scan_0034"


def test_a_patch_to_a_missing_row_inserts_it(api):
    row = _reading("2026-10-08T10:00:00.000Z", title="New")
    api._json("POST", "/api/sync/push", json={"changes": [{"table": "items", "row": row, "cols": ["title"]}]})
    assert api.pull_all()["items"]["i1"]["title"] == "New"


def test_an_older_edit_gets_the_current_row_back(api):
    api.push([{"table": "items", "row": _reading("2026-10-08T10:05:00.000Z", title="Kept")}])
    older = _reading("2026-10-08T10:00:00.000Z", title="Lost")
    result = api._json("POST", "/api/sync/push", json={"changes": [
        {"table": "items", "row": older, "cols": ["title"]},
        _week("Fresh", stamp()),
    ]})
    assert result["failures"] == []
    assert [r["title"] for r in result["current"]["items"]] == ["Kept"]
    assert "weeks" not in result["current"]


def _old_file(file_id, sha):
    return {"table": "files", "row": {
        "id": file_id, "sha256": sha * 64, "r2_key": f"files/{sha * 64}.pdf", "mime": "application/pdf", "bytes": 1,
        "original_name": None, "page_count": None, "text_status": "ready",
        "modified_at": "2026-06-01T00:00:00.000Z", "deleted": False}}


def test_the_purge_lets_go_of_files_nothing_uses(api):
    api.push([_old_file("used", "a"), _old_file("orphan", "b"), _old_file("tombstoned", "c"),
              {"table": "items", "row": _reading("2026-06-01T00:00:00.000Z", file_id="used")},
              {"table": "items", "row": {**_reading("2026-10-01T00:00:00.000Z", file_id="tombstoned"),
                                         "id": "i2", "deleted": True}}])
    api._json("POST", "/api/dev/purge")
    files = api.pull_all()["files"]
    assert files["used"]["deleted"] is False
    # A deleted reading can still be restored, so its file stays.
    assert files["tombstoned"]["deleted"] is False
    assert files["orphan"]["deleted"] is True
