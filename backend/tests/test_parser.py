import json
from pathlib import Path

import pytest

from study.parser import parse_title

FIXTURES = json.loads(
    (Path(__file__).resolve().parents[2] / "shared/title-fixtures.json").read_text()
)


@pytest.mark.parametrize("case", FIXTURES, ids=[c["input"][:40] for c in FIXTURES])
def test_parse_title(case):
    assert parse_title(case["input"]).as_dict() == case["expect"]
