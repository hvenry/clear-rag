"""The hand-rolled PDF layout parser.

A PDF contains no paragraphs, headings, columns or tables — only positioned glyphs and
drawn lines. Everything this module emits is *inferred* from that geometry, which is
exactly why it exists: the hardest stage of RAG should be visible and measured, not a
black box. pdfplumber is used strictly as the primitive extractor (words with positions,
line/rect geometry); every layout decision above that is made here, in plain sight.

Scope, deliberately bounded (see the Phase 4 spec): text-based PDFs, multi-column
reading order, heading inference, header/footer stripping, cross-page paragraph merge,
and simple tables (ruled, or consistently aligned, with spanning headers). No OCR, no
nested tables — those are the documented trigger for the docling/marker backends.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

from ...core.types import Block
from .base import BackendResult

#: Words whose tops are within this many points sit on the same visual line.
LINE_TOLERANCE = 2.0
#: A vertical gap larger than this multiple of the line height starts a new paragraph.
PARAGRAPH_GAP = 0.9
#: A paragraph whose median font size is at least this multiple of the body size,
#: with few words and no terminal period, is a heading.
HEADING_SIZE_RATIO = 1.15
HEADING_MAX_WORDS = 12
#: Repeated lines in the top/bottom this fraction of the page are headers/footers.
FURNITURE_BAND = 0.10
#: Column gutters: an empty vertical band at least this wide (points) splits columns.
GUTTER_MIN_WIDTH = 18.0
#: ...provided it is empty on at least this share of the page's lines.

_TERMINAL = (".", "!", "?", ":", ";", '"')


@dataclass
class _Word:
    text: str
    x0: float
    x1: float
    top: float
    bottom: float
    size: float
    bold: bool


@dataclass
class _Proto:
    """A block before spans exist: text plus what kind of thing it is."""

    kind: str  # "heading" | "paragraph" | "table"
    text: str
    size: float = 0.0
    level: int = 0
    page: int = 0
    top: float = 0.0
    """Vertical position on the page, used to slot tables into the reading flow."""
    #: Set on paragraphs that may continue onto the next page (no terminal punctuation).
    open_ended: bool = False


def parse_pdf(data: bytes) -> BackendResult:
    import pdfplumber

    pages_words: list[list[_Word]] = []
    pages_edges: list[tuple[list, list]] = []
    page_dims: list[tuple[float, float]] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            pages_words.append(
                [
                    _Word(
                        text=w["text"],
                        x0=float(w["x0"]),
                        x1=float(w["x1"]),
                        top=float(w["top"]),
                        bottom=float(w["bottom"]),
                        size=float(w.get("size", 11.0)),
                        bold="Bold" in str(w.get("fontname", "")),
                    )
                    for w in page.extract_words(extra_attrs=["size", "fontname"])
                ]
            )
            pages_edges.append(_page_edges(page))
            page_dims.append((float(page.width), float(page.height)))

    pages_words = _strip_furniture(pages_words, page_dims)
    body_size = _median([w.size for words in pages_words for w in words]) or 11.0

    pages_protos: list[list[_Proto]] = []
    for number, (words, edges) in enumerate(zip(pages_words, pages_edges, strict=True), start=1):
        table_protos, flow_words = _ruled_tables(words, edges, number)
        # Aligned-table detection runs before column reordering on purpose: a table's
        # gap between its label and number columns is geometrically identical to a
        # page-column gutter, and whichever detector runs first claims the words.
        aligned_protos, flow_words = _aligned_tables_page(flow_words, number)
        lines = _reorder_column_bands(_lines(flow_words))
        protos = _column_protos(lines, number, body_size)
        pages_protos.append(_slot_tables(protos, table_protos + aligned_protos))

    _assign_heading_levels(pages_protos, body_size)
    return _assemble(pages_protos)


# ── Lines and paragraphs ────────────────────────────────────────────────────────


def _lines(words: list[_Word], tolerance: float = LINE_TOLERANCE) -> list[list[_Word]]:
    """Cluster words into visual lines by top coordinate, reading order within a line."""
    if not words:
        return []
    lines: list[list[_Word]] = []
    for word in sorted(words, key=lambda w: (w.top, w.x0)):
        if lines and abs(word.top - lines[-1][0].top) <= tolerance:
            lines[-1].append(word)
        else:
            lines.append([word])
    for line in lines:
        line.sort(key=lambda w: w.x0)
    return lines


def _line_text(line: list[_Word]) -> str:
    return " ".join(w.text for w in line)


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def _line_height(lines: list[list[_Word]]) -> float:
    return _median([w.bottom - w.top for line in lines for w in line]) or 12.0


def _paragraphs(lines: list[list[_Word]]) -> list[list[list[_Word]]]:
    """Group consecutive lines into paragraphs.

    Two signals break a group: a vertical gap larger than a line, and a wholesale
    font-size shift — a heading sits close above its body text, so style change is
    the only separator a tight layout leaves.
    """
    if not lines:
        return []
    height = _line_height(lines)
    groups: list[list[list[_Word]]] = [[lines[0]]]
    for prev, line in zip(lines, lines[1:], strict=False):
        gap = min(w.top for w in line) - max(w.bottom for w in prev)
        size_shift = abs(
            (_median([w.size for w in line]) or 0) - (_median([w.size for w in prev]) or 0)
        )
        # A negative gap means the next line sits back *up* the page — a column jump
        # introduced by band reordering — which is always a paragraph boundary.
        if gap > PARAGRAPH_GAP * height or gap < -LINE_TOLERANCE or size_shift > 1.0:
            groups.append([line])
        else:
            groups[-1].append(line)
    return groups


def _aligned_tables_page(words: list[_Word], page_number: int) -> tuple[list[_Proto], list[_Word]]:
    protos: list[_Proto] = []
    consumed: set[int] = set()
    for para_lines in _paragraphs(_lines(words)):
        if (table := _aligned_table(para_lines, page_number)) is not None:
            protos.append(table)
            consumed.update(id(w) for line in para_lines for w in line)
    return protos, [w for w in words if id(w) not in consumed]


def _column_protos(lines: list[list[_Word]], page_number: int, body_size: float) -> list[_Proto]:
    protos: list[_Proto] = []
    for para_lines in _paragraphs(lines):
        text = " ".join(_line_text(line) for line in para_lines)
        group_words = [w for line in para_lines for w in line]
        size = _median([w.size for w in group_words]) or body_size
        top = min(w.top for w in group_words)
        if _is_heading(text, group_words, size, body_size):
            protos.append(_Proto(kind="heading", text=text, size=size, page=page_number, top=top))
        else:
            protos.append(
                _Proto(
                    kind="paragraph",
                    text=text,
                    size=size,
                    page=page_number,
                    top=top,
                    open_ended=not text.rstrip().endswith(_TERMINAL),
                )
            )
    return protos


# ── Headings ────────────────────────────────────────────────────────────────────


def _is_heading(text: str, words: list[_Word], size: float, body_size: float) -> bool:
    if len(words) > HEADING_MAX_WORDS or text.rstrip().endswith("."):
        return False
    if size >= HEADING_SIZE_RATIO * body_size:
        return True
    return all(w.bold for w in words) and size >= body_size


def _assign_heading_levels(pages_protos: list[list[_Proto]], body_size: float) -> None:
    """Rank heading font sizes document-wide: largest size is level 1, capped at 3."""
    sizes = sorted(
        {round(p.size, 1) for protos in pages_protos for p in protos if p.kind == "heading"},
        reverse=True,
    )
    level_of = {size: min(i + 1, 3) for i, size in enumerate(sizes)}
    for protos in pages_protos:
        for proto in protos:
            if proto.kind == "heading":
                proto.level = level_of[round(proto.size, 1)]


# ── Page furniture ──────────────────────────────────────────────────────────────


def _strip_furniture(
    pages_words: list[list[_Word]], page_dims: list[tuple[float, float]]
) -> list[list[_Word]]:
    """Drop repeated headers/footers and page numbers from the margins.

    A line is furniture when its text recurs at a similar position in the top or
    bottom band of most pages — or is a bare number in those bands, which catches
    page numbers that differ on every page.
    """
    if len(pages_words) < 2:
        return pages_words

    from collections import Counter

    band_lines: list[list[tuple[str, list[_Word]]]] = []
    counts: Counter[str] = Counter()
    for words, (_width, height) in zip(pages_words, page_dims, strict=True):
        page_band: list[tuple[str, list[_Word]]] = []
        for line in _lines(words):
            top = min(w.top for w in line)
            if top < FURNITURE_BAND * height or top > (1 - FURNITURE_BAND) * height:
                text = _line_text(line).strip()
                page_band.append((text, line))
                counts[text] += 1
        band_lines.append(page_band)

    needed = max(2, int(0.6 * len(pages_words)))
    stripped: list[list[_Word]] = []
    for words, page_band in zip(pages_words, band_lines, strict=True):
        drop: set[int] = set()
        for text, line in page_band:
            if counts[text] >= needed or text.replace(" ", "").isdigit():
                drop.update(id(w) for w in line)
        stripped.append([w for w in words if id(w) not in drop])
    return stripped


# ── Ruled tables ────────────────────────────────────────────────────────────────
#
# The visual grid of a ruled table is real ink whose geometry survives in the PDF, so
# extraction is genuinely mechanical: cluster the drawn line positions into row and
# column edges, then drop each word into the cell whose box contains its centre.

_EDGE_TOLERANCE = 2.0


def _page_edges(page) -> tuple[list[float], list[tuple[float, float, float]]]:
    """Drawn edges: horizontal y-positions, and vertical edges as (x, top, bottom).

    Vertical edges keep their extent so table-region detection can ask which of them
    belong to which vertical band of the page.
    """
    horizontal: list[float] = []
    vertical: list[tuple[float, float, float]] = []
    for ln in page.lines:
        if abs(float(ln["top"]) - float(ln["bottom"])) < 1:
            horizontal.append(float(ln["top"]))
        elif abs(float(ln["x0"]) - float(ln["x1"])) < 1:
            vertical.append((float(ln["x0"]), float(ln["top"]), float(ln["bottom"])))
    for r in page.rects:
        horizontal += [float(r["top"]), float(r["bottom"])]
        vertical.append((float(r["x0"]), float(r["top"]), float(r["bottom"])))
        vertical.append((float(r["x1"]), float(r["top"]), float(r["bottom"])))
    return horizontal, vertical


def _cluster(values: list[float], tolerance: float = _EDGE_TOLERANCE) -> list[float]:
    ordered = sorted(values)
    clusters: list[list[float]] = []
    for v in ordered:
        if clusters and v - clusters[-1][-1] <= tolerance:
            clusters[-1].append(v)
        else:
            clusters.append([v])
    return [sum(c) / len(c) for c in clusters]


#: Adjacent row edges further apart than this are different tables, not one grid.
#: Chosen well above any plausible row height so a busy table stays whole, while the
#: prose between two tables on one page never gets swallowed into a mega-grid.
_ROW_GAP_LIMIT = 40.0


def _ruled_tables(
    words: list[_Word],
    edges: tuple[list[float], list[tuple[float, float, float]]],
    page_number: int,
) -> tuple[list[_Proto], list[_Word]]:
    """Extract grid tables; return table protos plus the words left in normal flow.

    Edges are grouped into vertically connected *regions* first — a page carrying two
    shaded tables with prose between them has two separate grids, and treating every
    edge on the page as one grid consumes the prose into phantom cells (a failure the
    differential test caught on a real MD&A page with 186 shading rects).
    """
    all_ys = _cluster(edges[0])
    protos: list[_Proto] = []
    consumed: set[int] = set()

    region: list[float] = []
    for y in [*all_ys, None]:
        if y is not None and (not region or y - region[-1] <= _ROW_GAP_LIMIT):
            region.append(y)
            continue
        if len(region) >= 3:
            proto, taken = _grid_region(words, region, edges[1], page_number)
            if proto is not None:
                protos.append(proto)
                consumed |= taken
        region = [y] if y is not None else []

    return protos, [w for w in words if id(w) not in consumed]


def _grid_region(
    words: list[_Word],
    ys: list[float],
    v_edges: list[tuple[float, float, float]],
    page_number: int,
) -> tuple[_Proto | None, set[int]]:
    y_lo, y_hi = min(ys), max(ys)
    xs = _cluster(
        [
            x
            for x, top, bottom in v_edges
            if min(bottom, y_hi) - max(top, y_lo) > 0  # vertical extent overlaps region
        ]
    )
    # A 2-row table draws 3 horizontal and at least 3 vertical edges; a stray
    # underline draws 1 and must not trigger.
    if len(xs) < 3:
        return None, set()
    x_lo, x_hi = min(xs), max(xs)

    inside = [
        w
        for w in words
        if x_lo <= (w.x0 + w.x1) / 2 <= x_hi and y_lo <= (w.top + w.bottom) / 2 <= y_hi
    ]
    if not inside:
        return None, set()

    rows: list[str] = []
    for row_top, row_bottom in zip(ys, ys[1:], strict=False):
        cells: list[str] = []
        for col_left, col_right in zip(xs, xs[1:], strict=False):
            cell_words = [
                w
                for w in inside
                if col_left <= (w.x0 + w.x1) / 2 <= col_right
                and row_top <= (w.top + w.bottom) / 2 <= row_bottom
            ]
            cells.append(" ".join(_line_text(line) for line in _lines(cell_words)))
        rows.append(" | ".join(cells).rstrip(" |"))

    proto = _Proto(kind="table", text="\n".join(r for r in rows if r.strip()), page=page_number)
    proto.top = y_lo
    return proto, {id(w) for w in inside}


def _slot_tables(flow: list[_Proto], tables: list[_Proto]) -> list[_Proto]:
    """Insert table protos into the reading flow by vertical position."""
    protos = list(flow)
    for table in tables:
        index = next((i for i, p in enumerate(protos) if p.top > table.top), len(protos))
        protos.insert(index, table)
    return protos


# ── Aligned (borderless) tables ─────────────────────────────────────────────────
#
# No ink to read back here: the only evidence of a table is that word left-edges
# repeat at the same x positions across consecutive lines. Financial statements are
# the archetype — right-aligned numbers under year columns, label column on the left,
# hierarchy carried entirely by indentation.

_STOP_TOLERANCE = 3.0
_STOP_MATCH = 6.0
_MIN_TABLE_LINES = 3
#: Points of x-offset rendered as one leading space, preserving indent hierarchy.
_INDENT_UNIT = 4.0


def _aligned_table(para_lines: list[list[_Word]], page_number: int) -> _Proto | None:
    if len(para_lines) < _MIN_TABLE_LINES:
        return None
    x_min = min(w.x0 for line in para_lines for w in line)
    interior_from = x_min + 20

    # Cluster interior word left-edges; a stop must recur on most lines that have
    # interior words at all (label-only rows and spanning headers don't vote).
    base_lines = [line for line in para_lines if any(w.x0 > interior_from for w in line)]
    if len(base_lines) < 2:
        return None
    edges = [w.x0 for line in base_lines for w in line if w.x0 > interior_from]
    stops: list[float] = []
    for candidate in _cluster(edges, _STOP_TOLERANCE):
        support = sum(
            1 for line in base_lines if any(abs(w.x0 - candidate) <= _STOP_MATCH for w in line)
        )
        if support >= max(2, int(0.6 * len(base_lines))):
            stops.append(candidate)
    if len(stops) < 2:
        return None

    # Scope guard: this detector targets financial-statement-style tables, whose data
    # columns are numbers. Without it, two columns of prose whose words happen to
    # align read as a table. Numeric-majority in the stop-aligned cells is the
    # discriminator — a documented limitation for borderless all-text tables.
    aligned_words = [
        w for line in base_lines for w in line if any(abs(w.x0 - s) <= _STOP_MATCH for s in stops)
    ]
    numeric = [w for w in aligned_words if any(ch.isdigit() for ch in w.text)]
    if not aligned_words or len(numeric) / len(aligned_words) < 0.5:
        return None

    # Coverage guard: in a real table, most interior words sit on the stops. In
    # justified prose, wrapped lines share only coincidental positions (plus year
    # tokens for the numeric vote) — sparse alignment is the tell. "Interior" uses
    # the leading-cell boundary the renderer uses, so indented labels do not vote.
    interior_words = [w for line in base_lines for w in line if w.x0 > stops[0] - _STOP_MATCH]
    if interior_words and len(aligned_words) / len(interior_words) < 0.55:
        return None

    rows: list[str] = []
    for line in para_lines:
        interior = [w for w in line if w.x0 > stops[0] - _STOP_MATCH]
        aligned = [w for w in interior if any(abs(w.x0 - s) <= _STOP_MATCH for s in stops)]
        if interior and len(aligned) / len(interior) < 0.5:
            # A spanning header: its words sit between stops, not on them. Render as
            # plain text so "Year Ended December 31," survives as one phrase.
            rows.append(_line_text(line))
            continue
        leading = [w for w in line if w.x0 <= stops[0] - _STOP_MATCH]
        indent = (
            " " * int(round((min(w.x0 for w in leading) - x_min) / _INDENT_UNIT)) if leading else ""
        )
        cells = [indent + _line_text(leading)] if leading else [indent]
        for lo, hi in zip(stops, [*stops[1:], float("inf")], strict=False):
            cell_words = [w for w in interior if lo - _STOP_MATCH <= w.x0 < hi - _STOP_MATCH]
            cells.append(_line_text(cell_words))
        rows.append(" | ".join(cells).rstrip(" |"))

    proto = _Proto(
        kind="table",
        text="\n".join(r for r in rows if r.strip()),
        page=page_number,
        top=min(w.top for line in para_lines for w in line),
    )
    return proto


# ── Columns ─────────────────────────────────────────────────────────────────────
#
# Column layouts are detected per vertical *band*, not per page: a page whose middle
# section is two-column while its header and footer paragraphs run full width never
# shows a page-wide empty gutter, and treating the page as one column interleaves the
# side-by-side lines — the exact failure the differential test caught on real MD&A
# sections. A band is a run of consecutive lines that all leave the same gutter free.

_GUTTER_ZONE = 6.0
_MIN_BAND_LINES = 3


def _reorder_column_bands(lines: list[list[_Word]]) -> list[list[_Word]]:
    """Rewrite side-by-side line runs into reading order: left column, then right."""
    if len(lines) < _MIN_BAND_LINES:
        return lines

    candidates: list[float] = []
    for line in lines:
        for a, b in zip(line, line[1:], strict=False):
            if b.x0 - a.x1 >= GUTTER_MIN_WIDTH:
                candidates.append((a.x1 + b.x0) / 2)

    out = list(lines)
    for split in _cluster(candidates, 12.0):

        def crosses(line: list[_Word], split: float = split) -> bool:
            return any(w.x0 < split + _GUTTER_ZONE and w.x1 > split - _GUTTER_ZONE for w in line)

        def two_sided(line: list[_Word], split: float = split) -> bool:
            centres = [(w.x0 + w.x1) / 2 for w in line]
            return any(c < split for c in centres) and any(c > split for c in centres)

        rewritten: list[list[_Word]] = []
        run: list[list[_Word]] = []
        for line in out:
            if crosses(line):
                _flush_band(rewritten, run, split, two_sided)
                rewritten.append(line)
            else:
                run.append(line)
        _flush_band(rewritten, run, split, two_sided)
        out = rewritten
    return out


def _flush_band(
    rewritten: list[list[_Word]],
    run: list[list[_Word]],
    split: float,
    two_sided,
) -> None:
    """Emit a pending run: reordered into columns when it really was one, as-is otherwise."""
    if len(run) >= _MIN_BAND_LINES and sum(1 for ln in run if two_sided(ln)) >= 2:
        left = [[w for w in ln if (w.x0 + w.x1) / 2 < split] for ln in run]
        right = [[w for w in ln if (w.x0 + w.x1) / 2 > split] for ln in run]
        rewritten.extend(ln for ln in left if ln)
        rewritten.extend(ln for ln in right if ln)
    else:
        rewritten.extend(run)
    run.clear()


# ── Assembly ────────────────────────────────────────────────────────────────────


def _assemble(pages_protos: list[list[_Proto]]) -> BackendResult:
    """Join protos into canonical text, computing spans and the page map.

    Cross-page paragraph reassembly happens here, because assembly owns the joins: a
    page ending mid-sentence merges with a next page starting lowercase, contributing
    one block and a single-space join instead of a paragraph break.
    """
    merged: list[_Proto] = []
    page_starts: dict[int, int] = {}  # page -> index into merged where it begins

    for protos in pages_protos:
        for i, proto in enumerate(protos):
            previous = merged[-1] if merged else None
            if (
                i == 0
                and previous is not None
                and previous.kind == "paragraph"
                and previous.open_ended
                and proto.kind == "paragraph"
                and proto.text[:1].islower()
            ):
                page_starts.setdefault(proto.page, len(merged) - 1)
                previous.text = f"{previous.text} {proto.text}"
                previous.open_ended = proto.open_ended
                continue
            page_starts.setdefault(proto.page, len(merged))
            merged.append(proto)

    blocks: list[Block] = []
    parts: list[str] = []
    page_map: list[tuple[int, int]] = []
    offset = 0
    starts = {index: page for page, index in sorted(page_starts.items())}
    for i, proto in enumerate(merged):
        if i in starts:
            page_map.append((offset, starts[i]))
        blocks.append(
            Block(
                kind=proto.kind,
                span=(offset, offset + len(proto.text)),
                level=proto.level,
                page=proto.page,
            )
        )
        parts.append(proto.text)
        offset += len(proto.text) + 2  # "\n\n" join below

    return BackendResult(
        text="\n\n".join(parts),
        blocks=blocks,
        page_map=page_map,
        diagnostics={
            "backend": "primitives",
            "pages": len(pages_protos),
            "blocks": len(blocks),
        },
    )
