"""The rerank stage: a cross-encoder re-scores the fused shortlist.

Three outcomes, and the trace distinguishes all of them:

    * reranking is off: no stage, the fused order is truncated to ``k_final``;
    * reranking is on but no cross-encoder is installed: a *degraded* stage that says
      so, because a knob that silently does nothing is worse than one that reports it;
    * reranking runs: if the model fails to load or score, the stage degrades to
      fusion order rather than failing a query that was otherwise answerable.
"""

from __future__ import annotations

from ..core.stage import degradable
from ..core.trace import StageRecord
from ..core.types import Candidate, Chunk
from .context import QueryContext


async def rerank_stage(
    ctx: QueryContext,
    search_query: str,
    fused: list[Candidate],
    chunk_map: dict[str, Chunk],
) -> tuple[list[Candidate], StageRecord | None]:
    """Return the candidates handed on to assembly, and the stage record if one ran."""
    config = ctx.config
    shortlist = fused[: config.k_final]

    if not config.rerank:
        return shortlist, None

    if ctx.reranker is None:
        rec = ctx.trace.stage("rerank", "Rerank (unavailable)", requested=True)
        rec.candidates_in = fused
        rec.candidates_out = shortlist
        rec.degraded = True
        rec.error = "Reranking is enabled in config but no reranker is installed."
        rec.diagnostics = {
            "skipped": True,
            "remedy": "Not yet implemented; fusion order was used unchanged.",
        }
        return shortlist, rec

    reranker = ctx.reranker

    async def do_rerank(rec: StageRecord) -> list[Candidate]:
        rec.candidates_in = fused
        texts = [chunk_map[c.chunk_id].text for c in fused if c.chunk_id in chunk_map]
        out = await reranker.rerank(search_query, fused, texts, top_k=config.k_final)
        rec.candidates_out = out
        before = {c.chunk_id: c.rank for c in fused}
        rec.diagnostics = {"moves": {c.chunk_id: before.get(c.chunk_id, 0) - c.rank for c in out}}
        return out

    selected = await degradable(
        ctx.trace,
        "rerank",
        "Rerank (cross-encoder)",
        do_rerank,
        fallback=shortlist,
        model=reranker.name,
    )
    return selected, ctx.trace.find("rerank")
