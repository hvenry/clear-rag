# Parsers

Pluggable PDF parser backends that turn a PDF into canonical text plus typed structure blocks.

## Why
Parsing is the hardest stage of RAG and usually a black box, yet every later stage inherits its mistakes.
Making the backend a config knob (`parser`) turns parse quality into a measured variable: the SEC suite and `clear-rag parse-quality` compare backends on the same filings.
Typed blocks are what structural chunking, breadcrumb context and the Library's structure view consume; without them, those features have nothing to cut along.

## How it works
`ingest/parsers/__init__.py` holds a registry of `name -> (import probe, install remedy)`.
`parse_pdf(data, backend)` checks the probe with `importlib.util.find_spec`, imports `ingest/parsers/<backend>.py` lazily, and calls its `parse_pdf`.
Every backend returns the same `BackendResult`: `text`, `blocks`, `page_map` and `diagnostics`, so the rest of the pipeline cannot tell backends apart.

A `Block` (`core/types.py`) is a `heading`, `paragraph` or `table` with a `span` into the same text chunks use, a heading `level` (0 for non-headings) and a page.
`page_map` is a list of `(char_offset, page_number)` breakpoints; `Document.page_at` maps any offset to its page.

**Backends.**
- `naive` - pypdf text extraction, one paragraph block per page; the ablation baseline, always available.
- `primitives` - the hand-rolled layout parser over pdfplumber word geometry; the default.
- `docling` - IBM docling's layout and TableFormer models, mapped to headings, paragraphs and pipe-delimited tables; optional extra.
- `marker` - datalab marker's JSON render walked into the same block kinds; optional extra.

**The primitives parser** (`ingest/parsers/primitives.py`) uses pdfplumber only to extract positioned words and line/rect edges; every layout decision is its own:
1. Strip furniture: lines that recur in the top or bottom 10% band across most pages, and bare page numbers there.
2. Extract ruled tables from edge grids, grouped into vertically connected regions first.
3. Detect aligned (unruled) tables before column handling, since a table's column gap looks like a page gutter.
4. Group words into lines, reorder side-by-side column bands into reading order, and split paragraphs on vertical gaps.
5. Mark headings by font size ratio, word count and missing terminal punctuation, then assign levels across the document.
6. Slot tables back into the flow by vertical position, merge paragraphs that continue across a page break, and assemble text with `\n\n` joins and exact spans.
Its tunable thresholds are module constants at the top of the file.

**Fallback.** `Engine.ingest` checks `available_backends()` for PDFs before parsing.
If the configured backend is not installed, it parses with `naive`, marks the parse stage `degraded`, and records the install remedy in the trace error.
Non-PDF formats ignore the knob (see [ingestion](ingestion.md)).
The document's `meta.parser` records which backend produced its text.

## Tech
pypdf, pdfplumber, optional `docling` and `marker-pdf` extras (`pip install -e ".[docling]"`, `pip install -e ".[marker]"`), reportlab in tests for synthetic PDFs.

## Key files
- `src/clearrag/ingest/parsers/__init__.py` - registry, availability probe, remedies, `parse_pdf`
- `src/clearrag/ingest/parsers/base.py` - `BackendResult`, `ParserUnavailable`
- `src/clearrag/ingest/parsers/naive.py` - pypdf baseline
- `src/clearrag/ingest/parsers/primitives.py` - geometric layout parser
- `src/clearrag/ingest/parsers/docling.py` - docling adapter
- `src/clearrag/ingest/parsers/marker.py` - marker adapter
- `src/clearrag/eval/parse_quality.py` - differential test of backends against HTML ground truth
- `tests/pdf_fixtures.py` - synthetic PDFs with planted geometry for the primitives tests
- `tests/ingest/test_primitives_*.py` - columns, structure, tables, ingest

## Decisions and gotchas
- **Heavy backends import inside their function**, so the package always imports and an absent extra fails with a remedy, never an `ImportError`.
- **A missing backend never breaks ingestion.** It degrades to `naive` loudly, in the trace, rather than failing the upload.
- **Primitives scope is bounded:** text-based PDFs only, no OCR and no nested tables; scanned PDFs raise `EmptyExtraction` with an `ocrmypdf` hint.
- **Detector order matters.** Ruled tables, then aligned tables, then column reordering; whichever detector runs first claims the words.
- **Edge regions before grids.** Treating every edge on a page as one grid turned a page of table shading into phantom cells swallowing the prose; the differential test caught it on a real 10-K page.
- **marker licence:** GPL-3.0, and its surya weights carry a commercial-use restriction; its surya models also need an inference server (GPU vllm or a local `llama-server`), so it has no measured ablation row yet.
- Parse-quality results live in `evals/results/parse-quality.json`; see [evaluation](evaluation.md) for how they are produced.

## Related
- [Ingestion](ingestion.md)
- [Evaluation](evaluation.md)
- [Results files](results-files.md)
- [Atomic table chunks spec](specs/atomic-table-chunks.md)
