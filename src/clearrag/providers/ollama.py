"""Ollama providers -- the default path, requiring no credentials.

Ollama serves embedding models as well as chat models, which is why ``torch`` and
``sentence-transformers`` are absent from the default Docker image: one runtime covers
both, and the image stays in the hundreds of megabytes rather than gigabytes.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence

import httpx
import numpy as np

from ..core.types import Message
from .base import EmbedKind, ProviderError, l2_normalise

# Asymmetric embedding prefixes. Getting these wrong is a silent recall loss, not an
# error, which is exactly why they live in a table instead of being scattered in code.
_PREFIXES: dict[str, dict[str, str]] = {
    "nomic-embed-text": {"document": "search_document: ", "query": "search_query: "},
    "mxbai-embed-large": {
        "document": "",
        "query": "Represent this sentence for searching relevant passages: ",
    },
    "bge-m3": {"document": "", "query": ""},
    "embeddinggemma": {
        "document": "title: none | text: ",
        "query": "task: search result | query: ",
    },
}
_DEFAULT_PREFIX = {"document": "", "query": ""}

_NOT_RUNNING = (
    "Cannot reach Ollama at {url}. Start it with `ollama serve`, or set "
    "CLEARRAG_OLLAMA_URL if it is listening elsewhere."
)


def _prefix_for(model: str, kind: EmbedKind) -> str:
    base = model.split(":")[0]
    return _PREFIXES.get(base, _DEFAULT_PREFIX)[kind]


def pulled_models(base_url: str, timeout: float = 5.0) -> set[str] | None:
    """Names Ollama has pulled ("nomic-embed-text:latest"), or None if it cannot be
    reached. Synchronous on purpose: it is asked once, before a sweep starts."""
    try:
        r = httpx.get(f"{base_url.rstrip('/')}/api/tags", timeout=timeout)
        r.raise_for_status()
    except httpx.HTTPError:
        return None
    return {m["name"] for m in r.json().get("models", [])}


class OllamaChat:
    name = "ollama"

    def __init__(
        self,
        base_url: str,
        model: str,
        timeout: float = 300.0,
        think: bool = False,
        num_ctx: int = 8192,
        num_predict: int = 1024,
        keep_alive: str = "30m",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._timeout = timeout
        self.think = think
        """Reasoning models spend output budget thinking before answering.

        Off by default: answering from retrieved context is not a reasoning-limited task,
        and qwen3.5:9b left on its default burned an entire response budget on reasoning
        frames and returned no answer at all -- 3,751 thinking frames, zero content, and
        done_reason "length". Ollama accepts this flag on non-reasoning models too, so
        sending it unconditionally is safe.
        """
        self.num_ctx = num_ctx
        """Context window to allocate, sent explicitly rather than left to the default.

        Ollama's default is 4096 on most builds, which is exactly the pipeline's context
        budget -- so the packed chunks alone fill the window and the system prompt and
        question push it over. llama.cpp then truncates from the front, silently dropping
        the instructions and the retrieved context. That failure looks like a bad model,
        not a misconfigured one, which is why the value is stated here instead of assumed.
        """
        self.num_predict = num_predict
        """Ceiling on answer length. A grounded answer is short; this bounds the case
        where a model decides otherwise and spends minutes proving it."""
        self.keep_alive = keep_alive
        """How long Ollama holds the model in memory after a request. The default is five
        minutes, so a pause between questions costs a full reload of several gigabytes on
        the next one -- which reads as "the app is slow" rather than "the model unloaded".
        """

    async def complete(self, messages: Sequence[Message], *, temperature: float = 0.1) -> str:
        chunks = [c async for c in self.stream(messages, temperature=temperature)]
        return "".join(chunks)

    async def stream(
        self, messages: Sequence[Message], *, temperature: float = 0.1
    ) -> AsyncIterator[str]:
        payload = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
            "think": self.think,
            "keep_alive": self.keep_alive,
            "options": {
                "temperature": temperature,
                "num_ctx": self.num_ctx,
                "num_predict": self.num_predict,
            },
        }
        try:
            async with (
                httpx.AsyncClient(timeout=self._timeout) as client,
                client.stream("POST", f"{self.base_url}/api/chat", json=payload) as r,
            ):
                if r.status_code == 404:
                    raise ProviderError(
                        f"Model '{self.model}' is not available in Ollama.",
                        remedy=f"Run `ollama pull {self.model}`.",
                    )
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    data = json.loads(line)
                    # Reasoning arrives on `thinking`, never `content`. Only content is
                    # answer text; leaking reasoning would corrupt citation markers.
                    if token := data.get("message", {}).get("content"):
                        yield token
                    if data.get("done"):
                        break
        except httpx.ConnectError as exc:
            raise ProviderError(
                _NOT_RUNNING.format(url=self.base_url), remedy="Start Ollama, then retry."
            ) from exc

    async def preload(self) -> None:
        """Load the model into memory before the first question arrives.

        A chat request with no messages makes Ollama load the weights and return, which
        moves the several-second first-load off the first query and onto server startup
        where nobody is waiting on it. Best-effort by design: a failure here costs a slow
        first answer, so it must never prevent the server from starting.

        ``num_ctx`` has to match what queries will send. Ollama allocates the KV cache at
        load time and reloads the model when a later request asks for a different context
        size -- so preloading without it warms the wrong model and the first question pays
        the full load anyway, which is indistinguishable from preloading not working.
        """
        payload = {
            "model": self.model,
            "messages": [],
            "keep_alive": self.keep_alive,
            "options": {"num_ctx": self.num_ctx},
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(f"{self.base_url}/api/chat", json=payload)
                response.raise_for_status()
        except httpx.HTTPError:
            return

    async def healthcheck(self) -> None:
        await _check_model(self.base_url, self.model, self._timeout)


class OllamaEmbeddings:
    name = "ollama"

    def __init__(
        self, base_url: str, model: str, timeout: float = 120.0, keep_alive: str = "30m"
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._timeout = timeout
        self.keep_alive = keep_alive
        self._dims: int | None = None

    @property
    def id(self) -> str:
        return f"ollama:{self.model}"

    @property
    def dimensions(self) -> int:
        if self._dims is None:
            raise RuntimeError("Dimensions unknown until the first embed() call.")
        return self._dims

    async def embed(self, texts: Sequence[str], *, kind: EmbedKind) -> np.ndarray:
        if not texts:
            return np.zeros((0, self._dims or 0), dtype=np.float32)

        prefix = _prefix_for(self.model, kind)
        payload = {
            "model": self.model,
            "input": [f"{prefix}{t}" for t in texts],
            "keep_alive": self.keep_alive,
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                r = await client.post(f"{self.base_url}/api/embed", json=payload)
                if r.status_code == 404:
                    raise ProviderError(
                        f"Embedding model '{self.model}' is not available in Ollama.",
                        remedy=f"Run `ollama pull {self.model}`.",
                    )
                r.raise_for_status()
                vectors = r.json().get("embeddings") or []
        except httpx.ConnectError as exc:
            raise ProviderError(
                _NOT_RUNNING.format(url=self.base_url), remedy="Start Ollama, then retry."
            ) from exc

        if not vectors:
            raise ProviderError(f"Ollama returned no embeddings for model '{self.model}'.")

        arr = l2_normalise(np.asarray(vectors, dtype=np.float32))
        self._dims = int(arr.shape[1])
        return arr

    async def preload(self) -> None:
        """Load the embedding model and learn its dimensionality up front.

        Embedding one token is the cheapest way to do both, and it also settles the
        dimension probe the vector index would otherwise trigger on the first query.
        """
        try:
            await self.embed(["probe"], kind="query")
        except (ProviderError, httpx.HTTPError):
            return

    async def healthcheck(self) -> None:
        await _check_model(self.base_url, self.model, self._timeout)
        if self._dims is None:
            await self.embed(["probe"], kind="query")


async def _check_model(base_url: str, model: str, timeout: float) -> None:
    """Confirm Ollama is up and the model is pulled, with an actionable message if not."""
    try:
        async with httpx.AsyncClient(timeout=min(timeout, 10.0)) as client:
            r = await client.get(f"{base_url}/api/tags")
            r.raise_for_status()
            available = {m["name"] for m in r.json().get("models", [])}
    except httpx.ConnectError as exc:
        raise ProviderError(
            _NOT_RUNNING.format(url=base_url), remedy="Start Ollama, then retry."
        ) from exc
    except httpx.HTTPError as exc:
        raise ProviderError(f"Ollama responded with an error: {exc}") from exc

    # Ollama reports tags as "llama3.2:latest"; users typically write "llama3.2".
    if model not in available and f"{model}:latest" not in available:
        raise ProviderError(
            f"Model '{model}' is not pulled. Available: {', '.join(sorted(available)) or 'none'}.",
            remedy=f"Run `ollama pull {model}`.",
        )


async def pull_model(base_url: str, model: str) -> AsyncIterator[dict]:
    """Stream progress while Ollama pulls a model, so first-run has a progress bar."""
    async with (
        httpx.AsyncClient(timeout=None) as client,
        client.stream(
            "POST", f"{base_url.rstrip('/')}/api/pull", json={"model": model, "stream": True}
        ) as r,
    ):
        r.raise_for_status()
        async for line in r.aiter_lines():
            if line.strip():
                yield json.loads(line)
