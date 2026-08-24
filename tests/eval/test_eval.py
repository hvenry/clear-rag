"""Golden-set loading and the end-to-end evaluation harness."""

from __future__ import annotations

from pathlib import Path

import pytest

from clearrag.config import PipelineConfig
from clearrag.eval.golden import GoldenSetError, load_corpus, load_golden, resolve_quote
from clearrag.eval.runner import ablate, evaluate, markdown_table
from clearrag.providers.fake import FakeChat, FakeEmbeddings
from tests.conftest import REPO_ROOT

DOC = (
    "Harbour runs in two regions.\n"
    "Rollbacks use `hb deploy --rollback` to revert.\n"
    "Secrets live in Vault."
)


# ── Quote resolution ──


def test_resolves_a_quote_to_a_span():
    start, end = resolve_quote(DOC, "Secrets live in Vault")
    assert DOC[start:end] == "Secrets live in Vault"


def test_tolerates_a_line_wrap_inside_the_quote():
    """Markdown wraps at a column; a label written with a space must still match."""
    text = "the retention window is\nthirty-five days"
    start, end = resolve_quote(text, "retention window is thirty-five days")
    assert text[start:end] == "retention window is\nthirty-five days"


def test_missing_quote_is_an_error():
    with pytest.raises(GoldenSetError, match="not found"):
        resolve_quote(DOC, "this sentence does not appear")


def test_ambiguous_quote_is_an_error():
    """An ambiguous label is worse than no label, so it fails loudly."""
    with pytest.raises(GoldenSetError, match="ambiguous"):
        resolve_quote("alpha beta alpha", "alpha")


# ── Golden set loading ──


def write_golden(tmp_path: Path, *rows: str) -> Path:
    path = tmp_path / "golden.jsonl"
    path.write_text("\n".join(rows) + "\n")
    return path


def test_loads_and_resolves(tmp_path):
    path = write_golden(
        tmp_path,
        '{"id":"q1","question":"Where do secrets live?",'
        '"relevant":[{"doc":"a.md","quote":"Secrets live in Vault"}],"tags":["lexical"]}',
    )
    questions = load_golden(path, {"a.md": DOC})
    assert len(questions) == 1
    assert questions[0].relevant[0].span == resolve_quote(DOC, "Secrets live in Vault")
    assert questions[0].docs == {"a.md"}


def test_unknown_document_is_an_error(tmp_path):
    path = write_golden(
        tmp_path,
        '{"id":"q1","question":"?","relevant":[{"doc":"missing.md","quote":"x"}]}',
    )
    with pytest.raises(GoldenSetError, match="no document named"):
        load_golden(path, {"a.md": DOC})


def test_unanswerable_question_may_not_carry_spans(tmp_path):
    path = write_golden(
        tmp_path,
        '{"id":"q1","question":"?","unanswerable":true,'
        '"relevant":[{"doc":"a.md","quote":"Secrets live in Vault"}]}',
    )
    with pytest.raises(GoldenSetError, match="unanswerable but carries relevant spans"):
        load_golden(path, {"a.md": DOC})


def test_answerable_question_needs_at_least_one_span(tmp_path):
    path = write_golden(tmp_path, '{"id":"q1","question":"?","relevant":[]}')
    with pytest.raises(GoldenSetError, match="no relevant spans"):
        load_golden(path, {"a.md": DOC})


def test_duplicate_ids_are_an_error(tmp_path):
    row = '{"id":"q1","question":"?","relevant":[{"doc":"a.md","quote":"Secrets live in Vault"}]}'
    with pytest.raises(GoldenSetError, match="duplicate question id"):
        load_golden(write_golden(tmp_path, row, row), {"a.md": DOC})


# ── The shipped golden set ──


def test_shipped_golden_set_resolves_against_its_corpus():
    """Guards the corpus and labels against drifting apart."""
    root = REPO_ROOT / "evals"
    raw = load_corpus(root / "corpus")
    questions = load_golden(root / "golden.jsonl", {n: text for n, (text, _) in raw.items()})

    assert len(questions) >= 40, "golden set should be large enough to discriminate"
    assert any(q.unanswerable for q in questions), "needs unanswerable questions for refusal"
    assert any(len(q.relevant) > 1 for q in questions), "needs a multi-span question"


# ── End to end ──


@pytest.fixture
def mini_corpus(tmp_path) -> Path:
    corpus = tmp_path / "corpus"
    corpus.mkdir()
    (corpus / "regions.md").write_text(
        "Harbour runs in two regions, eu-west-1 and us-east-1.\n\n"
        "Regions are fully isolated with no cross-region replication of tenant data.\n"
    )
    (corpus / "deploy.md").write_text(
        "Promote a build with the deploy command and a commit sha.\n\n"
        "A canary sends five percent of traffic to the new build before promotion.\n"
    )
    return corpus


@pytest.fixture
def mini_golden(tmp_path) -> Path:
    return write_golden(
        tmp_path,
        '{"id":"q_regions","question":"Is tenant data replicated across regions?",'
        '"relevant":[{"doc":"regions.md","quote":"no cross-region replication"}],'
        '"must_mention":["no"],"tags":["semantic"]}',
        '{"id":"q_canary","question":"How much traffic goes to a canary?",'
        '"relevant":[{"doc":"deploy.md","quote":"five percent of traffic"}],'
        '"must_mention":["five percent"],"tags":["lexical"]}',
        '{"id":"q_unans","question":"What is the vacation policy?","relevant":[],'
        '"unanswerable":true,"tags":["unanswerable"]}',
    )


async def test_evaluate_scores_a_real_engine(loaded_engine, tmp_path):
    """The harness runs against a live engine, not a mocked ranking."""
    from clearrag.eval.golden import GoldenQuestion, RelevantSpan

    document = loaded_engine.store.list_documents()[0]
    full = loaded_engine.store.get_document(document["id"])
    span = resolve_quote(full.text, full.text.split("\n\n")[0][:40])

    question = GoldenQuestion(
        id="q1",
        question=full.text.split("\n\n")[0][:40],
        relevant=[RelevantSpan(doc=document["filename"], quote="q", span=span)],
    )
    run = await evaluate(loaded_engine, [question], ks=(1, 5), label="test")

    assert set(run.at_k) == {1, 5}
    assert run.at_k[5].n_answerable == 1
    assert run.at_k[5].recall == 1.0, "asking a document's own text should retrieve it"


async def test_ablation_compares_configurations(tmp_path, mini_corpus, mini_golden):
    variants = [
        ("dense", PipelineConfig(retrieval="dense", chunk_size=128, chunk_overlap=16, k_final=5)),
        (
            "lexical",
            PipelineConfig(retrieval="lexical", chunk_size=128, chunk_overlap=16, k_final=5),
        ),
        ("hybrid", PipelineConfig(retrieval="hybrid", chunk_size=128, chunk_overlap=16, k_final=5)),
    ]
    runs = await ablate(
        variants,
        corpus_dir=mini_corpus,
        golden_path=mini_golden,
        workspace_root=tmp_path / "ws",
        chat_factory=FakeChat,
        embeddings_factory=FakeEmbeddings,
    )

    assert [r.label for r in runs] == ["dense", "lexical", "hybrid"], "caller ordering preserved"
    assert all(r.at_k[5].n_answerable == 2 for r in runs)
    assert all(r.config.config_hash != runs[0].config.config_hash for r in runs[1:])


async def test_ablation_reuses_the_index_across_matching_ingest_settings(
    tmp_path, mini_corpus, mini_golden
):
    """Configurations differing only in query settings must not re-embed the corpus."""
    variants = [
        ("dense", PipelineConfig(retrieval="dense", chunk_size=128, chunk_overlap=16)),
        ("hybrid", PipelineConfig(retrieval="hybrid", chunk_size=128, chunk_overlap=16)),
        ("small chunks", PipelineConfig(retrieval="hybrid", chunk_size=64, chunk_overlap=8)),
    ]
    workspace = tmp_path / "ws"
    await ablate(
        variants,
        corpus_dir=mini_corpus,
        golden_path=mini_golden,
        workspace_root=workspace,
        chat_factory=FakeChat,
        embeddings_factory=FakeEmbeddings,
    )

    # Two distinct chunk configurations, so exactly two indexes -- not three.
    assert len(list(workspace.iterdir())) == 2


async def test_generation_enables_answer_side_metrics(tmp_path, mini_corpus, mini_golden):
    chat = FakeChat(script=["five percent [1]", "no [1]", "I don't have that information."])
    runs = await ablate(
        [("gen", PipelineConfig(chunk_size=128, chunk_overlap=16, k_final=5))],
        corpus_dir=mini_corpus,
        golden_path=mini_golden,
        workspace_root=tmp_path / "ws",
        chat_factory=lambda: chat,
        embeddings_factory=FakeEmbeddings,
        generate=True,
    )
    agg = runs[0].at_k[5]
    assert agg.refusal_accuracy is not None
    assert agg.mention_accuracy is not None


def test_markdown_table_marks_the_best_row():
    from clearrag.eval.metrics import Aggregate
    from clearrag.eval.runner import EvalRun

    def run(label: str, recall: float) -> EvalRun:
        agg = Aggregate(
            k=5,
            n_questions=3,
            n_answerable=2,
            recall=recall,
            precision=0.4,
            mrr=recall,
            ndcg=recall,
            hit_rate=recall,
        )
        return EvalRun(label=label, config=PipelineConfig(), at_k={1: agg, 5: agg})

    table = markdown_table([run("worse", 0.5), run("better", 0.9)], k=5)
    assert "**better**" in table
    assert "**worse**" not in table
    assert "recall@1" in table and "recall@5" in table


def test_markdown_table_handles_no_runs():
    assert "No runs" in markdown_table([])


def test_shipped_attribution_suite_resolves_against_its_corpus():
    root = REPO_ROOT / "evals" / "attribution"
    raw = load_corpus(root / "corpus")
    questions = load_golden(root / "golden.jsonl", {n: text for n, (text, _) in raw.items()})

    assert len(questions) >= 12
    assert any(q.unanswerable for q in questions)
    assert sum(1 for q in questions if q.must_not_mention) >= 8, (
        "must_not_mention labels are what make this an attribution suite"
    )
    # Single document by design: retrieval is trivially perfect, so every failure the
    # suite reports is a generation failure.
    assert len(raw) == 1
