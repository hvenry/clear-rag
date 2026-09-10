"""Build providers from settings.

Kept separate from the provider implementations so that adding a backend means adding a
file and one branch here, rather than touching the pipeline.
"""

from __future__ import annotations

from collections.abc import Sequence

from ..config import Settings
from .base import ChatProvider, EmbeddingProvider, ProviderError, Reranker
from .ollama import OllamaChat, OllamaEmbeddings, pulled_models
from .openai import OpenAIChat, OpenAIEmbeddings


def build_chat(settings: Settings) -> ChatProvider:
    match settings.chat_provider:
        case "ollama":
            return OllamaChat(
                settings.ollama_url,
                settings.chat_model,
                think=settings.think,
                num_ctx=settings.num_ctx,
                num_predict=settings.num_predict,
                keep_alive=settings.keep_alive,
            )
        case "openai":
            return OpenAIChat(
                settings.openai_api_key, settings.chat_model, settings.openai_base_url
            )
        case "anthropic":
            from .anthropic import DEFAULT_MODEL, AnthropicChat

            model = (
                settings.chat_model if settings.chat_model.startswith("claude") else DEFAULT_MODEL
            )
            return AnthropicChat(settings.anthropic_api_key, model)
        case other:  # pragma: no cover - guarded by pydantic Literal
            raise ProviderError(f"Unknown chat provider '{other}'.")


def build_embeddings(settings: Settings, model: str | None = None) -> EmbeddingProvider:
    """The configured embedder, or the named model on the same provider -- how an
    ablation sweep measures a row with a different embedding model."""
    model = model or settings.embed_model
    match settings.embed_provider:
        case "ollama":
            return OllamaEmbeddings(settings.ollama_url, model, keep_alive=settings.keep_alive)
        case "openai":
            return OpenAIEmbeddings(settings.openai_api_key, model, settings.openai_base_url)
        case other:  # pragma: no cover - guarded by pydantic Literal
            raise ProviderError(f"Unknown embedding provider '{other}'.")


def model_base(name: str) -> str:
    """Ollama names a default tag: "nomic-embed-text:latest" is "nomic-embed-text"."""
    return name.removesuffix(":latest")


def available_embedders(
    settings: Settings, candidates: Sequence[str]
) -> tuple[list[str], list[str]]:
    """Split candidate embedding models into the ones Ollama has pulled and the rest.

    Only Ollama can be asked what it has; on another provider, or with Ollama down,
    every candidate counts as missing, and the sweep says so rather than failing
    halfway through on a 404.
    """
    if settings.embed_provider != "ollama":
        return [], list(candidates)
    pulled = pulled_models(settings.ollama_url)
    if pulled is None:
        return [], list(candidates)
    have = {model_base(name) for name in pulled}
    present = [c for c in candidates if model_base(c) in have]
    return present, [c for c in candidates if c not in present]


def build_reranker(settings: Settings) -> Reranker | None:
    """The cross-encoder is optional: None (deps not installed) degrades gracefully --
    the pipeline reports a skipped stage rather than failing the query."""
    from . import rerank_onnx

    if not rerank_onnx.available():
        return None
    return rerank_onnx.OnnxReranker(settings.workspace / "models" / "ms-marco-minilm-l6")
