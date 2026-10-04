# Configuration

Two models in `src/clearrag/config.py` split configuration by lifetime: `Settings` for the process, `PipelineConfig` for the experiment.

## Why
Retrieval knobs must be hashable and attributable, so every trace and ablation row can be grouped by the exact configuration that produced it.
Process settings such as URLs, keys and inference tuning change how fast an answer arrives, never what is retrieved, so they must not perturb that hash.
Mixing the two would split the ablation table into incomparable groups whenever someone tuned Ollama.

## How it works
**`PipelineConfig`** is a frozen pydantic model of every knob that changes retrieval behaviour:
- Ingestion: `parser`, `chunker`, `chunk_size`, `chunk_overlap`, `context_mode`.
- Retrieval: `retrieval`, `k_candidates`, `fusion`, `rrf_k`, `dense_weight`.
- Reranking: `rerank`, `k_final`.
- Query understanding: `query_transform`, `query_variants`, `self_correct`, `rewrite_followups`.
- Generation: `max_context_tokens`, `temperature`.
Field descriptions in the model are the reference for ranges and defaults.
`config_hash` is the first 12 hex characters of a SHA-256 over the sorted JSON dump, and it is stamped on every trace.

**Knobs that re-index.**
`parser`, `chunker`, `chunk_size`, `chunk_overlap` and `context_mode` only affect documents indexed afterwards.
`PUT /api/config` returns `reindex_needed: true` when one of them changes, and the Lab marks the same knobs with `reindexes: true` in `web/src/lib/knobs.ts`.
Re-index rebuilds chunks and vectors from stored text; a `parser` change is the exception, since re-indexing cannot re-parse, so it applies only to files uploaded afterwards.

**`Settings`** is a pydantic-settings model read from `CLEARRAG_*` environment variables and `.env`.
It holds the workspace path, host and port, provider choice (`chat_provider`, `embed_provider`), model names, API keys and base URLs, and Ollama tuning (`think`, `num_ctx`, `num_predict`, `keep_alive`, `preload`).
`.env` is looked up in the working directory first, then at the repository root, so starting the server elsewhere does not silently fall back to defaults.
`.env.example` documents every variable a user would set.

**Single-source port.**
`CLEARRAG_PORT` (default 8010) is read by `Settings.port` for uvicorn, by `web/vite.config.ts` for the dev proxy (it loads the root `.env`), and by `docker-compose.yml`.
`scripts/dev.sh` asks `Settings` for the port rather than repeating the number.
8000 is avoided because a collision there tends to answer with another process's 404s instead of refusing the connection.

**Ways to change pipeline config.**
- Server: `GET /api/config` returns the current config, the defaults and the hash; `PUT /api/config` merges a partial patch and validates it.
- CLI: `clear-rag eval --set KEY=VALUE` (repeatable) validates overrides exactly as the model does; `--chunk-size` and `--chunk-overlap` are shorthands.
- Ablation: `src/clearrag/eval/variants.py` declares each row as a `PipelineConfig` built from a shared `BASE`.

**The embedder is not a knob.**
The embedding model identifies an index, not a query, because vectors from two models are not comparable.
It lives in `Settings.embed_model`, can be switched at runtime through `PUT /api/providers`, and rides on an ablation `Variant` rather than in `PipelineConfig`, so it lands in row provenance instead of `config_hash`.

## Tech
- pydantic and pydantic-settings, with the mypy pydantic plugin.

## Key files
- `src/clearrag/config.py` - `PipelineConfig`, `Settings`, `.env` lookup.
- `src/clearrag/api/app.py` - `/api/config` and `/api/providers` endpoints.
- `src/clearrag/__main__.py` - `--set` parsing and CLI overrides.
- `src/clearrag/eval/variants.py` - ablation rows and the `Variant` embedder field.
- `web/src/lib/knobs.ts` - UI metadata for every knob.
- `.env.example` - documented environment variables.

## Decisions and gotchas
- The server keeps `PipelineConfig` in memory, starting from defaults; config changes made in the UI do not survive a restart.
- `--set` applies to `clear-rag eval`; `ablate` sweeps its own fixed variants.
- `query_transform="hyde"` and `self_correct` validate but do nothing yet, and the Lab shows them disabled; see [HyDE](specs/hyde.md) and [self-correction](specs/self-correction.md).
- Adding any `PipelineConfig` field changes every `config_hash`, which matters for the snapshot gate in [tracing](tracing.md).
- `chunk_overlap` defaults to about 12% of `chunk_size` because the predecessor's 50% doubled the index and filled top-k with near-duplicates.

## Related
- [Providers](providers.md)
- [Query pipeline](query-pipeline.md)
- [Ingestion](ingestion.md)
- [Evaluation](evaluation.md)
- [Dev environment](dev-environment.md)
- [API](api.md)
