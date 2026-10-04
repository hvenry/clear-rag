# Development environment

How the project is installed, run and checked locally, in Docker and in CI.

## Why
A RAG app has two processes and an external model server, and the common failure is not a crash but a half-started stack that looks broken for the wrong reason.
The tooling is built to refuse to start rather than start wrong, and to keep the one shared setting, the port, in one place.

## How it works
### Run modes
- `make dev` runs `scripts/dev.sh`: uvicorn with `--reload` plus Vite with hot module replacement, opened at http://localhost:5173, with Vite proxying `/api` to the backend.
- `make serve` runs one server (`clear-rag serve`) that serves the built UI; run `make build` after UI changes.
- `make docker` builds and runs the production image with Docker Compose.

The Makefile calls `.venv/bin/...` directly, so the virtualenv never needs activating.
`make install` creates `.venv` with an explicit interpreter (`PYTHON ?= python3.12`) and refuses to run over an existing one, because layering a second interpreter into a venv leaves console scripts pointing at the wrong one.
It also stamps the hash of `pyproject.toml` into `.venv/.deps-stamp`.
Other targets: `test`, `e2e`, `lint`, `fix`, `check`, `build`, `reset` (wipes the workspace indexes and traces) and `clean`.

### What `scripts/dev.sh` checks, in order
1. The virtualenv exists and has the `clear-rag` script.
2. The venv still matches `pyproject.toml`, comparing the stamp and reinstalling `.[dev]` on drift.
3. `web/node_modules` exists, installing it if not.
4. The port and Ollama URL, read from `Settings` itself rather than a literal.
5. The port is free, naming the process (or Docker container) that holds it.
6. Ollama answers at `/api/tags`; this only warns, because the UI loads without a model.
7. The backend starts in its own process group and must answer `/api/config` before Vite starts; it fails fast if the backend exits.
8. Vite runs in the foreground, and its exit tears the backend down through the trap.

### One port
`CLEARRAG_PORT` (default 8010) is read by `Settings.port`, by the Vite proxy in `web/vite.config.ts` (which loads the repo-root `.env`), by `scripts/dev.sh`, and by `docker-compose.yml` on both sides of the port mapping.
Changing it in `.env` moves every consumer.

### Environment
`.env.example` documents the variables: Ollama URL and models, port, workspace, `NUM_CTX`, `NUM_PREDICT`, `KEEP_ALIVE`, `PRELOAD`, and optional OpenAI and Anthropic keys.
Copy it to `.env`, which is git-ignored and excluded from the Docker build context.

### Docker
`Dockerfile` has three stages:
- `web` builds the UI with Node, copying `evals/results/` because the bundle imports them.
- `slim` (the default target) is Python with the `rerank` extra, the built UI and the sample corpus, running as a non-root user with the workspace on a `/data` volume and a healthcheck against `/api/config`.
- `full` adds torch and sentence-transformers for models used directly.

`docker-compose.yml` points the app at Ollama on the host (`host.docker.internal`, mapped to the host gateway on Linux).
`docker compose --profile ollama up` adds a containerised Ollama for Linux and CI; set `CLEARRAG_OLLAMA_URL=http://ollama:11434` to use it.

### CI
`.github/workflows/ci.yml` runs two jobs on pushes to `main` and on pull requests:
- **python:** install `.[dev]`, `ruff check`, `ruff format --check`, `mypy src`, `pytest -q`, then `python scripts/render_results.py --check`.
- **web:** `npm install`, `npm run type-check`, `npm test`, `npm run build`, then Playwright with Chromium.

Neither job needs a model or a GPU, because tests run on fake providers and the browser test mocks the API.

## Tech
GNU Make, Bash, uvicorn, Vite, Docker multi-stage builds, Docker Compose profiles, GitHub Actions.

## Key files
- `Makefile` - every developer entry point
- `scripts/dev.sh` - the guarded dev stack
- `web/vite.config.ts` - dev proxy and port source
- `.env.example` - documented settings
- `Dockerfile` - web, slim and full stages
- `docker-compose.yml` - app plus the optional `ollama` profile
- `.github/workflows/ci.yml` - CI jobs

## Decisions and gotchas
- Port 8000 is avoided on purpose: it is the default for Django, `http.server` and many containers, and a collision answers with a plausible 404 instead of refusing.
- The backend must answer before Vite starts, because Vite prints its ready banner and proxies `/api` whether or not the backend is up.
- Ollama runs on the host by default because Docker on macOS has no GPU access, so a containerised Ollama would be CPU-only.
- `clear-rag serve` opens a browser unless `--no-browser` or `--reload` is passed.
- `docker-compose.yml` does not forward `CLEARRAG_EMBED_PROVIDER`, so the container always embeds with its default provider unless you add it.

## Related
- [Configuration](configuration.md)
- [Testing](testing.md)
- [Providers](providers.md)
- [API](api.md)
