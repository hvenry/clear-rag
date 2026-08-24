"""Build the SEC evaluation corpus: curated 10-K sections as PDFs + text ground truth.

SEC filings are public domain. EDGAR requires a declared User-Agent with a contact
address. For each filing this script:

1. downloads the primary 10-K HTML document,
2. locates the target Items (title-anchored, last occurrence — the body heading, not
   the table of contents or a prose cross-reference),
3. writes tag-stripped ground-truth text per Item (tables as " | "-joined rows), which
   the parse-quality differential test scores backends against,
4. renders each Item slice to PDF via headless Chromium (fallback: weasyprint),
   producing the documents the pipeline actually ingests.

Usage: python scripts/fetch_sec.py [--max-pages-per-item N] [--out evals/sec]
"""

from __future__ import annotations

import argparse
import io
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

USER_AGENT = "clear-rag research hvendittelli@gmail.com"

FILINGS = [
    {
        "company": "aapl",
        "label": "Apple Inc. 10-K FY2023",
        "url": "https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm",
    },
    {
        "company": "msft",
        "label": "Microsoft Corporation 10-K FY2023",
        "url": "https://www.sec.gov/Archives/edgar/data/789019/000095017023035122/msft-20230630.htm",
    },
]

#: (item number, slug, title anchor, next-item number, next-item title anchor).
#: The title anchor disambiguates a body heading from a prose cross-reference.
ITEMS = [
    ("1", "item1", r"Business", "1A", r"Risk\s+Factors"),
    ("1A", "item1a", r"Risk\s+Factors", "1B", r"Unresolved\s+Staff\s+Comments"),
    ("7", "item7", r"Management", "7A", r"Quantitative\s+and\s+Qualitative"),
    ("8", "item8", r"Financial\s+Statements", "9", r"Changes\s+in\s+and\s+Disagreements"),
]

#: Tag/entity noise allowed between "Item", its number, and its title in inline-XBRL
#: HTML. Bounded quantifiers throughout: an unbounded noise loop backtracks
#: catastrophically on an 8 MB filing.
_NOISE = r"(?:\s|&#160;|&nbsp;|&#8212;|—|-|\.|:|</?[^>]{0,300}>){0,60}"


def _locate(html: str, number: str, title: str) -> int | None:
    """Offset where the Item's body section begins.

    Preferred signal: an element carrying an ``id="item_1a_…"``-style anchor — filings
    that link their table of contents (Microsoft's does) mark the true body heading
    this way, which running page headers and prose cross-references never are.

    Fallback (Apple's filing has no such anchors): the *last* title-anchored textual
    occurrence of the heading. Scans for cheap "Item" anchors and applies the noisy
    pattern only to a short window after each — bounded work per candidate instead of
    one pathological regex over the whole document.
    """
    anchor_pattern = re.compile(rf'id="[^"]*item_?{re.escape(number.lower())}[_"]', re.IGNORECASE)
    anchors = list(anchor_pattern.finditer(html))
    if anchors:
        position = anchors[-1].start()
        tag_start = html.rfind("<", 0, position)
        return tag_start if tag_start != -1 else position

    pattern = re.compile(
        rf"Item{_NOISE}{re.escape(number)}\b{_NOISE}{title}",
        re.IGNORECASE | re.DOTALL,
    )
    best: int | None = None
    for candidate in re.finditer(r"Item", html, re.IGNORECASE):
        window = html[candidate.start() : candidate.start() + 4000]
        if pattern.match(window):
            best = candidate.start()
    return best


class _TextExtractor(HTMLParser):
    """Tag-stripped text with block structure: paragraphs on their own lines, table
    rows as ' | '-joined cells — the same shape the parsers emit, so parse-quality
    comparisons measure parsing rather than formatting conventions."""

    _BLOCK_TAGS = {"p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "li"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._cell: list[str] = []
        self._row: list[str] = []
        self._in_table = 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._in_table += 1
        elif tag in ("td", "th") and self._in_table:
            self._cell = []
        elif tag in self._BLOCK_TAGS and not self._in_table:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "table":
            self._in_table = max(0, self._in_table - 1)
            self.parts.append("\n")
        elif tag in ("td", "th") and self._in_table:
            self._row.append(" ".join(" ".join(self._cell).split()))
        elif tag == "tr" and self._in_table:
            cells = [c for c in self._row]
            if any(c for c in cells):
                self.parts.append("\n" + " | ".join(cells).rstrip(" |"))
            self._row = []

    def handle_data(self, data):
        if self._in_table:
            self._cell.append(data)
        else:
            self.parts.append(data)

    def text(self) -> str:
        raw = "".join(self.parts)
        lines = [" ".join(line.split()) for line in raw.splitlines()]
        out: list[str] = []
        for line in lines:
            if line:
                out.append(line)
            elif out and out[-1]:
                out.append("")
        return "\n".join(out).strip()


def _fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8", errors="replace")


def _find_renderer() -> list[str] | None:
    for name in ("chromium", "chromium-browser", "google-chrome-stable"):
        if (path := shutil.which(name)) is not None:
            return [path, "--headless", "--disable-gpu", "--no-pdf-header-footer"]
    return None


def _render_pdf(html_slice: str, head: str, out_path: Path, chromium: list[str] | None) -> None:
    document = f"<!DOCTYPE html><html>{head}<body>{html_slice}</body></html>"
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as handle:
        handle.write(document)
        src = handle.name
    if chromium is not None:
        subprocess.run(
            [*chromium, f"--print-to-pdf={out_path}", f"file://{src}"],
            check=True,
            capture_output=True,
            timeout=180,
        )
        return
    try:
        import weasyprint
    except ImportError:
        sys.exit("No PDF renderer found. Install chromium (preferred) or `pip install weasyprint`.")
    weasyprint.HTML(filename=src).write_pdf(str(out_path))


def _trim_pages(pdf_path: Path, max_pages: int) -> int:
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(str(pdf_path))
    if len(reader.pages) <= max_pages:
        return len(reader.pages)
    writer = PdfWriter()
    for page in reader.pages[:max_pages]:
        writer.add_page(page)
    buffer = io.BytesIO()
    writer.write(buffer)
    pdf_path.write_bytes(buffer.getvalue())
    return max_pages


@dataclass
class _Section:
    stem: str
    html: str


def _sections(html: str, company: str) -> list[_Section]:
    sections: list[_Section] = []
    for number, slug, title, next_number, next_title in ITEMS:
        start = _locate(html, number, title)
        end = _locate(html, next_number, next_title)
        if start is None:
            print(f"  WARNING: Item {number} not found for {company}; skipped.")
            continue
        if end is None or end <= start:
            end = min(len(html), start + 400_000)
            print(f"  WARNING: Item {next_number} anchor not found; truncating Item {number}.")
        sections.append(_Section(stem=f"{company}-10k-2023-{slug}", html=html[start:end]))
    return sections


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("evals/sec"))
    # High enough that no fetched Item actually trims: the ground truth covers the
    # whole Item, so a trimmed PDF would falsely depress word-recovery scores.
    parser.add_argument("--max-pages-per-item", type=int, default=60)
    args = parser.parse_args()

    corpus_dir = args.out / "corpus"
    truth_dir = args.out / "ground_truth"
    corpus_dir.mkdir(parents=True, exist_ok=True)
    truth_dir.mkdir(parents=True, exist_ok=True)
    chromium = _find_renderer()
    if chromium is None:
        print("chromium not found; will try weasyprint.")

    for filing in FILINGS:
        print(f"Fetching {filing['label']} …")
        html = _fetch(filing["url"])
        head_match = re.search(r"<head.*?</head>", html, re.IGNORECASE | re.DOTALL)
        head = head_match.group(0) if head_match else "<head></head>"

        for section in _sections(html, filing["company"]):
            extractor = _TextExtractor()
            extractor.feed(section.html)
            truth = extractor.text()
            (truth_dir / f"{section.stem}.txt").write_text(truth + "\n")

            pdf_path = corpus_dir / f"{section.stem}.pdf"
            _render_pdf(section.html, head, pdf_path, chromium)
            pages = _trim_pages(pdf_path, args.max_pages_per_item)
            size_kb = pdf_path.stat().st_size // 1024
            print(
                f"  {section.stem}: {pages} pages, {size_kb} KB, "
                f"{len(truth.split())} ground-truth words"
            )

    readme = args.out / "README.md"
    readme.write_text(
        "# SEC evaluation corpus\n\n"
        "Curated 10-K sections (public domain, via SEC EDGAR) used by the `sec` eval "
        "suite and the parse-quality differential test.\n\n"
        "| Filing | Source |\n|---|---|\n"
        + "\n".join(f"| {f['label']} | {f['url']} |" for f in FILINGS)
        + "\n\nRegenerate with `python scripts/fetch_sec.py`. PDFs in `corpus/` are "
        "rendered from the Item HTML slices with headless Chromium and are what the "
        "pipeline ingests; `ground_truth/*.txt` is tag-stripped text from the same "
        "slices (tables as ` | `-joined rows) and is never ingested — it is the "
        "oracle the parser backends are differentially scored against.\n"
    )
    print(f"Wrote {readme}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
