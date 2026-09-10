"""Committed results files: merge semantics, provenance, rendering and the drift check.

The numbers used to be hand-copied into four places. These tests pin the contract that
replaces that: the tool's output is the source of truth, rows say what measured them,
and anything rendered from them is checked against them.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from clearrag.config import PipelineConfig
from clearrag.eval.metrics import Aggregate
from clearrag.eval.results import (
    PROSE_DOCUMENTS,
    RENDERED_IN,
    RESULTS_DIR,
    apply_to_document,
    find_drift,
    known_values,
    merge_parse_quality,
    merge_results,
    render_table,
    row_identity,
)
from clearrag.eval.runner import EvalRun, ablate, provenance_of
from clearrag.providers.fake import FakeChat, FakeEmbeddings
from tests.conftest import REPO_ROOT


def _aggregate(k: int, recall: float, **tags: float) -> Aggregate:
    return Aggregate(
        k=k,
        n_questions=10,
        n_answerable=9,
        recall=recall,
        precision=0.2,
        mrr=recall,
        ndcg=recall,
        hit_rate=recall,
        by_tag=tags,
    )


def _run(label: str, recall: float, *, generated=False, chat="fake:fake-chat") -> EvalRun:
    return EvalRun(
        label=label,
        config=PipelineConfig(),
        at_k={1: _aggregate(1, recall / 2), 5: _aggregate(5, recall, lexical=recall)},
        generated=generated,
        documents=3,
        provenance={
            "measured_at": "2026-09-08",
            "chat_model": chat,
            "embed_model": "fake:fake-embed:64",
            "reranker": None,
            "source": "measured",
        },
    )


# ── Merge semantics ──


def test_merge_replaces_rows_with_the_same_identity_and_keeps_the_rest():
    first = merge_results(
        None, [_run("a", 0.5), _run("b", 0.6)], suite="retrieval", k=5, order=["a", "b"]
    )
    second = merge_results(first, [_run("a", 0.9)], suite="retrieval", k=5, order=["a", "b"])

    by_label = {row["label"]: row for row in second["rows"]}
    assert by_label["a"]["at_k"]["5"]["recall"] == 0.9
    assert by_label["b"]["at_k"]["5"]["recall"] == 0.6
    assert second["corpus"] == {"documents": 3, "questions": 10, "answerable": 9}


def test_rows_follow_the_variant_order_and_unknown_rows_trail():
    imported = _run("docling parser", 0.4)
    imported.provenance = {**imported.provenance, "source": "imported"}  # type: ignore[dict-item]
    existing = merge_results(None, [imported], suite="sec", k=5, order=[])

    merged = merge_results(
        existing,
        [_run("naive", 0.8), _run("primitives", 0.7)],
        suite="sec",
        k=5,
        order=["naive", "primitives"],
    )
    assert [row["label"] for row in merged["rows"]] == ["naive", "primitives", "docling parser"]


def test_generated_rows_are_distinct_per_chat_model():
    """An answer depends on the model, so two models make two rows; retrieval does not."""
    qwen = _run("512-token chunks", 0.9, generated=True, chat="ollama:qwen3.5:9b")
    llama = _run("512-token chunks", 0.5, generated=True, chat="ollama:llama3.2")
    merged = merge_results(None, [qwen], suite="attribution", k=5, order=["512-token chunks"])
    merged = merge_results(merged, [llama], suite="attribution", k=5, order=["512-token chunks"])
    assert len(merged["rows"]) == 2
    assert {row_identity(r) for r in merged["rows"]} == {
        ("512-token chunks", "ollama:qwen3.5:9b"),
        ("512-token chunks", "ollama:llama3.2"),
    }

    a = _run("x", 0.1, chat="ollama:one")
    b = _run("x", 0.2, chat="ollama:two")
    retrieval = merge_results(
        merge_results(None, [a], suite="retrieval", k=5, order=["x"]),
        [b],
        suite="retrieval",
        k=5,
        order=["x"],
    )
    assert len(retrieval["rows"]) == 1


def test_parse_quality_rows_are_keyed_by_file_and_backend_with_means():
    rows = [
        {
            "file": "a.pdf",
            "backend": "naive",
            "word_recovery": 1.0,
            "order_similarity": 1.0,
            "provenance": {},
        },
        {
            "file": "a.pdf",
            "backend": "primitives",
            "word_recovery": 0.9,
            "order_similarity": 0.8,
            "provenance": {},
        },
    ]
    merged = merge_parse_quality(None, rows)
    again = merge_parse_quality(merged, [{**rows[1], "word_recovery": 0.95}])
    assert [(r["file"], r["backend"]) for r in again["rows"]] == [
        ("a.pdf", "naive"),
        ("a.pdf", "primitives"),
    ]
    assert again["means"]["primitives"]["word_recovery"] == 0.95


# ── Provenance ──


async def test_ablate_stamps_provenance_and_corpus_size_on_every_run(tmp_path):
    runs = await ablate(
        [("default", PipelineConfig(k_candidates=50, k_final=10, rewrite_followups=False))],
        corpus_dir=REPO_ROOT / "evals" / "corpus",
        golden_path=REPO_ROOT / "evals" / "golden.jsonl",
        workspace_root=tmp_path,
        chat_factory=FakeChat,
        embeddings_factory=FakeEmbeddings,
    )
    run = runs[0]
    assert run.documents == 10
    assert run.provenance is not None
    assert run.provenance["chat_model"] == "fake:fake-chat"
    assert run.provenance["embed_model"].startswith("fake:")
    assert run.provenance["reranker"] is None
    assert run.provenance["source"] == "measured"
    assert run.to_dict()["provenance"] == run.provenance


def test_provenance_names_the_reranker_when_present(engine):
    class Named:
        name = "a reranker"

    engine.reranker = Named()
    assert provenance_of(engine, measured_at="2026-01-01")["reranker"] == "a reranker"


# ── Rendering ──


def test_render_table_has_tag_columns_and_marks_imported_rows():
    imported = _run("docling parser", 0.4)
    imported.provenance = {**imported.provenance, "source": "imported", "note": "not installed"}  # type: ignore[dict-item]
    results = merge_results(None, [_run("naive", 0.8), imported], suite="sec", k=5, order=["naive"])
    results["rows"][0]["at_k"]["5"]["by_tag"] = {
        "table": 0.5,
        "structure": 0.6,
        "cross-company": 0.7,
    }

    table = render_table(results)
    header = (
        "| Configuration | recall@1 | recall@5 | MRR | nDCG@5 | table | structure | cross-company |"
    )
    assert table.splitlines()[0] == header
    assert "| **naive** | 0.400 | 0.800 | 0.800 | 0.800 | 0.500 | 0.600 | 0.700 |" in table
    assert "| docling parser † |" in table
    assert "† imported from an earlier measurement" in table
    assert "not installed" in table


def test_apply_to_document_replaces_only_the_marked_region():
    doc = "intro\n<!-- results:retrieval -->\nold table\n<!-- /results:retrieval -->\noutro\n"
    out = apply_to_document(doc, "retrieval", "| new |")
    assert out == "intro\n<!-- results:retrieval -->\n| new |\n<!-- /results:retrieval -->\noutro\n"
    with pytest.raises(ValueError, match="no <!-- results:sec -->"):
        apply_to_document(doc, "sec", "| x |")


# ── Drift check ──


def test_find_drift_flags_numbers_no_results_file_can_vouch_for():
    values = known_values([{"rows": [{"at_k": {"5": {"recall": 0.9275, "by_tag": {"a": 1.0}}}}]}])
    text = (
        "prose says 0.927 and 1.000 and also 0.972\n"
        "<!-- results:retrieval -->\n| 0.111 |\n<!-- /results:retrieval -->\n"
        "<!-- prose-check:off -->\n0.222\n<!-- prose-check:on -->\n"
        "version 1.2345 and 0.50 are not metrics\n"
    )
    assert find_drift(text, values) == [(1, "0.972")]


# ── The committed files, and everything rendered from them ──


RESULTS_FILES = sorted((REPO_ROOT / RESULTS_DIR).glob("*.json"))
RENDERED = {suite: [REPO_ROOT / rel for rel in docs] for suite, docs in RENDERED_IN.items()}
PROSE = [REPO_ROOT / rel for rel in PROSE_DOCUMENTS]


@pytest.mark.parametrize("path", RESULTS_FILES, ids=lambda p: p.stem)
def test_every_committed_row_says_what_measured_it(path: Path):
    results = json.loads(path.read_text())
    for row in results["rows"]:
        provenance = row.get("provenance") or {}
        assert provenance.get("measured_at"), (
            f"{path.name}: {row.get('label', row)} has no measured_at"
        )
        assert provenance.get("source") in ("measured", "imported")


@pytest.mark.parametrize("path", RESULTS_FILES, ids=lambda p: p.stem)
def test_rendered_tables_match_the_committed_results(path: Path):
    """The README tables are generated; a hand edit, or a results file that moved on
    without re-rendering, fails here. Fix with `python scripts/render_results.py`."""
    results = json.loads(path.read_text())
    table = render_table(results)
    for document in RENDERED[results["suite"]]:
        text = document.read_text()
        assert apply_to_document(text, results["suite"], table) == text, (
            f"{document.relative_to(REPO_ROOT)} is out of date for {results['suite']}; "
            "run scripts/render_results.py"
        )


@pytest.mark.skipif(not RESULTS_FILES, reason="no results files committed yet")
def test_prose_numbers_are_ones_the_results_files_can_vouch_for():
    values = known_values(json.loads(p.read_text()) for p in RESULTS_FILES)
    drift = {
        str(document.relative_to(REPO_ROOT)): find_drift(document.read_text(), values)
        for document in PROSE
    }
    stale = {doc: hits for doc, hits in drift.items() if hits}
    assert not stale, f"numbers in prose that no results file vouches for: {stale}"
