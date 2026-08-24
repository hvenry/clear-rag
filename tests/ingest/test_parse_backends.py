"""The parser backend registry, and format-native block structure for text formats."""

import pytest

from clearrag.ingest.parse import parse
from clearrag.ingest.parsers import available_backends, parse_pdf
from clearrag.ingest.parsers.base import ParserUnavailable

MD = b"# Title\n\nFirst paragraph line.\n\n## Section A\n\nSecond paragraph.\n"


def test_markdown_gets_heading_and_paragraph_blocks():
    doc = parse("a.md", MD).document
    kinds = [(b.kind, b.level) for b in doc.blocks]
    assert kinds == [("heading", 1), ("paragraph", 0), ("heading", 2), ("paragraph", 0)]
    h = doc.blocks[2]
    assert doc.text[h.span[0] : h.span[1]] == "## Section A"


def test_block_spans_index_into_text():
    doc = parse("a.md", MD).document
    for b in doc.blocks:
        assert doc.text[b.span[0] : b.span[1]].strip()


def test_plain_text_gets_single_paragraph_block():
    doc = parse("a.txt", b"Just some plain text.").document
    assert [b.kind for b in doc.blocks] == ["paragraph"]
    assert doc.blocks[0].span == (0, len(doc.text))


def test_naive_backend_listed_and_optional_ones_report_unavailable():
    avail = available_backends()
    assert avail["naive"] is True
    if not avail["docling"]:
        with pytest.raises(ParserUnavailable) as exc:
            parse_pdf(b"%PDF-1.4", "docling")
        assert "pip install" in exc.value.remedy


def test_unknown_backend_rejected():
    with pytest.raises(ValueError):
        parse_pdf(b"%PDF-1.4", "nope")
