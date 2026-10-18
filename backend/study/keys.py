"""Position keys compatible with the fractional-indexing npm package.

Keys sort as plain strings. The web app inserts between them with
generateKeyBetween, so keys written here must use the same format.
"""

from __future__ import annotations

DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def _integer_length(head: str) -> int:
    if "a" <= head <= "z":
        return ord(head) - ord("a") + 2
    if "A" <= head <= "Z":
        return ord("Z") - ord(head) + 2
    raise ValueError(f"invalid key head: {head!r}")


def _integer_part(key: str) -> str:
    return key[: _integer_length(key[0])]


def _increment(integer: str) -> str:
    head, digits = integer[0], list(integer[1:])
    carry = True
    i = len(digits) - 1
    while carry and i >= 0:
        value = DIGITS.index(digits[i]) + 1
        if value == len(DIGITS):
            digits[i] = DIGITS[0]
        else:
            digits[i] = DIGITS[value]
            carry = False
        i -= 1
    if not carry:
        return head + "".join(digits)
    if head == "Z":
        return "a" + DIGITS[0]
    if head == "z":
        raise OverflowError("key space exhausted")
    new_head = chr(ord(head) + 1)
    if new_head > "a":
        digits.append(DIGITS[0])
    else:
        digits.pop()
    return new_head + "".join(digits)


def key_after(key: str | None) -> str:
    """Return a key that sorts after key, or the first key if key is None."""
    if key is None:
        return "a0"
    return _increment(_integer_part(key))


def keys_after(key: str | None, count: int) -> list[str]:
    keys: list[str] = []
    for _ in range(count):
        key = key_after(key)
        keys.append(key)
    return keys
