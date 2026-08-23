"""Retrieval regression gate.

Runs the full golden set through the real pipeline on fake providers and compares the
scores against a committed baseline.

The fake embedder is a bag-of-words hash projection, so these numbers are **not** a
measure of retrieval quality -- the real ones come from `clear-rag ablate` against
Ollama. What this catches is a change that quietly breaks chunking, BM25, fusion or
assembly: those show up as a score drop here, deterministically, in CI, with no models
installed and no GPU.

If this fails, the question is what changed in retrieval -- not whether to refresh the
baseline.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from clearrag.config import PipelineConfig
from clearrag.eval.runner import ablate
from clearrag.providers.fake import FakeChat, FakeEmbeddings

ROOT = Path(__file__).resolve().parents[1]
BASELINE_PATH = ROOT / "evals" / "baseline.json"

#: Scores are deterministic, so any tolerance at all is generosity. This allows a
#: rounding-level wobble while still catching a real regression.
TOLERANCE = 0.02


@pytest.fixture(scope="module")
def baseline() -> dict:
    return json.loads(BASELINE_PATH.read_text())


@pytest.fixture(scope="module")
def actual() -> dict:
    import asyncio

    config = PipelineConfig(k_candidates=50, k_final=10, rewrite_followups=False)
    with tempfile.TemporaryDirectory() as tmp:
        runs = asyncio.run(
            ablate(
                [("default", config)],
                corpus_dir=ROOT / "evals" / "corpus",
                golden_path=ROOT / "evals" / "golden.jsonl",
                workspace_root=Path(tmp),
                chat_factory=FakeChat,
                embeddings_factory=FakeEmbeddings,
            )
        )
    return {str(k): agg.to_dict() for k, agg in sorted(runs[0].at_k.items())}


def test_baseline_matches_the_current_config(baseline):
    """A stale baseline measures a configuration nobody runs any more."""
    config = PipelineConfig(k_candidates=50, k_final=10, rewrite_followups=False)
    assert baseline["config_hash"] == config.config_hash, (
        "The default pipeline configuration changed since the baseline was recorded. "
        "Re-run scripts/refresh_baseline.py and review the diff."
    )


def test_golden_set_has_not_shrunk(baseline, actual):
    assert actual["5"]["n_questions"] == baseline["n_questions"], (
        "The golden set changed size, so the baseline is not comparable. "
        "Re-run scripts/refresh_baseline.py."
    )


@pytest.mark.parametrize("k", ["1", "3", "5", "10"])
@pytest.mark.parametrize("metric", ["recall", "mrr", "ndcg", "hit_rate"])
def test_no_retrieval_regression(baseline, actual, k: str, metric: str):
    expected = baseline["at_k"][k][metric]
    observed = actual[k][metric]
    assert observed >= expected - TOLERANCE, (
        f"{metric}@{k} fell from {expected:.4f} to {observed:.4f}. "
        "Something in chunking, BM25, fusion or assembly changed for the worse."
    )


def test_scores_are_deterministic(actual):
    """Same corpus, same config, same code — the harness must not be flaky."""
    import asyncio

    config = PipelineConfig(k_candidates=50, k_final=10, rewrite_followups=False)
    with tempfile.TemporaryDirectory() as tmp:
        runs = asyncio.run(
            ablate(
                [("default", config)],
                corpus_dir=ROOT / "evals" / "corpus",
                golden_path=ROOT / "evals" / "golden.jsonl",
                workspace_root=Path(tmp),
                chat_factory=FakeChat,
                embeddings_factory=FakeEmbeddings,
            )
        )
    assert runs[0].at_k[5].to_dict() == actual["5"]
