"""Tests for backend/tts/pronounce.py, mostly from shared/pronunciation-fixtures.json,
which app/tests/test_spoken_text.ts and test_pinyin.ts also check, so the browser
voice and prepared audio always agree."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tts.pronounce import (
    MISAKI_GB_SYMBOLS,
    MISAKI_US_SYMBOLS,
    SYLLABLE_COUNT,
    find_pinyin_names,
    is_pinyin_name,
    pinyin_phonemes,
    pinyin_syllables,
    prepare_for_misaki,
    spoken_text,
    to_misaki,
)

FIXTURES = json.loads((Path(__file__).resolve().parents[2] / "shared/pronunciation-fixtures.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("written,spoken", FIXTURES["spokenText"], ids=[c[0][:30] for c in FIXTURES["spokenText"]])
def test_spoken_text(written, spoken):
    assert spoken_text(written) == spoken


@pytest.mark.parametrize("written,spoken", FIXTURES["spokenText"], ids=[c[0][:30] for c in FIXTURES["spokenText"]])
def test_spoken_text_twice_is_the_same(written, spoken):
    # The browser rewrites text before sending it to the server, which rewrites it again.
    assert spoken_text(spoken) == spoken


def test_the_rules_build_the_same_syllables_as_the_browser():
    assert SYLLABLE_COUNT == 414


@pytest.mark.parametrize("word,phonemes", FIXTURES["pinyinPhonemes"], ids=[c[0] for c in FIXTURES["pinyinPhonemes"]])
def test_pinyin_phonemes(word, phonemes):
    assert pinyin_phonemes(word) == phonemes


@pytest.mark.parametrize("case", FIXTURES["pinyinNames"], ids=[c["text"][:30] for c in FIXTURES["pinyinNames"]])
def test_pinyin_names(case):
    assert [n["word"] for n in find_pinyin_names(case["text"])] == case["names"]


def test_apostrophes_and_names():
    assert pinyin_syllables("Xi'an") == ["xi", "an"]
    assert pinyin_syllables("Chiang") is None
    assert is_pinyin_name("Beijing") and not is_pinyin_name("China") and not is_pinyin_name("Taxi")


@pytest.mark.parametrize("british,symbols", [(True, MISAKI_GB_SYMBOLS), (False, MISAKI_US_SYMBOLS)])
def test_misaki_sounds_use_only_its_symbols(british, symbols):
    for word in ["Zhuang", "Qiong", "Nve", "Chuai", "Er", "Weng", "Yue", "Shui", "Ri", "Ceng", "Xiaoping", "Zhou", "Mao", "Hua", "Zedong"]:
        sounds = to_misaki(pinyin_phonemes(word), british)
        assert set(sounds) <= symbols, (word, sounds)


def test_prepare_for_misaki_links_names_and_rewrites_the_rest():
    text = "In 1975\u20131980 Deng Xiaoping met Mao (d. 1976)."
    assert prepare_for_misaki(text) == "In 1975 to 1980 [Deng](/d\u02c8\u028c\u014b/) [Xiaoping](/\u0283jWp\u02c8\u026a\u014b/) met [Mao](/m\u02c8W/) (died 1976)."
    assert prepare_for_misaki("Mao", british=False) == "[Mao](/m\u02c8W/)"


def test_rules_version_matches_the_browser():
    from tts.pronounce import PRONUNCIATION_VERSION

    assert PRONUNCIATION_VERSION == FIXTURES["version"]


def test_marks_from_the_app_keep_their_word_and_take_misaki_symbols():
    marked = "On the [Ussuri](/u\u02d0s\u02c8u\u02d0\u0279i\u02d0/) [Deng](/d\u02c8\u028c\u014b/) Xiaoping, c. 1969."
    assert prepare_for_misaki(marked) == (
        "On the [Ussuri](/u\u02d0s\u02c8u\u02d0\u0279i\u02d0/) [Deng](/d\u02c8\u028c\u014b/) "
        "[Xiaoping](/\u0283jWp\u02c8\u026a\u014b/), circa 1969."
    )
    assert prepare_for_misaki("[Chiang](/t\u0283\u02c8a\u014b/)") == "[Chiang](/\u02a7\u02c8a\u014b/)"


def test_espeak_parts_keep_marks_and_mark_names_and_split_sentences():
    from tts.pronounce import espeak_parts, join_sounds, sentences

    parts = espeak_parts("On the [Ussuri](/u\u02d0s/), c. 1969. Deng Xiaoping came.")
    assert parts[0] == ("On the ", None)
    assert parts[1] == ("Ussuri", "u\u02d0s")
    assert ("Deng", "d\u02c8\u028c\u014b") in parts
    groups = sentences(parts)
    assert len(groups) == 2
    upper = lambda t: t.strip().upper()
    assert join_sounds(groups[0], upper) == "ON THE u\u02d0s, CIRCA 1969."
    assert join_sounds(groups[1], upper).endswith("CAME.")
