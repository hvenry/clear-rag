"""Synthetic PDF builders for parser tests.

Every fixture draws text at explicit coordinates with reportlab, so each geometric
property the primitives parser infers (column gutters, heading sizes, table alignment,
repeated footers) was planted deliberately and the assertions test inference, not luck.
"""

from __future__ import annotations

import io

from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas

WIDTH, HEIGHT = LETTER


def simple_pdf(paragraphs: list[str]) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    c.setFont("Helvetica", 11)
    y = HEIGHT - 72
    for para in paragraphs:
        for line in para.split("\n"):
            c.drawString(72, y, line)
            y -= 14
        y -= 14  # blank line between paragraphs
    c.save()
    return buf.getvalue()


def two_column_pdf(left_lines: list[str], right_lines: list[str]) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    c.setFont("Helvetica", 11)
    for i, line in enumerate(left_lines):
        c.drawString(54, HEIGHT - 72 - 14 * i, line)
    for i, line in enumerate(right_lines):
        c.drawString(WIDTH / 2 + 18, HEIGHT - 72 - 14 * i, line)
    c.save()
    return buf.getvalue()


def styled_pdf(title: str, sections: list[tuple[str, list[str]]]) -> bytes:
    """A title (bold 18), section headings (bold 14), body paragraphs (regular 11)."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    y = HEIGHT - 72
    c.setFont("Helvetica-Bold", 18)
    c.drawString(72, y, title)
    y -= 30
    for heading, paragraphs in sections:
        c.setFont("Helvetica-Bold", 14)
        c.drawString(72, y, heading)
        y -= 22
        c.setFont("Helvetica", 11)
        for para in paragraphs:
            for line in para.split("\n"):
                c.drawString(72, y, line)
                y -= 14
            y -= 14
    c.save()
    return buf.getvalue()


def repeated_footer_pdf(page_paragraphs: list[list[str]], footer: str) -> bytes:
    """Multi-page: body paragraphs per page, the same footer + page number on each.

    The last paragraph of each page deliberately carries no terminal punctuation, so a
    parser that merges across page breaks has something to merge.
    """
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    for number, paragraphs in enumerate(page_paragraphs, start=1):
        c.setFont("Helvetica", 11)
        y = HEIGHT - 72
        for para in paragraphs:
            for line in para.split("\n"):
                c.drawString(72, y, line)
                y -= 14
            y -= 14
        c.setFont("Helvetica", 9)
        c.drawString(72, 40, footer)
        c.drawString(WIDTH / 2, 28, str(number))
        c.showPage()
    c.save()
    return buf.getvalue()


def ruled_table_pdf(rows: list[list[str]]) -> bytes:
    """A fully ruled grid with cell text inset from each cell's top-left corner."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    c.setFont("Helvetica", 11)
    n_cols = len(rows[0])
    col_width, row_height = 120, 24
    x0, y_top = 72, HEIGHT - 100
    xs = [x0 + i * col_width for i in range(n_cols + 1)]
    ys = [y_top - i * row_height for i in range(len(rows) + 1)]
    c.grid(xs, ys)
    for r, row in enumerate(rows):
        for col, cell in enumerate(row):
            c.drawString(xs[col] + 4, ys[r] - row_height + 8, cell)
    c.save()
    return buf.getvalue()


STOPS = (72, 260, 360, 460)


def aligned_table_pdf(
    rows: list[list[str]],
    header_span: str | None = None,
    indents: list[int] | None = None,
) -> bytes:
    """Borderless rows aligned at fixed x stops; optional spanning header above."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    c.setFont("Helvetica", 11)
    y = HEIGHT - 100
    if header_span is not None:
        c.drawString(STOPS[1] + 20, y, header_span)
        y -= 16
    for i, row in enumerate(rows):
        indent = indents[i] if indents else 0
        for col, cell in enumerate(row):
            if cell:
                c.drawString(STOPS[col] + (indent if col == 0 else 0), y, cell)
        y -= 14
    c.save()
    return buf.getvalue()
