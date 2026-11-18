"""Folders on Library shelves (migration 0024) sync like every other table, and
a reading's folder_id is a column of its own, so moving a reading into a folder
on one device and reordering it on another both survive."""

from __future__ import annotations

from study.api import stamp


def _folder(title, modified_at, folder_id="f1", deleted=False):
    return {"table": "folders", "row": {"id": folder_id, "week_id": "w1", "title": title, "position": "a0",
                                        "modified_at": modified_at, "deleted": deleted}}


def _link(modified_at, folder_id=None, position="a0"):
    return {"id": "l1", "week_id": "w1", "item_id": "i1", "session_id": None, "position": position,
            "folder_id": folder_id, "modified_at": modified_at, "deleted": False}


def test_folders_round_trip_and_last_write_wins(api):
    assert api.push([_folder("The Expanse", "2026-11-01T10:00:00.000Z")]) == []
    assert api.push([_folder("Stale", "2026-11-01T09:00:00.000Z")]) == []
    row = api.pull_all()["folders"]["f1"]
    assert row["title"] == "The Expanse" and row["week_id"] == "w1" and row["deleted"] is False
    api.push([_folder("The Expanse", stamp(), deleted=True)])
    assert api.pull_all()["folders"]["f1"]["deleted"] is True


def test_a_readings_folder_and_its_place_are_separate_columns(api):
    api.push([{"table": "week_items", "row": _link("2026-11-01T10:00:00.000Z")}])
    # One device puts the reading in a folder; another, which never saw that, moves it along.
    api._json("POST", "/api/sync/push", json={"changes": [
        {"table": "week_items", "row": _link("2026-11-01T10:01:00.000Z", folder_id="f1"), "cols": ["folder_id"]}]})
    api._json("POST", "/api/sync/push", json={"changes": [
        {"table": "week_items", "row": _link("2026-11-01T10:02:00.000Z", position="a5"), "cols": ["position"]}]})
    row = api.pull_all()["week_items"]["l1"]
    assert row["folder_id"] == "f1" and row["position"] == "a5"


def test_readings_from_before_folders_have_no_folder(api):
    old = _link(stamp())
    del old["folder_id"]
    assert api.push([{"table": "week_items", "row": old}]) == []
    assert api.pull_all()["week_items"]["l1"].get("folder_id") is None
