"""Repair of ligatures and broken glyphs in machine-extracted text.

The rules here are mirrored in app/src/lib/textnorm.ts, so any change to the
tables must be made in both files and covered by both test suites.
"""

from __future__ import annotations

__all__ = ["LIGATURES", "CONTEXT_GLYPHS", "repair_text"]

# Genuine Unicode ligatures and long s. These are mapped explicitly rather
# than through NFKC, because compatibility normalisation would also rewrite
# superscripts, fractions and symbols that study material relies upon.
LIGATURES: dict[str, str] = {
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
    "\ufb05": "st",
    "\ufb06": "st",
    "\u017f": "s",
}

# Glyphs emitted by broken PDF font CMaps, most often in Calibri exports from
# Word. They are not compatibility characters, so normalisation cannot repair
# them, and they are replaced only after a lowercase Latin letter so that
# legitimate text such as "Ōsaka" is left alone.
CONTEXT_GLYPHS: dict[str, str] = {
    "\u019f": "ti",
    "\u014c": "ft",
}

# Characters after which a context glyph is treated as a broken ligature. The
# glyphs themselves are included so that runs such as "aŌŌ" are repaired in a
# single pass, which is what keeps repair_text idempotent.
_CONTEXT_PRECEDERS: frozenset[str] = frozenset(
    [chr(c) for c in range(ord("a"), ord("z") + 1)]
    + [chr(c) for c in range(0xE0, 0xF7)]
    + [chr(c) for c in range(0xF8, 0x100)]
) | frozenset(CONTEXT_GLYPHS)

_LIGATURE_TABLE = str.maketrans(LIGATURES)


def repair_text(text: str) -> str:
    """Repair ligatures and CMap glyph faults in extracted text.

    The function is idempotent, so it is safe to apply to text that may
    already have been repaired, for example during a re-runnable backfill.
    """
    if not text:
        return text

    text = text.translate(_LIGATURE_TABLE)
    if not any(glyph in text for glyph in CONTEXT_GLYPHS):
        return text

    out: list[str] = []
    previous = ""
    for ch in text:
        replacement = CONTEXT_GLYPHS.get(ch)
        if replacement is not None and previous in _CONTEXT_PRECEDERS:
            out.append(replacement)
        else:
            out.append(ch)
        previous = ch
    return "".join(out)
