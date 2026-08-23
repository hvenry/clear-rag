"""Cross-encoder reranker: protocol behaviour with a stubbed scorer, plus one real
inference test that runs only when the model has already been downloaded."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from clearrag.core.types import Candidate
from clearrag.providers.rerank_onnx import OnnxReranker, available

MODEL_DIR = Path(__file__).resolve().parents[1] / "workspace" / "models" / "ms-marco-minilm-l6"


def cands(n: int) -> list[Candidate]:
    return [Candidate(chunk_id=f"c{i}", score=0.5, rank=i + 1, source="rrf") for i in range(n)]


@pytest.fixture
def stubbed(monkeypatch) -> OnnxReranker:
    """A reranker whose scorer is deterministic arithmetic, no model needed."""
    reranker = OnnxReranker(Path("/nonexistent"))
    monkeypatch.setattr(reranker, "is_downloaded", lambda: True)
    # Score = text length, so ordering is knowable without inference.
    monkeypatch.setattr(
        reranker, "_score", lambda query, texts: np.array([float(len(t)) for t in texts])
    )
    return reranker


async def test_orders_by_score_and_reassigns_ranks(stubbed):
    out = await stubbed.rerank("q", cands(3), ["aa", "aaaa", "a"], top_k=3)
    assert [c.chunk_id for c in out] == ["c1", "c0", "c2"]
    assert [c.rank for c in out] == [1, 2, 3]
    assert all(c.source == "rerank" for c in out)


async def test_top_k_truncates(stubbed):
    out = await stubbed.rerank("q", cands(4), ["a", "aa", "aaa", "aaaa"], top_k=2)
    assert [c.chunk_id for c in out] == ["c3", "c2"]


async def test_records_where_each_candidate_came_from(stubbed):
    out = await stubbed.rerank("q", cands(2), ["a", "aaaa"], top_k=2)
    assert out[0].detail["previous_rank"] == 2, "the winner had been ranked second"


async def test_scores_are_sigmoid_bounded(stubbed):
    out = await stubbed.rerank("q", cands(2), ["a", "aaaa"], top_k=2)
    assert all(0.0 <= c.score <= 1.0 for c in out)


async def test_misaligned_inputs_are_rejected(stubbed):
    with pytest.raises(ValueError, match="candidates but"):
        await stubbed.rerank("q", cands(2), ["only one text"], top_k=2)


async def test_empty_shortlist_is_a_noop(stubbed):
    assert await stubbed.rerank("q", [], [], top_k=5) == []


@pytest.mark.skipif(
    not (available() and (MODEL_DIR / "model.onnx").exists()),
    reason="real model not downloaded",
)
async def test_real_model_prefers_the_relevant_passage():
    reranker = OnnxReranker(MODEL_DIR)
    texts = [
        "Sourdough requires a mature starter and a long cold ferment.",
        "To revert a bad release, run hb deploy --rollback immediately.",
    ]
    out = await reranker.rerank("How do I roll back a release?", cands(2), texts, top_k=2)
    assert out[0].chunk_id == "c1"
    assert out[0].score > 0.9
    assert out[1].score < 0.1
