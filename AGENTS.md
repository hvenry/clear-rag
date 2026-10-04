# clear-rag

A local-first RAG system whose retrieval process is visible: every stage streams to the UI as it completes, then the answer.
It exists to measure what each retrieval technique is worth, so ablation results are a first-class output.
Stack: Python (FastAPI, numpy, SQLite, pdfplumber), React + Vite + Tailwind, Ollama by default with optional OpenAI and Anthropic.

## Commands
```bash
make install                                         # create .venv and npm install; `make clean install` to rebuild
make dev                                             # backend reload + Vite HMR, open http://localhost:5173
make serve                                           # one server with the built UI on :8010 (`make build` first)
make test                                            # pytest + Vitest, fake providers, no models needed
make e2e                                             # Playwright against Vite on :5174 with /api mocked
make lint                                            # ruff, ruff format --check, mypy, tsc
make fix                                             # ruff autofix and format
.venv/bin/pytest tests/query/test_fuse.py -q         # one Python test file (add ::name for one test)
cd web && npx vitest run src/components/retrieval/rows.test.ts   # one Vitest file
cd web && npx playwright test e2e/session.spec.ts    # one Playwright spec
.venv/bin/clear-rag ablate --save-results            # measure with real models and update evals/results/
.venv/bin/python scripts/render_results.py --check   # README tables and prose numbers match results files
```

## Repo map
```
src/clearrag/core/       Candidate, Chunk, Trace, stage timing and degradation
src/clearrag/ingest/     parse backends, chunkers, contextual retrieval
src/clearrag/index/      BM25, exact vector index, SQLite store
src/clearrag/query/      one module per query stage
src/clearrag/providers/  chat, embedding, rerank providers, plus fakes
src/clearrag/eval/       golden sets, metrics, ablation runner, results files
src/clearrag/api/        FastAPI app and SSE streams
web/src/                 React UI: views/, components/, lib/
evals/                   corpora, golden sets, baseline, results/<suite>.json
scripts/                 dev loop, results rendering, snapshot gate, fetchers
```

## Conventions
- **Every retrieval stage speaks `list[Candidate]`.** The inspector draws rank flow between any two stages only because they share one type.
- **Optional stages degrade, they do not fail.** Use `degradable` and mark the record, so a missing reranker or parser still answers and says why.
- **Never hand-edit numbers.** Tables and three-decimal numbers come from `evals/results/*.json`; CI fails on anything a results file cannot vouch for.
- **Golden labels are quotes resolved to spans, never chunk ids.** Chunk ids change with chunking config, which is exactly what gets compared.
- **Do not edit `evals/**/corpus/`.** Golden quotes and the regression baseline resolve against that exact text.
- **Refresh `evals/baseline.json` only for a deliberate retrieval change.** A regression-gate failure means retrieval changed; find out why first.
- **Every new stage or knob gets plain-language copy in `web/src/lib/stages.ts` or `knobs.ts`.** Unbuilt knobs stay visible with `implemented: false`.
- **Colour encodes data only, always with a text label.** Colour alone fails the CVD validation the palette was built on.

## Docs
Pipeline:
- Before changing parsing backends or the block model, read `docs/parsers.md`.
- Before changing chunking, contextual retrieval, hashing or re-index, read `docs/ingestion.md`.
- Before changing BM25, the vector index, the SQLite schema or the embedder guard, read `docs/indexes.md`.
- Before adding or changing a query stage, read `docs/query-pipeline.md`.
- Before touching traces, stage records or the event stream, read `docs/tracing.md`.
- Before adding a provider or changing model switching, read `docs/providers.md`.
- Before adding a knob or setting, read `docs/configuration.md`.

Measurement:
- Before changing golden sets, metrics, variants or eval commands, read `docs/evaluation.md`.
- Before re-measuring or quoting a benchmark number, read `docs/results-files.md`.
- Before adding tests or debugging the regression gate or CI, read `docs/testing.md`.

App:
- Before changing an endpoint or stream format, read `docs/api.md`.
- Before changing views, the inspector or UI copy, read `docs/web-ui.md`.
- Before changing styling, colour or theme, read `docs/ui-design.md`.
- Before changing the dev loop, Docker, ports or CI, read `docs/dev-environment.md`.

## Planned
Build order: `docs/specs/roadmap.md`.
- Before implementing an ANN vector index, read `docs/specs/ann-vector-index.md`.
- Before implementing atomic table chunks, read `docs/specs/atomic-table-chunks.md`.
- Before implementing HyDE, read `docs/specs/hyde.md`.
- Before implementing the large-corpus benchmark, read `docs/specs/large-corpus-benchmark.md`.
- Before implementing query decomposition, read `docs/specs/query-decomposition.md`.
- Before implementing self-correction, read `docs/specs/self-correction.md`.
