"""Chunking, with emphasis on the span invariant everything downstream depends on."""

from __future__ import annotations

import pytest

from clearrag.core.types import Document
from clearrag.ingest.chunk import chunk_document


def make_doc(text: str) -> Document:
    return Document(id="d1", filename="t.txt", text=text, content_hash="h")


PROSE = "\n\n".join(
    f"Paragraph {i} about retrieval systems and their behaviour." for i in range(30)
)


def test_spans_reconstruct_chunk_text_exactly():
    """The invariant: text[start:end] IS the chunk. Citations depend on it."""
    doc = make_doc(PROSE)
    for chunk in chunk_document(doc, chunk_size=64, chunk_overlap=8).chunks:
        assert doc.text[chunk.span[0] : chunk.span[1]] == chunk.text


def test_spans_are_within_bounds():
    doc = make_doc(PROSE)
    for chunk in chunk_document(doc, chunk_size=64, chunk_overlap=8).chunks:
        assert 0 <= chunk.span[0] < chunk.span[1] <= len(doc.text)


def test_spans_advance_monotonically():
    chunks = chunk_document(make_doc(PROSE), chunk_size=64, chunk_overlap=8).chunks
    starts = [c.span[0] for c in chunks]
    assert starts == sorted(starts)


def test_ordinals_are_sequential():
    chunks = chunk_document(make_doc(PROSE), chunk_size=64, chunk_overlap=8).chunks
    assert [c.ordinal for c in chunks] == list(range(len(chunks)))


def test_whole_document_is_covered():
    doc = make_doc(PROSE)
    chunks = chunk_document(doc, chunk_size=64, chunk_overlap=8).chunks
    assert chunks[0].span[0] == 0
    # Consecutive chunks must touch or overlap, never leave a gap of dropped text.
    for previous, nxt in zip(chunks, chunks[1:], strict=False):
        assert nxt.span[0] <= previous.span[1]


def test_short_document_is_one_chunk():
    result = chunk_document(make_doc("A single short sentence."), chunk_size=512)
    assert len(result.chunks) == 1
    assert result.chunks[0].text == "A single short sentence."


def test_empty_document_yields_no_chunks():
    assert chunk_document(make_doc("   ")).chunks == []


def test_overlap_must_be_smaller_than_chunk_size():
    with pytest.raises(ValueError, match="smaller than chunk_size"):
        chunk_document(make_doc(PROSE), chunk_size=64, chunk_overlap=64)


def test_diagnostics_expose_boundaries_for_the_inspector():
    result = chunk_document(make_doc(PROSE), chunk_size=64, chunk_overlap=8)
    diagnostics = result.diagnostics
    assert diagnostics["count"] == len(result.chunks)
    assert diagnostics["boundaries"] == [list(c.span) for c in result.chunks]
    assert diagnostics["overlap_ratio"] == pytest.approx(8 / 64)
    assert len(diagnostics["tokens"]["histogram"]) == len(result.chunks)


def test_default_overlap_ratio_is_modest():
    """Guards against regressing to the predecessor's 50% overlap."""
    from clearrag.config import PipelineConfig

    config = PipelineConfig()
    assert config.chunk_overlap / config.chunk_size <= 0.2


def test_page_numbers_are_carried_onto_chunks():
    doc = Document(
        id="d1",
        filename="t.pdf",
        text="First page text.\n\nSecond page text.",
        content_hash="h",
        page_map=[(0, 1), (18, 2)],
    )
    chunks = chunk_document(doc, chunk_size=16, chunk_overlap=0).chunks
    assert {c.page for c in chunks} <= {1, 2}
    assert chunks[0].page == 1


def test_text_without_separators_still_splits():
    result = chunk_document(make_doc("x" * 4000), chunk_size=64, chunk_overlap=0)
    assert len(result.chunks) > 1


def test_chunks_start_at_a_word_boundary():
    """Regression: the overlap backup stepped back a fixed number of characters.

    That put the start of nearly every chunk in the middle of a word, so citation
    previews opened with fragments like "cal data" (from "historical data") and read
    as corruption rather than as a quotation.
    """
    doc = make_doc(PROSE)
    for chunk in chunk_document(doc, chunk_size=64, chunk_overlap=16).chunks:
        start = chunk.span[0]
        if start == 0:
            continue
        assert doc.text[start - 1].isspace() or doc.text[start].isspace(), (
            f"chunk starts mid-word at {start}: ...{doc.text[start - 12 : start]!r}"
            f"|{doc.text[start : start + 12]!r}..."
        )


def test_chunks_do_not_end_mid_word():
    doc = make_doc(PROSE)
    chunks = chunk_document(doc, chunk_size=64, chunk_overlap=16).chunks
    for chunk in chunks:
        end = chunk.span[1]
        if end == len(doc.text):
            continue
        assert doc.text[end - 1].isspace() or doc.text[end].isspace(), (
            f"chunk ends mid-word at {end}: ...{doc.text[end - 12 : end]!r}"
            f"|{doc.text[end : end + 12]!r}..."
        )
