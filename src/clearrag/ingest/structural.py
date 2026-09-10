"""Structure-first semantic chunking.

Fixed-size chunking cuts wherever the token budget happens to land, which is how a
résumé chunk ends up holding half of one job and two unrelated sections, the exact
attribution failure the README documents. This chunker cuts where the *document* says
its topics change: parsed heading boundaries first, and (when an embedder is available)
embedding-drop breakpoints inside sections too long for one chunk.

No overlap, deliberately: overlap is a recall hedge against arbitrary cut points, and
these cut points are not arbitrary.

Every chunk is still a contiguous span of ``Document.text``, so the span invariant
(citations, highlighting, span-anchored evaluation) holds unchanged.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable, Sequence

import numpy as np

from ..core.types import Block, Chunk, Document
from .chunk import (
    DEFAULT_SEPARATORS,
    ChunkResult,
    _chunk_id,
    _encoder,
    _merge_into_windows,
    _split_recursive,
    chunk_document,
    count_tokens,
)

#: Async embedding function: texts in, unit vectors out. Matches EmbeddingProvider.embed
#: with ``kind`` already bound.
EmbedFn = Callable[[Sequence[str]], Awaitable[np.ndarray]]


async def chunk_structural(
    document: Document,
    *,
    chunk_size: int = 512,
    embed: EmbedFn | None = None,
) -> ChunkResult:
    if not document.blocks:
        # Nothing structural to work with (plain text, a parser that found no
        # structure): recursive chunking is strictly better than one giant chunk.
        result = chunk_document(document, chunk_size=chunk_size, chunk_overlap=0)
        result.diagnostics["fallback"] = "recursive"
        return result

    sections = _sections(document.blocks)
    windows: list[tuple[int, int]] = []
    for span in await _packed_spans(document, sections, chunk_size, embed):
        windows.append(span)

    chunks = [
        Chunk(
            id=_chunk_id(document.id, i, start, end),
            doc_id=document.id,
            text=document.text[start:end],
            span=(start, end),
            ordinal=i,
            page=document.page_at(start),
        )
        for i, (start, end) in enumerate(windows)
    ]
    token_counts = [count_tokens(c.text) for c in chunks]
    return ChunkResult(
        chunks=chunks,
        diagnostics={
            "count": len(chunks),
            "chunker": "semantic",
            "chunk_size": chunk_size,
            "chunk_overlap": 0,
            "sections": len(sections),
            "tokens": {
                "min": min(token_counts, default=0),
                "max": max(token_counts, default=0),
                "mean": round(sum(token_counts) / len(token_counts), 1) if token_counts else 0,
                "histogram": token_counts,
            },
            "boundaries": [list(c.span) for c in chunks],
        },
    )


def _sections(blocks: list[Block]) -> list[tuple[int, int]]:
    """Contiguous spans, one per heading-bounded section, in document order."""
    spans: list[tuple[int, int]] = []
    start: int | None = None
    end = 0
    for block in blocks:
        if block.kind == "heading":
            if start is not None:
                spans.append((start, end))
            start = block.span[0]
        elif start is None:
            start = block.span[0]
        end = block.span[1]
    if start is not None and end > start:
        spans.append((start, end))
    return spans


async def _packed_spans(
    document: Document,
    sections: list[tuple[int, int]],
    chunk_size: int,
    embed: EmbedFn | None,
) -> list[tuple[int, int]]:
    """Greedily pack whole sections to the budget; split only over-long ones."""
    encoder = _encoder()
    packed: list[tuple[int, int]] = []
    current: tuple[int, int] | None = None
    current_tokens = 0

    for start, end in sections:
        tokens = len(encoder.encode(document.text[start:end]))
        if tokens > chunk_size:
            if current is not None:
                packed.append(current)
                current, current_tokens = None, 0
            packed.extend(await _split_section(document, (start, end), chunk_size, embed))
            continue
        if current is not None and current_tokens + tokens <= chunk_size:
            current = (current[0], end)
            current_tokens += tokens
        else:
            if current is not None:
                packed.append(current)
            current, current_tokens = (start, end), tokens
    if current is not None:
        packed.append(current)
    return packed


async def _split_section(
    document: Document,
    span: tuple[int, int],
    chunk_size: int,
    embed: EmbedFn | None,
) -> list[tuple[int, int]]:
    """A section too big for one chunk.

    With an embedder: cut where meaning shifts: embed the section's units (paragraph
    blocks when it has several, sentences when it is one long paragraph), and break
    where the distance between adjacent units spikes above mean + one standard
    deviation. Fragments still over budget fall back to recursive splitting, as does
    the whole section when no embedder is available or the units are too few to
    yield a meaningful distance distribution.
    """
    fragments = [span]
    if embed is not None:
        units = _units(document, span)
        if len(units) >= 4:  # fewer units make mean+std a coin flip
            vectors = await embed([document.text[s:e] for s, e in units])
            distances = 1.0 - np.sum(vectors[:-1] * vectors[1:], axis=1)
            threshold = float(np.mean(distances) + np.std(distances))
            breaks = [i + 1 for i, d in enumerate(distances) if d > threshold]
            if breaks:
                fragments = []
                lo = 0
                for b in [*breaks, len(units)]:
                    fragments.append((units[lo][0], units[b - 1][1]))
                    lo = b

    encoder = _encoder()
    windows: list[tuple[int, int]] = []
    for start, end in fragments:
        if len(encoder.encode(document.text[start:end])) <= chunk_size:
            windows.append((start, end))
            continue
        pieces = _split_recursive(
            document.text[start:end], start, chunk_size, DEFAULT_SEPARATORS, encoder
        )
        windows.extend(_merge_into_windows(pieces, chunk_size, 0, encoder, document.text))
    return windows


_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def _units(document: Document, span: tuple[int, int]) -> list[tuple[int, int]]:
    """Embedding units inside a section: its paragraph blocks, or its sentences when
    the section is effectively one long paragraph."""
    start, end = span
    paragraphs = [
        b.span
        for b in document.blocks
        if b.kind != "heading" and b.span[0] >= start and b.span[1] <= end
    ]
    if len(paragraphs) >= 4:
        return paragraphs

    units: list[tuple[int, int]] = []
    cursor = start
    for match in _SENTENCE_END.finditer(document.text, start, end):
        if match.start() > cursor:
            units.append((cursor, match.start()))
        cursor = match.end()
    if cursor < end:
        units.append((cursor, end))
    return units
