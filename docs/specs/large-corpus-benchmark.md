# Large-corpus benchmark

**Status:** draft

A third retrieval suite large enough (thousands of chunks) that each search returns a genuine shortlist, so recall@5 stops saturating and query expansion, reranking and ANN search can be measured where they matter.

## Goal
The retrieval corpus is about a dozen chunks at the default size, so every search returns the whole corpus as its shortlist.
Two findings in the README are capped by that: recall@5 barely separates the strong rows, and multi-query changes nothing under the reranker because nothing is ever left out of the shortlist.
An ANN index cannot be measured either, since exact search over a few chunks has no latency to save.
It worked if the strong configurations separate on recall@5 and the multi-query row under the reranker differs from the reranker alone, in either direction.

## Scope
- In: a public-domain or permissively licensed corpus of several thousand chunks, a fetch script, a golden set with span-anchored labels including `paraphrase` and `distractor` tags, a `large` suite in the eval runner and results files, a README section.
- Out: committing the corpus itself if its size or licence forbids it (fetch it instead), LLM-generated golden questions without human review, and generation metrics on this suite.

## Design
Builds on [evaluation](../evaluation.md) and [results files](../results-files.md).

- **Corpus.** Candidates are a public technical documentation set (for example a large open-source project's docs) or more SEC filing sections fetched by `scripts/fetch_sec.py`.
  The bar is: distinct topics with overlapping vocabulary, so distractors exist naturally, and a stable upstream version that can be pinned.
- **Fetch, do not commit.** A `scripts/fetch_large.py` downloads a pinned version into `evals/large/corpus/` (gitignored) and verifies a checksum, so labels cannot silently drift from the text they quote.
- **Golden set.** `evals/large/golden.jsonl` in the existing format, around 100 questions, written by hand against the text with quotes that resolve to exactly one span.
  The golden loader's hard error on ambiguous quotes matters more here, since repeated boilerplate is common in large corpora.
- **Suite.** Register `large` wherever suites are enumerated in `src/clearrag/eval/` and in `RENDERED_IN` in `src/clearrag/eval/results.py`, rendering its table into a new README section.
  The UI's Results view picks it up from `evals/results/large.json` through `web/src/lib/results.ts`.
- **Cost.** Ingesting thousands of chunks with Ollama embeddings is the slow step; the runner already shares one index per ingest signature and embedder, which keeps a sweep to one ingest per chunking configuration.

## Tasks
- [ ] Choose and pin the corpus, recording its licence and version in `evals/large/README.md`.
- [ ] Write the fetch script with checksum verification and a test for its failure mode.
- [ ] Write and review the golden set; run the loader to prove every quote resolves.
- [ ] Register the suite in the runner, results files, README markers and web Results view.
- [ ] Run `clear-rag ablate --suite large --save-results` and write the findings, including what multi-query does under the reranker.

## Done when
- [ ] `evals/results/large.json` exists with measured rows and provenance, rendered into the README.
- [ ] The README's multi-query and recall@5 caveats are updated to cite the new suite.
- [ ] `make lint`, `make test` and `render_results.py --check` pass.
- [ ] [Evaluation](../evaluation.md) documents the suite, this spec is deleted, and it is removed from the roadmap and the AGENTS.md Planned list.

## Open questions
- Which corpus? Owner: the user; default: SEC filings, since the fetch and ground-truth tooling already exists.

## Related
- [Evaluation](../evaluation.md)
- [Results files](../results-files.md)
- [ANN vector index](ann-vector-index.md)
