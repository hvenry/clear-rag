"""FastAPI application.

The chat endpoint streams Server-Sent Events rather than returning JSON, and it streams
*stage events* alongside answer tokens. That is what makes the retrieval process visible
while it happens: the client sees keyword search finish, vector search finish, fusion
reorder the candidates, and only then does the answer begin.

SSE rather than WebSockets because the traffic is one-directional, it survives proxies,
and browsers reconnect on their own.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..config import PipelineConfig, Settings, get_settings
from ..core.types import Message
from ..ingest.parse import EmptyExtraction, UnsupportedFile
from ..pipeline import Engine
from ..providers.base import ProviderError
from ..providers.registry import build_chat, build_embeddings, build_reranker


def _find_web_dist() -> Path:
    """Locate the built UI.

    Checked in order so the same code works from a source checkout, an editable install
    inside a container, and a site-packages install where the package no longer sits
    beside the web directory.
    """
    if override := os.environ.get("CLEARRAG_WEB_DIST"):
        return Path(override)
    here = Path(__file__).resolve()
    candidates = [
        here.parents[3] / "web" / "dist",
        Path("/app/web/dist"),
        Path.cwd() / "web" / "dist",
    ]
    return next((c for c in candidates if (c / "index.html").is_file()), candidates[0])


WEB_DIST = _find_web_dist()


def _find_sample_corpus() -> Path | None:
    """The bundled evaluation corpus doubles as a demo corpus.

    A three-chunk resume makes every retrieval comparison degenerate -- all retrievers
    return everything. Ten documents (~60 chunks) is where hybrid-vs-dense differences,
    the rank-flow chart, and the Lab's comparisons become visible, so the UI offers to
    load this corpus in one click rather than asking the user to find files to drop.
    """
    here = Path(__file__).resolve()
    candidates = [
        here.parents[3] / "evals" / "corpus",
        Path("/app/evals/corpus"),
        Path.cwd() / "evals" / "corpus",
    ]
    return next((c for c in candidates if c.is_dir() and any(c.glob("*.md"))), None)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list)


class State:
    """Process-wide singletons. Rebuilt when configuration changes."""

    engine: Engine | None = None
    settings: Settings
    config: PipelineConfig

    def build(self) -> Engine:
        self.engine = Engine(
            self.settings,
            self.config,
            chat=build_chat(self.settings),
            embeddings=build_embeddings(self.settings),
            reranker=build_reranker(self.settings),
        )
        return self.engine

    def get(self) -> Engine:
        if self.engine is None:
            return self.build()
        return self.engine


state = State()


def engine() -> Engine:
    try:
        return state.get()
    except ProviderError as exc:
        raise HTTPException(503, {"message": str(exc), "remedy": exc.remedy}) from exc


async def _preload() -> None:
    """Ask the providers to load their models before the first question arrives.

    Runs as a background task rather than inline: loading several gigabytes of weights
    takes seconds, and a server that refuses to accept connections until a model is warm
    is worse than one whose first answer is slow. Every failure here is swallowed for the
    same reason -- preloading is an optimisation, and a cold model still answers.
    """
    try:
        eng = state.get()
    except ProviderError:
        return
    for provider in (eng.chat, eng.embeddings):
        preload = getattr(provider, "preload", None)
        if preload is None:
            continue
        try:
            await preload()
        except Exception:  # noqa: BLE001 - an unusable provider is the healthcheck's job
            continue


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.settings = get_settings()
    state.config = PipelineConfig()
    state.settings.ensure_workspace()
    warm = asyncio.create_task(_preload()) if state.settings.preload else None
    yield
    if warm is not None:
        warm.cancel()
    if state.engine is not None:
        state.engine.store.close()


app = FastAPI(title="clear-rag", version="0.1.0", lifespan=lifespan)

# The Vite dev server runs on a different origin during development only; the packaged
# app serves the bundle from this same process and never crosses origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


# ── Health & configuration ──────────────────────────────────────────────────────


@app.get("/api/health")
async def health() -> dict[str, Any]:
    """Preflight. Reports actionable remedies rather than raising."""
    try:
        return await state.get().healthcheck()
    except ProviderError as exc:
        return {
            "ok": False,
            "checks": [
                {"component": "startup", "ok": False, "error": str(exc), "remedy": exc.remedy}
            ],
        }


@app.get("/api/config")
async def read_config() -> dict[str, Any]:
    return {
        "config": state.config.model_dump(),
        "config_hash": state.config.config_hash,
        "providers": {
            "chat": {"provider": state.settings.chat_provider, "model": state.settings.chat_model},
            "embeddings": {
                "provider": state.settings.embed_provider,
                "model": state.settings.embed_model,
            },
        },
    }


@app.put("/api/config")
async def write_config(patch: dict[str, Any]) -> dict[str, Any]:
    """Update pipeline configuration.

    Ingestion-time settings are accepted but only affect documents indexed afterwards;
    the response says so explicitly rather than implying the corpus was rewritten.
    """
    try:
        updated = state.config.model_copy(update=patch)
        PipelineConfig.model_validate(updated.model_dump())
    except Exception as exc:
        raise HTTPException(422, str(exc)) from exc

    reindex_needed = any(
        patch.get(key) is not None and patch[key] != getattr(state.config, key)
        for key in ("chunker", "chunk_size", "chunk_overlap", "contextualize")
    )
    state.config = updated
    if state.engine is not None:
        state.engine.config = updated

    return {
        "config": updated.model_dump(),
        "config_hash": updated.config_hash,
        "reindex_needed": reindex_needed,
    }


# ── Documents ───────────────────────────────────────────────────────────────────


@app.get("/api/documents")
async def list_documents(eng: Engine = Depends(engine)) -> list[dict[str, Any]]:
    return eng.store.list_documents()


@app.post("/api/documents")
async def upload(files: list[UploadFile] = File(...), eng: Engine = Depends(engine)) -> dict:
    results: list[dict[str, Any]] = []
    for upload_file in files:
        data = await upload_file.read()
        name = upload_file.filename or "untitled"
        try:
            results.append(await eng.ingest(name, data))
        except (UnsupportedFile, EmptyExtraction) as exc:
            results.append({"status": "rejected", "filename": name, "message": str(exc)})
        except ProviderError as exc:
            results.append(
                {"status": "failed", "filename": name, "message": str(exc), "remedy": exc.remedy}
            )
    return {"results": results}


@app.post("/api/documents/sample")
async def load_sample_corpus(eng: Engine = Depends(engine)) -> dict[str, Any]:
    """Ingest the bundled evaluation corpus. Idempotent: unchanged files are skipped."""
    corpus = _find_sample_corpus()
    if corpus is None:
        raise HTTPException(404, "The bundled sample corpus is not available in this install.")
    results: list[dict[str, Any]] = []
    for path in sorted(corpus.glob("*.md")):
        try:
            results.append(await eng.ingest(path.name, path.read_bytes()))
        except ProviderError as exc:
            raise HTTPException(503, {"message": str(exc), "remedy": exc.remedy}) from exc
    return {
        "results": results,
        "indexed": sum(1 for r in results if r["status"] == "indexed"),
        "unchanged": sum(1 for r in results if r["status"] == "unchanged"),
    }


@app.post("/api/reindex")
async def reindex(eng: Engine = Depends(engine)) -> dict[str, Any]:
    """Rebuild chunks, vectors and the keyword index under the current configuration."""
    try:
        return await eng.reindex()
    except ProviderError as exc:
        raise HTTPException(503, {"message": str(exc), "remedy": exc.remedy}) from exc


@app.get("/api/documents/{doc_id}")
async def get_document(doc_id: str, eng: Engine = Depends(engine)) -> dict[str, Any]:
    document = eng.store.get_document(doc_id)
    if document is None:
        raise HTTPException(404, f"No document with id '{doc_id}'.")
    chunks = eng.store.chunks_for_doc(doc_id)
    return {
        "id": document.id,
        "filename": document.filename,
        "text": document.text,
        "meta": document.meta,
        # Spans let the Chunk Inspector draw boundaries directly over the source text.
        "chunks": [
            {
                "id": c.id,
                "ordinal": c.ordinal,
                "span": list(c.span),
                "page": c.page,
                "text": c.text,
                "context": c.context,
            }
            for c in chunks
        ],
    }


@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: str, eng: Engine = Depends(engine)) -> dict[str, Any]:
    if eng.store.get_document(doc_id) is None:
        raise HTTPException(404, f"No document with id '{doc_id}'.")
    return {"deleted": doc_id, "chunks_removed": eng.delete_document(doc_id)}


# ── Chat ────────────────────────────────────────────────────────────────────────


@app.post("/api/chat")
async def chat(request: ChatRequest, eng: Engine = Depends(engine)) -> StreamingResponse:
    history = [
        Message(role=m.get("role", "user"), content=m.get("content", ""))
        for m in request.history
        if m.get("content")
    ]

    async def events() -> AsyncIterator[str]:
        try:
            async for event in eng.query(request.question, history):
                yield sse(event)
        except Exception as exc:  # pragma: no cover - last-resort guard
            yield sse({"type": "error", "message": f"{type(exc).__name__}: {exc}"})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Embedding map ───────────────────────────────────────────────────────────────


@app.get("/api/map")
async def embedding_map(query: str | None = None, eng: Engine = Depends(engine)) -> dict[str, Any]:
    """The corpus projected to 2D, optionally with a query point and its neighbours."""
    from ..index.project import fit_projection

    try:
        index = await eng._vector_index()
    except Exception as exc:
        raise HTTPException(
            503, {"message": str(exc), "remedy": getattr(exc, "remedy", None)}
        ) from exc

    ids, vectors = index.snapshot()
    if len(ids) < 3:
        raise HTTPException(
            409,
            "The map needs at least 3 indexed chunks. Upload documents or load the sample corpus.",
        )

    projection = fit_projection(vectors)
    coords = projection.transform(vectors)
    chunks = eng.store.get_chunks(ids)
    filenames = {d["id"]: d["filename"] for d in eng.store.list_documents()}

    points = [
        {
            "chunk_id": cid,
            "doc_id": chunks[cid].doc_id,
            "filename": filenames.get(chunks[cid].doc_id, "?"),
            "ordinal": chunks[cid].ordinal,
            "x": round(float(x), 4),
            "y": round(float(y), 4),
        }
        for cid, (x, y) in zip(ids, coords, strict=True)
        if cid in chunks
    ]

    query_point = None
    neighbours: list[str] = []
    if query and query.strip():
        try:
            vector = await eng.embeddings.embed([query.strip()], kind="query")
        except ProviderError as exc:
            raise HTTPException(503, {"message": str(exc), "remedy": exc.remedy}) from exc
        qx, qy = projection.transform(vector)[0]
        query_point = {"x": round(float(qx), 4), "y": round(float(qy), 4)}
        neighbours = [c.chunk_id for c in index.search(vector[0], k=min(5, len(ids)))]

    return {
        "points": points,
        "query": query_point,
        "neighbours": neighbours,
        "explained_variance": list(projection.explained),
    }


# ── Traces ──────────────────────────────────────────────────────────────────────


@app.get("/api/traces")
async def list_traces(limit: int = 50, eng: Engine = Depends(engine)) -> list[dict[str, Any]]:
    return eng.store.list_traces(limit)


@app.get("/api/traces/{trace_id}")
async def get_trace(trace_id: str, eng: Engine = Depends(engine)) -> dict[str, Any]:
    trace = eng.store.get_trace(trace_id)
    if trace is None:
        raise HTTPException(404, f"No trace with id '{trace_id}'.")
    return trace


# ── Static bundle ───────────────────────────────────────────────────────────────

if WEB_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str) -> FileResponse:
        """Serve the SPA, letting client-side routing own every non-API path."""
        candidate = WEB_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(WEB_DIST / "index.html")
