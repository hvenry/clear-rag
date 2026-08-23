"""Retrieval metrics, asserted against hand-computed values.

These are pure arithmetic, so the tests state the expected number and where it comes
from rather than recomputing the implementation in the assertion.
"""

from __future__ import annotations

import math

import pytest

from clearrag.core.types import Chunk
from clearrag.eval.golden import GoldenQuestion, RelevantSpan
from clearrag.eval.metrics import aggregate, covers, score_question


def chunk(cid: str, start: int, end: int, doc: str = "d1") -> Chunk:
    return Chunk(id=cid, doc_id=doc, text="x" * (end - start), span=(start, end), ordinal=0)


def label(start: int, end: int, doc: str = "a.md") -> RelevantSpan:
    return RelevantSpan(doc=doc, quote="q", span=(start, end))


def question(labels: list[RelevantSpan], **kwargs) -> GoldenQuestion:
    return GoldenQuestion(id="q", question="?", relevant=labels, **kwargs)


# ── covers ──


def test_full_containment_counts():
    assert covers(chunk("c", 0, 100), label(10, 20), "a.md")


def test_no_overlap_does_not_count():
    assert not covers(chunk("c", 0, 10), label(50, 60), "a.md")


def test_different_document_never_counts():
    assert not covers(chunk("c", 0, 100), label(10, 20, doc="a.md"), "b.md")


def test_marginal_clip_does_not_count():
    """A chunk catching the last two characters of the answer has not found it."""
    assert not covers(chunk("c", 18, 40), label(10, 20), "a.md")


def test_threshold_is_measured_against_the_label_not_the_chunk():
    # Chunk covers 10 of the label's 20 characters: exactly the 0.5 default.
    assert covers(chunk("c", 10, 20), label(10, 30), "a.md", threshold=0.5)
    assert not covers(chunk("c", 10, 20), label(10, 30), "a.md", threshold=0.51)


# ── score_question ──


def test_perfect_first_hit():
    result = score_question(question([label(0, 50)]), [(chunk("c1", 0, 100), "a.md")], k=5)
    assert (result.recall, result.reciprocal_rank, result.ndcg, result.hit) == (1.0, 1.0, 1.0, True)
    assert result.first_relevant_rank == 1


def test_reciprocal_rank_reflects_position():
    ranked = [
        (chunk("c1", 500, 600), "a.md"),
        (chunk("c2", 700, 800), "a.md"),
        (chunk("c3", 0, 100), "a.md"),
    ]
    result = score_question(question([label(0, 50)]), ranked, k=5)
    assert result.first_relevant_rank == 3
    assert result.reciprocal_rank == pytest.approx(1 / 3)


def test_nothing_relevant_scores_zero():
    result = score_question(question([label(0, 50)]), [(chunk("c1", 900, 950), "a.md")], k=5)
    assert (result.recall, result.reciprocal_rank, result.hit) == (0.0, 0.0, False)
    assert result.missed  # names the span that was never surfaced


def test_k_truncates_before_scoring():
    ranked = [(chunk(f"c{i}", 900 + i, 910 + i), "a.md") for i in range(4)]
    ranked.append((chunk("hit", 0, 100), "a.md"))
    assert score_question(question([label(0, 50)]), ranked, k=3).hit is False
    assert score_question(question([label(0, 50)]), ranked, k=5).hit is True


def test_recall_counts_labelled_spans_not_chunks():
    """The denominator is the number of labels, so it survives a chunking change."""
    q = question([label(0, 50), label(1000, 1050, doc="b.md")])
    result = score_question(q, [(chunk("c1", 0, 100), "a.md")], k=5)
    assert result.recall == pytest.approx(0.5)
    assert len(result.missed) == 1


def test_precision_is_over_the_returned_window():
    ranked = [(chunk("c1", 0, 100), "a.md"), (chunk("c2", 900, 950), "a.md")]
    assert score_question(question([label(0, 50)]), ranked, k=2).precision == pytest.approx(0.5)


def test_ndcg_matches_hand_computation():
    # One relevant document at rank 2: DCG = 1/log2(3); IDCG (one relevant) = 1/log2(2) = 1.
    ranked = [(chunk("c1", 900, 950), "a.md"), (chunk("c2", 0, 100), "a.md")]
    result = score_question(question([label(0, 50)]), ranked, k=5)
    assert result.ndcg == pytest.approx(1 / math.log2(3))


def test_ndcg_prefers_relevant_results_higher():
    high = score_question(
        question([label(0, 50)]),
        [(chunk("c1", 0, 100), "a.md"), (chunk("c2", 900, 950), "a.md")],
        k=5,
    )
    low = score_question(
        question([label(0, 50)]),
        [(chunk("c2", 900, 950), "a.md"), (chunk("c1", 0, 100), "a.md")],
        k=5,
    )
    assert high.ndcg > low.ndcg
    assert high.recall == low.recall  # recall alone cannot see the difference


def test_unanswerable_question_is_not_scored_on_retrieval():
    result = score_question(question([], unanswerable=True), [(chunk("c1", 0, 100), "a.md")], k=5)
    assert (result.recall, result.hit) == (0.0, False)
    assert result.unanswerable


# ── aggregate ──


def test_aggregate_excludes_unanswerable_from_retrieval_means():
    good = score_question(question([label(0, 50)]), [(chunk("c1", 0, 100), "a.md")], k=5)
    unanswerable = score_question(question([], unanswerable=True), [], k=5)

    agg = aggregate([good, unanswerable], k=5)
    assert agg.n_questions == 2
    assert agg.n_answerable == 1
    # Averaging the unanswerable question in would report 0.5 and mean nothing.
    assert agg.recall == pytest.approx(1.0)


def test_aggregate_reports_refusal_accuracy_separately():
    a = score_question(question([], unanswerable=True), [], k=5)
    b = score_question(question([], unanswerable=True), [], k=5)
    a.refused, b.refused = True, False
    assert aggregate([a, b], k=5).refusal_accuracy == pytest.approx(0.5)


def test_refusal_accuracy_is_none_without_generation():
    agg = aggregate([score_question(question([], unanswerable=True), [], k=5)], k=5)
    assert agg.refusal_accuracy is None


def test_aggregate_breaks_recall_down_by_tag():
    hit = score_question(
        question([label(0, 50)], tags=["lexical"]), [(chunk("c1", 0, 100), "a.md")], k=5
    )
    miss = score_question(
        question([label(0, 50)], tags=["semantic"]), [(chunk("c1", 900, 950), "a.md")], k=5
    )
    by_tag = aggregate([hit, miss], k=5).by_tag
    assert by_tag == {"lexical": pytest.approx(1.0), "semantic": pytest.approx(0.0)}


def test_aggregate_of_nothing_does_not_divide_by_zero():
    agg = aggregate([], k=5)
    assert (agg.recall, agg.mrr, agg.ndcg, agg.n_questions) == (0.0, 0.0, 0.0, 0)
