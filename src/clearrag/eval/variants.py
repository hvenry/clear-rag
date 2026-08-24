"""The standard ablation sweep.

Each variant isolates one decision so the table reads as an argument rather than a
grid of numbers. The ordering is deliberate: it walks from the 2023-era baseline the
predecessor project implemented up to the current pipeline, so each row answers
"was that change worth it?"
"""

from __future__ import annotations

from ..config import PipelineConfig
from ..ingest.parsers import available_backends

BASE = PipelineConfig(k_candidates=50, k_final=10, rewrite_followups=False)


def standard_variants() -> list[tuple[str, PipelineConfig]]:
    return [
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
        (
            "hybrid + RRF + cross-encoder rerank",
            BASE.model_copy(update={"retrieval": "hybrid", "fusion": "rrf", "rerank": True}),
        ),
        # Chunk size sweep, holding retrieval fixed at the current best. Small sizes are
        # included because structurally dense documents (a resume, a spec, a settings
        # table) pack several distinct sections into one 512-token chunk, and a small
        # model cannot reliably attribute a claim to the right section inside one.
        (
            "hybrid + RRF, 96-token chunks",
            BASE.model_copy(update={"chunk_size": 96, "chunk_overlap": 12}),
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


#: The strongest retrieval configuration the standard sweep found; the sec sweep holds
#: it fixed and varies the Phase 4 knobs one at a time.
_SEC_BASE = BASE.model_copy(update={"retrieval": "hybrid", "fusion": "rrf", "rerank": True})


def sec_variants() -> tuple[list[tuple[str, PipelineConfig]], list[str]]:
    """The Phase 4 sweep: parser × chunker × context, one dimension at a time.

    Returns ``(variants, skipped_backends)`` — heavyweight parser backends that are
    not installed are omitted rather than crashing the sweep, and named so the CLI
    can say how to add them.
    """
    backends = available_backends()
    skipped = [name for name in ("docling", "marker") if not backends.get(name)]

    variants: list[tuple[str, PipelineConfig]] = [
        # Parser sweep: what does parsing quality alone do to retrieval?
        ("naive parser", _SEC_BASE.model_copy(update={"parser": "naive"})),
        ("primitives parser", _SEC_BASE.model_copy(update={"parser": "primitives"})),
    ]
    for name in ("docling", "marker"):
        if backends.get(name):
            variants.append((f"{name} parser", _SEC_BASE.model_copy(update={"parser": name})))

    variants += [
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
    return variants, skipped
