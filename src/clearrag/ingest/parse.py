"""Turn uploaded files into ``Document``s with an intact character offset space.

The invariant every downstream stage relies on: ``Document.text`` is the authoritative
string, and every chunk span indexes into it. That is what lets a citation highlight an
exact region of the original file instead of naming a chunk number.

Phase 3 replaces the PDF path with docling for real table and heading structure. pypdf is
adequate for prose and keeps Phase 0 dependency-light.
"""

from __future__ import annotations

import hashlib
import io
import time
from dataclasses import dataclass

from ..core.types import Document

SUPPORTED = {".pdf", ".txt", ".md", ".markdown", ".docx", ".csv"}


class UnsupportedFile(ValueError):
    pass


class EmptyExtraction(ValueError):
    """Raised when a file parses but yields no text -- typically a scanned PDF."""


@dataclass
class ParseResult:
    document: Document
    diagnostics: dict


def parse(filename: str, data: bytes) -> ParseResult:
    started = time.perf_counter()
    suffix = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix not in SUPPORTED:
        raise UnsupportedFile(
            f"'{suffix or filename}' is not supported. Supported: {', '.join(sorted(SUPPORTED))}"
        )

    match suffix:
        case ".pdf":
            text, page_map, extra = _parse_pdf(data)
        case ".docx":
            text, page_map, extra = _parse_docx(data)
        case _:
            text, page_map, extra = data.decode("utf-8", errors="replace"), [], {}

    text = text.strip()
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
        meta={"format": suffix.lstrip("."), "bytes": len(data)},
    )
    return ParseResult(
        document=document,
        diagnostics={
            "format": suffix.lstrip("."),
            "characters": len(text),
            "pages": len(page_map) or None,
            "extract_ms": round((time.perf_counter() - started) * 1000, 2),
            **extra,
        },
    )


def _parse_pdf(data: bytes) -> tuple[str, list[tuple[int, int]], dict]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    page_map: list[tuple[int, int]] = []
    offset = 0
    empty_pages = 0

    for number, page in enumerate(reader.pages, start=1):
        content = (page.extract_text() or "").strip()
        if not content:
            empty_pages += 1
            continue
        page_map.append((offset, number))
        parts.append(content)
        offset += len(content) + 2  # matches the "\n\n" join below

    return (
        "\n\n".join(parts),
        page_map,
        {"empty_pages": empty_pages, "total_pages": len(reader.pages)},
    )


def _parse_docx(data: bytes) -> tuple[str, list[tuple[int, int]], dict]:
    import docx

    document = docx.Document(io.BytesIO(data))
    paragraphs = [p.text for p in document.paragraphs if p.text.strip()]
    tables = len(document.tables)
    # Tables are flattened to pipe-delimited rows. Crude, but it keeps their content
    # searchable; docling in Phase 3 preserves real structure.
    rows = [
        " | ".join(cell.text.strip() for cell in row.cells)
        for table in document.tables
        for row in table.rows
    ]
    return "\n\n".join(paragraphs + rows), [], {"tables": tables}
