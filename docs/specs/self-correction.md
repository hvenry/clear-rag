# Self-correction

**Status:** draft

When the retrieved chunks look irrelevant to the question, the pipeline rewrites the query and retries retrieval once, and the trace shows both attempts.

## Goal
Today a bad first retrieval goes straight to generation, and the model either refuses or answers from the wrong passage.
The `self_correct` knob exists in `src/clearrag/config.py` and is shown disabled in the Lab, so the interface already promises this.
It worked if false refusals fall on the generation suites (`clear-rag eval --generate`) without a matching rise in wrong-section answers, at a measured latency cost.

## Scope
- In: a grading stage, a corrective rewrite, a single retry, trace and UI support for two retrieval passes, ablation rows with `--generate`.
- Out: more than one retry, web search fallback, and per-chunk filtering (grading decides retry or not, it does not drop chunks).

## Design
Builds on [query pipeline](../query-pipeline.md) and [tracing](../tracing.md).

- **Grade.** A new `src/clearrag/query/grade.py` stage runs after rerank (or fusion when rerank is off).
  It asks the chat model whether the top chunks contain information that answers the question and parses a yes/no verdict per chunk.
  The stage records the verdicts and an overall `sufficient` flag; it is `degradable`, and a failed grade counts as sufficient so the query continues.
  If the reranker ran, its scores can short-circuit grading: a top score above a threshold skips the model call.
- **Rewrite.** On insufficient retrieval a corrective prompt in `src/clearrag/generate/prompt.py` rewrites the query using the question and the chunks that missed, and retrieval through rerank runs once more.
- **Trace.** The second pass emits its stages with a `pass: 2` config entry, so the inspector can draw two pipelines in sequence rather than overwriting the first.
  `Trace.resolved_query` becomes the query that produced the final shortlist.
- **Composition.** `Engine.query` in `src/clearrag/pipeline.py` loops at most twice around the retrieval stages; stage modules stay unaware of the retry.
- **UI.** Enable the knob in `web/src/lib/knobs.ts`, add a grade stage to `web/src/lib/stages.ts`, and render a second pass in the Chat stage strip.

## Tasks
- [ ] Add a failing test with scripted fake providers where the first retrieval misses and the corrected query hits.
- [ ] Implement the grade stage, verdict parsing and the threshold short-circuit.
- [ ] Implement the corrective rewrite and the bounded retry in the engine.
- [ ] Add pass-aware stage records and the second-pass UI; update the query-events snapshot.
- [ ] Enable the knob and add ablation rows measured with `--generate` on the retrieval and attribution suites.

## Done when
- [ ] Ablation rows with and without self-correction show refusal and grounding changes and the added latency.
- [ ] The Lab knob is enabled and documented; no knob remains with `implemented: false` for this feature.
- [ ] `make lint`, `make test` and `make e2e` pass.
- [ ] [Query pipeline](../query-pipeline.md) and [tracing](../tracing.md) describe the built feature, this spec is deleted, and it is removed from the roadmap and the AGENTS.md Planned list.

## Open questions
- Grade with the chat model or the cross-encoder only? Default: cross-encoder threshold first, chat model only when it is inconclusive, so the common case adds no model call.

## Related
- [Query pipeline](../query-pipeline.md)
- [Tracing](../tracing.md)
- [Query decomposition](query-decomposition.md)
