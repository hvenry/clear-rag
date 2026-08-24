"""marker backend contract test. Skips when the optional extra is not installed."""

import importlib.util

import pytest

marker_installed = importlib.util.find_spec("marker") is not None
pytestmark = pytest.mark.skipif(not marker_installed, reason="marker extra not installed")


def test_marker_backend_produces_blocks_and_valid_spans():
    from clearrag.ingest.parsers.marker import parse_pdf
    from tests.pdf_fixtures import styled_pdf

    result = parse_pdf(styled_pdf("Report", [("Section", ["A body paragraph."])]))
    assert result.text and result.blocks
    kinds = {b.kind for b in result.blocks}
    assert kinds <= {"heading", "paragraph", "table"}
    for b in result.blocks:
        assert 0 <= b.span[0] < b.span[1] <= len(result.text)
