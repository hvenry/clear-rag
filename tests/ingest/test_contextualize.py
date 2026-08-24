"""Contextual retrieval: breadcrumbs from parse structure, indexed but never displayed."""

from clearrag.config import PipelineConfig, Settings
from clearrag.ingest.contextualize import breadcrumb
from clearrag.pipeline import Engine
from clearrag.providers.fake import FakeChat, FakeEmbeddings

MD = b"# Apple 10-K\n\n## Item 1A Risk Factors\n\nSupply chain concentration risk text.\n"


def test_breadcrumb_is_heading_path():
    from clearrag.ingest.chunk import chunk_document
    from clearrag.ingest.parse import parse

    doc = parse("aapl.md", MD).document
    chunk = chunk_document(doc).chunks[0]
    crumb = breadcrumb(doc, chunk)
    assert crumb.startswith("Apple 10-K")  # heading text, markers stripped
    assert "Item 1A Risk Factors" in crumb


def test_breadcrumb_falls_back_to_filename_without_headings():
    from clearrag.ingest.chunk import chunk_document
    from clearrag.ingest.parse import parse

    doc = parse("notes.txt", b"No structure here at all.").document
    chunk = chunk_document(doc).chunks[0]
    assert breadcrumb(doc, chunk) == "notes.txt"


async def test_breadcrumb_mode_indexes_context_but_displays_clean_text(tmp_path):
    engine = Engine(
        Settings(workspace=tmp_path),
        PipelineConfig(context_mode="breadcrumb"),
        FakeChat(),
        FakeEmbeddings(),
    )
    result = await engine.ingest("aapl.md", MD)
    chunks = engine.store.chunks_for_doc(result["document_id"])
    assert all(c.context and "Risk Factors" in c.context for c in chunks if "Supply" in c.text)
    assert all("›" not in c.text for c in chunks)  # stored text untouched


async def test_llm_context_generated_and_cached_by_content(tmp_path):
    chat = FakeChat(script=["This excerpt is from the risk section."])
    engine = Engine(
        Settings(workspace=tmp_path),
        PipelineConfig(context_mode="llm"),
        chat,
        FakeEmbeddings(),
    )
    result = await engine.ingest("aapl.md", MD)
    calls_after_first = len(chat.calls)
    assert calls_after_first >= 1
    await engine.reindex()  # same spans, same model -> pure cache hits
    assert len(chat.calls) == calls_after_first
    chunks = engine.store.chunks_for_doc(result["document_id"])
    assert any(c.context and "risk section" in c.context for c in chunks)
    assert all("risk section" not in c.text for c in chunks)  # stored text untouched


async def test_reindex_applies_context_mode_change(tmp_path):
    engine = Engine(Settings(workspace=tmp_path), PipelineConfig(), FakeChat(), FakeEmbeddings())
    result = await engine.ingest("aapl.md", MD)
    assert all(c.context is None for c in engine.store.chunks_for_doc(result["document_id"]))
    engine.config = PipelineConfig(context_mode="breadcrumb")
    await engine.reindex()
    chunks = engine.store.chunks_for_doc(result["document_id"])
    assert chunks and all(c.context for c in chunks)
