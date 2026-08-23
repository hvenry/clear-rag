"""The standard ablation sweep.

Each variant isolates one decision so the table reads as an argument rather than a
grid of numbers. The ordering is deliberate: it walks from the 2023-era baseline the
predecessor project implemented up to the current pipeline, so each row answers
"was that change worth it?"
"""

from __future__ import annotations

from ..config import PipelineConfig

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
