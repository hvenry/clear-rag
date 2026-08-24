"""marker backend: datalab's ML-based PDF converter as an optional extra.

Licence note, documented deliberately: marker is GPL-3.0 and its surya model weights
carry a commercial-use restriction above a revenue threshold — fine for this research
project, but the asterisk belongs next to the import. Strongest on prose-heavy
documents (articles, books, papers); the ablation table is where that claim gets
tested against docling and the primitives parser. Imports stay inside the function so
this module can always be imported; the registry gates availability.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from ...core.types import Block
from .base import BackendResult

_HEADING_TYPES = {"SectionHeader", "Title"}
_TABLE_TYPES = {"Table", "TableOfContents"}


def parse_pdf(data: bytes) -> BackendResult:
    from marker.converters.pdf import PdfConverter
    from marker.models import create_model_dict
    from marker.output import text_from_rendered
    from marker.renderers.json import JSONRenderer

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "input.pdf"
        path.write_bytes(data)
        converter = PdfConverter(
            artifact_dict=create_model_dict(),
            renderer=f"{JSONRenderer.__module__}.{JSONRenderer.__name__}",
        )
        rendered = converter(str(path))

    items: list[tuple[str, str, int, int | None]] = []

    def walk(node, page: int | None) -> None:
        block_type = getattr(node, "block_type", "")
        if block_type == "Page":
            parts = str(getattr(node, "id", None) or "/page/0").split("/")
            index = parts[2] if len(parts) > 2 else ""
            page = int(index) + 1 if index.isdigit() else None
        children = getattr(node, "children", None) or []
        text = _plain_text(getattr(node, "html", "") or "")
        if block_type in _HEADING_TYPES and text:
            level = 1 if block_type == "Title" else 2
            items.append((text, "heading", level, page))
            return
        if block_type in _TABLE_TYPES and text:
            items.append((text, "table", 0, page))
            return
        if not children and text:
            items.append((text, "paragraph", 0, page))
            return
        for child in children:
            walk(child, page)

    for page_node in getattr(rendered, "children", None) or []:
        walk(page_node, None)
    if not items:
        # Fall back to the rendered plain text as one block rather than losing the file.
        text, _, _ = text_from_rendered(rendered)
        items = [(text.strip(), "paragraph", 0, None)] if text.strip() else []

    blocks: list[Block] = []
    parts: list[str] = []
    page_map: list[tuple[int, int]] = []
    seen_pages: set[int] = set()
    offset = 0
    for text, kind, level, page in items:
        if page is not None and page not in seen_pages:
            seen_pages.add(page)
            page_map.append((offset, page))
        blocks.append(Block(kind=kind, span=(offset, offset + len(text)), level=level, page=page))
        parts.append(text)
        offset += len(text) + 2

    return BackendResult(
        text="\n\n".join(parts),
        blocks=blocks,
        page_map=page_map,
        diagnostics={"backend": "marker", "blocks": len(blocks)},
    )


def _plain_text(html: str) -> str:
    import re

    return re.sub(r"<[^>]+>", " ", html).replace("&amp;", "&").strip()
