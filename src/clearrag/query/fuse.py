"""Reciprocal Rank Fusion.

    RRF(d) = sum over retrievers r of  1 / (k + rank_r(d))

The property that makes RRF the right default: it consumes *ranks*, not scores. BM25
scores are unbounded sums of idf terms and cosine similarities live in [-1, 1]; they
cannot be added or averaged meaningfully without a normalisation scheme that has to be
retuned whenever the corpus changes. Ranks are already comparable.

``k`` (60, from the original paper) damps the contribution of top ranks so a single
retriever placing something first cannot by itself dominate agreement between retrievers.

Every fused candidate records where its score came from, per retriever. That breakdown is
the data behind the rank-flow diagram - without it the UI could show *that* a document
moved but not *why*.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING

from ..core.stage import timed
from ..core.trace import StageRecord
from ..core.types import Candidate

if TYPE_CHECKING:
    from .context import QueryContext


def reciprocal_rank_fusion(
    rankings: Mapping[str, Sequence[Candidate]], *, k: int = 60, top_k: int | None = None
) -> list[Candidate]:
    scores: dict[str, float] = defaultdict(float)
    contributions: dict[str, dict[str, dict[str, float]]] = defaultdict(dict)

    for source, candidates in rankings.items():
        for candidate in candidates:
            contribution = 1.0 / (k + candidate.rank)
            scores[candidate.chunk_id] += contribution
            contributions[candidate.chunk_id][source] = {
                "rank": candidate.rank,
                "score": candidate.score,
                "contribution": round(contribution, 6),
            }

    ordered = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    if top_k is not None:
        ordered = ordered[:top_k]

    return [
        Candidate(
            chunk_id=chunk_id,
            score=round(score, 6),
            rank=i + 1,
            source="rrf",
            detail={
                "contributions": contributions[chunk_id],
                "found_by": sorted(contributions[chunk_id]),
            },
        )
        for i, (chunk_id, score) in enumerate(ordered)
    ]


def weighted_fusion(
    rankings: Mapping[str, Sequence[Candidate]],
    *,
    weights: Mapping[str, float],
    top_k: int | None = None,
) -> list[Candidate]:
    """Score-based alternative, min-max normalised per retriever.

    Offered mainly so the ablation table has something to compare RRF against. It is
    sensitive to score distribution in a way RRF is not, which is the point being measured.
    """
    scores: dict[str, float] = defaultdict(float)
    contributions: dict[str, dict[str, dict[str, float]]] = defaultdict(dict)

    for source, candidates in rankings.items():
        if not candidates:
            continue
        values = [c.score for c in candidates]
        lo, hi = min(values), max(values)
        spread = (hi - lo) or 1.0
        weight = weights.get(source, 0.0)
        for candidate in candidates:
            normalised = (candidate.score - lo) / spread
            scores[candidate.chunk_id] += weight * normalised
            contributions[candidate.chunk_id][source] = {
                "rank": candidate.rank,
                "score": candidate.score,
                "normalised": round(normalised, 6),
                "contribution": round(weight * normalised, 6),
            }

    ordered = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    if top_k is not None:
        ordered = ordered[:top_k]

    return [
        Candidate(
            chunk_id=chunk_id,
            score=round(score, 6),
            rank=i + 1,
            source="weighted",
            detail={
                "contributions": contributions[chunk_id],
                "found_by": sorted(contributions[chunk_id]),
            },
        )
        for i, (chunk_id, score) in enumerate(ordered)
    ]


def fuse_stage(
    ctx: QueryContext, rankings: Mapping[str, list[Candidate]]
) -> tuple[list[Candidate], StageRecord | None]:
    """Merge the retrievers' rankings, or pass a lone ranking through untouched.

    With a single retriever there is nothing to fuse and no stage is recorded: the
    interface would otherwise draw a merge step that merged nothing.
    """
    if len(rankings) <= 1:
        return next(iter(rankings.values()), []), None

    config = ctx.config
    rec = ctx.trace.stage("fuse", "Fuse (RRF)", method=config.fusion, rrf_k=config.rrf_k)
    with timed(rec):
        if config.fusion == "rrf":
            fused = reciprocal_rank_fusion(rankings, k=config.rrf_k)
        else:
            fused = weighted_fusion(
                rankings,
                weights={"dense": config.dense_weight, "bm25": 1.0 - config.dense_weight},
            )
        rec.candidates_out = fused
        rec.diagnostics = {
            "inputs": {k: len(v) for k, v in rankings.items()},
            "unique_candidates": len(fused),
            "found_by_both": sum(1 for c in fused if len(c.detail.get("found_by", [])) > 1),
        }
    return fused, rec
