"""The retrievers: keyword and vector search, run concurrently.

Each retriever times itself rather than being wrapped, because the two run under one
``gather`` and a shared timer would report the slower one's wait for both.

Each produces ``list[Candidate]`` - the universal currency that lets fusion, reranking and
the rank-flow diagram treat them identically.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable

from ..core.trace import StageRecord
from ..core.types import Candidate
from .context import QueryContext


async def retrieve(
    ctx: QueryContext, search_query: str
) -> tuple[dict[str, list[Candidate]], list[StageRecord]]:
    """Run the configured retrievers and return their rankings keyed by source.

    Rankings come back in dispatch order (vector, then keyword), which is the order
    fusion records their contributions. The stage records come back in the order the
    interface should receive them -- keyword first, since it is the faster one.
    A provider failure propagates: without retrieval there is nothing to degrade to.
    """
    config = ctx.config
    use_dense = config.retrieval in ("dense", "hybrid")
    use_lexical = config.retrieval in ("lexical", "hybrid")

    dense_rec = (
        ctx.trace.stage("dense", "Vector search", k=config.k_candidates) if use_dense else None
    )
    lexical_rec = (
        ctx.trace.stage("bm25", "Keyword search (BM25)", k=config.k_candidates)
        if use_lexical
        else None
    )

    async def run_dense(rec: StageRecord) -> list[Candidate]:
        start = time.perf_counter()
        vector = await ctx.embeddings.embed([search_query], kind="query")
        results = ctx.vectors.search(vector[0], k=config.k_candidates, allowed=ctx.allowed)
        rec.duration_ms = (time.perf_counter() - start) * 1000
        rec.candidates_out = results
        rec.diagnostics = {
            "corpus_size": len(ctx.vectors),
            "returned": len(results),
            "top_score": results[0].score if results else None,
        }
        return results

    async def run_lexical(rec: StageRecord) -> list[Candidate]:
        start = time.perf_counter()
        results = await asyncio.to_thread(
            ctx.lexical.search, search_query, config.k_candidates, ctx.allowed
        )
        rec.duration_ms = (time.perf_counter() - start) * 1000
        rec.candidates_out = results
        rec.diagnostics = {
            "vocabulary_terms": len(ctx.lexical.postings),
            "returned": len(results),
            "query_terms": sorted({t for c in results for t in c.detail.get("matched_terms", {})}),
        }
        return results

    tasks: list[tuple[str, Awaitable[list[Candidate]]]] = []
    if dense_rec is not None:
        tasks.append(("dense", run_dense(dense_rec)))
    if lexical_rec is not None:
        tasks.append(("bm25", run_lexical(lexical_rec)))

    results = await asyncio.gather(*(coro for _, coro in tasks))
    rankings = {name: result for (name, _), result in zip(tasks, results, strict=True)}
    records = [rec for rec in (lexical_rec, dense_rec) if rec is not None]
    return rankings, records
