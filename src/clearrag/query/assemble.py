"""Pack retrieved chunks into the model's context budget.

Three jobs, in order of how often they are skipped by RAG implementations that later
behave strangely:

1. **Deduplicate overlapping spans.** Adjacent chunks share their overlap region by
   construction, so a naive top-k regularly feeds the model the same sentences twice.
2. **Respect the token budget**, and record what was dropped. Silently truncating context
   produces answers that omit information the retriever actually found, and the trace is
   the only place that becomes visible.
3. **Number the chunks stably**, so the generator can cite ``[1]`` and the citation can be
   resolved back to an exact span.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from ..core.stage import timed
from ..core.trace import StageRecord
from ..core.types import Candidate, Chunk
from ..ingest.chunk import count_tokens

if TYPE_CHECKING:
    from ..index.store import Store
    from .context import QueryContext


@dataclass
class AssembledContext:
    prompt_context: str
    used: list[tuple[int, Chunk]]
    """``(marker, chunk)`` pairs; marker is the 1-based number shown to the model."""
    diagnostics: dict


def assemble(
    candidates: Sequence[Candidate],
    chunks: dict[str, Chunk],
    *,
    max_tokens: int = 4096,
) -> AssembledContext:
    used: list[tuple[int, Chunk]] = []
    blocks: list[str] = []
    spent = 0
    dropped: list[dict] = []
    seen_spans: list[tuple[str, int, int]] = []

    for candidate in candidates:
        chunk = chunks.get(candidate.chunk_id)
        if chunk is None:
            continue

        if _overlaps(chunk, seen_spans):
            dropped.append({"chunk_id": chunk.id, "reason": "overlapping_span"})
            continue

        marker = len(used) + 1
        # The marker alone labels the passage. The chunk id used to ride along here
        # "for transparency", but the model never needs it (the [n]→chunk mapping
        # lives in `used`), and small models parroted "(c_…)" into their answers.
        block = f"[{marker}] {chunk.text.strip()}"
        cost = count_tokens(block)

        if spent + cost > max_tokens:
            dropped.append({"chunk_id": chunk.id, "reason": "token_budget", "tokens": cost})
            continue

        used.append((marker, chunk))
        blocks.append(block)
        seen_spans.append((chunk.doc_id, *chunk.span))
        spent += cost

    return AssembledContext(
        prompt_context="\n\n".join(blocks),
        used=used,
        diagnostics={
            "chunks_used": len(used),
            "chunks_dropped": len(dropped),
            "dropped": dropped,
            "context_tokens": spent,
            "budget_tokens": max_tokens,
            "budget_used_pct": round(100 * spent / max_tokens, 1) if max_tokens else 0.0,
        },
    )


def _overlaps(chunk: Chunk, seen: list[tuple[str, int, int]]) -> bool:
    """True when more than half of ``chunk`` already appears in an accepted chunk."""
    start, end = chunk.span
    length = max(1, end - start)
    for doc_id, other_start, other_end in seen:
        if doc_id != chunk.doc_id:
            continue
        shared = min(end, other_end) - max(start, other_start)
        if shared > 0 and shared / length > 0.5:
            return True
    return False


def assemble_stage(
    ctx: QueryContext, selected: Sequence[Candidate], chunk_map: dict[str, Chunk]
) -> tuple[AssembledContext, StageRecord]:
    """Pack the selected candidates and record what reached the model."""
    rec = ctx.trace.stage("assemble", "Assemble context", max_tokens=ctx.config.max_context_tokens)
    with timed(rec):
        packed = assemble(selected, chunk_map, max_tokens=ctx.config.max_context_tokens)
        rec.candidates_in = list(selected)
        used_ids = {chunk.id for _, chunk in packed.used}
        rec.candidates_out = [c for c in selected if c.chunk_id in used_ids]
        rec.diagnostics = packed.diagnostics
    return packed, rec


def filenames_for(store: Store, packed: AssembledContext) -> dict[str, str]:
    """Document id -> filename for every document the packed context draws on."""
    return {
        doc_id: (doc.filename if (doc := store.get_document(doc_id)) else "unknown")
        for doc_id in {chunk.doc_id for _, chunk in packed.used}
    }


def context_event(packed: AssembledContext, filenames: dict[str, str]) -> dict[str, Any]:
    """The SSE payload carrying the passages the model is about to read."""
    return {
        "type": "context",
        "chunks": [
            {
                "marker": marker,
                "chunk_id": chunk.id,
                "doc_id": chunk.doc_id,
                "filename": filenames.get(chunk.doc_id, "unknown"),
                # Position within its document. Without it a chunk is an opaque id,
                # and a preview drawn from an overlap region looks like it belongs to
                # the neighbouring chunk.
                "ordinal": chunk.ordinal,
                "text": chunk.text,
                "span": list(chunk.span),
                "page": chunk.page,
            }
            for marker, chunk in packed.used
        ],
    }
