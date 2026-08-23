"""Ollama provider wire behaviour, exercised against a mock transport.

The fake providers cover pipeline logic; these cover the bit that actually talks HTTP,
including the thinking-token failure that made a current-generation model unusable.
"""

from __future__ import annotations

import json

import httpx
import pytest

from clearrag.core.types import Message
from clearrag.providers.base import ProviderError
from clearrag.providers.ollama import OllamaChat, OllamaEmbeddings, _prefix_for


@pytest.fixture
def capture(monkeypatch):
    """Intercept outbound requests and script the response."""
    state: dict = {"requests": [], "handler": None}

    def install(handler):
        state["handler"] = handler

    def _handler(request: httpx.Request) -> httpx.Response:
        state["requests"].append(json.loads(request.content))
        return state["handler"](request)

    real = httpx.AsyncClient

    def patched(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(_handler)
        return real(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    state["install"] = install
    return state


def ndjson(*frames: dict) -> str:
    return "".join(json.dumps(f) + "\n" for f in frames)


MESSAGES = [Message(role="user", content="hello")]


async def test_thinking_is_disabled_by_default(capture):
    """Regression: qwen3.5 spent its entire output budget thinking and returned nothing.

    3,751 of 3,752 streamed frames were `thinking`, content was empty, and the response
    ended with done_reason "length" -- a current-generation model that appeared simply
    broken. Answering from retrieved context does not need visible reasoning, so the
    provider turns it off unless asked for.
    """
    capture["install"](
        lambda r: httpx.Response(200, content=ndjson({"message": {"content": "hi"}, "done": True}))
    )
    chat = OllamaChat("http://x", "qwen3.5:9b")
    assert await chat.complete(MESSAGES) == "hi"
    assert capture["requests"][0]["think"] is False


async def test_thinking_can_be_re_enabled(capture):
    capture["install"](
        lambda r: httpx.Response(200, content=ndjson({"message": {"content": "hi"}, "done": True}))
    )
    chat = OllamaChat("http://x", "qwen3.5:9b", think=True)
    await chat.complete(MESSAGES)
    assert capture["requests"][0]["think"] is True


async def test_streams_content_frames_in_order(capture):
    capture["install"](
        lambda r: httpx.Response(
            200,
            content=ndjson(
                {"message": {"content": "Hello"}},
                {"message": {"content": " world"}},
                {"message": {"content": ""}, "done": True},
            ),
        )
    )
    chat = OllamaChat("http://x", "m")
    assert [c async for c in chat.stream(MESSAGES)] == ["Hello", " world"]


async def test_thinking_frames_are_never_emitted_as_answer_text(capture):
    """Even with thinking on, reasoning must not leak into the answer or its citations."""
    capture["install"](
        lambda r: httpx.Response(
            200,
            content=ndjson(
                {"message": {"thinking": "let me consider [9]"}},
                {"message": {"content": "answer [1]"}, "done": True},
            ),
        )
    )
    chat = OllamaChat("http://x", "m", think=True)
    assert await chat.complete(MESSAGES) == "answer [1]"


async def test_missing_model_reports_how_to_fix_it(capture):
    capture["install"](lambda r: httpx.Response(404, content=b'{"error":"model not found"}'))
    chat = OllamaChat("http://x", "absent-model")
    with pytest.raises(ProviderError) as exc:
        await chat.complete(MESSAGES)
    assert "ollama pull absent-model" in exc.value.remedy


async def test_unreachable_ollama_reports_how_to_fix_it(monkeypatch):
    real = httpx.AsyncClient

    def patched(*args, **kwargs):
        def boom(request):
            raise httpx.ConnectError("refused", request=request)

        kwargs["transport"] = httpx.MockTransport(boom)
        return real(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)
    with pytest.raises(ProviderError) as exc:
        await OllamaChat("http://127.0.0.1:1", "m").complete(MESSAGES)
    assert "Cannot reach Ollama" in str(exc.value)
    assert exc.value.remedy


# ── Embeddings ──


async def test_embeddings_are_l2_normalised(capture):
    capture["install"](lambda r: httpx.Response(200, json={"embeddings": [[3.0, 4.0]]}))
    vectors = await OllamaEmbeddings("http://x", "nomic-embed-text").embed(["a"], kind="query")
    assert vectors.shape == (1, 2)
    assert abs(float((vectors[0] ** 2).sum()) - 1.0) < 1e-6


async def test_query_and_document_get_different_prefixes(capture):
    capture["install"](lambda r: httpx.Response(200, json={"embeddings": [[1.0, 0.0]]}))
    embedder = OllamaEmbeddings("http://x", "nomic-embed-text")

    await embedder.embed(["cats"], kind="document")
    await embedder.embed(["cats"], kind="query")

    document_input, query_input = (r["input"][0] for r in capture["requests"])
    assert document_input != query_input, "asymmetric models need distinct prefixes"
    assert document_input.startswith("search_document: ")
    assert query_input.startswith("search_query: ")


def test_unknown_embedding_model_falls_back_to_no_prefix():
    assert _prefix_for("some-new-model", "query") == ""


def test_symmetric_model_uses_no_prefix():
    assert _prefix_for("bge-m3", "query") == _prefix_for("bge-m3", "document") == ""


async def test_empty_input_short_circuits(capture):
    capture["install"](lambda r: httpx.Response(500, content=b"should not be called"))
    assert (await OllamaEmbeddings("http://x", "m").embed([], kind="query")).shape[0] == 0
    assert capture["requests"] == []
