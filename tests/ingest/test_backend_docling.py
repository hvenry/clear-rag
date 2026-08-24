"""docling backend contract test. Skips when the optional extra is not installed."""

import importlib.util

import pytest

docling_installed = importlib.util.find_spec("docling") is not None
pytestmark = pytest.mark.skipif(not docling_installed, reason="docling extra not installed")


def test_docling_backend_produces_blocks_and_valid_spans():
    from clearrag.ingest.parsers.docling import parse_pdf
    from tests.pdf_fixtures import styled_pdf

    result = parse_pdf(styled_pdf("Report", [("Section", ["A body paragraph."])]))
    assert result.text and result.blocks
    kinds = {b.kind for b in result.blocks}
    assert kinds <= {"heading", "paragraph", "table"}
    for b in result.blocks:
        assert 0 <= b.span[0] < b.span[1] <= len(result.text)
