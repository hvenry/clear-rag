"""Turn uploaded files into ``Document``s with an intact character offset space.

The invariant every downstream stage relies on: ``Document.text`` is the authoritative
string, and every chunk span indexes into it. That is what lets a citation highlight an
exact region of the original file instead of naming a chunk number.

Phase 4 adds two things. PDF parsing is a pluggable *backend* (naive pypdf extraction,
the hand-rolled primitives parser, or docling/marker as optional extras), because
parsing quality is a measured variable in the ablation table, not an implementation
detail. And every format now yields ``Block`` structure (headings, paragraphs, tables
with spans into the canonical text), which structural chunking and breadcrumb contexts
consume downstream.
"""

from __future__ import annotations

import hashlib
import io
import re
import time
from dataclasses import dataclass

from ..core.types import Block, Document
from .parsers import parse_pdf

SUPPORTED = {".pdf", ".txt", ".md", ".markdown", ".docx", ".csv"}

_MD_HEADING = re.compile(r"^(#{1,6})\s")


class UnsupportedFile(ValueError):
    pass


class EmptyExtraction(ValueError):
    """Raised when a file parses but yields no text -- typically a scanned PDF."""


@dataclass
class ParseResult:
    document: Document
    diagnostics: dict


def parse(filename: str, data: bytes, *, parser: str = "primitives") -> ParseResult:
    started = time.perf_counter()
    suffix = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix not in SUPPORTED:
        raise UnsupportedFile(
            f"'{suffix or filename}' is not supported. Supported: {', '.join(sorted(SUPPORTED))}"
        )

    page_map: list[tuple[int, int]] = []
    match suffix:
        case ".pdf":
            backend = parse_pdf(data, parser)
            text, blocks, page_map = backend.text, backend.blocks, backend.page_map
            extra = {**backend.diagnostics, "parser": parser}
        case ".docx":
            text, blocks, extra = _parse_docx(data)
        case ".md" | ".markdown":
            text = data.decode("utf-8", errors="replace").strip()
            blocks = _markdown_blocks(text)
            extra = {}
        case _:
            text = data.decode("utf-8", errors="replace").strip()
            blocks = [Block(kind="paragraph", span=(0, len(text)))] if text else []
            extra = {}

    if not text:
        raise EmptyExtraction(
            f"No text could be extracted from '{filename}'. If it is a scanned document, "
            "run it through OCR first (e.g. `ocrmypdf in.pdf out.pdf`)."
        )

    content_hash = hashlib.sha256(data).hexdigest()
    document = Document(
        # Derived rather than random, so re-ingesting the same file yields the same id
        # and two runs over one corpus produce byte-identical traces.
        id=f"d_{hashlib.blake2b(f'{filename}:{content_hash}'.encode(), digest_size=6).hexdigest()}",
        filename=filename,
        text=text,
        content_hash=content_hash,
        page_map=page_map,
        meta={
            "format": suffix.lstrip("."),
            "bytes": len(data),
            # Which backend produced this text. Reindex cannot re-parse (the original
            # bytes are gone), so a parser-knob change needs this to say so honestly.
            **({"parser": parser} if suffix == ".pdf" else {}),
        },
        blocks=blocks,
    )
    return ParseResult(
        document=document,
        diagnostics={
            "format": suffix.lstrip("."),
            "characters": len(text),
            "pages": len(page_map) or None,
            "blocks": len(blocks),
            "extract_ms": round((time.perf_counter() - started) * 1000, 2),
            **extra,
        },
    )


def _markdown_blocks(text: str) -> list[Block]:
    """Heading and paragraph blocks from Markdown, with exact spans into ``text``.

    Deliberately minimal: ATX headings and blank-line-separated paragraphs cover this
    project's corpora, and anything fancier (setext headings, fenced code) degrades
    gracefully into paragraph blocks rather than being mis-labelled.
    """
    blocks: list[Block] = []
    para_start: int | None = None
    para_end = 0
    offset = 0

    def flush() -> None:
        nonlocal para_start
        if para_start is not None:
            blocks.append(Block(kind="paragraph", span=(para_start, para_end)))
            para_start = None

    for line in text.splitlines(keepends=True):
        stripped = line.rstrip("\n")
        if not stripped.strip():
            flush()
        elif (m := _MD_HEADING.match(stripped)) is not None:
            flush()
            blocks.append(
                Block(kind="heading", span=(offset, offset + len(stripped)), level=len(m.group(1)))
            )
        else:
            if para_start is None:
                para_start = offset
            para_end = offset + len(stripped)
        offset += len(line)
    flush()
    return blocks


def _parse_docx(data: bytes) -> tuple[str, list[Block], dict]:
    import docx

    document = docx.Document(io.BytesIO(data))
    # (text, kind, level) items assembled into the canonical string below.
    items: list[tuple[str, str, int]] = []
    for p in document.paragraphs:
        stripped = p.text.strip()
        if not stripped:
            continue
        style = (p.style.name or "") if p.style is not None else ""
        if style.startswith("Heading"):
            digits = "".join(ch for ch in style if ch.isdigit())
            level = min(int(digits), 3) if digits else 1
            items.append((stripped, "heading", level))
        else:
            items.append((stripped, "paragraph", 0))

    # Tables are flattened to pipe-delimited rows, one block per table so downstream
    # stages know a table is a table even without cell geometry.
    for table in document.tables:
        rows = [" | ".join(cell.text.strip() for cell in row.cells) for row in table.rows]
        if rows:
            items.append(("\n".join(rows), "table", 0))

    blocks: list[Block] = []
    parts: list[str] = []
    offset = 0
    for text_part, kind, level in items:
        blocks.append(Block(kind=kind, span=(offset, offset + len(text_part)), level=level))
        parts.append(text_part)
        offset += len(text_part) + 2  # matches the "\n\n" join
    return "\n\n".join(parts), blocks, {"tables": len(document.tables)}
