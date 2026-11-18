"""How readings should sound, for the Kokoro speech server and audio preparation.

The Python twin of app/src/lib/listen/spokenText.ts and pinyin.ts. Both are
tested against shared/pronunciation-fixtures.json, so the browser voice and
prepared audio always say a word the same way. See those files for why each
rule exists; the comments here only note where Python differs.

prepare_for_misaki() is the server's entry point. misaki, Kokoro's text front
end in Python, takes a fixed pronunciation for a word written as a link,
"[Xiaoping](/ʃjWpˈɪŋ/)", in its own symbols, so pinyin names reach the model as
exact sounds while every other word goes through misaki as before. The link
text is the written word, so misaki's word timings still name the word the
reader shows and highlighting is unaffected.
"""

from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
from functools import lru_cache
from pathlib import Path

def _shared_dir() -> Path:
    """Where shared/pinyin-lists.json is: STUDY_SHARED_DIR when set, else the
    repository's shared folder (a source checkout, or the speech pack, which
    copies the same layout), else the copy the packaged build carries beside
    its modules (packaging/windows/studylibrary.spec)."""
    if os.environ.get("STUDY_SHARED_DIR"):
        return Path(os.environ["STUDY_SHARED_DIR"])
    here = Path(__file__).resolve()
    candidates = [here.parents[2] / "shared"] if len(here.parents) > 2 else []
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        candidates.append(Path(bundle) / "shared")
    candidates.append(here.parent / "shared")
    for folder in candidates:
        if (folder / "pinyin-lists.json").is_file():
            return folder
    return candidates[0] if candidates else here.parent / "shared"


SHARED = _shared_dir()

# Raise with PRONUNCIATION_VERSION in spokenText.ts when any rule changes.
PRONUNCIATION_VERSION = 1

# ---------------------------------------------------------------- spoken text

ANY_DASH = "[-\u2010\u2011\u2012\u2013\u2014\u2212]"
TYPESET_DASH = "[\u2010\u2011\u2012\u2013\u2014\u2212]"

UNITS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty"]
UNIT_ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"]


def cardinal_words(n: int) -> str:
    if n < 10:
        return UNITS[n]
    if n < 20:
        return TEENS[n - 10]
    unit = n % 10
    return f"{TENS[n // 10]}-{UNITS[unit]}" if unit else TENS[n // 10]


def ordinal_words(n: int) -> str:
    if n < 10:
        return UNIT_ORDINALS[n]
    if n == 12:
        return "twelfth"
    if n < 20:
        return f"{TEENS[n - 10]}th"
    unit = n % 10
    if unit:
        return f"{TENS[n // 10]}-{UNIT_ORDINALS[unit]}"
    return f"{TENS[n // 10][:-1]}ieth"


def roman_value(s: str) -> int | None:
    m = re.fullmatch(r"(X{0,3})(IX|IV|V?I{0,3})", s)
    if not m or s == "":
        return None
    ones = {"": 0, "I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7, "VIII": 8, "IX": 9}
    value = len(m.group(1)) * 10 + ones[m.group(2)]
    return value or None


COUNTED = {
    "act", "appendix", "article", "book", "chapter", "class", "figure", "mark", "part", "phase",
    "plate", "section", "stage", "table", "title", "type", "vatican", "volume",
}
REGNAL = {
    "Alexander", "Benedict", "Catherine", "Charles", "Edward", "Elizabeth", "Ferdinand", "Francis",
    "Frederick", "George", "Gregory", "Gustav", "Henry", "Isabella", "Ivan", "James", "John", "Joseph",
    "Karl", "Leo", "Leopold", "Louis", "Ludwig", "Mary", "Mehmed", "Napoleon", "Nicholas", "Paul",
    "Peter", "Philip", "Pius", "Richard", "Selim", "Suleiman", "Victor", "Wilhelm", "William",
}
NOT_A_NAME = {"A", "An", "And", "As", "At", "But", "By", "For", "From", "If", "In", "Of", "On", "Or", "The", "To", "With"}

NUMERAL = re.compile(r"\b([A-Za-z]+)(\s+)(?:([A-Za-z]+)\s+)?([IVX]+)(?=\Z|[^A-Za-z0-9])")


def _numeral(m: re.Match) -> str:
    first, gap, second, numeral = m.group(1), m.group(2), m.group(3), m.group(4)
    value = roman_value(numeral)
    if value is None:
        return m.group(0)
    before = second if second is not None else first
    lead = f"{first}{gap}{second} " if second is not None else f"{first}{gap}"
    war = second is not None and first.lower() == "world" and second.lower() == "war"
    if war or before.lower() in COUNTED:
        return f"{lead}{cardinal_words(value).capitalize()}"
    if not re.fullmatch(r"[A-Z][a-z]+", before) or before in NOT_A_NAME:
        return m.group(0)
    if len(numeral) == 1 and before not in REGNAL:
        return m.group(0)
    return f"{lead}the {ordinal_words(value).capitalize()}"


MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def _iso_date(m: re.Match) -> str:
    y, mo, d = m.group(1), int(m.group(2)), int(m.group(3))
    if 1 <= mo <= 12 and 1 <= d <= 31:
        return f"the {ordinal_words(d)} of {MONTHS[mo - 1]} {y}"
    return m.group(0)


def _short_years(m: re.Match) -> str:
    century, year, end = m.group(1), m.group(2), m.group(3)
    return f"{century}{year} to {end}" if int(end) > int(year) else m.group(0)


RULES: list[tuple[re.Pattern, object]] = [
    (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), _iso_date),
    (re.compile(rf"\b(\d{{3}}0s)\s*{ANY_DASH}\s*(\d0s|\d{{3}}0s)\b"), r"\1 to \2"),
    (re.compile(rf"\b(\d{{4}})\s*{ANY_DASH}\s*(present|today|now)\b", re.I), r"\1 to \2"),
    (re.compile(rf"\b(\d{{4}})\s*{ANY_DASH}(?=\s*(?:[)\],;:.]|\Z))"), r"\1 onwards"),
    (re.compile(rf"\b(\d{{2}})(\d{{2}})\s*{ANY_DASH}\s*(\d{{2}})\b(?!\d)"), _short_years),
    (re.compile(rf"(\d)\s*{TYPESET_DASH}\s*(?=\d)"), r"\1 to "),
    (re.compile(r"\b(?:c|ca)\.\s*(?=\d)"), "circa "),
    (re.compile(r"\bpp\.\s*(?=\d)"), "pages "),
    (re.compile(r"\bp\.\s*(?=\d)"), "page "),
    (re.compile(r"\b(\d+)\s*ff\."), r"\1 and following"),
    (re.compile(r"\b[Vv]ols\.\s*"), "volumes "),
    (re.compile(r"\b[Vv]ol\.\s*"), "volume "),
    (re.compile(r"\b[Cc]hs\.\s*(?=\d)"), "chapters "),
    (re.compile(r"\b[Cc]h\.\s*(?=\d)"), "chapter "),
    (re.compile(r"\b[Nn]os\.\s*(?=\d)"), "numbers "),
    (re.compile(r"\b[Nn]o\.\s*(?=\d)"), "number "),
    (re.compile(r"\bnn\.\s*(?=\d)"), "notes "),
    (re.compile(r"\bn\.\s*(?=\d)"), "note "),
    (re.compile(r"\b[Ff]igs\.\s*(?=\d)"), "figures "),
    (re.compile(r"\b[Ff]ig\.\s*(?=\d)"), "figure "),
    (re.compile(r"\bd\.\s*(?=\d)"), "died "),
    (re.compile(r"\bb\.\s*(?=\d)"), "born "),
    (re.compile(r"\br\.\s*(?=\d)"), "reigned "),
    (re.compile(r"\be\.\s?g\.(?!\w)", re.I), "for example"),
    (re.compile(r"\bi\.\s?e\.(?!\w)", re.I), "that is"),
    (re.compile(r"\bcf\.(?!\w)", re.I), "compare"),
    (re.compile(r"\bet al\.?(?!\w)"), "and others"),
    (re.compile(r"\bviz\.(?!\w)"), "namely"),
    (re.compile(r"\(eds\.\)"), "(editors)"),
    (re.compile(r"\(ed\.\)"), "(editor)"),
    (re.compile(r"\beds?\.\s+by\b"), "edited by"),
    (re.compile(r"\btrans\.\s+by\b"), "translated by"),
    (re.compile(r"\bAD(?=\s+\d)"), "A-D"),
    (re.compile(r"(\d)\s*AD\b"), r"\1 A-D"),
    (re.compile(r"(\d)\s*CE\b"), r"\1 C-E"),
    (re.compile(r"\bSino-(?=[A-Z])"), "Sighno-"),
]


def spoken_text(text: str) -> str:
    """The text as it should be spoken. Text needing no change comes back as it was."""
    out = text
    for pattern, replacement in RULES:
        out = pattern.sub(replacement, out)
    return NUMERAL.sub(_numeral, out)


# --------------------------------------------------------------------- pinyin

INITIALS = [
    ("b", "lab", "b"), ("p", "lab", "p"), ("m", "lab", "m"), ("f", "f", "f"),
    ("d", "dt", "d"), ("t", "dt", "t"), ("n", "nl", "n"), ("l", "nl", "l"),
    ("g", "gkh", "\u0261"), ("k", "gkh", "k"), ("h", "gkh", "h"),
    ("j", "pal", "d\u0292"), ("q", "pal", "t\u0283"), ("x", "pal", "\u0283"),
    ("zh", "ret", "d\u0292"), ("ch", "ret", "t\u0283"), ("sh", "ret", "\u0283"), ("r", "ret", "\u0279"),
    ("z", "sib", "dz"), ("c", "sib", "ts"), ("s", "sib", "s"),
]

# (spelling, groups, single initials also allowed, glide, rhyme)
FINALS = [
    ("a", ("lab", "f", "dt", "nl", "gkh", "ret", "sib"), (), "", "\u0251\u02d0"),
    ("ai", ("lab", "dt", "nl", "gkh", "ret", "sib"), (), "", "a\u026a"),
    ("an", ("lab", "f", "dt", "nl", "gkh", "ret", "sib"), (), "", "an"),
    ("ang", ("lab", "f", "dt", "nl", "gkh", "ret", "sib"), (), "", "a\u014b"),
    ("ao", ("lab", "dt", "nl", "gkh", "ret", "sib"), (), "", "a\u028a"),
    ("e", ("dt", "nl", "gkh", "ret", "sib"), ("m",), "", "\u0259"),
    ("ei", ("lab", "f", "dt", "nl", "gkh"), ("zh", "sh", "z"), "", "e\u026a"),
    ("en", ("lab", "f", "gkh", "ret", "sib"), ("d", "n"), "", "\u0259n"),
    ("eng", ("lab", "f", "dt", "nl", "gkh", "ret", "sib"), (), "", "\u028c\u014b"),
    ("o", ("lab", "f"), (), "", "\u0254\u02d0"),
    ("ong", ("dt", "nl", "gkh", "ret", "sib"), (), "", "\u0252\u014b"),
    ("ou", ("dt", "nl", "gkh", "ret", "sib", "f"), ("p", "m"), "", "\u0259\u028a"),
    ("i", ("lab", "dt", "nl", "pal", "ret", "sib"), (), "", "i\u02d0"),
    ("ia", ("pal",), ("l",), "j", "\u0251\u02d0"),
    ("ian", ("lab", "dt", "nl", "pal"), (), "j", "\u025bn"),
    ("iang", ("pal",), ("n", "l"), "j", "a\u014b"),
    ("iao", ("lab", "dt", "nl", "pal"), (), "j", "a\u028a"),
    ("ie", ("lab", "dt", "nl", "pal"), (), "j", "\u025b"),
    ("in", ("lab", "nl", "pal"), (), "", "\u026an"),
    ("ing", ("lab", "dt", "nl", "pal"), (), "", "\u026a\u014b"),
    ("iong", ("pal",), (), "j", "\u028a\u014b"),
    ("iu", ("pal",), ("m", "d", "n", "l"), "j", "\u0259\u028a"),
    ("u", ("lab", "f", "dt", "nl", "gkh", "pal", "ret", "sib"), (), "", "u\u02d0"),
    ("ua", ("gkh", "ret"), (), "w", "\u0251\u02d0"),
    ("uai", ("gkh",), ("zh", "ch", "sh"), "w", "a\u026a"),
    ("uan", ("dt", "nl", "gkh", "pal", "ret", "sib"), (), "w", "an"),
    ("uang", ("gkh",), ("zh", "ch", "sh"), "w", "a\u014b"),
    ("ui", ("dt", "gkh", "ret", "sib"), (), "w", "e\u026a"),
    ("un", ("dt", "gkh", "pal", "ret", "sib"), ("l",), "", "\u028an"),
    ("uo", ("dt", "nl", "gkh", "ret", "sib"), (), "w", "\u0254\u02d0"),
    ("ue", ("pal",), ("n", "l"), "w", "\u025b"),
    ("v", (), ("n", "l"), "j", "u\u02d0"),
    ("ve", (), ("n", "l"), "j", "\u025b"),
]

PALATAL_FORMS = {"u": ("", "u\u02d0"), "un": ("", "u\u02d0n"), "uan": ("w", "\u025bn"), "ue": ("w", "\u025b")}

BARE = [
    ("a", "", "\u0251\u02d0"), ("ai", "", "a\u026a"), ("an", "", "an"), ("ang", "", "a\u014b"), ("ao", "", "a\u028a"),
    ("e", "", "\u0259"), ("ei", "", "e\u026a"), ("en", "", "\u025bn"), ("eng", "", "\u028c\u014b"), ("er", "", "\u025c\u02d0"),
    ("o", "", "\u0254\u02d0"), ("ou", "", "\u0259\u028a"),
    ("yi", "", "i\u02d0"), ("yin", "", "\u026an"), ("ying", "", "\u026a\u014b"),
    ("ya", "j", "\u0251\u02d0"), ("yao", "j", "a\u028a"), ("yan", "j", "\u025bn"), ("yang", "j", "a\u014b"),
    ("ye", "j", "\u025b"), ("yo", "j", "\u0254\u02d0"), ("yong", "j", "\u028a\u014b"), ("you", "j", "\u0259\u028a"),
    ("yu", "j", "u\u02d0"), ("yuan", "jw", "\u025bn"), ("yue", "jw", "\u025b"), ("yun", "j", "u\u02d0n"),
    ("wa", "w", "\u0251\u02d0"), ("wai", "w", "a\u026a"), ("wan", "w", "an"), ("wang", "w", "a\u014b"),
    ("wei", "w", "e\u026a"), ("wen", "w", "\u0259n"), ("weng", "w", "\u028c\u014b"), ("wo", "w", "\u0254\u02d0"), ("wu", "w", "u\u02d0"),
]


def _vowel_of_i(group: str) -> str:
    if group == "ret":
        return "\u025c\u02d0"
    if group == "sib":
        return "\u0259"
    return "i\u02d0"


def _build() -> dict[str, tuple[str, str]]:
    out = {spelling: (glide, rhyme) for spelling, glide, rhyme in BARE}
    for initial, group, sound in INITIALS:
        for spelling, groups, also, glide, rhyme in FINALS:
            if group not in groups and initial not in also:
                continue
            if spelling == "i":
                rhyme = _vowel_of_i(group)
            if group == "pal" and spelling in PALATAL_FORMS:
                glide, rhyme = PALATAL_FORMS[spelling]
            out[initial + spelling] = (sound + glide, rhyme)
    return out


SYLLABLES = _build()
SYLLABLE_COUNT = len(SYLLABLES)
LONGEST = max(len(s) for s in SYLLABLES)


def _plain(word: str) -> str:
    s = word.lower().replace("u:", "v")
    s = unicodedata.normalize("NFD", s).replace("u\u0308", "v")
    return re.sub("[\u0300-\u036f]", "", s)


def _split(part: str) -> list[str] | None:
    @lru_cache(maxsize=None)
    def from_(i: int) -> tuple[str, ...] | None:
        if i == len(part):
            return ()
        for length in range(min(LONGEST, len(part) - i), 0, -1):
            piece = part[i : i + length]
            if piece not in SYLLABLES or (i > 0 and piece[0] in "aeo"):
                continue
            rest = from_(i + length)
            if rest is not None:
                return (piece, *rest)
        return None

    found = from_(0)
    return list(found) if found is not None else None


def pinyin_syllables(word: str) -> list[str] | None:
    parts = re.split("['\u2019]", _plain(word))
    if any(p == "" for p in parts):
        return None
    out: list[str] = []
    for p in parts:
        s = _split(p)
        if s is None:
            return None
        out.extend(s)
    return out


@lru_cache(maxsize=1)
def _lists() -> tuple[frozenset[str], frozenset[str]]:
    data = json.loads((SHARED / "pinyin-lists.json").read_text(encoding="utf-8"))
    return frozenset(data["names"]), frozenset(data["notNames"])


ONLY_PINYIN = re.compile(
    r"(?:^|[ng])x|q(?=i|u(?:a|n|$))|zh|iu|uo|iao|iang|iong|uang|ia(?=[bcdfghjklmpqrstvwxyz])"
    r"|ao(?=[bcdfghjklmnpqrstvwxyz]|$)|.eng|'"
)
NAME_SHAPE = re.compile("[A-Z\u00c0-\u01dc][a-z\u00e0-\u01dc]*(?:['\u2019][a-z\u00e0-\u01dc]+)*")
WORDS = re.compile("(?:[^\\W\\d_]|['\u2019-])+")


def _could_be_name(word: str) -> bool:
    _, not_names = _lists()
    return bool(NAME_SHAPE.fullmatch(unicodedata.normalize("NFC", word))) and _plain(word) not in not_names and pinyin_syllables(word) is not None


def is_pinyin_name(word: str) -> bool:
    if not _could_be_name(word):
        return False
    names, _ = _lists()
    p = _plain(word).replace("\u2019", "'")
    return p in names or bool(ONLY_PINYIN.search(p))


def pinyin_phonemes(word: str) -> str | None:
    """A pinyin word's sounds in espeak-ng's British symbols, stressed on its last syllable."""
    syllables = pinyin_syllables(word)
    if syllables is None:
        return None
    out = []
    for i, s in enumerate(syllables):
        onset, rhyme = SYLLABLES[s]
        out.append(f"{onset}\u02c8{rhyme}" if i == len(syllables) - 1 else f"{onset}{rhyme}")
    return "".join(out)


def find_pinyin_names(text: str) -> list[dict]:
    """The pinyin names in a passage, as find_pinyin_names in pinyin.ts: [{start, end, word, phonemes}]."""
    words = [(m.start(), m.group(0)) for m in WORDS.finditer(text)]

    def parts(w: str) -> list[str]:
        return [p for p in w.split("-") if p]

    could = [bool(parts(w)) and all(_could_be_name(p) for p in parts(w)) for _, w in words]
    counts = [could[i] and any(is_pinyin_name(p) for p in parts(w)) for i, (_, w) in enumerate(words)]

    def touching(i: int) -> bool:
        start, w = words[i]
        return text[start + len(w) : words[i + 1][0]] == " "

    for _ in range(2):
        for i in range(len(words) - 1):
            if not touching(i):
                continue
            if counts[i] and could[i + 1]:
                counts[i + 1] = True
            if counts[i + 1] and could[i]:
                counts[i] = True
    out = []
    for i, (start, w) in enumerate(words):
        if counts[i]:
            phonemes = " ".join(pinyin_phonemes(p) or "" for p in parts(w))
            out.append({"start": start, "end": start + len(w), "word": w, "phonemes": phonemes})
    return out


# ---------------------------------------------------------------- for misaki

# espeak-ng writes diphthongs and affricates as two symbols; misaki writes each as one.
_MISAKI_SHARED = [("d\u0292", "\u02a4"), ("t\u0283", "\u02a7"), ("e\u026a", "A"), ("a\u026a", "I"), ("a\u028a", "W"), ("\u0254\u026a", "Y")]
# British keeps length marks and the British vowels; American has neither, and an r after its NURSE vowel.
_MISAKI_GB = [("\u0259\u028a", "Q")]
_MISAKI_US = [("\u0259\u028a", "O"), ("\u025c\u02d0", "\u025c\u0279"), ("\u0252", "\u0251"), ("\u02d0", ""), ("a", "\u00e6")]

MISAKI_GB_SYMBOLS = frozenset("AIQWYabdfhijklmnpstuvwz\u00f0\u014b\u0251\u0252\u0254\u0259\u025b\u025c\u0261\u026a\u0279\u0283\u028a\u028c\u0292\u02a4\u02a7\u02c8\u02cc\u02d0\u03b8\u1d4a ")
MISAKI_US_SYMBOLS = frozenset("AIOWYbdfhijklmnpstuvwz\u00e6\u00f0\u014b\u0251\u0254\u0259\u025b\u025c\u0261\u026a\u0279\u027e\u0283\u028a\u028c\u0292\u02a4\u02a7\u02c8\u02cc\u03b8\u1d4a\u1d7b\u0294 ")


def to_misaki(ipa: str, british: bool = True) -> str:
    """espeak-style sounds written in misaki's symbols for a British or American voice."""
    out = ipa
    for old, new in _MISAKI_SHARED + (_MISAKI_GB if british else _MISAKI_US):
        out = out.replace(old, new)
    return out


LINK = re.compile(r"\[([^\]]+)\]\(/([^)]*)/\)")


def _prepare_plain(text: str, british: bool) -> str:
    spoken = spoken_text(text)
    out, last = [], 0
    for name in find_pinyin_names(spoken):
        out.append(spoken[last : name["start"]])
        out.append(f"[{name['word']}](/{to_misaki(name['phonemes'], british)}/)")
        last = name["end"]
    out.append(spoken[last:])
    return "".join(out)


def prepare_for_misaki(text: str, british: bool = True) -> str:
    """The text a misaki pipeline should be given: spoken forms written out, pinyin names as fixed sounds.

    Text from the app arrives already marked by annotate.ts, with dictionary
    words and names as "[word](/sounds/)" in espeak-ng's symbols. Those marks
    keep their word and have their sounds written in misaki's symbols; the
    text between them goes through the same rules, which change nothing the
    app has already rewritten.
    """
    out, last = [], 0
    for m in LINK.finditer(text):
        out.append(_prepare_plain(text[last : m.start()], british))
        out.append(f"[{m.group(1)}](/{to_misaki(m.group(2), british)}/)")
        last = m.end()
    out.append(_prepare_plain(text[last:], british))
    return "".join(out)


# ------------------------------------------------- for espeak-ng engines (ONNX)

_SENTENCE_END = re.compile(r"(?<=[.!?\u2026])\s+")


def espeak_parts(text: str) -> list[tuple[str, str | None]]:
    """A paragraph as (written text, fixed sounds or None) pieces, for an engine
    that phonemises with espeak-ng itself, as kokoro-onnx does. Marks from the
    app keep their sounds, which are already espeak-ng's symbols, the text
    between them is rewritten (spoken_text) and pinyin names are marked here."""
    parts: list[tuple[str, str | None]] = []

    def plain(stretch: str) -> None:
        spoken, last = spoken_text(stretch), 0
        for name in find_pinyin_names(spoken):
            if name["start"] > last:
                parts.append((spoken[last : name["start"]], None))
            parts.append((name["word"], name["phonemes"]))
            last = name["end"]
        if last < len(spoken):
            parts.append((spoken[last:], None))

    last = 0
    for m in LINK.finditer(text):
        plain(text[last : m.start()])
        parts.append((m.group(1), m.group(2)))
        last = m.end()
    plain(text[last:])
    return [p for p in parts if p[0]]


def sentences(parts: list[tuple[str, str | None]]) -> list[list[tuple[str, str | None]]]:
    """The pieces grouped into sentences, splitting plain text where a sentence ends."""
    out: list[list[tuple[str, str | None]]] = []
    current: list[tuple[str, str | None]] = []
    for text, sounds in parts:
        if sounds is not None:
            current.append((text, sounds))
            continue
        pieces = _SENTENCE_END.split(text)
        for i, piece in enumerate(pieces):
            if piece:
                current.append((piece, None))
            if i < len(pieces) - 1 and current:
                out.append(current)
                current = []
    if current:
        out.append(current)
    return out


def join_sounds(sentence: list[tuple[str, str | None]], phonemise) -> str:
    """One sentence's sounds: plain pieces through `phonemise`, fixed ones as they
    are, with a piece that touched its neighbour in the text touching it here,
    as phonemiseMarked in annotate.ts does for the browser."""
    out = ""
    for text, sounds in sentence:
        if sounds is not None:
            if out and not out.endswith(" ") and (text[:1].isalnum()):
                out += " " if out[-1:] not in "(\u00ab\u201c\"" else ""
            out += sounds
            continue
        if not text.strip():
            if out and not out.endswith(" "):
                out += " "
            continue
        said = phonemise(text).strip()
        if text[:1].isspace() and out and not out.endswith(" "):
            out += " "
        out += said
        if text[-1:].isspace():
            out += " "
    return " ".join(out.split())
