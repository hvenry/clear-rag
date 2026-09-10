"""Which embedding models a sweep can measure is asked of Ollama, never assumed."""

from __future__ import annotations

import httpx

from clearrag.config import Settings
from clearrag.providers import ollama, registry


def test_pulled_models_reads_the_tags_endpoint(monkeypatch):
    class Response:
        def raise_for_status(self) -> None:
            pass

        def json(self) -> dict:
            return {"models": [{"name": "nomic-embed-text:latest"}, {"name": "qwen3.5:9b"}]}

    monkeypatch.setattr(ollama.httpx, "get", lambda url, timeout: Response())
    assert ollama.pulled_models("http://x/") == {"nomic-embed-text:latest", "qwen3.5:9b"}


def test_pulled_models_is_none_when_ollama_is_unreachable(monkeypatch):
    def down(url, timeout):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(ollama.httpx, "get", down)
    assert ollama.pulled_models("http://x") is None


def test_available_embedders_splits_candidates_by_what_is_pulled(monkeypatch):
    monkeypatch.setattr(
        registry, "pulled_models", lambda url: {"nomic-embed-text:latest", "all-minilm:latest"}
    )
    settings = Settings(embed_provider="ollama")
    have, missing = registry.available_embedders(settings, ["all-minilm", "mxbai-embed-large"])
    assert have == ["all-minilm"]
    assert missing == ["mxbai-embed-large"]


def test_everything_is_missing_when_ollama_cannot_be_asked(monkeypatch):
    monkeypatch.setattr(registry, "pulled_models", lambda url: None)
    settings = Settings(embed_provider="ollama")
    assert registry.available_embedders(settings, ["all-minilm"]) == ([], ["all-minilm"])
    assert registry.available_embedders(Settings(embed_provider="openai"), ["x"]) == ([], ["x"])


def test_build_embeddings_takes_a_model_override():
    settings = Settings(embed_provider="ollama", embed_model="nomic-embed-text")
    assert registry.build_embeddings(settings).id == "ollama:nomic-embed-text"
    assert registry.build_embeddings(settings, "all-minilm").id == "ollama:all-minilm"
