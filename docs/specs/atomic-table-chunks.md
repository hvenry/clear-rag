# Atomic table chunks

**Status:** draft

Under semantic chunking each parsed table becomes a chunk of its own, so a question about a financial statement retrieves the table rather than a large section that happens to contain it.

## Goal
Semantic chunking packs whole heading-bounded sections up to the token budget, which folds a statement's table into one large mixed chunk.
On the SEC suite that chunk ranks worse than the accidental isolation fixed-size cutting provides, and the `table` column drops sharply (see the SEC table in the README).
The typed blocks already mark every table, so the fix is a chunking rule, not a parser change.
It worked if `primitives + semantic chunking` recovers the `table` column to at least the recursive-chunking row without losing `structure`.

## Scope
- In: table blocks as chunk boundaries in `chunk_structural`, an over-budget table policy, a breadcrumb for table chunks, a new SEC ablation row.
- Out: table-to-text serialisation, cell-level retrieval, and changes to recursive chunking.

## Design
Builds on [ingestion](../ingestion.md) and the block model in [parsers](../parsers.md).

- **Boundaries.** In `src/clearrag/ingest/structural.py`, `_sections` gains table awareness: a `table` block closes the current section and forms a section of its own, and the next block opens a new one.
  `_packed_spans` must never merge a table section with a neighbour, so it is emitted directly rather than offered to the greedy packer.
- **Over-budget tables.** A table above `chunk_size` is split on row boundaries (line breaks inside the table span), never mid-row, and each piece keeps the table's header row in its context preamble rather than its text, so spans stay exact.
- **Context.** `apply_breadcrumbs` in `src/clearrag/ingest/contextualize.py` already builds a heading path; table chunks get the same path plus "Table" so BM25 and the embedder see what statement the numbers belong to.
- **Knob.** None.
  This becomes the behaviour of `chunker="semantic"`, since the current behaviour is a measured defect rather than an alternative worth keeping.
  The old row stays in `evals/results/sec.json` as an imported row so the before and after both remain visible.
- **Diagnostics.** The chunk stage records `table_chunks` so the Library shows how many tables were isolated.

## Tasks
- [ ] Add a failing test in `tests/ingest/test_structural_chunk.py` that a table block between two paragraphs yields its own chunk with an exact span.
- [ ] Implement table boundaries in `_sections` and `_packed_spans`.
- [ ] Implement row-boundary splitting for over-budget tables, with a test using a reportlab table fixture from `tests/pdf_fixtures.py`.
- [ ] Extend breadcrumbs for table chunks and record `table_chunks` in diagnostics.
- [ ] Re-run `clear-rag ablate --suite sec --save-results` and re-render the README.

## Done when
- [ ] The SEC table shows the semantic-chunking rows re-measured, with the `table` column at or above the recursive row, or the README explains why not.
- [ ] `make lint` and `make test` pass, including the regression gate (refresh `evals/baseline.json` only if the semantic path is part of it).
- [ ] [Ingestion](../ingestion.md) describes table isolation, the README finding about semantic chunking and tables is rewritten, this spec is deleted, and it is removed from the roadmap and the AGENTS.md Planned list.

## Open questions
- Should a short table (a few rows) still pack with its caption paragraph? Default: no, isolate every table first and measure before adding exceptions.

## Related
- [Ingestion](../ingestion.md)
- [Parsers](../parsers.md)
- [Evaluation](../evaluation.md)
