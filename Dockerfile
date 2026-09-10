# syntax=docker/dockerfile:1

# ── Stage 1: build the UI ───────────────────────────────────────────────────────
FROM node:22-alpine AS web

WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci || npm install
COPY web/ ./
# The bundle imports the committed benchmark results from the repository root.
COPY evals/results/ /evals/results/
RUN npm run build


# ── Stage 2: slim runtime (default) ─────────────────────────────────────────────
# Embeddings are served by Ollama, so torch and sentence-transformers are absent and
# the image stays in the hundreds of megabytes rather than several gigabytes.
FROM python:3.12-slim AS slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    CLEARRAG_WORKSPACE=/data \
    CLEARRAG_WEB_DIST=/app/web/dist \
    CLEARRAG_HOST=0.0.0.0 \
    CLEARRAG_PORT=8010 \
    CLEARRAG_OLLAMA_URL=http://host.docker.internal:11434

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src/ ./src/
# The rerank extra is onnxruntime + tokenizers (~40 MB of wheels, no torch); the
# 23 MB cross-encoder itself downloads into the /data volume on first use.
RUN pip install --no-cache-dir ".[rerank]"

COPY --from=web /web/dist ./web/dist
COPY evals/corpus/ ./evals/corpus/

# Non-root, with the workspace volume owned by it.
RUN useradd --create-home --uid 10001 clearrag \
    && mkdir -p /data && chown -R clearrag:clearrag /data /app
USER clearrag

VOLUME ["/data"]
EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request,sys; p=os.environ.get('CLEARRAG_PORT','8010'); sys.exit(0 if urllib.request.urlopen(f'http://127.0.0.1:{p}/api/config', timeout=4).status==200 else 1)"

CMD ["clear-rag", "serve", "--no-browser"]


# ── Stage 3: full runtime (opt-in) ──────────────────────────────────────────────
# Adds torch and sentence-transformers for HuggingFace models used directly.
# Build with: docker build --target full -t clear-rag:full .
FROM slim AS full
USER root
RUN pip install --no-cache-dir \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    "sentence-transformers>=3.3" "torch>=2.5"
USER clearrag
