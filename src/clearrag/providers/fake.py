"""Deterministic fake providers.

This is the single piece of infrastructure that makes the project testable. Most RAG
codebases have no tests because every path appears to require a running model; with a
hash-based embedder and a scripted chat model the whole pipeline runs in milliseconds
with nothing installed.

The embedder is not random: it is a bag-of-words hash projection, so texts sharing
vocabulary genuinely land near each other. That means retrieval tests assert real ranking
behaviour rather than merely asserting that the plumbing connects.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import AsyncIterator, Sequence

import numpy as np

from ..core.types import Message
from .base import EmbedKind, l2_normalise

_WORD = re.compile(r"[a-z0-9]+")


class FakeEmbeddings:
    name = "fake"

    def __init__(self, model: str | None = None, dimensions: int = 64) -> None:
        # Any name is accepted, so a sweep can name "embedders" and get distinct
        # indexes and provenance out of one bag-of-words function.
        self.model = model or "fake-embed"
        self._dims = dimensions

    @property
    def id(self) -> str:
        return f"fake:{self.model}:{self._dims}"

    @property
    def dimensions(self) -> int:
        return self._dims

    async def embed(self, texts: Sequence[str], *, kind: EmbedKind) -> np.ndarray:
        del kind  # deliberately symmetric so tests are not sensitive to prefixes
        if not texts:
            return np.zeros((0, self._dims), dtype=np.float32)
        rows = np.zeros((len(texts), self._dims), dtype=np.float32)
        for i, text in enumerate(texts):
            for word in _WORD.findall(text.lower()):
                digest = hashlib.blake2b(word.encode(), digest_size=8).digest()
                slot = int.from_bytes(digest[:4], "big") % self._dims
                sign = 1.0 if digest[4] % 2 == 0 else -1.0
                rows[i, slot] += sign
        return l2_normalise(rows)

    async def healthcheck(self) -> None:
        return None


class FakeChat:
    """Chat model that replays scripted responses, then falls back to echoing context."""

    name = "fake"

    def __init__(self, model: str = "fake-chat", script: Sequence[str] | None = None) -> None:
        self.model = model
        self._script = list(script or [])
        self.calls: list[list[Message]] = []
        """Every message list this provider was asked to complete, for assertions."""

    async def complete(self, messages: Sequence[Message], *, temperature: float = 0.1) -> str:
        return "".join([c async for c in self.stream(messages, temperature=temperature)])

    async def stream(
        self, messages: Sequence[Message], *, temperature: float = 0.1
    ) -> AsyncIterator[str]:
        del temperature
        self.calls.append(list(messages))
        reply = self._script.pop(0) if self._script else "Based on the context, [1] applies."
        for word in reply.split(" "):
            yield word + " "

    async def healthcheck(self) -> None:
        return None
