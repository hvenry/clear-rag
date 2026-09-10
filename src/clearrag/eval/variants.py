"""The standard ablation sweep.

Each variant isolates one decision so the table reads as an argument rather than a
grid of numbers. The ordering is deliberate: it walks from the 2023-era baseline the
predecessor project implemented up to the current pipeline, so each row answers
"was that change worth it?"
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import NamedTuple

from ..config import PipelineConfig
from ..ingest.parsers import available_backends

BASE = PipelineConfig(k_candidates=50, k_final=10, rewrite_followups=False)


class Variant(NamedTuple):
    """One row of an ablation table: a label, the configuration it measures, and
    optionally the embedding model to measure it with.

    The embedder is deliberately not a ``PipelineConfig`` knob. The config describes
    a query against an index; the embedder *is* the index -- vectors from two models
    are not comparable, and the store refuses to serve a mismatch. So it rides on the
    variant, where the sweep builds a separate index for it, and lands in the row's
    provenance rather than its config hash.
    """

    label: str
    config: PipelineConfig
    embed_model: str | None = None
    """An embedding model for this row, or None for the process default
    (``CLEARRAG_EMBED_MODEL``)."""


#: Embedding models the standard sweep measures beside the default, when they are
#: pulled. One smaller and one larger than nomic-embed-text, so the rows ask whether
#: embedder size is what the numbers are made of: all-minilm is the 384-dimension
#: MiniLM family the predecessor project embedded with; mxbai-embed-large is 1024.
EMBEDDERS = ("all-minilm", "mxbai-embed-large")


def standard_variants(embedders: Sequence[str] = ()) -> list[Variant]:
    """The standard sweep, plus two rows per extra embedding model: dense-only, where
    the embedder is the whole retriever, and hybrid + RRF, which asks whether lexical
    fusion covers for a weaker one. The reranked rows are not repeated, because on this
    corpus the cross-encoder re-scores the whole shortlist and the embedder could not
    show through it."""
    rows: list[tuple[str, PipelineConfig]] = [
        # Where the predecessor project stood: dense-only, top-k, 50% chunk overlap.
        (
            "dense only, 50% overlap (2024 baseline)",
            BASE.model_copy(update={"retrieval": "dense", "chunk_size": 512, "chunk_overlap": 256}),
        ),
        # Same retrieval, sane overlap — isolates the cost of the overlap alone.
        ("dense only", BASE.model_copy(update={"retrieval": "dense"})),
        ("keyword only (BM25)", BASE.model_copy(update={"retrieval": "lexical"})),
        (
            "hybrid + weighted fusion",
            BASE.model_copy(update={"retrieval": "hybrid", "fusion": "weighted"}),
        ),
        ("hybrid + RRF", BASE.model_copy(update={"retrieval": "hybrid", "fusion": "rrf"})),
        # Query expansion where the fused order is the final order. With reranking on
        # (two rows down) the cross-encoder re-scores the whole shortlist, and on a
        # corpus this small the shortlist is the corpus -- so this row, not that one,
        # is where expansion can show.
        (
            "hybrid + RRF + multi-query",
            BASE.model_copy(
                update={"retrieval": "hybrid", "fusion": "rrf", "query_transform": "multi"}
            ),
        ),
        (
            "hybrid + RRF + cross-encoder rerank",
            BASE.model_copy(update={"retrieval": "hybrid", "fusion": "rrf", "rerank": True}),
        ),
        # Query expansion on top of the strongest retrieval row. Costs one generation per
        # question; the `paraphrase`-tagged questions are the ones it exists to help, so
        # that column is where its worth shows -- or fails to.
        (
            "hybrid + RRF + rerank + multi-query",
            BASE.model_copy(
                update={
                    "retrieval": "hybrid",
                    "fusion": "rrf",
                    "rerank": True,
                    "query_transform": "multi",
                }
            ),
        ),
        # Chunk size sweep, holding retrieval fixed at the current best. Small sizes are
        # included because structurally dense documents (a resume, a spec, a settings
        # table) pack several distinct sections into one 512-token chunk, and a small
        # model cannot reliably attribute a claim to the right section inside one.
        (
            "hybrid + RRF, 96-token chunks",
            BASE.model_copy(update={"chunk_size": 96, "chunk_overlap": 12}),
        ),
        # The one index where each search does NOT return the whole corpus, so the
        # candidate set itself can change -- the regime expansion was designed for.
        (
            "hybrid + RRF + multi-query, 96-token chunks",
            BASE.model_copy(
                update={"chunk_size": 96, "chunk_overlap": 12, "query_transform": "multi"}
            ),
        ),
        (
            "hybrid + RRF, 192-token chunks",
            BASE.model_copy(update={"chunk_size": 192, "chunk_overlap": 24}),
        ),
        (
            "hybrid + RRF, 256-token chunks",
            BASE.model_copy(update={"chunk_size": 256, "chunk_overlap": 32}),
        ),
        (
            "hybrid + RRF, 1024-token chunks",
            BASE.model_copy(update={"chunk_size": 1024, "chunk_overlap": 128}),
        ),
    ]
    variants = [Variant(label, config) for label, config in rows]
    for model in embedders:
        variants += [
            Variant(f"dense only, {model}", BASE.model_copy(update={"retrieval": "dense"}), model),
            Variant(
                f"hybrid + RRF, {model}",
                BASE.model_copy(update={"retrieval": "hybrid", "fusion": "rrf"}),
                model,
            ),
        ]
    return variants


def attribution_variants() -> list[Variant]:
    """The attribution suite varies chunk size only. The other variable, the chat
    model, is a process setting: run the sweep once per model and the results file
    keeps one row per (chunk size, model), because generated answers depend on the
    model and the row's provenance says which one wrote them."""
    return [
        Variant("512-token chunks", BASE),
        Variant(
            "192-token chunks", BASE.model_copy(update={"chunk_size": 192, "chunk_overlap": 24})
        ),
    ]


#: The strongest retrieval configuration the standard sweep found; the sec sweep holds
#: it fixed and varies the Phase 4 knobs one at a time.
_SEC_BASE = BASE.model_copy(update={"retrieval": "hybrid", "fusion": "rrf", "rerank": True})


def sec_variants() -> tuple[list[Variant], list[str]]:
    """The Phase 4 sweep: parser × chunker × context, one dimension at a time.

    Returns ``(variants, skipped_backends)`` — heavyweight parser backends that are
    not installed are omitted rather than crashing the sweep, and named so the CLI
    can say how to add them.
    """
    backends = available_backends()
    skipped = [name for name in ("docling", "marker") if not backends.get(name)]

    rows: list[tuple[str, PipelineConfig]] = [
        # Parser sweep: what does parsing quality alone do to retrieval?
        ("naive parser", _SEC_BASE.model_copy(update={"parser": "naive"})),
        ("primitives parser", _SEC_BASE.model_copy(update={"parser": "primitives"})),
    ]
    for name in ("docling", "marker"):
        if backends.get(name):
            rows.append((f"{name} parser", _SEC_BASE.model_copy(update={"parser": name})))

    rows += [
        # Chunker sweep at the primitives parser.
        (
            "primitives + semantic chunking",
            _SEC_BASE.model_copy(update={"parser": "primitives", "chunker": "semantic"}),
        ),
        # Context sweep (recursive chunking, primitives parser). "none" is the
        # "primitives parser" row above.
        (
            "primitives + breadcrumb context",
            _SEC_BASE.model_copy(update={"parser": "primitives", "context_mode": "breadcrumb"}),
        ),
        (
            "primitives + LLM context",
            _SEC_BASE.model_copy(update={"parser": "primitives", "context_mode": "llm"}),
        ),
        # The headline row: everything Phase 4 built, together.
        (
            "primitives + semantic + breadcrumb",
            _SEC_BASE.model_copy(
                update={
                    "parser": "primitives",
                    "chunker": "semantic",
                    "context_mode": "breadcrumb",
                }
            ),
        ),
    ]
    return [Variant(label, config) for label, config in rows], skipped
