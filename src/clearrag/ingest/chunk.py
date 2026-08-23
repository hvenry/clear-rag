"""Splitting documents into retrievable chunks.

Two properties matter more than the splitting rule itself:

**Spans are exact.** Every chunk records where it came from in ``Document.text``, which is
what makes citation highlighting and span-anchored evaluation possible. Chunkers here
locate their output in the source rather than returning bare strings.

**Boundaries are reported.** ``diagnostics`` carries the cut positions and the token
histogram, which is precisely what the Chunk Inspector draws over the document. Bad
chunking is obvious the moment you can see it, and nearly invisible when you cannot.

On overlap: the default is 64 tokens against a 512-token chunk -- 12%. The predecessor
project used 256 against 512, a 50% overlap that doubled index size and filled the top-k
with near-duplicate neighbours of a single passage.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from functools import lru_cache

from ..core.types import Chunk, Document

DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", " "]


@lru_cache(maxsize=1)
def _encoder():
    """cl100k_base is a reasonable stand-in for any model's tokenizer at this granularity."""
    import tiktoken

    return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    return len(_encoder().encode(text))


@dataclass
class ChunkResult:
    chunks: list[Chunk]
    diagnostics: dict


def chunk_document(
    document: Document,
    *,
    chunk_size: int = 512,
    chunk_overlap: int = 64,
    separators: list[str] | None = None,
) -> ChunkResult:
    """Recursively split on the largest separator that fits, then window with overlap."""
    if chunk_overlap >= chunk_size:
        raise ValueError("chunk_overlap must be smaller than chunk_size")

    encoder = _encoder()
    separators = separators or DEFAULT_SEPARATORS
    pieces = _split_recursive(document.text, 0, chunk_size, separators, encoder)
    windows = _merge_into_windows(pieces, chunk_size, chunk_overlap, encoder, document.text)

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
            "chunk_size": chunk_size,
            "chunk_overlap": chunk_overlap,
            "overlap_ratio": round(chunk_overlap / chunk_size, 3),
            "tokens": {
                "min": min(token_counts, default=0),
                "max": max(token_counts, default=0),
                "mean": round(sum(token_counts) / len(token_counts), 1) if token_counts else 0,
                "histogram": token_counts,
            },
            # Cut positions in the source. The Chunk Inspector draws these as bands.
            "boundaries": [list(c.span) for c in chunks],
        },
    )


def _chunk_id(doc_id: str, ordinal: int, start: int, end: int) -> str:
    """A deterministic id for a chunk's position within its document.

    Random ids made ranking non-deterministic: BM25 and RRF break score ties on chunk
    id, so two runs over an identical corpus produced slightly different rankings and
    slightly different metrics. Deriving the id from position removes that, and makes
    traces from separate runs directly comparable.
    """
    digest = hashlib.blake2b(f"{doc_id}:{ordinal}:{start}:{end}".encode(), digest_size=6)
    return f"c_{digest.hexdigest()}"


def _split_recursive(
    text: str, offset: int, limit: int, separators: list[str], encoder
) -> list[tuple[int, int]]:
    """Break text into spans no larger than ``limit`` tokens, preferring natural breaks."""
    if not text.strip():
        return []
    if len(encoder.encode(text)) <= limit:
        return [(offset, offset + len(text))]

    for i, sep in enumerate(separators):
        if sep not in text:
            continue
        spans: list[tuple[int, int]] = []
        cursor = 0
        for part in text.split(sep):
            if part:
                spans.extend(
                    _split_recursive(part, offset + cursor, limit, separators[i + 1 :], encoder)
                )
            cursor += len(part) + len(sep)
        if spans:
            return spans

    # No separator left: hard-split on token boundaries so a single long run of text
    # still produces usable chunks rather than one oversized one.
    return _hard_split(text, offset, limit, encoder)


def _hard_split(text: str, offset: int, limit: int, encoder) -> list[tuple[int, int]]:
    tokens = encoder.encode(text)
    spans: list[tuple[int, int]] = []
    cursor = 0
    for i in range(0, len(tokens), limit):
        piece = encoder.decode(tokens[i : i + limit])
        found = text.find(piece, cursor)
        start = found if found != -1 else cursor
        spans.append((offset + start, offset + start + len(piece)))
        cursor = start + len(piece)
    return spans


def _snap_to_word_start(text: str, position: int, floor: int) -> int:
    """Move ``position`` forward to the next word boundary, never past ``floor``.

    Overlap is computed in characters, so without this the backup lands wherever the
    arithmetic points -- routinely inside a word. Every chunk after the first then opens
    on a fragment, which turns a citation preview into what looks like corrupt text
    ("cal data" for "historical data").

    Forward rather than backward so the snap can only ever shrink the overlap, never
    grow a window past the size budget.
    """
    if position <= floor:
        return floor
    limit = min(len(text), position + 64)
    cursor = position
    while cursor < limit and not text[cursor].isspace():
        cursor += 1
    while cursor < limit and text[cursor].isspace():
        cursor += 1
    # No boundary within reach (a very long token): leave the original position rather
    # than swallowing an arbitrary amount of text.
    return cursor if cursor < limit else position


def _merge_into_windows(
    pieces: list[tuple[int, int]], chunk_size: int, overlap: int, encoder, text: str
) -> list[tuple[int, int]]:
    """Greedily pack adjacent spans up to ``chunk_size``, backing up by ``overlap``."""
    if not pieces:
        return []

    windows: list[tuple[int, int]] = []
    current_start, current_end = pieces[0]
    current_tokens = 0

    for start, end in pieces:
        span_tokens = max(1, (end - start) // 4)  # cheap estimate; exact count is per-window
        if current_tokens and current_tokens + span_tokens > chunk_size:
            windows.append((current_start, current_end))
            # Back up by roughly `overlap` tokens, approximated in characters. Exactness
            # is not required here: overlap is a recall hedge, not a correctness property.
            backup = min(overlap * 4, current_end - current_start)
            raw_start = max(current_end - backup, current_start)
            current_start = _snap_to_word_start(text, raw_start, current_start)
            current_tokens = max(1, (current_end - current_start) // 4)
        current_end = end
        current_tokens += span_tokens

    windows.append((current_start, current_end))
    return [(s, e) for s, e in windows if e > s]
