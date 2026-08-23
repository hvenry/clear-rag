"""Reciprocal Rank Fusion arithmetic."""

from __future__ import annotations

import pytest

from clearrag.core.types import Candidate
from clearrag.query.fuse import reciprocal_rank_fusion, weighted_fusion


def ranked(source: str, ids: list[str], scores: list[float] | None = None) -> list[Candidate]:
    scores = scores or [1.0 / (i + 1) for i in range(len(ids))]
    return [
        Candidate(chunk_id=cid, score=scores[i], rank=i + 1, source=source)
        for i, cid in enumerate(ids)
    ]


def test_empty_input():
    assert reciprocal_rank_fusion({}) == []


def test_single_ranking_preserves_order():
    fused = reciprocal_rank_fusion({"dense": ranked("dense", ["a", "b", "c"])})
    assert [c.chunk_id for c in fused] == ["a", "b", "c"]


def test_score_matches_formula():
    # Scores are rounded to 6dp on the way out to keep trace payloads small, so the
    # tolerance here matches that rounding rather than float precision.
    fused = reciprocal_rank_fusion({"dense": ranked("dense", ["a"])}, k=60)
    assert fused[0].score == pytest.approx(1 / 61, abs=1e-6)


def test_agreement_beats_a_single_first_place():
    # "b" is second in both rankings; "a" is first in one and absent from the other.
    # 2/62 > 1/61, so consensus wins -- which is the property RRF exists to provide.
    fused = reciprocal_rank_fusion(
        {"dense": ranked("dense", ["a", "b"]), "bm25": ranked("bm25", ["c", "b"])}, k=60
    )
    assert fused[0].chunk_id == "b"


def test_records_per_source_contributions():
    fused = reciprocal_rank_fusion({"dense": ranked("dense", ["a"]), "bm25": ranked("bm25", ["a"])})
    detail = fused[0].detail
    assert detail["found_by"] == ["bm25", "dense"]
    assert set(detail["contributions"]) == {"bm25", "dense"}
    assert detail["contributions"]["dense"]["rank"] == 1


def test_ranks_are_reassigned_contiguously():
    fused = reciprocal_rank_fusion(
        {"dense": ranked("dense", ["a", "b", "c"]), "bm25": ranked("bm25", ["c", "d"])}
    )
    assert [c.rank for c in fused] == list(range(1, len(fused) + 1))


def test_source_is_relabelled():
    fused = reciprocal_rank_fusion({"dense": ranked("dense", ["a"])})
    assert fused[0].source == "rrf"


def test_top_k_truncates():
    fused = reciprocal_rank_fusion({"dense": ranked("dense", list("abcdef"))}, top_k=2)
    assert len(fused) == 2


def test_ties_break_deterministically():
    a = reciprocal_rank_fusion({"x": ranked("x", ["b"]), "y": ranked("y", ["a"])})
    b = reciprocal_rank_fusion({"y": ranked("y", ["a"]), "x": ranked("x", ["b"])})
    assert [c.chunk_id for c in a] == [c.chunk_id for c in b]


def test_smaller_k_amplifies_top_ranks():
    # With k=1 the gap between rank 1 and rank 2 is large; with k=1000 it is negligible.
    sharp = reciprocal_rank_fusion({"d": ranked("d", ["a", "b"])}, k=1)
    flat = reciprocal_rank_fusion({"d": ranked("d", ["a", "b"])}, k=1000)
    assert (sharp[0].score - sharp[1].score) > (flat[0].score - flat[1].score)


def test_weighted_fusion_respects_weights():
    fused = weighted_fusion(
        {"dense": ranked("dense", ["a", "b"]), "bm25": ranked("bm25", ["b", "a"])},
        weights={"dense": 1.0, "bm25": 0.0},
    )
    assert fused[0].chunk_id == "a"


def test_weighted_fusion_handles_flat_scores():
    # A retriever returning identical scores must not divide by a zero spread.
    fused = weighted_fusion(
        {"dense": ranked("dense", ["a", "b"], scores=[0.5, 0.5])}, weights={"dense": 1.0}
    )
    assert len(fused) == 2
