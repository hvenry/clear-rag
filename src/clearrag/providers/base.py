"""Provider protocols.

Three protocols rather than one, because generation, embedding and reranking are
genuinely independent choices: it is entirely reasonable to generate with Claude while
embedding locally with Ollama.

Two signatures here are load-bearing:

``embed(..., kind=...)`` -- every modern embedding model (nomic, bge, e5, Qwen3) is
asymmetric and expects different prefixes for queries and passages. Encoding both the
same way silently costs recall, and it is exactly the mistake the predecessor project
made. Putting ``kind`` in the signature makes it unrepresentable.

``EmbeddingProvider.id`` -- changing embedding model invalidates every stored vector.
The id is written next to the index so a mismatch can refuse to serve queries instead of
quietly returning noise.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import Literal, Protocol, runtime_checkable

import numpy as np

from ..core.types import Candidate, Message

EmbedKind = Literal["document", "query"]


class ProviderError(RuntimeError):
    """Raised when a provider is unreachable or rejects a request.

    Carries a human-readable remedy so the UI can show a next step rather than a stack
    trace -- "Ollama isn't running, start it with `ollama serve`" beats ConnectionError.
    """

    def __init__(self, message: str, *, remedy: str | None = None) -> None:
        super().__init__(message)
        self.remedy = remedy


@runtime_checkable
class ChatProvider(Protocol):
    name: str
    model: str

    async def complete(self, messages: Sequence[Message], *, temperature: float = 0.1) -> str:
        """Return a full completion."""
        ...

    def stream(
        self, messages: Sequence[Message], *, temperature: float = 0.1
    ) -> AsyncIterator[str]:
        """Yield completion text incrementally."""
        ...

    async def healthcheck(self) -> None:
        """Raise ProviderError if this provider is not usable right now."""
        ...


@runtime_checkable
class EmbeddingProvider(Protocol):
    name: str
    model: str

    @property
    def id(self) -> str:
        """Stable identity of the embedding space, e.g. 'ollama:nomic-embed-text'."""
        ...

    @property
    def dimensions(self) -> int: ...

    async def embed(self, texts: Sequence[str], *, kind: EmbedKind) -> np.ndarray:
        """Return an ``(len(texts), dimensions)`` float32 array of L2-normalised vectors."""
        ...

    async def healthcheck(self) -> None: ...


@runtime_checkable
class Reranker(Protocol):
    name: str

    async def rerank(
        self, query: str, candidates: Sequence[Candidate], texts: Sequence[str], *, top_k: int
    ) -> list[Candidate]:
        """Re-score candidates against the query and return the top_k, re-ranked."""
        ...


def l2_normalise(vectors: np.ndarray) -> np.ndarray:
    """Normalise rows to unit length so inner product equals cosine similarity.

    Normalising *both* sides is what the predecessor project got wrong: it normalised
    documents by hand and left query vectors raw, which left the reported similarity
    scores meaningless even though the ranking happened to survive.
    """
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.ndim == 1:
        vectors = vectors.reshape(1, -1)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return np.ascontiguousarray(vectors / norms, dtype=np.float32)
