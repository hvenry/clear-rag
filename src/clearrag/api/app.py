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
from uuid import uuid4

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


# The bundled evaluation corpora double as demo corpora. A three-chunk resume makes
# every retrieval comparison degenerate -- all retrievers return everything -- so the
# UI offers these in one click rather than asking the user to find files to drop.
# Sets are identified by filename: sample documents keep their bundled names, which
# is what lets "remove set" find them again without a tagging scheme.
SAMPLE_SETS: list[dict[str, str]] = [
    {
        "id": "dev-docs",
        "label": "Engineering docs",
        "description": "Ten short internal docs (~60 chunks) — the corpus the Lab "
        "comparisons and the bundled evals assume.",
        "rel": "evals/corpus",
        "glob": "*.md",
    },
    {
        "id": "sec-10k",
        "label": "SEC 10-K sections",
        "description": "Apple and Microsoft FY2023 10-K sections as PDFs — financial "
        "tables and dense vocabulary, the parser comparison corpus.",
        "rel": "evals/sec/corpus",
        "glob": "*.pdf",
    },
]


def _sample_files(spec: dict[str, str]) -> list[Path]:
    """Resolve a sample set to files, tolerating the same three install shapes as the
    web bundle: source checkout, container, site-packages install run from the repo."""
    here = Path(__file__).resolve()
    for root in (here.parents[3], Path("/app"), Path.cwd()):
        directory = root / spec["rel"]
        if directory.is_dir():
            files = sorted(directory.glob(spec["glob"]))
            if files:
                return files
    return []


def _sample_set(set_id: str) -> dict[str, str]:
    spec = next((s for s in SAMPLE_SETS if s["id"] == set_id), None)
    if spec is None:
        raise HTTPException(404, f"No sample set named '{set_id}'.")
    return spec


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list)
    session_id: str | None = None


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
        # Out-of-the-box values, so a "reset to defaults" in the UI restores the
        # model's actual defaults rather than a hardcoded copy that can drift.
        "defaults": PipelineConfig().model_dump(),
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
        for key in ("parser", "chunker", "chunk_size", "chunk_overlap", "context_mode")
    )
    state.config = updated
    if state.engine is not None:
        state.engine.config = updated

    return {
        "config": updated.model_dump(),
        "config_hash": updated.config_hash,
        "reindex_needed": reindex_needed,
    }


def _split_models(entries: list[tuple[str, list[str] | None]]) -> dict[str, list[str]]:
    """Bucket installed models into chat vs embedding by their capabilities.

    Ollama's /api/show reports a ``capabilities`` array ("completion", "embedding",
    …). When a model's capabilities cannot be fetched (older Ollama, transient
    error), fall back to the naming convention — "embed" in the tag — rather than
    listing an embedding model as something you could chat with.
    """
    chat: list[str] = []
    embedding: list[str] = []
    for name, capabilities in entries:
        if capabilities is not None:
            (embedding if "embedding" in capabilities else chat).append(name)
        elif "embed" in name.lower():
            embedding.append(name)
        else:
            chat.append(name)
    return {"chat": sorted(chat), "embedding": sorted(embedding)}


@app.get("/api/models")
async def list_models() -> dict[str, Any]:
    """Models installed in the local Ollama, split by what each can actually do —
    a selector offering an embedding model as a chat model is a footgun, not a choice.

    Best-effort: an unreachable Ollama returns empty lists rather than an error —
    the selector degrades to a text field, it does not break the header.
    """
    empty: dict[str, list[str]] = {"chat": [], "embedding": []}
    if state.settings.chat_provider != "ollama" and state.settings.embed_provider != "ollama":
        return empty
    try:
        import httpx

        async with httpx.AsyncClient(timeout=4.0) as client:
            response = await client.get(f"{state.settings.ollama_url}/api/tags")
            response.raise_for_status()
            names = [m["name"] for m in response.json().get("models", []) if "name" in m]

            async def capabilities(name: str) -> list[str] | None:
                try:
                    shown = await client.post(
                        f"{state.settings.ollama_url}/api/show", json={"model": name}
                    )
                    shown.raise_for_status()
                    return shown.json().get("capabilities")
                except Exception:
                    return None

            all_caps = await asyncio.gather(*(capabilities(n) for n in names))
        return _split_models(list(zip(names, all_caps, strict=True)))
    except Exception:
        return empty


@app.put("/api/providers")
async def update_providers(patch: dict[str, Any]) -> dict[str, Any]:
    """Switch the chat or embedding model at runtime.

    The engine is rebuilt lazily with the new providers. A chat-model change is free;
    an embedding-model change makes every stored vector incomparable — the
    embedding-space guard refuses queries until a re-index, and the response says so
    up front instead of letting the guard be a surprise.
    """
    allowed = {"chat_model", "embed_model"}
    unknown = set(patch) - allowed
    if unknown:
        raise HTTPException(422, f"Unknown provider settings: {sorted(unknown)}")

    embed_changed = "embed_model" in patch and patch["embed_model"] != state.settings.embed_model
    for key, value in patch.items():
        if not isinstance(value, str) or not value.strip():
            raise HTTPException(422, f"{key} must be a non-empty string")
        setattr(state.settings, key, value.strip())

    # Providers are constructed from settings, so dropping the engine is the whole
    # switch — the next request rebuilds it with the new models.
    state.engine = None

    return {
        "providers": {
            "chat": {"provider": state.settings.chat_provider, "model": state.settings.chat_model},
            "embeddings": {
                "provider": state.settings.embed_provider,
                "model": state.settings.embed_model,
            },
        },
        "reindex_needed": embed_changed,
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
    """One-shot import of the default sample set. Idempotent; the Lab still calls it."""
    files = _sample_files(SAMPLE_SETS[0])
    if not files:
        raise HTTPException(404, "The bundled sample corpus is not available in this install.")
    results: list[dict[str, Any]] = []
    for path in files:
        try:
            results.append(await eng.ingest(path.name, path.read_bytes()))
        except ProviderError as exc:
            raise HTTPException(503, {"message": str(exc), "remedy": exc.remedy}) from exc
    return {
        "results": results,
        "indexed": sum(1 for r in results if r["status"] == "indexed"),
        "unchanged": sum(1 for r in results if r["status"] == "unchanged"),
    }


@app.delete("/api/documents")
async def clear_documents(eng: Engine = Depends(engine)) -> dict[str, Any]:
    """Empty the index entirely: every document, chunk and vector."""
    docs = eng.store.list_documents()
    chunks_removed = sum(eng.delete_document(d["id"]) for d in docs)
    return {"removed": len(docs), "chunks_removed": chunks_removed}


# ── Sample sets ─────────────────────────────────────────────────────────────────


@app.get("/api/samples")
async def list_sample_sets(eng: Engine = Depends(engine)) -> list[dict[str, Any]]:
    """The bundled sample sets available in this install, with how much of each is
    already indexed — that difference is what makes the UI's import/remove buttons
    honest instead of stateless."""
    indexed = {d["filename"] for d in eng.store.list_documents()}
    listing = []
    for spec in SAMPLE_SETS:
        files = _sample_files(spec)
        if not files:
            continue
        listing.append(
            {
                "id": spec["id"],
                "label": spec["label"],
                "description": spec["description"],
                "file_count": len(files),
                "indexed_count": sum(1 for f in files if f.name in indexed),
            }
        )
    return listing


@app.post("/api/samples/{set_id}")
async def import_sample_set(set_id: str, eng: Engine = Depends(engine)) -> StreamingResponse:
    """Ingest a sample set, streaming per-file progress as SSE.

    Indexing embeds every chunk, so a set takes seconds to minutes depending on the
    embedding provider. A single blocking JSON response leaves the user staring at a
    dead button for that long; this stream is what the progress bar reads.
    """
    files = _sample_files(_sample_set(set_id))
    if not files:
        raise HTTPException(404, f"Sample set '{set_id}' is not available in this install.")

    async def events() -> AsyncIterator[str]:
        # The full plan first, so the client can draw every pending file before the
        # slow part starts rather than discovering the set one embed at a time.
        yield sse({"type": "start", "filenames": [p.name for p in files]})
        # A degraded parse (e.g. the configured backend is not installed) is recorded
        # in each file's trace; surface it once so the fallback is not silent in the UI.
        warned: set[str] = set()
        # Resuming a stopped import must not pay for the files that already landed.
        # The engine's content-hash short-circuit only fires *after* parsing, which for
        # a PDF is most of the cost — but sample sets are static bundles, so a filename
        # already in the store is the same file and can be skipped without reading it.
        already = {d["filename"] for d in eng.store.list_documents()}
        indexed = unchanged = 0
        for position, path in enumerate(files):
            yield sse(
                {"type": "file", "filename": path.name, "index": position, "total": len(files)}
            )
            if path.name in already:
                unchanged += 1
                continue
            try:
                result = await eng.ingest(path.name, path.read_bytes())
            except (UnsupportedFile, EmptyExtraction) as exc:
                yield sse({"type": "error", "message": f"{path.name}: {exc}"})
                continue
            except ProviderError as exc:
                yield sse({"type": "error", "message": str(exc), "remedy": exc.remedy})
                return
            if result["status"] == "indexed":
                indexed += 1
            elif result["status"] == "unchanged":
                unchanged += 1
            for stage in result.get("trace", {}).get("stages", []):
                if stage.get("degraded") and stage.get("error") and stage["error"] not in warned:
                    warned.add(stage["error"])
                    yield sse({"type": "warning", "message": stage["error"]})
        yield sse({"type": "done", "indexed": indexed, "unchanged": unchanged})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/samples/{set_id}")
async def remove_sample_set(set_id: str, eng: Engine = Depends(engine)) -> dict[str, Any]:
    """Remove a sample set's documents from the index, matched by bundled filename."""
    names = {p.name for p in _sample_files(_sample_set(set_id))}
    docs = [d for d in eng.store.list_documents() if d["filename"] in names]
    chunks_removed = sum(eng.delete_document(d["id"]) for d in docs)
    return {"removed": len(docs), "chunks_removed": chunks_removed}


@app.post("/api/reindex")
async def reindex(eng: Engine = Depends(engine)) -> dict[str, Any]:
    """Rebuild chunks, vectors and the keyword index under the current configuration."""
    try:
        return await eng.reindex()
    except ProviderError as exc:
        raise HTTPException(503, {"message": str(exc), "remedy": exc.remedy}) from exc


@app.post("/api/reindex/stream")
async def reindex_stream(eng: Engine = Depends(engine)) -> StreamingResponse:
    """The same rebuild, streamed as per-document SSE progress for the Lab's bar."""

    async def events() -> AsyncIterator[str]:
        try:
            async for event in eng.reindex_events():
                yield sse(event)
        except ProviderError as exc:
            yield sse({"type": "error", "message": str(exc), "remedy": exc.remedy})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/documents/{doc_id}")
async def get_document(doc_id: str, eng: Engine = Depends(engine)) -> dict[str, Any]:
    document = eng.store.get_document(doc_id)
    if document is None:
        raise HTTPException(404, f"No document with id '{doc_id}'.")
    chunks = eng.store.chunks_for_doc(doc_id)
    created_at = next(
        (d["created_at"] for d in eng.store.list_documents() if d["id"] == doc_id), None
    )
    return {
        "id": document.id,
        "filename": document.filename,
        "text": document.text,
        "created_at": created_at,
        "meta": document.meta,
        # Parse structure, so the Library view can draw what the parser recovered —
        # headings, paragraphs, tables — before it ever became chunks.
        "blocks": [
            {"kind": b.kind, "span": list(b.span), "level": b.level, "page": b.page}
            for b in document.blocks
        ],
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


# ── Chat sessions ───────────────────────────────────────────────────────────────

DEFAULT_SESSION_TITLE = "New chat"


def _new_session_id() -> str:
    return f"s_{uuid4().hex[:12]}"


class SessionCreate(BaseModel):
    title: str | None = None
    doc_ids: list[str] | None = None
    """Documents this session's retrieval is scoped to. None = the whole corpus,
    including documents added later."""


class SessionUpdate(BaseModel):
    title: str | None = None
    doc_ids: list[str] | None = None
    all_documents: bool = False
    """True widens the scope back to the whole corpus — distinct from omitting
    ``doc_ids``, which leaves the scope untouched."""


@app.get("/api/sessions")
async def list_sessions(eng: Engine = Depends(engine)) -> list[dict[str, Any]]:
    """All sessions, newest first. An empty store gets a default unscoped session,
    so the chat view always has somewhere to land."""
    sessions = eng.store.list_sessions()
    if not sessions:
        sessions = [eng.store.create_session(_new_session_id(), DEFAULT_SESSION_TITLE, None)]
    return sessions


@app.post("/api/sessions")
async def create_session(body: SessionCreate, eng: Engine = Depends(engine)) -> dict[str, Any]:
    title = (body.title or "").strip() or DEFAULT_SESSION_TITLE
    return eng.store.create_session(_new_session_id(), title, body.doc_ids)


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str, eng: Engine = Depends(engine)) -> dict[str, Any]:
    session = eng.store.get_session(session_id)
    if session is None:
        raise HTTPException(404, f"No session with id '{session_id}'.")
    # Assistant messages carry their full trace, so a reopened conversation keeps
    # its stage strips and citations rather than degrading to bare text.
    messages = eng.store.session_messages(session_id)
    for message in messages:
        message["trace"] = eng.store.get_trace(message["trace_id"]) if message["trace_id"] else None
    return {**session, "messages": messages}


@app.patch("/api/sessions/{session_id}")
async def update_session(
    session_id: str, body: SessionUpdate, eng: Engine = Depends(engine)
) -> dict[str, Any]:
    if eng.store.get_session(session_id) is None:
        raise HTTPException(404, f"No session with id '{session_id}'.")
    title = (body.title or "").strip() or None
    updated = eng.store.update_session(
        session_id, title=title, doc_ids=body.doc_ids, clear_doc_filter=body.all_documents
    )
    assert updated is not None
    return updated


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str, eng: Engine = Depends(engine)) -> dict[str, Any]:
    if eng.store.get_session(session_id) is None:
        raise HTTPException(404, f"No session with id '{session_id}'.")
    eng.store.delete_session(session_id)
    return {"deleted": session_id}


# ── Chat ────────────────────────────────────────────────────────────────────────


@app.post("/api/chat")
async def chat(request: ChatRequest, eng: Engine = Depends(engine)) -> StreamingResponse:
    history = [
        Message(role=m.get("role", "user"), content=m.get("content", ""))
        for m in request.history
        if m.get("content")
    ]

    session = None
    if request.session_id is not None:
        session = eng.store.get_session(request.session_id)
        if session is None:
            raise HTTPException(404, f"No session with id '{request.session_id}'.")

    async def events() -> AsyncIterator[str]:
        doc_ids = session["doc_ids"] if session is not None else None
        if session is not None:
            # The first question becomes the title; the placeholder name says nothing.
            if session["n_messages"] == 0 and session["title"] == DEFAULT_SESSION_TITLE:
                eng.store.update_session(session["id"], title=request.question[:60])
            eng.store.add_session_message(session["id"], "user", request.question)
        try:
            async for event in eng.query(
                request.question,
                history,
                doc_ids=doc_ids,
                session_id=session["id"] if session is not None else None,
            ):
                if session is not None and event["type"] == "done":
                    trace = event["trace"]
                    eng.store.add_session_message(
                        session["id"], "assistant", trace.get("answer") or "", trace.get("id")
                    )
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


# ── Runtime ─────────────────────────────────────────────────────────────────────


@app.get("/api/runtime")
async def runtime() -> dict[str, Any]:
    """What the inference runtime is doing: which models are resident, and where.

    Separate from /api/health because it answers a different question. Health asks "can
    this work at all"; this asks "why is it slow" -- and on a GPU box the answer is
    usually that a model quietly spilled into system RAM.
    """
    from ..providers.runtime import ollama_runtime

    if state.settings.chat_provider != "ollama" and state.settings.embed_provider != "ollama":
        return {"available": False, "error": "No Ollama provider is configured.", "models": []}
    return await ollama_runtime(state.settings.ollama_url)


# ── Traces ──────────────────────────────────────────────────────────────────────


@app.get("/api/traces")
async def list_traces(
    limit: int = 50, session_id: str | None = None, eng: Engine = Depends(engine)
) -> list[dict[str, Any]]:
    """Recent traces — all of them, or one chat session's with ``session_id``."""
    return eng.store.list_traces(limit, session_id=session_id)


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
