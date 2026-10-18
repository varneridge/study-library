"""Convert Zotero note HTML into BlockNote blocks.

Handles paragraphs, headings, lists, quotes, links and inline styles.
Anything else is flattened to text, which is enough for migrated notes.
"""

from __future__ import annotations

import uuid
from html.parser import HTMLParser

DEFAULT_PROPS = {"textColor": "default", "backgroundColor": "default", "textAlignment": "left"}

STYLE_TAGS = {
    "strong": "bold", "b": "bold",
    "em": "italic", "i": "italic",
    "u": "underline",
    "s": "strike", "strike": "strike", "del": "strike",
    "code": "code",
}
HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 3, "h5": 3, "h6": 3}


def _block(block_type: str, content: list, **props) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "type": block_type,
        "props": {**DEFAULT_PROPS, **props},
        "content": content,
        "children": [],
    }


class _NoteParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[dict] = []
        self.styles: list[str] = []
        self.lists: list[str] = []
        self.link: dict | None = None
        self.current: dict | None = None
        self.pending_type: tuple[str, dict] | None = None

    # Block handling

    def _open(self, block_type: str, **props) -> None:
        self._close()
        self.current = _block(block_type, [], **props)

    def _close(self) -> None:
        if self.current is not None:
            self._trim(self.current["content"])
            if self.current["content"]:
                self.blocks.append(self.current)
        self.current = None

    @staticmethod
    def _trim(content: list) -> None:
        while content and content[-1].get("type") == "text" and not content[-1]["text"].strip():
            content.pop()
        if content and content[-1].get("type") == "text":
            content[-1]["text"] = content[-1]["text"].rstrip()
        if content and content[0].get("type") == "text":
            content[0]["text"] = content[0]["text"].lstrip()

    def _ensure_block(self) -> None:
        if self.current is None:
            self.current = _block("paragraph", [])

    # Parser callbacks

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in ("p", "div", "blockquote", "pre"):
            if tag != "div" or self.current is None:
                self._open("paragraph")
        elif tag in HEADINGS:
            self._open("heading", level=HEADINGS[tag])
        elif tag in ("ul", "ol"):
            self._close()
            self.lists.append("bulletListItem" if tag == "ul" else "numberedListItem")
        elif tag == "li":
            self._open(self.lists[-1] if self.lists else "bulletListItem")
        elif tag == "br":
            self._ensure_block()
            self._text("\n")
        elif tag in STYLE_TAGS:
            self.styles.append(STYLE_TAGS[tag])
        elif tag == "a":
            href = dict(attrs).get("href")
            if href:
                self._ensure_block()
                self.link = {"type": "link", "href": href, "content": []}

    def handle_endtag(self, tag: str) -> None:
        if tag in ("p", "blockquote", "pre", "li") or tag in HEADINGS:
            self._close()
        elif tag in ("ul", "ol"):
            self._close()
            if self.lists:
                self.lists.pop()
        elif tag in STYLE_TAGS:
            style = STYLE_TAGS[tag]
            if style in self.styles:
                self.styles.reverse()
                self.styles.remove(style)
                self.styles.reverse()
        elif tag == "a" and self.link is not None:
            if self.link["content"]:
                self._ensure_block()
                self.current["content"].append(self.link)
            self.link = None

    def handle_data(self, data: str) -> None:
        if not data.strip() and self.current is None:
            return
        self._ensure_block()
        self._text(" ".join(data.split("\n")) if "\n" in data else data)

    def _text(self, text: str) -> None:
        styles = {style: True for style in self.styles}
        target = self.link["content"] if self.link is not None else self.current["content"]
        if target and target[-1].get("type") == "text" and target[-1]["styles"] == styles:
            target[-1]["text"] += text
        else:
            target.append({"type": "text", "text": text, "styles": styles})

    def close(self) -> None:
        super().close()
        self._close()


def html_to_blocks(html: str, drop_first_if: str | None = None) -> list[dict]:
    """Convert note HTML to blocks.

    drop_first_if removes the first block when its text matches, because
    Zotero repeats the note title as the first line of the note.
    """
    parser = _NoteParser()
    parser.feed(html or "")
    parser.close()
    blocks = parser.blocks
    if blocks and drop_first_if and block_text(blocks[0]).strip() == drop_first_if.strip():
        blocks = blocks[1:]
    return blocks


def block_text(block: dict) -> str:
    parts = []
    for node in block.get("content", []):
        if node.get("type") == "text":
            parts.append(node["text"])
        elif node.get("type") == "link":
            parts.extend(child.get("text", "") for child in node.get("content", []))
    return "".join(parts)
