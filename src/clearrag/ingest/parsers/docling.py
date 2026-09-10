"""docling backend: IBM's ML-based layout parser as an optional extra.

MIT-licensed, fully local. Its layout and TableFormer models make it the reference
point for table-heavy documents, exactly what the primitives parser's ablation rows
are measured against. Imports stay inside the function so this module can always be
imported; the registry gates availability.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from ...core.types import Block
from .base import BackendResult


def parse_pdf(data: bytes) -> BackendResult:
    from docling.document_converter import DocumentConverter
    from docling_core.types.doc import DocItemLabel, TableItem, TextItem

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "input.pdf"
        path.write_bytes(data)
        converted = DocumentConverter().convert(str(path))
    doc = converted.document

    # (text, kind, level, page) items, assembled into canonical text below.
    items: list[tuple[str, str, int, int | None]] = []
    for item, level in doc.iterate_items():
        page = None
        prov = getattr(item, "prov", None)
        if prov:
            page = getattr(prov[0], "page_no", None)
        if isinstance(item, TableItem):
            rows: list[str] = []
            grid = getattr(getattr(item, "data", None), "grid", None) or []
            for row in grid:
                rows.append(" | ".join(getattr(cell, "text", "").strip() for cell in row))
            if rows:
                items.append(("\n".join(rows), "table", 0, page))
        elif isinstance(item, TextItem):
            text = (item.text or "").strip()
            if not text:
                continue
            if item.label == DocItemLabel.TITLE:
                items.append((text, "heading", 1, page))
            elif item.label == DocItemLabel.SECTION_HEADER:
                items.append((text, "heading", min(max(level, 1), 3), page))
            else:
                items.append((text, "paragraph", 0, page))

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
        offset += len(text) + 2  # "\n\n" join

    return BackendResult(
        text="\n\n".join(parts),
        blocks=blocks,
        page_map=page_map,
        diagnostics={"backend": "docling", "blocks": len(blocks)},
    )
