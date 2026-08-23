"""Anthropic chat provider (bring your own key).

Uses the official ``anthropic`` SDK, imported lazily so the default Ollama-only path
never needs it installed and the slim Docker image stays small.

Three details here are easy to get wrong and are deliberate:

* **No ``temperature``.** Sampling parameters were removed on the current model family
  (Opus 5, Sonnet 5, Fable 5, Opus 4.8/4.7) and sending one returns a 400. The protocol
  accepts ``temperature`` because Ollama honours it; this provider maps it onto ``effort``
  instead of forwarding it.
* **System prompts are a top-level parameter**, not a message role, so system messages are
  lifted out of the message list rather than passed through.
* **Server-side refusal fallbacks are enabled by default.** Without them a policy decline
  simply stops the response; with them the same request is re-run on a fallback model
  inside the same call.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from typing import Any

from ..core.types import Message
from .base import ProviderError

DEFAULT_MODEL = "claude-opus-5"

# RAG answers are deliberately short and grounded; this is a ceiling, not a target.
MAX_TOKENS = 4096

_FALLBACK_BETA = "server-side-fallback-2026-07-01"


def _load_sdk() -> Any:
    try:
        import anthropic
    except ModuleNotFoundError as exc:  # pragma: no cover - import guard
        raise ProviderError(
            "The 'anthropic' package is not installed.",
            remedy="Install the optional extra: `uv pip install -e '.[byok]'`",
        ) from exc
    return anthropic


def _split_system(messages: Sequence[Message]) -> tuple[str | None, list[dict[str, str]]]:
    """Lift system turns into the top-level ``system`` parameter."""
    system_parts = [m.content for m in messages if m.role == "system"]
    turns = [{"role": m.role, "content": m.content} for m in messages if m.role != "system"]
    return ("\n\n".join(system_parts) or None), turns


def _effort_for(temperature: float) -> str:
    """Map the protocol's temperature knob onto the closest effort level.

    Grounded question answering over retrieved context is not an intelligence-limited
    task, so low effort is both faster and cheaper without hurting answer quality.
    """
    return "low" if temperature <= 0.3 else "medium"


class AnthropicChat:
    name = "anthropic"

    def __init__(self, api_key: str, model: str = DEFAULT_MODEL) -> None:
        if not api_key:
            raise ProviderError(
                "No Anthropic API key configured.",
                remedy="Set CLEARRAG_ANTHROPIC_API_KEY in .env, or switch back to Ollama.",
            )
        self.model = model
        self._api_key = api_key
        self._client: Any = None

    def _get_client(self) -> Any:
        if self._client is None:
            self._client = _load_sdk().AsyncAnthropic(api_key=self._api_key)
        return self._client

    async def complete(self, messages: Sequence[Message], *, temperature: float = 0.1) -> str:
        return "".join([c async for c in self.stream(messages, temperature=temperature)])

    async def stream(
        self, messages: Sequence[Message], *, temperature: float = 0.1
    ) -> AsyncIterator[str]:
        anthropic = _load_sdk()
        system, turns = _split_system(messages)
        kwargs: dict[str, Any] = {
            "model": self.model,
            "max_tokens": MAX_TOKENS,
            "messages": turns,
            "output_config": {"effort": _effort_for(temperature)},
            "betas": [_FALLBACK_BETA],
            "fallbacks": "default",
        }
        if system:
            kwargs["system"] = system

        try:
            async with self._get_client().beta.messages.stream(**kwargs) as stream:
                async for text in stream.text_stream:
                    yield text
                final = await stream.get_final_message()
        except anthropic.AuthenticationError as exc:
            raise ProviderError(
                "Anthropic rejected the API key.",
                remedy="Check CLEARRAG_ANTHROPIC_API_KEY in .env.",
            ) from exc
        except anthropic.RateLimitError as exc:
            retry = exc.response.headers.get("retry-after", "60")
            raise ProviderError(
                "Anthropic rate limit reached.", remedy=f"Retry in about {retry}s."
            ) from exc
        except anthropic.APIConnectionError as exc:
            raise ProviderError("Could not reach the Anthropic API.") from exc

        # A refusal that survives the fallback chain arrives as a normal 200 response,
        # so it has to be checked explicitly rather than caught.
        if final.stop_reason == "refusal":
            detail = getattr(final, "stop_details", None)
            category = getattr(detail, "category", None) or "unspecified"
            raise ProviderError(
                f"The model declined to answer (category: {category}).",
                remedy="Rephrase the question, or switch to a local Ollama model.",
            )

    async def healthcheck(self) -> None:
        anthropic = _load_sdk()
        try:
            await self._get_client().models.retrieve(self.model)
        except anthropic.NotFoundError as exc:
            raise ProviderError(f"Unknown Anthropic model '{self.model}'.") from exc
        except anthropic.AuthenticationError as exc:
            raise ProviderError(
                "Anthropic rejected the API key.",
                remedy="Check CLEARRAG_ANTHROPIC_API_KEY in .env.",
            ) from exc
