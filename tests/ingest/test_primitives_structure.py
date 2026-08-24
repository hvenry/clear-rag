"""Primitives parser: headings, page furniture, cross-page paragraph reassembly."""

from clearrag.ingest.parsers.primitives import parse_pdf
from tests.pdf_fixtures import repeated_footer_pdf, styled_pdf


def _two_page_doc():
    return repeated_footer_pdf(
        [["Page one body text that continues"], ["onto the second page cleanly."]],
        footer="Contoso Corp - Confidential",
    )


def test_headings_detected_with_levels():
    data = styled_pdf("Annual Report", [("Risk Factors", ["Body text here."])])
    blocks = parse_pdf(data).blocks
    heads = [(b.level, b.kind) for b in blocks if b.kind == "heading"]
    assert heads == [(1, "heading"), (2, "heading")]


def test_footer_and_page_numbers_stripped():
    text = parse_pdf(_two_page_doc()).text
    assert "Confidential" not in text


def test_paragraph_merges_across_page_break():
    result = parse_pdf(_two_page_doc())
    paras = [b for b in result.blocks if b.kind == "paragraph"]
    assert len(paras) == 1
    merged = result.text[paras[0].span[0] : paras[0].span[1]]
    assert "continues onto the second page" in merged
