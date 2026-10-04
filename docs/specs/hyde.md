# HyDE

**Status:** draft

Vector search embeds a short hypothetical answer written by the chat model instead of the question, so a question phrased unlike the document can still land near it.

## Goal
HyDE (hypothetical document embeddings) targets the same failure as multi-query expansion: question vocabulary that diverges from the document's.
`query_transform="hyde"` is already a value in `PipelineConfig` and shown disabled in the Lab.
It is last in the roadmap because multi-query already lifts the `paraphrase` column, so HyDE has to beat that rather than the baseline.
It worked if the HyDE row is measured beside the multi-query row on `paraphrase`, recall@1 and latency, and the README says which to prefer.

## Scope
- In: the `hyde` transform, its prompt, dense-only use of the hypothetical text, trace and UI support, ablation rows.
- Out: feeding the hypothetical answer to BM25 (it would reward invented terms), multiple hypothetical documents, and showing the hypothetical text as an answer.

## Design
Builds on [query pipeline](../query-pipeline.md).

- **Transform.** `transform_query` in `src/clearrag/query/transform.py` gains a `_hypothesise` path: a prompt in `src/clearrag/generate/prompt.py` asks for a short passage that would answer the question, in the style of a document rather than a reply.
  The diagnostics record the passage so the inspector shows exactly what was embedded.
- **Retrieval split.** BM25 searches the resolved question; vector search embeds the hypothetical passage (as `kind="document"`, since it stands in for a document).
  `retrieve` in `src/clearrag/query/retrieve.py` therefore takes per-retriever query lists instead of one shared list.
- **Fallback.** A provider failure degrades to embedding the question, as expansion degrades today.
- **UI.** Enable the option in `web/src/lib/knobs.ts` and explain it in `web/src/lib/stages.ts` and a Learn topic.

## Tasks
- [ ] Refactor `retrieve` to accept per-retriever queries, with the snapshot gate proving no behaviour change.
- [ ] Add the prompt, the transform path and a fake-provider test that the dense retriever receives the passage and BM25 does not.
- [ ] Enable the knob and add the stage and Learn copy.
- [ ] Add HyDE rows to the retrieval sweep and measure them against multi-query.

## Done when
- [ ] The retrieval results table has HyDE rows beside multi-query, and the README states the comparison.
- [ ] `make lint`, `make test` and `render_results.py --check` pass.
- [ ] [Query pipeline](../query-pipeline.md) describes HyDE, this spec is deleted, and it is removed from the roadmap and the AGENTS.md Planned list.

## Related
- [Query pipeline](../query-pipeline.md)
- [Query decomposition](query-decomposition.md)
