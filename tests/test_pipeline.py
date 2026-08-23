"""End-to-end pipeline behaviour, running entirely on fake providers."""

from __future__ import annotations

import pytest
from conftest import drain

from clearrag.core.types import Message
from clearrag.pipeline import EmbeddingSpaceMismatch, Engine
from clearrag.providers.fake import FakeChat, FakeEmbeddings


async def test_ingest_indexes_a_document(engine):
    result = await engine.ingest("notes.txt", b"Retrieval augmented generation explained.")
    assert result["status"] == "indexed"
    assert result["chunks"] >= 1
    assert engine.store.count_chunks() == result["chunks"]


async def test_reingesting_identical_content_is_a_noop(engine):
    data = b"Identical bytes both times."
    first = await engine.ingest("a.txt", data)
    before = engine.store.count_chunks()
    second = await engine.ingest("a.txt", data)

    assert second["status"] == "unchanged"
    assert second["document_id"] == first["document_id"]
    assert engine.store.count_chunks() == before


async def test_ingest_trace_reports_every_stage(engine):
    result = await engine.ingest("notes.txt", b"Some indexable prose about systems.")
    assert [s["name"] for s in result["trace"]["stages"]] == ["parse", "chunk", "embed", "index"]
    assert all(s["error"] is None for s in result["trace"]["stages"])


async def test_query_without_documents_is_a_friendly_error(engine):
    events = await drain(engine.query("anything"))
    assert events[0]["type"] == "error"
    assert "remedy" in events[0]


async def test_query_emits_stages_then_tokens_then_done(loaded_engine):
    events = await drain(loaded_engine.query("Where did Henry study?"))
    kinds = [e["type"] for e in events]

    assert kinds[-1] == "done"
    assert "token" in kinds
    # Every retrieval stage must be reported before the first answer token, which is what
    # lets the UI show retrieval happening rather than summarising it afterwards.
    assert kinds.index("stage") < kinds.index("token")
    assert kinds.index("context") < kinds.index("token")


async def test_generate_splits_the_wait_into_prefill_and_decode(loaded_engine):
    """One duration cannot say whether the wait was the model *reading* the retrieved
    context or *writing* the answer -- and those have opposite fixes: retrieve less, or
    run a smaller model. The trace has to carry both or it cannot be acted on."""
    events = await drain(loaded_engine.query("Where did Henry study?"))
    generate = next(
        e["stage"] for e in events if e["type"] == "stage" and e["stage"]["name"] == "generate"
    )
    diagnostics = generate["diagnostics"]

    assert diagnostics["ttft_ms"] is not None
    assert diagnostics["tokens"] > 0
    assert diagnostics["prompt_tokens"] > 0
    # The two halves must account for the whole stage, or the split is decorative.
    assert diagnostics["ttft_ms"] + diagnostics["decode_ms"] == pytest.approx(
        generate["duration_ms"], abs=0.5
    )


async def test_healthcheck_reports_a_missing_reranker_without_failing(engine):
    """Optional components warn, they do not fail. A preflight that goes red over a
    degradation teaches people to ignore red preflights."""
    report = await engine.healthcheck()
    rerank = next(c for c in report["checks"] if c["component"] == "rerank")

    assert rerank["optional"] is True
    assert rerank["ok"] is False
    assert "[rerank]" in rerank["remedy"]
    assert report["ok"] is True


async def test_hybrid_retrieval_runs_both_retrievers_and_fuses(loaded_engine):
    events = await drain(loaded_engine.query("Queen's University computing"))
    stages = {e["stage"]["name"]: e["stage"] for e in events if e["type"] == "stage"}

    assert {"bm25", "dense", "fuse"} <= set(stages)
    assert stages["fuse"]["diagnostics"]["inputs"].keys() == {"bm25", "dense"}


async def test_every_retrieval_stage_speaks_the_candidate_type(loaded_engine):
    """The universal-currency invariant that makes the rank-flow diagram generic."""
    events = await drain(loaded_engine.query("sourdough hydration"))
    stages = [e["stage"] for e in events if e["type"] == "stage"]

    retrieval = [s for s in stages if s["candidates_out"] is not None]
    assert {s["name"] for s in retrieval} >= {"bm25", "dense", "fuse"}
    for stage in retrieval:
        for candidate in stage["candidates_out"]:
            assert {"chunk_id", "score", "rank", "source"} <= candidate.keys()
        ranks = [c["rank"] for c in stage["candidates_out"]]
        assert ranks == list(range(1, len(ranks) + 1))


async def test_retrieval_finds_the_relevant_document(loaded_engine):
    """The fake embedder is a bag-of-words projection, so this asserts real ranking."""
    events = await drain(loaded_engine.query("Queen's University Kingston Ontario"))
    context = next(e for e in events if e["type"] == "context")

    texts = " ".join(c["text"] for c in context["chunks"]).lower()
    assert "queen" in texts or "kingston" in texts


async def test_trace_is_persisted_and_retrievable(loaded_engine):
    events = await drain(loaded_engine.query("What is the crumb structure about?"))
    trace_id = events[-1]["trace"]["id"]

    stored = loaded_engine.store.get_trace(trace_id)
    assert stored is not None
    assert stored["query"] == "What is the crumb structure about?"
    assert stored["config_hash"] == loaded_engine.config.config_hash


async def test_config_hash_changes_with_configuration(config):
    assert config.config_hash != config.model_copy(update={"k_final": 9}).config_hash


async def test_followup_is_rewritten_not_answered(settings, config):
    """Regression guard for the predecessor project's contextualisation bug.

    The rewrite prompt must instruct the model to reformulate, never to answer -- its
    output is fed straight into the retriever as a search query.
    """
    chat = FakeChat(script=["What school did Henry Vendittelli attend?"])
    engine = Engine(settings, config, chat=chat, embeddings=FakeEmbeddings())
    await engine.ingest("resume.txt", b"Henry studied at Queen's University in Kingston.")

    events = await drain(
        engine.query(
            "What about his school?",
            history=[
                Message(role="user", content="Who is Henry?"),
                Message(role="assistant", content="A software engineer."),
            ],
        )
    )

    transform = next(
        e["stage"] for e in events if e["type"] == "stage" and e["stage"]["name"] == "transform"
    )
    assert transform["diagnostics"]["rewritten"] is True
    assert transform["diagnostics"]["search_query"] == "What school did Henry Vendittelli attend?"

    system_prompt = chat.calls[0][0].content
    assert "Do NOT answer" in system_prompt


async def test_first_turn_skips_rewriting(loaded_engine):
    events = await drain(loaded_engine.query("Where did Henry study?"))
    transform = next(
        e["stage"] for e in events if e["type"] == "stage" and e["stage"]["name"] == "transform"
    )
    assert transform["diagnostics"]["rewritten"] is False


async def test_citations_resolve_to_real_chunks(settings, config):
    chat = FakeChat(script=["Henry studied at Queen's University [1]."])
    engine = Engine(settings, config, chat=chat, embeddings=FakeEmbeddings())
    await engine.ingest("resume.txt", b"Henry studied at Queen's University in Kingston.")

    events = await drain(engine.query("Where did Henry study?"))
    trace = events[-1]["trace"]

    assert len(trace["citations"]) == 1
    citation = trace["citations"][0]
    assert citation["marker"] == 1
    assert citation["filename"] == "resume.txt"

    document = engine.store.get_document(citation["doc_id"])
    start, end = citation["span"]
    assert document.text[start:end]  # the span points at real text


async def test_invented_citation_markers_are_dropped(settings, config):
    """A model citing [9] when three passages were supplied must not render a source."""
    chat = FakeChat(script=["This is supported by [9] and also [1]."])
    engine = Engine(settings, config, chat=chat, embeddings=FakeEmbeddings())
    await engine.ingest("resume.txt", b"Henry studied at Queen's University in Kingston.")

    events = await drain(engine.query("Where did Henry study?"))
    trace = events[-1]["trace"]
    generate = next(s for s in trace["stages"] if s["name"] == "generate")

    assert 9 in generate["diagnostics"]["hallucinated_markers"]
    assert all(c["marker"] != 9 for c in trace["citations"])


async def test_refusal_is_recorded_as_such(settings, config):
    """Refusing when the context lacks an answer is correct behaviour, and is labelled so.

    The predecessor project scored answers by cosine similarity to their context, which
    penalised exactly this response.
    """
    chat = FakeChat(script=["I don't have that information in the provided documents."])
    engine = Engine(settings, config, chat=chat, embeddings=FakeEmbeddings())
    await engine.ingest("resume.txt", b"Henry studied at Queen's University in Kingston.")

    events = await drain(engine.query("What is the airspeed velocity of a swallow?"))
    generate = next(s for s in events[-1]["trace"]["stages"] if s["name"] == "generate")
    assert generate["diagnostics"]["refused"] is True


async def test_assembled_context_stays_within_budget(loaded_engine):
    loaded_engine.config = loaded_engine.config.model_copy(update={"max_context_tokens": 300})
    events = await drain(loaded_engine.query("Tell me about everything indexed here."))
    assemble = next(
        e["stage"] for e in events if e["type"] == "stage" and e["stage"]["name"] == "assemble"
    )
    diagnostics = assemble["diagnostics"]
    assert diagnostics["context_tokens"] <= diagnostics["budget_tokens"]


async def test_deleting_a_document_removes_it_from_both_indexes(loaded_engine):
    doc_id = loaded_engine.store.list_documents()[0]["id"]
    before = loaded_engine.store.count_chunks()

    removed = loaded_engine.delete_document(doc_id)

    assert removed > 0
    assert loaded_engine.store.count_chunks() == before - removed
    index = await loaded_engine._vector_index()
    assert len(index) == loaded_engine.store.count_chunks()


async def test_changing_the_embedder_refuses_instead_of_returning_noise(
    loaded_engine, settings, config
):
    """Vectors from a different model are not comparable; the guard must refuse."""
    other = Engine(
        settings, config, chat=FakeChat(), embeddings=FakeEmbeddings(model="different-model")
    )
    with pytest.raises(EmbeddingSpaceMismatch, match="Re-index"):
        await other._vector_index()


async def test_indexes_survive_a_restart(loaded_engine, settings, config):
    expected = loaded_engine.store.count_chunks()
    reopened = Engine(settings, config, chat=FakeChat(), embeddings=FakeEmbeddings())

    assert reopened.store.count_chunks() == expected
    assert reopened.lexical.n_docs == expected
    assert len(await reopened._vector_index()) == expected


async def test_requesting_an_unavailable_reranker_is_reported_not_ignored(loaded_engine):
    """A config knob that silently does nothing is worse than one that says so."""
    loaded_engine.config = loaded_engine.config.model_copy(update={"rerank": True})
    events = await drain(loaded_engine.query("Where did Henry study?"))

    rerank = next(
        (e["stage"] for e in events if e["type"] == "stage" and e["stage"]["name"] == "rerank"),
        None,
    )
    assert rerank is not None, "an enabled-but-missing reranker must appear in the trace"
    assert rerank["degraded"] is True
    assert rerank["diagnostics"]["skipped"] is True
    # And the answer still arrives, using fusion order unchanged.
    assert events[-1]["type"] == "done"


async def test_reindex_applies_a_new_chunk_size_to_existing_documents(loaded_engine):
    """Changing an ingestion knob must actually change the stored corpus.

    Without a reindex path, editing chunk_size after ingestion silently applies only to
    future documents -- indistinguishable from the setting being broken.
    """
    before = loaded_engine.store.count_chunks()

    # Shrinking chunks is the direction guaranteed to change the count on any corpus;
    # growing them saturates at one chunk per document, which this tiny fixture already hits.
    loaded_engine.config = loaded_engine.config.model_copy(
        update={"chunk_size": 16, "chunk_overlap": 0}
    )
    report = await loaded_engine.reindex()

    after = loaded_engine.store.count_chunks()
    assert report["status"] == "reindexed"
    assert report["total_chunks"] == after
    assert after > before, "smaller chunks over the same text must mean more of them"

    # Both indexes agree with the store, and queries still work end to end.
    assert loaded_engine.lexical.n_docs == after
    assert len(await loaded_engine._vector_index()) == after
    events = await drain(loaded_engine.query("Where did Henry study?"))
    assert events[-1]["type"] == "done"


async def test_reindex_recovers_from_an_embedder_change(loaded_engine, settings, config):
    """Reindex is the remedy the embedding-space guard asks for, so it must not be
    blocked by that same guard."""
    other = Engine(settings, config, chat=FakeChat(), embeddings=FakeEmbeddings(model="new-model"))
    with pytest.raises(EmbeddingSpaceMismatch):
        await other._vector_index()

    report = await other.reindex()
    assert report["embedder"] == other.embeddings.id

    # The guard is now satisfied and queries flow again.
    events = await drain(other.query("Where did Henry study?"))
    assert events[-1]["type"] == "done"


async def test_reindex_with_no_documents_is_a_clean_noop(engine):
    report = await engine.reindex()
    assert report["total_chunks"] == 0
    assert report["documents"] == []
