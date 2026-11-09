"""Tests for study.textnorm, mirrored by app/src/lib/textnorm.test.ts."""

import pytest

from study.textnorm import LIGATURES, repair_text


@pytest.mark.parametrize(("ligature", "expected"), sorted(LIGATURES.items()))
def test_each_ligature_is_expanded(ligature, expected):
    assert repair_text(f"x{ligature}y") == f"x{expected}y"


def test_repairs_ligatures_in_running_text():
    assert repair_text("ﬁnal ﬂow oﬀer eﬃcient baﬄe ﬅop ﬆop ſun") == (
        "final flow offer efficient baffle stop stop sun"
    )


def test_repairs_calibri_glyphs_after_lowercase_letters():
    assert repair_text("informaƟon leŌ aŌer") == "information left after"


def test_repairs_runs_of_glyphs_in_one_pass():
    assert repair_text("aŌŌ") == "aftft"


@pytest.mark.parametrize(
    "text",
    [
        "café résumé",
        "E = mc² ½ ™",
        "Ōsaka",
        "the letter Ɵ",
        "INFORMAƟON",
        "😀Ɵ",
    ],
)
def test_leaves_legitimate_text_untouched(text):
    assert repair_text(text) == text


@pytest.mark.parametrize(
    "text",
    ["aŌŌ", "posiƟƟon", "ﬁ ſ Ɵ", "leŌ", "Ōsaka", "plain text", ""],
)
def test_repair_is_idempotent(text):
    once = repair_text(text)
    assert repair_text(once) == once


def test_empty_string_is_returned_unchanged():
    assert repair_text("") == ""
