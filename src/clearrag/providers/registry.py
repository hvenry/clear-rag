"""Build providers from settings.

Kept separate from the provider implementations so that adding a backend means adding a
file and one branch here, rather than touching the pipeline.
"""

from __future__ import annotations

from ..config import Settings
from .base import ChatProvider, EmbeddingProvider, ProviderError
from .ollama import OllamaChat, OllamaEmbeddings
from .openai import OpenAIChat, OpenAIEmbeddings


def build_chat(settings: Settings) -> ChatProvider:
    match settings.chat_provider:
        case "ollama":
            return OllamaChat(settings.ollama_url, settings.chat_model, think=settings.think)
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


def build_embeddings(settings: Settings) -> EmbeddingProvider:
    match settings.embed_provider:
        case "ollama":
            return OllamaEmbeddings(settings.ollama_url, settings.embed_model)
        case "openai":
            return OpenAIEmbeddings(
                settings.openai_api_key, settings.embed_model, settings.openai_base_url
            )
        case other:  # pragma: no cover - guarded by pydantic Literal
            raise ProviderError(f"Unknown embedding provider '{other}'.")
