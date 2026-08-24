# SEC evaluation corpus

Curated 10-K sections (public domain, via SEC EDGAR) used by the `sec` eval suite and the parse-quality differential test.

| Filing | Source |
|---|---|
| Apple Inc. 10-K FY2023 | https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm |
| Microsoft Corporation 10-K FY2023 | https://www.sec.gov/Archives/edgar/data/789019/000095017023035122/msft-20230630.htm |

Regenerate with `python scripts/fetch_sec.py`. PDFs in `corpus/` are rendered from the Item HTML slices with headless Chromium and are what the pipeline ingests; `ground_truth/*.txt` is tag-stripped text from the same slices (tables as ` | `-joined rows) and is never ingested — it is the oracle the parser backends are differentially scored against.

## Parse quality (differential test)

Word recovery and reading-order similarity against the HTML-derived ground truth,
via `clear-rag parse-quality`. Measured 2026-08-23:

| file | backend | word recovery | order similarity |
|---|---|---|---|
| aapl-10k-2023-item1.pdf | naive | 1.000 | 1.000 |
| aapl-10k-2023-item1.pdf | primitives | 1.000 | 1.000 |
| aapl-10k-2023-item1.pdf | docling | 0.987 | 0.993 |
| aapl-10k-2023-item1a.pdf | naive | 1.000 | 1.000 |
| aapl-10k-2023-item1a.pdf | primitives | 1.000 | 1.000 |
| aapl-10k-2023-item1a.pdf | docling | 0.991 | 0.995 |
| aapl-10k-2023-item7.pdf | naive | 1.000 | 0.998 |
| aapl-10k-2023-item7.pdf | primitives | 1.000 | 1.000 |
| aapl-10k-2023-item7.pdf | docling | 0.982 | 0.991 |
| aapl-10k-2023-item8.pdf | naive | 1.000 | 0.999 |
| aapl-10k-2023-item8.pdf | primitives | 0.999 | 0.999 |
| aapl-10k-2023-item8.pdf | docling | 0.981 | 0.985 |
| msft-10k-2023-item1.pdf | naive | 1.000 | 1.000 |
| msft-10k-2023-item1.pdf | primitives | 0.992 | 0.995 |
| msft-10k-2023-item1.pdf | docling | 0.993 | 0.996 |
| msft-10k-2023-item1a.pdf | naive | 1.000 | 1.000 |
| msft-10k-2023-item1a.pdf | primitives | 0.994 | 0.997 |
| msft-10k-2023-item1a.pdf | docling | 0.997 | 0.998 |
| msft-10k-2023-item7.pdf | naive | 1.000 | 1.000 |
| msft-10k-2023-item7.pdf | primitives | 0.991 | 0.991 |
| msft-10k-2023-item7.pdf | docling | 0.992 | 0.973 |
| msft-10k-2023-item8.pdf | naive | 1.000 | 1.000 |
| msft-10k-2023-item8.pdf | primitives | 0.989 | 0.988 |
| msft-10k-2023-item8.pdf | docling | 0.985 | 0.978 |

An honest caveat: these PDFs are born-digital Chromium renders of linear HTML, which
is the *best case* for flat extraction — pypdf emits the content stream in reading
order, so `naive` scores near-perfect here. The primitives parser earns its keep on
what recovery/order cannot see: typed structure (headings, tables as tables, page
provenance) that structural chunking and breadcrumb contexts consume. On scanned or
natively multi-column PDFs the ordering comparison would separate the backends far
more; this corpus measures structure fidelity, not extraction difficulty.

The two findings this test caught during development are worth keeping: a page-wide
"mega grid" built from 186 row-shading rects was swallowing prose between two tables
into phantom cells (order similarity 0.78 → 0.99 after the fix), and partial-page
column bands were interleaving side-by-side lines that whole-page gutter detection
could not see.

## Retrieval ablation (real models)

`clear-rag ablate --suite sec` with llama3.2 + nomic-embed-text via Ollama and the
ONNX cross-encoder reranker, measured 2026-08-23. Retrieval-side metrics over the
42-question golden set (39 answerable):

| Configuration | recall@1 | recall@5 | MRR | nDCG@5 | table | structure | cross-company |
|---|---|---|---|---|---|---|---|
| naive parser | 0.564 | 0.872 | 0.697 | 0.779 | 0.636 | 0.875 | 0.889 |
| primitives parser | 0.462 | 0.846 | 0.609 | 0.696 | 0.545 | 0.875 | 0.778 |
| docling parser | 0.385 | 0.718 | 0.521 | 0.611 | 0.455 | 0.750 | 0.667 |
| primitives + semantic chunking | 0.487 | 0.769 | 0.615 | 0.655 | 0.273 | 0.875 | 0.778 |
| primitives + breadcrumb context | 0.462 | 0.846 | 0.611 | 0.696 | 0.545 | 0.875 | 0.778 |
| primitives + LLM context | 0.436 | 0.846 | 0.594 | 0.684 | 0.545 | 0.875 | 0.778 |
| primitives + semantic + breadcrumb | 0.487 | 0.769 | 0.615 | 0.655 | 0.273 | 0.875 | 0.778 |

> marker is wired as a backend and passes its contract test (via a local
> `llama-server` for surya's models), but its ablation row was cancelled mid-run —
> CPU-only inference was impractically slow. Rerun when a GPU path is configured:
> `SURYA_INFERENCE_BACKEND=llamacpp LLAMA_CPP_BINARY=<path> clear-rag ablate --suite sec`
> from a venv with the `[marker]` extra.


**What the numbers say — three honest findings, none of them the marketing version:**

1. **Naive extraction wins on this corpus.** recall@5 0.872 vs 0.846: the flat pypdf
   text beat the structured parse by two questions. Chromium-rendered single-column
   PDFs are flat extraction's best case (see the parse-quality caveat above), and
   structure-preserving table rendering (`cell | cell` rows) buys nothing at
   retrieval time on questions BM25 can already match by rare tokens. The primitives
   parser's value shows up in *structure consumers* — chunk boundaries, breadcrumbs,
   page provenance — not in raw retrieval on clean renders. A scanned or natively
   multi-column corpus is where this row should flip; that corpus does not exist
   here yet, and this table refuses to pretend otherwise. **docling underperforms
   both** (recall@5 0.718, two labelled quotes lost to its parse, and most of its
   misses are financial-table questions): its ML table reconstruction rewrites row
   structure aggressively enough that labels stop resolving and table content lands
   in worse-ranking chunks. On clean renders, the 300 MB of layout models buy
   negative retrieval value over 400 lines of geometry heuristics — the strongest
   argument this table makes for the build-from-primitives decision.
2. **Semantic chunking is a regression for financial tables** (table recall@5
   0.545 → 0.273, three lost questions all in Item 8 statements). Heading-bounded
   packing folds a statement's table into one large section chunk whose embedding
   and BM25 profile is diluted by surrounding prose. Fixed-size chunking accidentally
   isolates table rows better. The obvious Phase-4.5 fix — treat table blocks as
   atomic chunks instead of packing them into sections — falls straight out of the
   block model, and now has a number waiting to judge it.
3. **Contextual retrieval changed nothing measurable here** (± one question). The
   corpus has two companies with strongly distinct vocabulary, so chunks are rarely
   ambiguous enough for a breadcrumb or an LLM blurb to matter; the cross-company
   distractor questions were already resolved by content terms. The technique's
   motivating case — many near-identical documents — is not this corpus. The LLM
   variant also costs one generation per chunk at index time, so on this evidence
   the free breadcrumb is strictly the better default, and neither earns its keep
   on retrieval metrics alone. Answer-side grounding (`--generate`) may yet
   separate them: a situating sentence is visible to the *generator* too.
