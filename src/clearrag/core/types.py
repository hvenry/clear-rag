"""Core value types shared by every stage of the pipeline.

The single most important decision in this module is that every retrieval stage
consumes and produces ``list[Candidate]``. Keyword search, vector search, fusion and
reranking all speak the same type, which is what lets the UI draw a rank-flow diagram
between any two adjacent stages without knowing what those stages do.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# ── Documents and chunks ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Document:
    """A source file after parsing, with its full text intact.

    ``text`` is authoritative: every chunk's ``span`` indexes into it, which is what
    makes citations point at exact regions of the original rather than at chunk numbers.
    """

    id: str
    filename: str
    text: str
    content_hash: str
    page_map: list[tuple[int, int]] = field(default_factory=list)
    """``(char_offset, page_number)`` breakpoints, ascending. Empty for non-paged formats."""
    meta: dict[str, Any] = field(default_factory=dict)
    blocks: list[Block] = field(default_factory=list)
    """Parse structure over ``text``, in reading order. Empty when the parser found none."""

    def page_at(self, offset: int) -> int | None:
        """Page number containing ``offset``, or None if this document has no pages."""
        if not self.page_map:
            return None
        page = self.page_map[0][1]
        for start, num in self.page_map:
            if start > offset:
                break
            page = num
        return page


@dataclass(frozen=True)
class Block:
    """One structural unit the parser recovered: a heading, paragraph, or table.

    ``span`` indexes into ``Document.text``, the same offset space chunks use, so the
    UI can draw parse structure, chunk boundaries and citations over one string.
    ``level`` is the heading level (1-3) and 0 for non-headings.
    """

    kind: str  # "heading" | "paragraph" | "table"
    span: tuple[int, int]
    level: int = 0
    page: int | None = None


@dataclass(frozen=True)
class Chunk:
    """A retrievable unit of text, anchored to its position in the source document."""

    id: str
    doc_id: str
    text: str
    span: tuple[int, int]
    ordinal: int
    page: int | None = None
    context: str | None = None
    """Contextual-retrieval preamble. Embedded and indexed, but never displayed."""

    @property
    def indexed_text(self) -> str:
        """What actually gets embedded and put in the inverted index."""
        return f"{self.context}\n\n{self.text}" if self.context else self.text


# ── Retrieval ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Candidate:
    """One chunk's standing at one point in the pipeline.

    ``rank`` is 1-based and always relative to the stage that emitted it, so a
    candidate's movement between stages is exactly ``rank_before - rank_after``.
    """

    chunk_id: str
    score: float
    rank: int
    source: str
    detail: dict[str, Any] = field(default_factory=dict)
    """Stage-specific extras, e.g. which query terms matched and how often."""


@dataclass(frozen=True)
class Citation:
    """A validated pointer from a sentence in the answer back to source text."""

    chunk_id: str
    doc_id: str
    filename: str
    span: tuple[int, int]
    page: int | None
    quote: str
    marker: int
    """The number shown inline in the answer, 1-based."""


# ── Conversation ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Message:
    role: str  # "system" | "user" | "assistant"
    content: str
