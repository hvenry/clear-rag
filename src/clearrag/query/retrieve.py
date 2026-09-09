"""The retrievers: keyword and vector search, run concurrently.

Each retriever times itself rather than being wrapped, because the two run under one
``gather`` and a shared timer would report the slower one's wait for both. Each
produces ``list[Candidate]`` -- the universal currency that lets fusion, reranking and
the rank-flow diagram treat them identically.

With query expansion on, a retriever searches every phrasing and fuses its own rankings
by reciprocal rank before handing one list on. Two levels of fusion, then: phrasings
within a retriever here, retrievers against each other in the fuse stage. The
alternative -- one flat fusion over every (retriever, phrasing) pair -- would score the
same chunks but would leave the interface with no single keyword or vector ranking to
draw, and "which search found this" is the one thing the inspector must always answer.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Sequence

from ..core.trace import StageRecord
from ..core.types import Candidate
from .context import QueryContext
from .fuse import reciprocal_rank_fusion


async def retrieve(
    ctx: QueryContext, queries: Sequence[str]
) -> tuple[dict[str, list[Candidate]], list[StageRecord]]:
    """Run the configured retrievers and return their rankings keyed by source.

    ``queries`` is the resolved question first, then any expansions. Rankings come back
    in dispatch order (vector, then keyword), which is the order fusion records their
    contributions. The stage records come back in the order the interface should
    receive them -- keyword first, since it is the faster one. A provider failure
    propagates: without retrieval there is nothing to degrade to.
    """
    config = ctx.config
    use_dense = config.retrieval in ("dense", "hybrid")
    use_lexical = config.retrieval in ("lexical", "hybrid")
    phrasings = list(queries)

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
        vectors = await ctx.embeddings.embed(phrasings, kind="query")
        per_phrasing = [
            ctx.vectors.search(vector, k=config.k_candidates, allowed=ctx.allowed)
            for vector in vectors
        ]
        results = merge_variants(
            per_phrasing, source="dense", rrf_k=config.rrf_k, top_k=config.k_candidates
        )
        rec.duration_ms = (time.perf_counter() - start) * 1000
        rec.candidates_out = results
        rec.diagnostics = {
            "corpus_size": len(ctx.vectors),
            "returned": len(results),
            "top_score": results[0].score if results else None,
        }
        _note_variants(rec, per_phrasing)
        return results

    async def run_lexical(rec: StageRecord) -> list[Candidate]:
        start = time.perf_counter()
        per_phrasing = await asyncio.to_thread(
            lambda: [
                ctx.lexical.search(phrasing, config.k_candidates, ctx.allowed)
                for phrasing in phrasings
            ]
        )
        results = merge_variants(
            per_phrasing, source="bm25", rrf_k=config.rrf_k, top_k=config.k_candidates
        )
        rec.duration_ms = (time.perf_counter() - start) * 1000
        rec.candidates_out = results
        rec.diagnostics = {
            "vocabulary_terms": len(ctx.lexical.postings),
            "returned": len(results),
            "query_terms": sorted({t for c in results for t in c.detail.get("matched_terms", {})}),
        }
        _note_variants(rec, per_phrasing)
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


def merge_variants(
    per_phrasing: Sequence[list[Candidate]], *, source: str, rrf_k: int, top_k: int
) -> list[Candidate]:
    """Fuse one retriever's rankings across query phrasings into a single ranking.

    A single phrasing passes through untouched -- the common case must stay exactly what
    it was. With several, reciprocal rank fusion across phrasings decides the order, so
    a chunk that most phrasings rank well beats one that a single phrasing happened to
    rank first. The merged score is the fused score; the retriever's own numbers
    (cosine, matched terms) survive in ``detail`` from the phrasing that ranked the
    chunk best, with matched terms unioned across phrasings, and ``detail["variants"]``
    records where each phrasing placed it.
    """
    if len(per_phrasing) == 1:
        return per_phrasing[0]

    fused = reciprocal_rank_fusion(
        {f"q{i}": ranking for i, ranking in enumerate(per_phrasing)}, k=rrf_k, top_k=top_k
    )
    by_phrasing = [{c.chunk_id: c for c in ranking} for ranking in per_phrasing]

    merged: list[Candidate] = []
    for candidate in fused:
        hits = {
            i: table[candidate.chunk_id]
            for i, table in enumerate(by_phrasing)
            if candidate.chunk_id in table
        }
        best = min(hits.values(), key=lambda c: c.rank)
        detail = dict(best.detail)
        if any("matched_terms" in hit.detail for hit in hits.values()):
            terms: dict[str, int] = {}
            for hit in hits.values():
                for term, freq in hit.detail.get("matched_terms", {}).items():
                    terms[term] = max(terms.get(term, 0), freq)
            detail["matched_terms"] = dict(sorted(terms.items()))
        detail["variants"] = {
            str(i): {"rank": hit.rank, "score": hit.score} for i, hit in sorted(hits.items())
        }
        merged.append(
            Candidate(
                chunk_id=candidate.chunk_id,
                score=candidate.score,
                rank=candidate.rank,
                source=source,
                detail=detail,
            )
        )
    return merged


def _note_variants(rec: StageRecord, per_phrasing: Sequence[list[Candidate]]) -> None:
    """Only when expansion actually happened: a plain query's record stays as it was."""
    if len(per_phrasing) > 1:
        rec.diagnostics["variants"] = len(per_phrasing)
        rec.diagnostics["returned_per_variant"] = [len(ranking) for ranking in per_phrasing]
