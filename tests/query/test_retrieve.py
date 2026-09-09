"""Per-retriever fusion across query phrasings."""

from __future__ import annotations

import pytest

from clearrag.core.types import Candidate
from clearrag.query.retrieve import merge_variants


def test_single_phrasing_passes_through_untouched():
    """With expansion off, retrieval must produce exactly what it always produced."""
    only = [Candidate("a", 1.0, 1, "bm25"), Candidate("b", 0.5, 2, "bm25")]
    assert merge_variants([only], source="bm25", rrf_k=60, top_k=10) is only


def test_agreement_across_phrasings_outranks_a_single_first_place():
    q0 = [
        Candidate("a", 9.0, 1, "bm25", {"matched_terms": {"rollback": 1}}),
        Candidate("b", 5.0, 2, "bm25", {"matched_terms": {"release": 1}}),
    ]
    q1 = [
        Candidate("b", 4.0, 1, "bm25", {"matched_terms": {"revert": 2}}),
        Candidate("c", 1.0, 2, "bm25", {"matched_terms": {"deploy": 1}}),
    ]
    q2 = [
        Candidate("b", 3.0, 1, "bm25", {"matched_terms": {"release": 3}}),
        Candidate("a", 2.0, 2, "bm25", {"matched_terms": {"rollback": 1}}),
    ]

    merged = merge_variants([q0, q1, q2], source="bm25", rrf_k=60, top_k=10)

    # b was never the single best score, but every phrasing ranked it well.
    assert [c.chunk_id for c in merged] == ["b", "a", "c"]
    assert [c.rank for c in merged] == [1, 2, 3]
    assert all(c.source == "bm25" for c in merged)

    b = merged[0]
    assert b.score == pytest.approx(1 / 62 + 2 / 61, abs=1e-6)
    assert b.detail["variants"] == {
        "0": {"rank": 2, "score": 5.0},
        "1": {"rank": 1, "score": 4.0},
        "2": {"rank": 1, "score": 3.0},
    }
    # Matched terms are unioned so the inspector can show every word that fired.
    assert b.detail["matched_terms"] == {"release": 3, "revert": 2}


def test_dense_detail_comes_from_the_best_placing_phrasing():
    q0 = [Candidate("a", 0.40, 1, "dense", {"cosine": 0.40})]
    q1 = [
        Candidate("b", 0.90, 1, "dense", {"cosine": 0.90}),
        Candidate("a", 0.70, 2, "dense", {"cosine": 0.70}),
    ]

    merged = merge_variants([q0, q1], source="dense", rrf_k=60, top_k=10)
    a = next(c for c in merged if c.chunk_id == "a")

    assert a.detail["cosine"] == 0.40  # rank 1 in q0 beats rank 2 in q1
    assert "matched_terms" not in a.detail


def test_top_k_truncates_the_merged_ranking():
    q0 = [Candidate("a", 1.0, 1, "bm25"), Candidate("b", 0.5, 2, "bm25")]
    q1 = [Candidate("c", 1.0, 1, "bm25")]
    assert len(merge_variants([q0, q1], source="bm25", rrf_k=60, top_k=1)) == 1
