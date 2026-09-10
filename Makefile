.PHONY: help install dev build test lint fix check serve docker clean reset

# Three ways to run the app. Pick by what you are doing:
#   make dev     developing: backend auto-reload + Vite HMR, open http://localhost:5173
#   make serve   using it:   one server, the built UI, open http://localhost:8010
#   make docker  appliance:  the production image (code changes need `--build`)

.DEFAULT_GOAL := help

help:
	@echo "Run modes:"
	@echo "  dev        develop: backend reload + frontend HMR in one command (:5173)"
	@echo "  serve      use: single server with the built UI (:8010)"
	@echo "  docker     production image via compose (data persists in a volume)"
	@echo "Everything else:"
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | grep -vE '^(dev|serve|docker):' | awk 'BEGIN {FS=":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

# Pin the interpreter explicitly. Running `python3 -m venv` over an existing venv does
# not error, it layers a second interpreter into bin/ and leaves the console scripts
# pointing at whichever one was there last -- a venv that half-works in confusing ways.
PYTHON ?= python3.12

install:  ## Install Python and web dependencies (override with PYTHON=python3.13)
	@test ! -d .venv || (echo "ERROR: .venv exists. Run 'make clean install' to rebuild it." && exit 1)
	$(PYTHON) -m venv .venv
	.venv/bin/pip install -e ".[dev]"
	@(shasum -a 256 pyproject.toml 2>/dev/null || sha256sum pyproject.toml) | cut -d' ' -f1 > .venv/.deps-stamp
	cd web && npm install

build:  ## Build the web bundle
	cd web && npm run build

test:  ## Run the test suite (no models required)
	.venv/bin/pytest -q

lint:  ## Lint and type-check
	.venv/bin/ruff check .
	.venv/bin/ruff format --check .
	.venv/bin/mypy src
	cd web && npm run type-check

fix:  ## Auto-fix lint and formatting
	.venv/bin/ruff check --fix .
	.venv/bin/ruff format .

check:  ## Verify providers and index are reachable
	.venv/bin/clear-rag check

serve:  ## Run the app: one server, built UI (run `make build` after frontend changes)
	.venv/bin/clear-rag serve

dev:  ## Develop: backend (reload) + frontend (HMR) together, then open http://localhost:5173
	@bash scripts/dev.sh

docker:  ## Build and run via Docker
	docker compose up --build

reset:  ## Wipe indexed documents, vectors and traces (keeps the venv)
	rm -rf workspace/*.db workspace/*.db-* workspace/*.npz workspace/*.pkl

clean:
	rm -rf .venv web/node_modules web/dist .pytest_cache .ruff_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
