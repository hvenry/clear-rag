"""OpenAI-compatible chat and embedding providers (bring your own key).

Raw httpx rather than the ``openai`` SDK, because the chat-completions and embeddings
shapes are small and stable, and because ``base_url`` makes this one class work against
every OpenAI-compatible endpoint -- Together, Groq, OpenRouter, vLLM, LM Studio -- without
another dependency in the image.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence

import httpx
import numpy as np

from ..core.types import Message
from .base import EmbedKind, ProviderError, l2_normalise


def _raise_for(status: int, body: str) -> None:
    if status == 401:
        raise ProviderError(
            "The API key was rejected.", remedy="Check CLEARRAG_OPENAI_API_KEY in .env."
        )
    if status == 429:
        raise ProviderError("Rate limit reached.", remedy="Wait a moment and retry.")
    raise ProviderError(f"Provider returned HTTP {status}: {body[:200]}")


class OpenAIChat:
    name = "openai"

    def __init__(
        self,
        api_key: str,
        model: str = "gpt-4o-mini",
        base_url: str = "https://api.openai.com/v1",
        timeout: float = 300.0,
    ) -> None:
        if not api_key:
            raise ProviderError(
                "No OpenAI API key configured.",
                remedy="Set CLEARRAG_OPENAI_API_KEY in .env, or switch back to Ollama.",
            )
        self.model = model
        self._key = api_key
        self._base = base_url.rstrip("/")
        self._timeout = timeout

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}

    async def complete(self, messages: Sequence[Message], *, temperature: float = 0.1) -> str:
        return "".join([c async for c in self.stream(messages, temperature=temperature)])

    async def stream(
        self, messages: Sequence[Message], *, temperature: float = 0.1
    ) -> AsyncIterator[str]:
        payload = {
            "model": self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": temperature,
            "stream": True,
        }
        try:
            async with (
                httpx.AsyncClient(timeout=self._timeout) as client,
                client.stream(
                    "POST", f"{self._base}/chat/completions", json=payload, headers=self._headers
                ) as r,
            ):
                if r.status_code >= 400:
                    _raise_for(r.status_code, (await r.aread()).decode())
                async for line in r.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if data == "[DONE]":
                        break
                    delta = json.loads(data)["choices"][0].get("delta", {})
                    if token := delta.get("content"):
                        yield token
        except httpx.ConnectError as exc:
            raise ProviderError(f"Could not reach {self._base}.") from exc

    async def healthcheck(self) -> None:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(f"{self._base}/models", headers=self._headers)
                if r.status_code >= 400:
                    _raise_for(r.status_code, r.text)
        except httpx.ConnectError as exc:
            raise ProviderError(f"Could not reach {self._base}.") from exc


class OpenAIEmbeddings:
    name = "openai"

    def __init__(
        self,
        api_key: str,
        model: str = "text-embedding-3-small",
        base_url: str = "https://api.openai.com/v1",
        timeout: float = 120.0,
    ) -> None:
        if not api_key:
            raise ProviderError(
                "No OpenAI API key configured.", remedy="Set CLEARRAG_OPENAI_API_KEY in .env."
            )
        self.model = model
        self._key = api_key
        self._base = base_url.rstrip("/")
        self._timeout = timeout
        self._dims: int | None = None

    @property
    def id(self) -> str:
        return f"openai:{self.model}"

    @property
    def dimensions(self) -> int:
        if self._dims is None:
            raise RuntimeError("Dimensions unknown until the first embed() call.")
        return self._dims

    async def embed(self, texts: Sequence[str], *, kind: EmbedKind) -> np.ndarray:
        # OpenAI's embedding models are symmetric: unlike nomic or bge they take no
        # query/document prefix, so `kind` is accepted and intentionally unused.
        del kind
        if not texts:
            return np.zeros((0, self._dims or 0), dtype=np.float32)
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                r = await client.post(
                    f"{self._base}/embeddings",
                    json={"model": self.model, "input": list(texts)},
                    headers={"Authorization": f"Bearer {self._key}"},
                )
                if r.status_code >= 400:
                    _raise_for(r.status_code, r.text)
                rows = [item["embedding"] for item in r.json()["data"]]
        except httpx.ConnectError as exc:
            raise ProviderError(f"Could not reach {self._base}.") from exc

        arr = l2_normalise(np.asarray(rows, dtype=np.float32))
        self._dims = int(arr.shape[1])
        return arr

    async def healthcheck(self) -> None:
        await self.embed(["probe"], kind="query")
