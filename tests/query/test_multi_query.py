"""Multi-query expansion end to end, on fake providers."""

from __future__ import annotations

from clearrag.config import PipelineConfig
from clearrag.pipeline import Engine
from clearrag.providers.fake import FakeChat, FakeEmbeddings
from tests.conftest import CORPUS, drain


async def _engine(settings, chat: FakeChat, **overrides) -> Engine:
    config = PipelineConfig(chunk_size=64, chunk_overlap=8, k_candidates=10, k_final=3, **overrides)
    engine = Engine(settings, config, chat=chat, embeddings=FakeEmbeddings())
    for filename, text in CORPUS.items():
        await engine.ingest(filename.replace(".pdf", ".txt"), text.encode())
    return engine


async def test_multi_query_runs_every_retriever_over_every_phrasing(settings):
    chat = FakeChat(
        script=[
            "Which university did Henry attend?\nHenry's alma mater",
            "Henry studied at Queen's [1].",
        ]
    )
    engine = await _engine(settings, chat, query_transform="multi", query_variants=2)

    events = await drain(engine.query("Where did Henry study?"))
    stages = {e["stage"]["name"]: e["stage"] for e in events if e["type"] == "stage"}

    assert stages["transform"]["diagnostics"]["expansions"] == [
        "Which university did Henry attend?",
        "Henry's alma mater",
    ]
    for name in ("bm25", "dense"):
        stage = stages[name]
        assert stage["diagnostics"]["variants"] == 3
        assert len(stage["diagnostics"]["returned_per_variant"]) == 3
        ranks = [c["rank"] for c in stage["candidates_out"]]
        assert ranks == list(range(1, len(ranks) + 1))
        assert all(c["source"] == name for c in stage["candidates_out"])
        assert all("variants" in c["detail"] for c in stage["candidates_out"])

    # Fusion still sees exactly two retrievers, so the inspector's "found by" holds.
    assert stages["fuse"]["diagnostics"]["inputs"].keys() == {"dense", "bm25"}
    # One generation for the expansions, one for the answer.
    assert len(chat.calls) == 2
    assert events[-1]["type"] == "done"
    assert events[-1]["trace"]["resolved_query"] == "Where did Henry study?"


async def test_multi_query_still_lands_on_the_right_document(settings):
    chat = FakeChat(
        script=["Queen's University Kingston\nHenry's university", "It was Queen's [1]."]
    )
    engine = await _engine(settings, chat, query_transform="multi", query_variants=2)

    events = await drain(engine.query("Where did Henry study?"))
    context = next(e for e in events if e["type"] == "context")

    texts = " ".join(c["text"] for c in context["chunks"]).lower()
    assert "queen" in texts or "kingston" in texts


async def test_expansion_off_means_no_extra_model_calls(settings):
    chat = FakeChat(script=["Answer [1]."])
    engine = await _engine(settings, chat)

    events = await drain(engine.query("Where did Henry study?"))
    stages = {e["stage"]["name"]: e["stage"] for e in events if e["type"] == "stage"}

    assert "expansions" not in stages["transform"]["diagnostics"]
    assert "variants" not in stages["bm25"]["diagnostics"]
    assert "variants" not in stages["dense"]["diagnostics"]
    assert len(chat.calls) == 1
