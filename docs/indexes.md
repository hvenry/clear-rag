# Indexes

The three stores behind retrieval: a hand-built BM25 inverted index, an exact vector index, and a SQLite store.

## Why
Hybrid retrieval needs a keyword index and a vector index that agree on chunk ids, plus durable storage for text, spans, traces and sessions.
BM25 is written from the formula because it is one of the things this project exists to teach, and the vector index is exact so there are no ANN parameters to misconfigure.
Without the embedder guard, switching embedding models would keep answering queries against incomparable vectors, returning plausible noise.

## How it works
All three live in the workspace directory (`CLEARRAG_WORKSPACE`, default `./workspace`):
- `clearrag.db` - the SQLite store
- `lexical.pkl` - the pickled BM25 postings and document lengths
- `vectors.npz` - the vector matrix and chunk ids (`Settings.vectors_path` names `vectors.npy`; `VectorIndex.save` swaps the suffix)

`Engine._persist_indexes` saves both indexes and writes `embedder_id` to the store's `meta` table after every ingest, re-index and delete.

**Lexical (BM25).** `index/lexical.py` keeps `postings` (term to chunk to frequency) and `doc_len`.
Scoring uses FTS5's defaults, `k1 = 1.2` and `b = 0.75`, with the non-negative idf variant `ln(1 + (N - df + 0.5) / (df + 0.5))`.
Tokenisation lowercases and splits on anything that is not a letter or digit, mirroring FTS5's `unicode61`.
Only chunks in some query term's postings are scored, ties break on chunk id, and each `Candidate.detail` lists the matched terms and frequencies the inspector highlights.

**Vector.** `index/vector.py` holds one float32 matrix and scores a query with a single matrix-vector product.
Providers L2-normalise both document and query vectors (`providers/base.py:l2_normalise`), so the inner product is cosine similarity.
Top-k uses `argpartition` and then sorts only those k rows.

Both `search` methods take `allowed`, a set of chunk ids applied before top-k, so a session scoped to some documents still gets k real candidates from that scope.

**Store.** `index/store.py` opens SQLite in WAL mode with foreign keys on.
Tables:
- `meta` - key/value, notably `embedder_id`
- `documents` - full text, content hash, page map, meta and blocks as JSON
- `chunks` - text, context, span, ordinal, page; cascade-deleted with their document
- `context_cache` - LLM-written chunk contexts (see [ingestion](ingestion.md))
- `traces` - query traces as JSON payloads, indexed by time and config hash (see [tracing](tracing.md))
- `sessions` and `session_messages` - chat sessions, an optional document filter, and messages linked to trace ids
`_migrate` adds columns that post-date an existing database, because `CREATE TABLE IF NOT EXISTS` leaves old tables untouched.

**Embedder identity.** `Store.check_embedder` returns the previously recorded embedder id when it differs from the configured one and chunks exist.
`Engine._vector_index` turns that into `EmbeddingSpaceMismatch`, which stops queries and asks for a re-index or the old embedder.
As a second line of defence, `VectorIndex.load` returns an empty index when stored vectors have a different dimensionality.
The ablation runner puts the embedder id in each variant's workspace path, so variants with different embedders never share an index (see [evaluation](evaluation.md)).

## Tech
SQLite (stdlib `sqlite3`), numpy, pickle.

## Key files
- `src/clearrag/index/lexical.py` - BM25 inverted index and persistence
- `src/clearrag/index/vector.py` - exact cosine index and persistence
- `src/clearrag/index/store.py` - SQLite schema, migrations, embedder guard, sessions, context cache
- `src/clearrag/index/project.py` - PCA projection of the vector index for the embedding map
- `src/clearrag/pipeline.py` - `_vector_index`, `_persist_indexes`, `EmbeddingSpaceMismatch`
- `tests/index/test_bm25.py` - BM25 tests, including the FTS5 differential test
- `tests/index/test_store_blocks.py` - block round-tripping through the store

## Decisions and gotchas
- **BM25 is differentially tested.** `tests/index/test_bm25.py` indexes the same corpus into SQLite FTS5 and asserts both rank alike; a from-scratch ranker is easy to write plausibly and hard to verify by reading.
- **Exact search, on purpose.** Under roughly 100k chunks a full matrix product is fast enough, and an approximate index should arrive as a measured experiment (see the [ANN spec](specs/ann-vector-index.md)).
- **Lazy vector load.** The vector index loads on first use because a fresh provider learns its dimensionality only after one embed call, so `_vector_index` probes with a dummy query.
- **Deleting removes everywhere.** `Engine.delete_document` drops the store rows, vector rows and postings, then persists.
- **The `lexical.pkl` file is trusted input** loaded with pickle; never point the workspace at an untrusted directory.
- `make reset` deletes the workspace databases and index files but keeps the venv.

## Related
- [Ingestion](ingestion.md)
- [Query pipeline](query-pipeline.md)
- [Tracing](tracing.md)
- [Providers](providers.md)
- [Evaluation](evaluation.md)
- [ANN vector index spec](specs/ann-vector-index.md)
