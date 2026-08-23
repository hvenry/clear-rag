.PHONY: help install reinstall dev build test lint fix check serve docker clean reset

help:
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS=":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

# Pin the interpreter explicitly. Running `python3 -m venv` over an existing venv does
# not error, it layers a second interpreter into bin/ and leaves the console scripts
# pointing at whichever one was there last -- a venv that half-works in confusing ways.
PYTHON ?= python3.12

install:  ## Install Python and web dependencies (override with PYTHON=python3.13)
	@test ! -d .venv || (echo "ERROR: .venv exists. Run 'make clean' first, or 'make reinstall'." && exit 1)
	$(PYTHON) -m venv .venv
	.venv/bin/pip install -e ".[dev]"
	cd web && npm install

reinstall:  ## Delete and rebuild the virtualenv from scratch
	rm -rf .venv
	$(MAKE) install

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

serve:  ## Run the app
	.venv/bin/clear-rag serve

dev:  ## Backend with reload (run `cd web && npm run dev` alongside)
	.venv/bin/clear-rag serve --reload --no-browser

docker:  ## Build and run via Docker
	docker compose up --build

reset:  ## Wipe indexed documents, vectors and traces (keeps the venv)
	rm -rf workspace/*.db workspace/*.db-* workspace/*.npz workspace/*.pkl

clean:
	rm -rf .venv web/node_modules web/dist .pytest_cache .ruff_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
