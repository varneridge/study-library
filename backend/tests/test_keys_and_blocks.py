from study.blocks import block_text, html_to_blocks
from study.keys import DIGITS, key_after, keys_after


def test_keys_sort_in_order():
    keys = keys_after(None, 5000)
    assert keys[0] == "a0"
    assert keys == sorted(keys)
    assert len(set(keys)) == len(keys)


def test_first_key_and_rollover():
    assert key_after(None) == "a0"
    assert key_after("a0") == "a1"
    assert key_after("a" + DIGITS[-1]) == "b00"
    assert key_after("a0V") == "a1"


def test_zotero_note_html():
    html = (
        '<div data-schema-version="9"><h1>(AT1) 00 Introductory Session</h1>'
        "<p>Seminar on <strong>Chen</strong> and <em>Westad</em>.</p>"
        "<ul><li>Empire as frame</li><li>Revolution as <a href=\"https://example.com\">rupture</a></li></ul>"
        "<p>Line one<br>line two</p></div>"
    )
    blocks = html_to_blocks(html, drop_first_if="(AT1) 00 Introductory Session")
    assert [b["type"] for b in blocks] == [
        "paragraph", "bulletListItem", "bulletListItem", "paragraph",
    ]
    assert block_text(blocks[0]) == "Seminar on Chen and Westad."
    assert blocks[0]["content"][1] == {"type": "text", "text": "Chen", "styles": {"bold": True}}
    assert blocks[2]["content"][1]["type"] == "link"
    assert block_text(blocks[3]) == "Line one\nline two"


def test_empty_note():
    assert html_to_blocks("") == []
    assert html_to_blocks("<p>   </p>") == []
