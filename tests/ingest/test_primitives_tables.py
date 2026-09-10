"""Primitives parser: table extraction: ruled grids, then aligned borderless rows."""

from clearrag.ingest.parsers.primitives import parse_pdf
from tests.pdf_fixtures import aligned_table_pdf, ruled_table_pdf


def test_ruled_table_extracted_row_major():
    data = ruled_table_pdf([["Segment", "2023", "2022"], ["Products", "298,085", "316,199"]])
    result = parse_pdf(data)
    tables = [b for b in result.blocks if b.kind == "table"]
    assert len(tables) == 1
    lines = result.text[tables[0].span[0] : tables[0].span[1]].splitlines()
    assert lines[0] == "Segment | 2023 | 2022"
    assert lines[1] == "Products | 298,085 | 316,199"


def test_justified_prose_with_years_is_not_a_table():
    # Wrapped, justified-ish prose: a few word starts coincide across lines and the
    # lines contain year tokens, the false positive that mangled a real MD&A intro.
    import io

    from reportlab.lib.pagesizes import LETTER
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    c.setFont("Helvetica", 11)
    rows = [
        [
            (72, "The following Discussion and"),
            (260, "Analysis of financial"),
            (430, "condition for"),
        ],
        [(72, "fiscal year"), (140, "ended June 30,"), (260, "2022. compared with the")],
        [(72, "prior fiscal"), (170, "year ended June 30,"), (260, "2023. should be read")],
        [(72, "in conjunction with the"), (260, "notes to financial"), (430, "statements here.")],
    ]
    y = 700
    for row in rows:
        for x, text in row:
            c.drawString(x, y, text)
        y -= 14
    c.save()
    result = parse_pdf(buf.getvalue())
    assert not [b for b in result.blocks if b.kind == "table"]


def test_aligned_table_with_spanning_header_and_indentation():
    data = aligned_table_pdf(
        [
            ["Revenue:", "", "", ""],
            ["Products", "298,085", "316,199", "297,392"],
            ["Total revenue", "394,328", "401,399", "375,521"],
        ],
        header_span="Year Ended December 31,",
        indents=[0, 12, 24],
    )
    result = parse_pdf(data)
    table = next(b for b in result.blocks if b.kind == "table")
    lines = result.text[table.span[0] : table.span[1]].splitlines()
    assert "Year Ended December 31," in lines[0]
    products = next(ln for ln in lines if "Products" in ln)
    total = next(ln for ln in lines if "Total revenue" in ln)
    assert products.startswith("   Products")  # indentation preserved
    assert total.startswith("      Total revenue")
    assert "394,328" in total
