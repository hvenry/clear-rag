# Roadmap

Build order for planned work.
Reorder lines here; never rename spec files.

1. [Query decomposition](query-decomposition.md) - split comparative questions into sub-questions so each side of the answer is retrieved.
2. [Atomic table chunks](atomic-table-chunks.md) - keep each table in a chunk of its own under semantic chunking, to recover the table recall it loses.
3. [Large-corpus benchmark](large-corpus-benchmark.md) - a corpus big enough that the shortlist is a real cut and recall@5 stops saturating.
4. [ANN vector index](ann-vector-index.md) - FAISS HNSW as a measured alternative to exact search, recall against latency.
5. [Self-correction](self-correction.md) - grade retrieval, rewrite the query and retry once.
6. [HyDE](hyde.md) - search with a hypothetical answer's embedding; last because multi-query already covers its motivating case.
