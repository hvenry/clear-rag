"""The transform stage: follow-up rewriting and multi-query expansion."""

from __future__ import annotations

from clearrag.config import PipelineConfig
from clearrag.core.trace import Trace
from clearrag.core.types import Message
from clearrag.generate.prompt import parse_expansions
from clearrag.index.lexical import LexicalIndex
from clearrag.index.store import Store
from clearrag.index.vector import VectorIndex
from clearrag.providers.base import ProviderError
from clearrag.providers.fake import FakeChat, FakeEmbeddings
from clearrag.query.context import QueryContext
from clearrag.query.transform import transform_query


def test_parse_expansions_strips_decoration_and_duplicates():
    reply = (
        '1. "How do I revert a deployment?"\n'
        "2) How do I revert a deployment?\n"
        "- Undo a release\n"
        "\n"
        "How do I roll back a bad release?\n"
        "* Rolling back a broken deploy\n"
    )
    out = parse_expansions(reply, "How do I roll back a bad release?", n=5)
    assert out == [
        "How do I revert a deployment?",
        "Undo a release",
        "Rolling back a broken deploy",
    ]


def test_parse_expansions_caps_at_n():
    assert parse_expansions("a\nb\nc\nd", "original", n=2) == ["a", "b"]


def _ctx(tmp_path, config: PipelineConfig, chat: FakeChat) -> QueryContext:
    return QueryContext(
        config=config,
        trace=Trace(query="q"),
        chat=chat,
        embeddings=FakeEmbeddings(),
        reranker=None,
        store=Store(tmp_path / "db.sqlite"),
        lexical=LexicalIndex(),
        vectors=VectorIndex(64),
    )


async def test_multi_query_searches_the_original_plus_the_expansions(tmp_path):
    chat = FakeChat(script=["Where did Henry go to university?\nWhich school did Henry attend?"])
    ctx = _ctx(tmp_path, PipelineConfig(query_transform="multi", query_variants=2), chat)

    queries, rec = await transform_query(ctx, "Where did Henry study?", [])

    assert queries == [
        "Where did Henry study?",
        "Where did Henry go to university?",
        "Which school did Henry attend?",
    ]
    assert rec.diagnostics["expansions"] == queries[1:]
    assert rec.config["variants"] == 2
    assert len(chat.calls) == 1
    # Reranking and generation see the resolved question, never an expansion.
    assert ctx.trace.resolved_query == "Where did Henry study?"


async def test_expansion_degrades_to_the_plain_query_when_the_model_fails(tmp_path):
    class Down(FakeChat):
        async def complete(self, messages, *, temperature=0.1):
            raise ProviderError("model offline", remedy="start it")

    ctx = _ctx(tmp_path, PipelineConfig(query_transform="multi"), Down())
    queries, rec = await transform_query(ctx, "anything", [])

    assert queries == ["anything"]
    assert rec.degraded is True
    assert "offline" in (rec.error or "")
    assert rec.diagnostics["expansions"] == []


async def test_expansion_is_off_by_default_and_leaves_the_record_untouched(tmp_path):
    """The common path must be exactly what it was before expansion existed."""
    chat = FakeChat(script=["should never be consulted"])
    ctx = _ctx(tmp_path, PipelineConfig(), chat)

    queries, rec = await transform_query(ctx, "plain", [])

    assert queries == ["plain"]
    assert "expansions" not in rec.diagnostics
    assert "variants" not in rec.config
    assert rec.label == "Rewrite query"
    assert chat.calls == []


async def test_followup_is_rewritten_before_it_is_expanded(tmp_path):
    chat = FakeChat(
        script=[
            "What did Henry study at Queen's?",
            "Henry's degree subject\nHenry's field of study",
        ]
    )
    ctx = _ctx(tmp_path, PipelineConfig(query_transform="multi", query_variants=2), chat)
    history = [
        Message(role="user", content="Tell me about Henry"),
        Message(role="assistant", content="He went to Queen's."),
    ]

    queries, _ = await transform_query(ctx, "What did he study there?", history)

    assert queries[0] == "What did Henry study at Queen's?"
    assert len(queries) == 3
    # The expansion prompt was given the rewritten query, not the raw follow-up.
    assert chat.calls[1][-1].content == "What did Henry study at Queen's?"
