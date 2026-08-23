"""Running the golden set, and sweeping configurations to produce an ablation table.

The ablation table is the artifact this whole subsystem exists to produce. "I built a
RAG pipeline" is not a claim anyone can check; "hybrid retrieval lifted recall@5 from
0.71 to 0.94 on a 26-question golden set" is.

One subtlety drives the structure here: configurations that differ in *ingestion*
settings need a different index, so the corpus must be re-ingested for them. Runs are
therefore grouped by their ingestion signature and share a workspace where they can,
because embedding the corpus is by far the slowest step in a sweep.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import PipelineConfig, Settings
from ..core.types import Chunk
from ..pipeline import Engine
from ..providers.base import ChatProvider, EmbeddingProvider, Reranker
from .golden import GoldenQuestion, load_corpus, load_golden
from .metrics import Aggregate, QuestionResult, aggregate, score_answer, score_question

DEFAULT_KS = (1, 3, 5, 10)

#: Stages whose output is a retrieval ranking. Assembly is excluded deliberately: it
#: drops chunks for token budget and span overlap, which are packing concerns rather
#: than retrieval quality, and scoring them together would conflate the two.
_RANKING_STAGES = ("rerank", "fuse", "dense", "bm25")


@dataclass
class EvalRun:
    label: str
    config: PipelineConfig
    at_k: dict[int, Aggregate]
    results: list[QuestionResult] = field(default_factory=list)
    ingest_ms: float = 0.0
    query_ms: float = 0.0
    generated: bool = False

    @property
    def primary(self) -> Aggregate:
        return self.at_k[max(self.at_k)] if 5 not in self.at_k else self.at_k[5]

    def to_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "config_hash": self.config.config_hash,
            "config": self.config.model_dump(),
            "generated": self.generated,
            "ingest_ms": round(self.ingest_ms, 1),
            "query_ms": round(self.query_ms, 1),
            "at_k": {str(k): a.to_dict() for k, a in sorted(self.at_k.items())},
            "questions": [
                {
                    "id": r.id,
                    "tags": r.tags,
                    "recall": round(r.recall, 4),
                    "first_relevant_rank": r.first_relevant_rank,
                    "missed": r.missed,
                    "refused": r.refused,
                    "mentioned": r.mentioned,
                    "confused": r.confused,
                    "grounded": r.grounded,
                }
                for r in self.results
            ],
        }


async def evaluate(
    engine: Engine,
    questions: Sequence[GoldenQuestion],
    *,
    ks: Sequence[int] = DEFAULT_KS,
    generate: bool = False,
    label: str = "run",
) -> EvalRun:
    """Run every golden question against an engine whose corpus is already indexed."""
    filenames = {doc["id"]: doc["filename"] for doc in engine.store.list_documents()}
    per_k: dict[int, list[QuestionResult]] = {k: [] for k in ks}
    started = time.perf_counter()

    for question in questions:
        ranking: list[str] = []
        answer: str | None = None
        cited: list[dict] = []

        async for event in engine.query(question.question, generate=generate):
            if event["type"] == "done":
                ranking = _final_ranking(event["trace"])
                answer = event["trace"].get("answer")
                cited = event["trace"].get("citations") or []
            elif event["type"] == "error":
                # A failed question scores zero rather than aborting the sweep; the
                # per-question breakdown records which ones failed.
                ranking, answer = [], None
                break

        chunks = engine.store.get_chunks(ranking)
        ranked: list[tuple[Chunk, str]] = [
            (chunks[cid], filenames.get(chunks[cid].doc_id, "?"))
            for cid in ranking
            if cid in chunks
        ]

        for k in ks:
            result = score_question(question, ranked, k=k)
            if generate and answer is not None:
                score_answer(result, question, answer, cited)
            per_k[k].append(result)

    elapsed = (time.perf_counter() - started) * 1000
    primary_k = 5 if 5 in per_k else max(per_k)
    return EvalRun(
        label=label,
        config=engine.config,
        at_k={k: aggregate(results, k=k) for k, results in per_k.items()},
        results=per_k[primary_k],
        query_ms=elapsed,
        generated=generate,
    )


def _final_ranking(trace: dict[str, Any]) -> list[str]:
    """Chunk ids from the last stage that produced a retrieval ranking."""
    stages = {s["name"]: s for s in trace.get("stages", [])}
    for name in _RANKING_STAGES:
        stage = stages.get(name)
        if stage and stage.get("candidates_out"):
            return [c["chunk_id"] for c in stage["candidates_out"]]
    return []


# ── Ablation sweep ──────────────────────────────────────────────────────────────

#: Settings that change the index rather than the query. Runs agreeing on all of these
#: can share an ingested workspace.
_INGEST_KEYS = ("chunker", "chunk_size", "chunk_overlap", "contextualize")


def _ingest_signature(config: PipelineConfig) -> str:
    return "-".join(str(getattr(config, key)) for key in _INGEST_KEYS)


async def ablate(
    variants: Sequence[tuple[str, PipelineConfig]],
    *,
    corpus_dir: Path,
    golden_path: Path,
    workspace_root: Path,
    chat_factory: Callable[[], ChatProvider],
    embeddings_factory: Callable[[], EmbeddingProvider],
    reranker_factory: Callable[[], Reranker | None] | None = None,
    ks: Sequence[int] = DEFAULT_KS,
    generate: bool = False,
    on_progress: Callable[[str], None] | None = None,
) -> list[EvalRun]:
    """Evaluate each named configuration, re-indexing only when ingestion settings change."""
    raw_corpus = load_corpus(corpus_dir)
    questions = load_golden(golden_path, {name: text for name, (text, _) in raw_corpus.items()})

    # Group by ingestion signature so the expensive embedding step is paid once per
    # distinct index rather than once per variant.
    groups: dict[str, list[tuple[str, PipelineConfig]]] = {}
    for label, config in variants:
        groups.setdefault(_ingest_signature(config), []).append((label, config))

    runs: list[EvalRun] = []
    for signature, members in groups.items():
        workspace = workspace_root / f"idx-{signature}"
        settings = Settings(workspace=workspace)
        engine = Engine(
            settings,
            members[0][1],
            chat_factory(),
            embeddings_factory(),
            reranker=reranker_factory() if reranker_factory else None,
        )

        ingest_started = time.perf_counter()
        if engine.store.count_chunks() == 0:
            for filename, (_, data) in raw_corpus.items():
                await engine.ingest(filename, data)
        ingest_ms = (time.perf_counter() - ingest_started) * 1000

        for label, config in members:
            if on_progress:
                on_progress(label)
            engine.config = config
            run = await evaluate(engine, questions, ks=ks, generate=generate, label=label)
            run.ingest_ms = ingest_ms
            runs.append(run)

        engine.store.close()

    # Restore the caller's ordering; grouping is an implementation detail.
    order = {label: i for i, (label, _) in enumerate(variants)}
    return sorted(runs, key=lambda r: order[r.label])


# ── Reporting ───────────────────────────────────────────────────────────────────


def markdown_table(runs: Sequence[EvalRun], *, k: int = 5) -> str:
    """Render an ablation table ready to paste into the README.

    recall@1 sits beside recall@k on purpose. On a small corpus recall@5 saturates at
    1.0 for every configuration and stops telling you anything, while recall@1 and MRR
    still separate a pipeline that puts the answer first from one that merely puts it
    somewhere in the window. A table whose columns cannot distinguish its rows is worse
    than no table, because it looks like evidence.
    """
    if not runs:
        return "_No runs._"

    columns = f"| Configuration | recall@1 | recall@{k} | MRR | nDCG@{k} |"
    columns += " lexical | semantic | distractor |"
    header = columns + "\n|---|---|---|---|---|---|---|---|"

    def rank_key(run: EvalRun) -> tuple[float, float]:
        agg = run.at_k.get(k)
        return (agg.recall, agg.ndcg) if agg else (0.0, 0.0)

    best = max((rank_key(run) for run in runs), default=(0.0, 0.0))

    rows = []
    for run in runs:
        agg = run.at_k.get(k)
        if agg is None:
            continue
        at_one = run.at_k.get(1)
        name = f"**{run.label}**" if rank_key(run) == best else run.label
        rows.append(
            f"| {name} | {fmt(at_one.recall if at_one else None)} | {agg.recall:.3f} | "
            f"{agg.mrr:.3f} | {agg.ndcg:.3f} | {agg.by_tag.get('lexical', 0):.3f} | "
            f"{agg.by_tag.get('semantic', 0):.3f} | {agg.by_tag.get('distractor', 0):.3f} |"
        )

    generated = [r for r in runs if r.generated]
    footer = ""
    if generated:
        footer = "\n\n" + "\n".join(
            f"- {r.label}: refusal accuracy {fmt(r.at_k[k].refusal_accuracy)}, "
            f"required-mention accuracy {fmt(r.at_k[k].mention_accuracy)}"
            for r in generated
            if k in r.at_k
        )

    return "\n".join([header, *rows]) + footer


def fmt(value: float | None) -> str:
    return "—" if value is None else f"{value:.3f}"


def write_report(runs: Sequence[EvalRun], path: Path, *, k: int = 5) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"k": k, "runs": [run.to_dict() for run in runs]}, indent=2) + "\n")
