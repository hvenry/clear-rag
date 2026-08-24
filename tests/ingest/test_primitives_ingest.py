"""End to end: a PDF ingested through the primitives backend keeps the span invariant."""

from clearrag.config import PipelineConfig, Settings
from clearrag.pipeline import Engine
from clearrag.providers.fake import FakeChat, FakeEmbeddings
from tests.pdf_fixtures import styled_pdf


async def test_pdf_ingests_through_primitives_with_valid_chunk_spans(tmp_path):
    engine = Engine(Settings(workspace=tmp_path), PipelineConfig(), FakeChat(), FakeEmbeddings())
    data = styled_pdf("Report", [("Section", ["A body paragraph with searchable words."])])
    result = await engine.ingest("r.pdf", data)
    assert result["status"] == "indexed"
    parse_stage = next(s for s in result["trace"]["stages"] if s["name"] == "parse")
    assert parse_stage["config"]["parser"] == "primitives"
    doc = engine.store.get_document(result["document_id"])
    assert doc is not None and doc.blocks
    for chunk in engine.store.chunks_for_doc(doc.id):
        assert doc.text[chunk.span[0] : chunk.span[1]] == chunk.text
