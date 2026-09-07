"""What every query stage needs, bundled once.

A query stage is a function of ``(context, inputs) -> (outputs, StageRecord)``.

The context carries the things the engine owns, the experiment configuration, the open
trace, the providers and the indexes - so a stage never reaches back into the engine
and the engine never needs to know how a stage works.

Adding a retrieval technique means adding a module beside the others in this package,
not editing the generator that composes them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..config import PipelineConfig
from ..core.trace import StageRecord, Trace
from ..index.lexical import LexicalIndex
from ..index.store import Store
from ..index.vector import VectorIndex
from ..providers.base import ChatProvider, EmbeddingProvider, Reranker


@dataclass
class QueryContext:
    config: PipelineConfig
    trace: Trace
    chat: ChatProvider
    embeddings: EmbeddingProvider
    reranker: Reranker | None
    store: Store
    lexical: LexicalIndex
    vectors: VectorIndex
    allowed: set[str] | None = None
    """Chunk ids a document filter permits. None searches the whole corpus."""


def stage_event(rec: StageRecord) -> dict[str, Any]:
    """The SSE payload announcing that a stage has finished."""
    return {"type": "stage", "stage": rec.to_dict()}
