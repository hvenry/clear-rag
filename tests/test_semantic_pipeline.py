"""The semantic chunker knob reaches the engine: ingest and reindex both dispatch."""

from clearrag.config import PipelineConfig, Settings
from clearrag.pipeline import Engine
from clearrag.providers.fake import FakeChat, FakeEmbeddings

MD = b"# Doc\n\n## Alpha\n\nAlpha body.\n\n## Beta\n\nBeta body.\n"


def _engine(tmp_path, **cfg):
    return Engine(Settings(workspace=tmp_path), PipelineConfig(**cfg), FakeChat(), FakeEmbeddings())


async def test_semantic_chunker_used_when_configured(tmp_path):
    engine = _engine(tmp_path, chunker="semantic", chunk_size=64)
    result = await engine.ingest("a.md", MD)
    chunk_stage = next(s for s in result["trace"]["stages"] if s["name"] == "chunk")
    assert chunk_stage["config"]["chunker"] == "semantic"
    assert "sections" in chunk_stage["diagnostics"]


async def test_reindex_respects_semantic_chunker(tmp_path):
    engine = _engine(tmp_path, chunker="recursive")
    await engine.ingest("a.md", MD)
    engine.config = PipelineConfig(chunker="semantic", chunk_size=64)
    out = await engine.reindex()
    assert out["status"] == "reindexed"
    doc_id = out["documents"][0]["document_id"]
    doc = engine.store.get_document(doc_id)
    for chunk in engine.store.chunks_for_doc(doc_id):
        assert doc.text[chunk.span[0] : chunk.span[1]] == chunk.text
