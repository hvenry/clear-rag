# Query decomposition

**Status:** draft

A question that compares two things ("Which company had more employees, Apple or Microsoft?") is split into sub-questions, each sub-question is searched, and the answer is built from evidence for every side.

## Goal
Comparative and multi-part questions fail today because one query vector and one BM25 ranking favour whichever side of the comparison the wording leans towards.
The other side's evidence never reaches the shortlist, so the model answers half the question or refuses.
Decomposition retrieves each part separately and guarantees each part a share of the context.
It worked if a new `comparative` tag column on the SEC suite rises over hybrid + RRF without lowering the other columns, measured with `clear-rag ablate --suite sec`.

## Scope
- In: a `decompose` value for the `query_transform` knob, the sub-question prompt and parser, per-sub-question retrieval and a merge that gives every sub-question a quota, trace and UI support, comparative golden questions, an ablation row.
- Out: multi-hop chains where one sub-question's answer feeds the next (sequential decomposition), and decomposing on a schedule or by classifier; the knob is explicit.

## Design
Builds on the transform and retrieval stages described in [query pipeline](../query-pipeline.md).

- **Knob.** Add `"decompose"` to `PipelineConfig.query_transform` in `src/clearrag/config.py`, reusing `query_variants` as the upper bound on sub-questions.
  It is mutually exclusive with `multi`, which keeps one transform per query and one comparison per Lab run.
- **Transform.** `transform_query` in `src/clearrag/query/transform.py` gains a `_decompose` path beside `_expand`.
  A new `build_decompose_messages` / `parse_subquestions` pair in `src/clearrag/generate/prompt.py` asks for independent, self-contained sub-questions and returns an empty list when the question is not decomposable.
  An empty list means the original question searches alone, so decomposition never makes a simple question worse.
  Diagnostics record `sub_questions`; a provider failure degrades exactly as expansion does.
- **Retrieval.** Each sub-question searches both retrievers, as phrasings do now.
  The difference is the merge: phrasings are alternative wordings of one need and fuse by reciprocal rank in `merge_variants`, but sub-questions are different needs and must not compete.
  A new `merge_subquestions` in `src/clearrag/query/retrieve.py` interleaves the per-sub-question rankings round-robin, deduplicating, so the top of the merged list holds each sub-question's best chunk.
  `detail["variants"]` keeps where each sub-question placed a chunk, so the inspector can still show who found what.
- **Rerank.** The cross-encoder scores against one query string; scoring every chunk against the comparative question can push one side out of `k_final`.
  The rerank stage scores each chunk against the sub-question that retrieved it best, then applies the same round-robin quota before truncating.
- **Generation.** The answer prompt sees the original question; the sub-questions appear in the trace only.
- **UI.** `web/src/lib/knobs.ts` gains the `decompose` option with a hint, `web/src/lib/stages.ts` explains the transform stage's sub-questions, and the Chat transform readout lists them.
- **Eval.** Add comparative questions to `evals/sec/golden.jsonl` whose `relevant` list carries one quote from each company's filing, tagged `comparative`.
  recall@k already counts labelled spans covered, so a question that retrieves only one side scores half.
  Add a `hybrid + RRF + decomposition` variant to the SEC sweep in `src/clearrag/eval/variants.py`.

## Tasks
- [ ] Write 8 to 10 comparative questions with two-sided span labels in `evals/sec/golden.jsonl`, tag `comparative`, and measure the current pipeline so the baseline row exists first.
- [ ] Add the `decompose` knob value and the prompt/parser pair, with unit tests on parsing including the "not decomposable" case.
- [ ] Implement `merge_subquestions` with tests on quota and deduplication, and wire the transform and retrieval paths.
- [ ] Make the rerank stage quota-aware under decomposition, with a test that one side cannot be crowded out.
- [ ] Add trace diagnostics, knob and stage copy, and the Chat readout; update the query-events snapshot.
- [ ] Add the SEC variant and run `clear-rag ablate --suite sec --save-results`, then `python scripts/render_results.py`.

## Done when
- [ ] The SEC results table has a decomposition row and a `comparative` column, measured with real models.
- [ ] Non-comparative questions score the same with and without decomposition, or the README says by how much they do not.
- [ ] `make lint`, `make test` and `make e2e` pass, and `render_results.py --check` passes.
- [ ] [Query pipeline](../query-pipeline.md) and [evaluation](../evaluation.md) describe the built feature, this spec is deleted, and it is removed from the roadmap and the AGENTS.md Planned list.

## Open questions
- Round-robin quota or a weighted share by sub-question confidence? Default: round-robin, it is explainable in the inspector.
- Should decomposition also run on the retrieval suite? Default: no, it has no comparative questions and would only measure the "not decomposable" path.

## Related
- [Query pipeline](../query-pipeline.md)
- [Evaluation](../evaluation.md)
- [Self-correction](self-correction.md)
