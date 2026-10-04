# ANN vector index

**Status:** draft

An approximate nearest-neighbour index (FAISS HNSW) as a selectable alternative to exact vector search, adopted only as far as a measured recall-against-latency curve justifies.

## Goal
`src/clearrag/index/vector.py` is exact on purpose: under roughly 100k chunks a full matrix-vector product is milliseconds and has nothing to misconfigure.
That choice was deferred, not settled: the claim is that ANN costs recall for latency the project does not need, and nothing measures it yet.
It worked if a committed plot or table shows recall@k and query latency for exact and HNSW across corpus sizes, and the default follows from it.

## Scope
- In: a `VectorIndex` protocol with exact and HNSW implementations, an index knob, persistence, a latency-and-recall sweep on the large corpus, a Lab control.
- Out: other ANN families (IVF, ScaNN), GPU indexes, and distributed or external vector databases.

## Design
Builds on [indexes](../indexes.md) and needs the [large-corpus benchmark](large-corpus-benchmark.md) to have anything to measure.

- **Protocol.** Extract the interface `Engine` and the retrievers use (`add`, `remove_doc`, `search` with `allowed`, `save`, `load`, `__len__`) into a protocol; the current class becomes `ExactVectorIndex`.
- **HNSW.** `HnswVectorIndex` wraps `faiss.IndexHNSWFlat` with inner-product metric over the already L2-normalised vectors, so scores stay cosine.
  FAISS ids are integers, so the index keeps an id map; deletes rebuild, since HNSW does not support removal.
  The `allowed` filter (document scoping) runs as over-fetch then filter, and the stage diagnostics record when filtering left fewer than `k` results.
- **Dependency.** `faiss-cpu` as an optional extra, `[ann]`; a configured but missing index degrades to exact search with a degraded stage record, like a missing parser backend.
- **Knob.** `vector_index: "exact" | "hnsw"` plus `hnsw_ef_search` in `PipelineConfig`.
  Changing `vector_index` rebuilds the index from stored vectors, so it is marked as re-indexing in `web/src/lib/knobs.ts`.
- **Measurement.** The ablation sweep adds rows per `ef_search`; a separate latency benchmark script records per-query p50 and p95 for both indexes at several corpus sizes, written into a results file so the README can render it.

## Tasks
- [ ] Extract the vector index protocol and rename the exact implementation, with no behaviour change (the regression gate and query-events snapshot must match byte for byte).
- [ ] Implement `HnswVectorIndex` with persistence, the id map and the `allowed` filter, tested against exact search on a fixed corpus.
- [ ] Add the optional extra, the degraded fallback and the knob.
- [ ] Write the latency benchmark and run the sweep on the large corpus.
- [ ] Decide the default from the numbers and write the finding into the README.

## Done when
- [ ] Recall and latency for both indexes are in a committed results file and rendered in the README.
- [ ] `make lint`, `make test` and `render_results.py --check` pass, and the snapshot gate matches after the protocol extraction.
- [ ] [Indexes](../indexes.md) describes both implementations and the decision, this spec is deleted, and it is removed from the roadmap and the AGENTS.md Planned list.

## Open questions
- Is HNSW worth shipping if exact search stays under its latency at every measured size? Default: keep it as a knob, not the default, and say so.

## Related
- [Indexes](../indexes.md)
- [Large-corpus benchmark](large-corpus-benchmark.md)
