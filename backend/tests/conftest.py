"""Integration fixtures. Starts the Worker locally with wrangler dev, using a
fresh local D1 database and R2 bucket for the test session."""

from __future__ import annotations

import os
import socket
import subprocess
import time
from pathlib import Path

import pytest
import requests

from study.api import Api

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "app"
KEY = "test-processor-key"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="session")
def server(tmp_path_factory):
    state = tmp_path_factory.mktemp("wrangler-state")
    env = {**os.environ, "WRANGLER_SEND_METRICS": "false", "CI": "true", "NO_COLOR": "1"}
    (APP / "dist").mkdir(exist_ok=True)
    if not (APP / "dist" / "index.html").exists():
        (APP / "dist" / "index.html").write_text("<!doctype html><title>Study Library</title>")
    subprocess.run(
        ["npx", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", str(state)],
        cwd=APP, env=env, check=True, capture_output=True,
    )
    port = _free_port()
    log = open(state / "wrangler.log", "w")
    process = subprocess.Popen(
        ["npx", "wrangler", "dev", "--port", str(port), "--ip", "127.0.0.1",
         "--persist-to", str(state), "--var", "ALLOW_UNAUTHENTICATED:true",
         "--var", f"PROCESSOR_KEY:{KEY}", "--var", "DEV_RESET:true"],
        cwd=APP, env=env, stdout=log, stderr=subprocess.STDOUT,
    )
    url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 90
    while time.time() < deadline:
        try:
            if requests.get(url + "/api/ping", timeout=2).ok:
                break
        except requests.RequestException:
            pass
        time.sleep(0.5)
    else:
        process.terminate()
        raise RuntimeError("wrangler dev did not start: " + (state / "wrangler.log").read_text()[-2000:])
    yield url
    process.terminate()
    process.wait(timeout=20)


@pytest.fixture
def api(server):
    client = Api(server, processor_key=KEY)
    client._json("POST", "/api/dev/reset")
    return client


@pytest.fixture
def module(api):
    """A module with AT1 to AT4, each with a lecture and a seminar."""
    from study.api import stamp

    changes = [{"table": "modules", "row": {
        "id": "m1", "code": "HY335", "title": "China and the World",
        "session_pattern": ["lecture", "seminar"], "description": None,
        "last_opened_week_id": None, "position": "a0", "modified_at": stamp(), "deleted": False}}]
    weeks = {}
    for number in range(1, 5):
        week_id = f"w{number}"
        weeks[("AT", number)] = week_id
        changes.append({"table": "weeks", "row": {
            "id": week_id, "module_id": "m1", "term": "AT", "number": number, "title": None,
            "is_reading_week": False, "modified_at": stamp(), "deleted": False}})
        for position, kind in (("a0", "lecture"), ("a1", "seminar")):
            changes.append({"table": "sessions", "row": {
                "id": f"s{number}{kind[0]}", "week_id": week_id, "kind": kind, "title": None,
                "position": position, "modified_at": stamp(), "deleted": False}})
    assert api.push(changes) == []
    return {"id": "m1", "weeks": weeks}
