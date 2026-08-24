"""The baseline PDF backend: pypdf text extraction, one paragraph block per page.

This is exactly what the project shipped with before the parser became pluggable. It
stays as the ablation baseline: every improvement a structured parser claims is measured
against this, not against nothing.
"""

from __future__ import annotations

import io

from ...core.types import Block
from .base import BackendResult


def parse_pdf(data: bytes) -> BackendResult:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    blocks: list[Block] = []
    page_map: list[tuple[int, int]] = []
    offset = 0
    empty_pages = 0

    for number, page in enumerate(reader.pages, start=1):
        content = (page.extract_text() or "").strip()
        if not content:
            empty_pages += 1
            continue
        page_map.append((offset, number))
        blocks.append(Block(kind="paragraph", span=(offset, offset + len(content)), page=number))
        parts.append(content)
        offset += len(content) + 2  # matches the "\n\n" join below

    return BackendResult(
        text="\n\n".join(parts),
        blocks=blocks,
        page_map=page_map,
        diagnostics={"empty_pages": empty_pages, "total_pages": len(reader.pages)},
    )
