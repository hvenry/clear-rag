"""Primitives parser: words cluster into lines, lines into paragraph blocks."""

from clearrag.ingest.parsers.primitives import parse_pdf
from tests.pdf_fixtures import simple_pdf


def test_paragraphs_become_blocks_with_valid_spans():
    data = simple_pdf(["First paragraph spans\ntwo drawn lines.", "Second paragraph."])
    result = parse_pdf(data)
    paras = [b for b in result.blocks if b.kind == "paragraph"]
    assert len(paras) == 2
    assert result.text[paras[0].span[0] : paras[0].span[1]] == (
        "First paragraph spans two drawn lines."
    )
    assert paras[0].page == 1


def test_page_map_points_at_first_block():
    result = parse_pdf(simple_pdf(["Only paragraph."]))
    assert result.page_map == [(0, 1)]
