# Testing

How the Python and web suites run with no models, no GPU and no backend, and which gates protect retrieval quality and observable output.

## Why

Most RAG codebases have no tests because every path appears to need a running model.
Deterministic fake providers remove that dependency, so the whole pipeline runs in CI in seconds.
On top of unit tests, three gates catch regressions that ordinary assertions miss: a metrics baseline, a parser differential test, and an event-stream snapshot for refactors.

## How it works

**Fake providers** (`src/clearrag/providers/fake.py`).
`FakeEmbeddings` is a bag-of-words hash projection, so texts sharing vocabulary land near each other and retrieval tests assert real ranking behaviour.
`FakeChat` replays scripted responses, then falls back to echoing its context, and records every call for assertions.
`tests/conftest.py` builds an `Engine` on both over a temporary workspace, with small chunks so a tiny corpus still yields several, plus a `loaded_engine` fixture and a `drain` helper for event streams.

**Python layout.**
`tests/` mirrors `src/clearrag/`: `api`, `core`, `eval`, `index`, `ingest`, `providers`, `query`, with pipeline and config tests at the top level.
`pytest-asyncio` runs in auto mode, so async tests need no decorator.
The API tests drive the FastAPI app through `TestClient`.
Optional backends skip cleanly: the docling and marker tests skip when their extras are absent, and the real cross-encoder test skips until its model is downloaded.

**Regression gate** (`tests/eval/test_regression.py`).
The full retrieval golden set runs through the real pipeline on fake providers and is compared with `evals/baseline.json`.
Each of recall, MRR, nDCG and hit rate at k of 1, 3, 5 and 10 may not fall more than a small tolerance.
It also fails if the default config hash or the golden set size changed, and it runs the sweep twice to prove scores are deterministic.
The numbers measure nothing about quality; they catch a change that silently breaks chunking, BM25, fusion or assembly.
After a deliberate retrieval change, run `python scripts/refresh_baseline.py` and read the diff.

**BM25 differential test** (`tests/index/test_bm25.py`).
The same corpus is indexed into SQLite FTS5 and the rankings are compared with the hand-written `LexicalIndex`.

**Parser fixtures** (`tests/pdf_fixtures.py`).
Synthetic PDFs are drawn with reportlab at explicit coordinates, so every column gutter, heading size, table alignment and repeated footer the primitives parser infers was planted on purpose.

**Committed-results checks** (`tests/eval/test_results.py`).
Every committed results row must carry provenance, the README tables must match the JSON, and prose numbers must appear in a results file.

**Refactor gate** (`scripts/snapshot_query_events.py`).
It records every query event stream across several configurations, with ids, timestamps and durations stripped.
A refactor that changes nothing observable reproduces the file byte for byte; run it before and after with `--compare`.

**Web unit tests.**
Vitest runs `src/**/*.test.ts`, kept beside the code they test (for example `web/src/components/retrieval/rows.test.ts`).

**Browser test.**
Playwright runs `web/e2e/*.spec.ts` against a Vite dev server it starts on port 5174, so it never collides with a `make dev` session on 5173.
Every `/api` call is answered by fixtures in the spec through `page.route`, so no backend, model or index is needed.
Traces are retained on failure.

**Running tests.**
- `make test` runs `pytest -q` and `npm test`; `make e2e` runs Playwright.
- One Python test: `.venv/bin/pytest tests/query/test_fuse.py -k <name> -q`.
- One Vitest file: `cd web && npx vitest run src/components/retrieval/rows.test.ts`.
- One Playwright spec: `cd web && npx playwright test e2e/session.spec.ts`.

**CI** (`.github/workflows/ci.yml`).
The Python job runs `ruff check`, `ruff format --check`, `mypy src`, `pytest -q` and `scripts/render_results.py --check`.
The web job runs `type-check`, `npm test`, `npm run build`, then installs Chromium and runs the Playwright test.

## Tech

pytest with pytest-asyncio, FastAPI `TestClient`, SQLite FTS5, reportlab, Vitest, Playwright (Chromium).

## Key files

- `src/clearrag/providers/fake.py` - deterministic embedder and chat model
- `tests/conftest.py` - engine fixtures and the shared tiny corpus
- `tests/eval/test_regression.py` - the baseline gate
- `evals/baseline.json` - committed fake-provider scores
- `scripts/refresh_baseline.py` - regenerates the baseline
- `scripts/snapshot_query_events.py` - event-stream snapshot for refactors
- `tests/pdf_fixtures.py` - synthetic PDF builders
- `web/playwright.config.ts` - port, web server and mocked-API setup
- `web/vite.config.ts` - Vitest include pattern

## Decisions and gotchas

- If the regression gate fails, find what changed in retrieval first; refreshing the baseline to make it pass defeats it.
- Reranking libraries are dev dependencies so CI exercises the real cross-encoder path rather than only the "not installed" fallback.
- The baseline compares metrics, which cannot see a refactor that changes stage records or event order; that is the snapshot script's job.
- Real quality numbers never come from tests; they come from `clear-rag ablate` against Ollama.

## Related

- [Evaluation](evaluation.md)
- [Results files](results-files.md)
- [Providers](providers.md)
- [Dev environment](dev-environment.md)
