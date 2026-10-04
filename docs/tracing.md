# Tracing

Every ingest and query builds a `Trace`: a structured record of what each stage received, produced, and how long it took.

## Why
The trace is a returned value, not a log, so the UI can render it, SQLite can store it, and evaluation can reason about it without re-invoking a model.
Keeping instrumentation out of the stages means a new technique only implements its logic and still shows up in the inspector.
Without degraded-stage recording, an optional component that failed would either kill the query or silently do nothing.

## How it works
`Trace.stage(name, label, **config)` opens a `StageRecord` and appends it immediately, so a stage that raises still appears.
A record holds the stage config, free-form `diagnostics`, optional `candidates_in` and `candidates_out`, `duration_ms`, `error` and a `degraded` flag.
The presence of candidate lists is what tells the UI a stage belongs in the rank-flow diagram.
The trace itself carries the query, `resolved_query`, `config_hash`, answer, citations, total time and optional `session_id`.

Three helpers in `src/clearrag/core/stage.py` do the timing:
- `timed` and `atimed` time a sync or async block, record the exception text on failure, and re-raise.
- `degradable` runs an optional stage and, on any exception, records the error, sets `degraded`, passes `candidates_in` through as `candidates_out`, and returns a fallback.
Retrievers time themselves instead, because they share one `gather` and a shared timer would charge the slower one's wait to both.

**Event stream.**
`Engine.query` yields dicts that `POST /api/chat` writes as Server-Sent Events (`src/clearrag/api/app.py`):
- `stage` - one finished `StageRecord`, via `stage_event` in `src/clearrag/query/context.py`.
- `context` - the packed passages with markers, spans, pages and ordinals.
- `token` - answer text as it streams.
- `done` - the full trace dict.
- `error` - a message plus an optional `remedy` for the UI to show.
SSE was chosen over WebSockets because traffic is one-directional and survives proxies.
Ingest builds its own trace (parse, chunk, embed, index) and returns it in the upload response.
Re-index streams `start`, per-document `doc` and a final `done` event over `POST /api/reindex/stream`.

**Persistence.**
After generation, `Store.save_trace` writes the trace JSON to the `traces` table, indexed by creation time and `config_hash`.
When the query belongs to a chat session, the assistant message stores the trace id, and `GET /api/sessions/{id}` attaches each full trace so a reopened conversation keeps its stage strips and citations.
`GET /api/traces` lists recent traces (optionally for one `session_id`) and `GET /api/traces/{id}` returns one.

**Redaction.**
`StageRecord.to_dict` passes stage config through `redact`, which masks any key containing `key`, `token`, `secret`, `password` or `authorization`, recursively.

**Refactor gate.**
`scripts/snapshot_query_events.py` runs a fixed set of questions and configurations on fake providers (plus the real ONNX reranker when its model is downloaded) and records every event stream with ids, timestamps and durations stripped.
A refactor that changes nothing observable reproduces the file byte for byte; `--compare` reports the first differing streams and `--ignore KEY` strips fields that are expected to change.
This complements the metric baseline in [evaluation](evaluation.md), which cannot see changes to stage records or diagnostics.

## Key files
- `src/clearrag/core/trace.py` - `Trace`, `StageRecord`, `redact`.
- `src/clearrag/core/stage.py` - `timed`, `atimed`, `degradable`.
- `src/clearrag/query/context.py` - `stage_event`, the SSE stage payload.
- `src/clearrag/api/app.py` - `/api/chat` SSE stream and `/api/traces` endpoints.
- `src/clearrag/index/store.py` - `traces` table and session messages.
- `scripts/snapshot_query_events.py` - event-stream snapshot and compare.

## Decisions and gotchas
- Only queries that generate are saved; `generate=False` (retrieval-only eval) returns the trace in `done` but never persists it.
- `config_hash` on every trace makes recorded queries attributable to the exact configuration, so comparisons are a group-by.
- Adding a `PipelineConfig` field changes every `config_hash`, so pass `--ignore config_hash` to the snapshot compare in that change.
- Stage event order is part of the UI contract: keyword search is yielded before vector search because it usually finishes first.

## Related
- [Query pipeline](query-pipeline.md)
- [API](api.md)
- [Web UI](web-ui.md)
- [Testing](testing.md)
- [Configuration](configuration.md)
