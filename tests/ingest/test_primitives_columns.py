"""Primitives parser: column detection and reading order."""

from clearrag.ingest.parsers.primitives import parse_pdf
from tests.pdf_fixtures import simple_pdf, two_column_pdf


def test_columns_read_left_then_right_not_interleaved():
    data = two_column_pdf(
        ["alpha one", "alpha two", "alpha three"], ["beta one", "beta two", "beta three"]
    )
    text = parse_pdf(data).text
    assert text.index("alpha three") < text.index("beta one")
    assert "alpha one beta one" not in text  # the naive interleave failure


def test_single_column_unaffected():
    data = simple_pdf(["A single column paragraph that spans the width of the page."])
    result = parse_pdf(data)
    assert len([b for b in result.blocks if b.kind == "paragraph"]) == 1
