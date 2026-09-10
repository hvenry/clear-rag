"""The engine: composes stages from configuration and emits a trace as it goes.

Two pipelines live here.

``ingest`` runs Parse -> Chunk -> Embed -> Index. Documents are content-hashed, so
re-ingesting an unchanged file is a no-op instead of re-embedding it -- the predecessor
project rebuilt its entire index on every launch.

``query`` runs Transform -> [BM25 || Dense] -> Fuse -> Rerank -> Assemble -> Generate as an
async generator of events. The events are the point: the UI receives each stage as it
completes, so the retrieval process is visible *while it happens* rather than summarised
after the answer arrives. Each of those stages is its own module under ``clearrag.query``;
this file composes them and owns nothing about how any one of them works.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Sequence
from typing import Any

from .config import PipelineConfig, Settings
from .core.stage import atimed
from .core.trace import Trace
from .core.types import Message
from .index.lexical import LexicalIndex
from .index.store import Store
from .index.vector import VectorIndex
from .ingest.chunk import ChunkResult, chunk_document
from .ingest.contextualize import apply_breadcrumbs, apply_llm_context
from .ingest.parse import parse
from .ingest.parsers import available_backends, backend_remedy
from .ingest.structural import chunk_structural
from .providers.base import ChatProvider, EmbeddingProvider, ProviderError, Reranker
from .query.assemble import assemble_stage, context_event, filenames_for
from .query.context import QueryContext, stage_event
from .query.fuse import fuse_stage
from .query.generate import Generation
from .query.rerank import rerank_stage
from .query.retrieve import retrieve
from .query.transform import transform_query


class EmbeddingSpaceMismatch(RuntimeError):
    """The stored index was written by a different embedding model."""


class Engine:
    def __init__(
        self,
        settings: Settings,
        config: PipelineConfig,
        chat: ChatProvider,
        embeddings: EmbeddingProvider,
        reranker: Reranker | None = None,
    ) -> None:
        settings.ensure_workspace()
        self.settings = settings
        self.config = config
        self.chat = chat
        self.embeddings = embeddings
        self.reranker = reranker

        self.store = Store(settings.db_path)
        self._lexical_path = settings.workspace / "lexical.pkl"
        self.lexical = LexicalIndex.load(self._lexical_path)
        self._vectors: VectorIndex | None = None

    # ── Index lifecycle ─────────────────────────────────────────────────────────

    async def _vector_index(self) -> VectorIndex:
        """Load the vector index lazily, refusing to serve a stale embedding space."""
        if self._vectors is not None:
            return self._vectors

        if (previous := self.store.check_embedder(self.embeddings.id)) is not None:
            raise EmbeddingSpaceMismatch(
                f"This index was built with '{previous}' but the configured embedder is "
                f"'{self.embeddings.id}'. Stored vectors from a different model are not "
                "comparable. Re-index the documents, or switch the embedder back."
            )

        # Probe for dimensionality; a fresh provider does not know it until it embeds once.
        try:
            dims = self.embeddings.dimensions
        except RuntimeError:
            await self.embeddings.embed(["probe"], kind="query")
            dims = self.embeddings.dimensions

        self._vectors = VectorIndex.load(self.settings.vectors_path, dims)
        return self._vectors

    def _persist_indexes(self) -> None:
        if self._vectors is not None:
            self._vectors.save(self.settings.vectors_path)
        self.lexical.save(self._lexical_path)
        self.store.set_meta("embedder_id", self.embeddings.id)

    # ── Ingestion ───────────────────────────────────────────────────────────────

    async def _chunk(self, document) -> ChunkResult:
        """Dispatch on the chunker knob. Semantic chunking may embed section units to
        find topic breakpoints, hence the async path."""
        if self.config.chunker == "semantic":
            return await chunk_structural(
                document,
                chunk_size=self.config.chunk_size,
                embed=lambda texts: self.embeddings.embed(texts, kind="document"),
            )
        return chunk_document(
            document,
            chunk_size=self.config.chunk_size,
            chunk_overlap=self.config.chunk_overlap,
        )

    async def _contextualize(self, document, chunks: list) -> list:
        """Apply the configured context mode. Touches only ``Chunk.context``; the
        stored text, spans and citations never change."""
        if self.config.context_mode == "breadcrumb":
            return apply_breadcrumbs(document, chunks)
        if self.config.context_mode == "llm":
            return await apply_llm_context(
                document,
                chunks,
                self.chat,
                self.store,
                model=getattr(self.chat, "model", "unknown"),
            )
        return chunks

    async def ingest(self, filename: str, data: bytes) -> dict[str, Any]:
        trace = Trace(query=f"ingest:{filename}", config_hash=self.config.config_hash)
        started = time.perf_counter()

        suffix = filename.rsplit(".", 1)[-1].lower()
        backend = self.config.parser
        fallback_error: str | None = None
        if suffix == "pdf" and not available_backends().get(backend, False):
            # A config knob pointing at an uninstalled backend degrades loudly: the
            # naive parser still ingests the file, and the trace says what happened.
            remedy = backend_remedy(backend)
            fallback_error = f"Parser '{backend}' is not installed; fell back to naive extraction."
            if remedy:
                fallback_error += f" Install it with: {remedy}"
            backend = "naive"

        rec = trace.stage("parse", "Parse", format=suffix, parser=backend)
        if fallback_error:
            rec.degraded = True
            rec.error = fallback_error
        with_timer = atimed(rec)
        async with with_timer:
            result = parse(filename, data, parser=backend)
            rec.diagnostics = result.diagnostics
        document = result.document

        # Content hash short-circuit: an unchanged file costs nothing to re-upload.
        if (existing := self.store.find_by_hash(document.content_hash)) is not None:
            return {
                "status": "unchanged",
                "document_id": existing.id,
                "filename": existing.filename,
                "message": f"'{filename}' is already indexed with identical content.",
                "trace": trace.to_dict(),
            }

        rec = trace.stage(
            "chunk",
            "Chunk",
            chunker=self.config.chunker,
            chunk_size=self.config.chunk_size,
            chunk_overlap=self.config.chunk_overlap,
        )
        async with atimed(rec):
            chunked = await self._chunk(document)
            rec.diagnostics = chunked.diagnostics
        chunks = await self._contextualize(document, chunked.chunks)

        rec = trace.stage("embed", "Embed", model=self.embeddings.id)
        async with atimed(rec):
            vectors = await self.embeddings.embed([c.indexed_text for c in chunks], kind="document")
            rec.diagnostics = {
                "vectors": int(vectors.shape[0]),
                "dimensions": int(vectors.shape[1]) if vectors.size else 0,
            }

        rec = trace.stage("index", "Index")
        async with atimed(rec):
            index = await self._vector_index()
            document.meta.update(self._index_meta())
            self.store.upsert_document(document)
            self.store.replace_chunks(document.id, chunks)
            index.add([c.id for c in chunks], vectors)
            for chunk in chunks:
                self.lexical.add(chunk.id, chunk.indexed_text)
            self._persist_indexes()
            rec.diagnostics = {
                "chunks_indexed": len(chunks),
                "corpus_chunks": len(index),
                "vocabulary_terms": len(self.lexical.postings),
            }

        trace.total_ms = (time.perf_counter() - started) * 1000
        return {
            "status": "indexed",
            "document_id": document.id,
            "filename": document.filename,
            "chunks": len(chunks),
            "trace": trace.to_dict(),
        }

    def _index_meta(self) -> dict[str, Any]:
        """What this document's chunks and vectors were built with, stamped at ingest
        and re-stamped on re-index, so the inspector can say which settings a document
        actually carries rather than which the config currently shows."""
        return {
            "chunker": self.config.chunker,
            "chunk_size": self.config.chunk_size,
            "chunk_overlap": self.config.chunk_overlap,
            "context_mode": self.config.context_mode,
            "embedder": self.embeddings.id,
        }

    async def reindex(self) -> dict[str, Any]:
        """One-shot re-index: drain the event stream, return the final report."""
        async for event in self.reindex_events():
            if event["type"] == "done":
                return {key: value for key, value in event.items() if key != "type"}
        raise RuntimeError("reindex stream ended without a result")  # pragma: no cover

    async def reindex_events(self) -> AsyncIterator[dict[str, Any]]:
        """Re-chunk and re-embed every stored document under the current configuration,
        yielding per-document progress and a final ``done`` report.

        Documents keep their full extracted text in SQLite, so changing an ingestion
        setting (chunk size, overlap) does not require the original files -- the corpus
        is rebuilt from stored text. Without this path, editing chunk_size in the config
        would look like it worked while every existing document stayed chunked the old
        way, which is indistinguishable from the knob being broken.

        This is also the recovery path for a changed embedding model: it deliberately
        does NOT go through the embedding-space guard, because rebuilding every vector
        is exactly what the guard's error message asks for.

        Streamed rather than returned because re-embedding a corpus takes seconds to
        minutes -- a silent button for that long reads as broken.
        """
        summaries = self.store.list_documents()
        started = time.perf_counter()
        yield {"type": "start", "filenames": [row["filename"] for row in summaries]}

        # Probe dimensionality directly rather than via _vector_index(), which would
        # refuse to load an index written by a different embedder.
        try:
            dims = self.embeddings.dimensions
        except RuntimeError:
            await self.embeddings.embed(["probe"], kind="query")
            dims = self.embeddings.dimensions

        fresh_vectors = VectorIndex(dims)
        fresh_lexical = LexicalIndex()
        documents: list[dict[str, Any]] = []
        total_chunks = 0

        stale_parses = 0
        for position, row in enumerate(summaries):
            yield {
                "type": "doc",
                "filename": row["filename"],
                "index": position,
                "total": len(summaries),
            }
            document = self.store.get_document(row["id"])
            if document is None:
                continue
            # Reindex rebuilds from stored text; it cannot re-parse. A PDF whose text
            # came from a different parser backend keeps that backend's text, and
            # pretending otherwise would make the parser knob look broken.
            stored_parser = document.meta.get("parser")
            if stored_parser is not None and stored_parser != self.config.parser:
                stale_parses += 1
            chunked = await self._chunk(document)
            chunks = await self._contextualize(document, chunked.chunks)
            vectors = await self.embeddings.embed([c.indexed_text for c in chunks], kind="document")
            document.meta.update(self._index_meta())
            self.store.upsert_document(document)
            self.store.replace_chunks(document.id, chunks)
            fresh_vectors.add([c.id for c in chunks], vectors)
            for chunk in chunks:
                fresh_lexical.add(chunk.id, chunk.indexed_text)
            documents.append(
                {
                    "document_id": document.id,
                    "filename": document.filename,
                    "chunks": len(chunks),
                }
            )
            total_chunks += len(chunks)

        # Swap in the rebuilt indexes only after every document succeeded, so a failure
        # mid-rebuild leaves the previous (consistent) indexes in place.
        self._vectors = fresh_vectors
        self.lexical = fresh_lexical
        self._persist_indexes()

        result = {
            "type": "done",
            "status": "reindexed",
            "documents": documents,
            "total_chunks": total_chunks,
            "config_hash": self.config.config_hash,
            "embedder": self.embeddings.id,
            "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        }
        if stale_parses:
            result["note"] = (
                f"{stale_parses} PDF(s) keep text from a different parser backend, and "
                "re-indexing cannot re-parse. Re-upload the files to apply the new parser."
            )
        yield result

    def delete_document(self, doc_id: str) -> int:
        chunk_ids = self.store.delete_document(doc_id)
        if self._vectors is not None:
            self._vectors.remove_doc(set(chunk_ids))
        for chunk_id in chunk_ids:
            self.lexical.remove_doc(chunk_id)
        self._persist_indexes()
        return len(chunk_ids)

    # ── Query ───────────────────────────────────────────────────────────────────

    async def query(
        self,
        question: str,
        history: Sequence[Message] = (),
        *,
        generate: bool = True,
        doc_ids: Sequence[str] | None = None,
        session_id: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Run the query pipeline, yielding events as each stage completes.

        The stages themselves live in ``clearrag.query``, one module each. This method
        only composes them, in order, and turns every finished stage into an event --
        so adding a technique is a new module plus one line here, and the machinery
        that makes retrieval visible (the trace, the events) needs no change at all.

        ``generate=False`` stops after context assembly. Retrieval quality is measured
        far more often than answer quality, and evaluating a golden set should not cost
        one LLM generation per question just to score what was retrieved.

        ``doc_ids`` scopes retrieval to those documents (a chat session's document
        filter); None searches the whole corpus. Document ids rather than chunk ids,
        resolved here at query time, because chunk ids change on every re-index.
        """
        trace = Trace(query=question, config_hash=self.config.config_hash, session_id=session_id)
        started = time.perf_counter()

        try:
            index = await self._vector_index()
        except (EmbeddingSpaceMismatch, ProviderError) as exc:
            yield _error_event(exc)
            return

        if self.store.count_chunks() == 0:
            yield {
                "type": "error",
                "message": "No documents have been indexed yet.",
                "remedy": "Drag a PDF, DOCX, Markdown or text file onto the window.",
            }
            return

        allowed: set[str] | None = None
        if doc_ids is not None:
            allowed = self.store.chunk_ids_for_docs(list(doc_ids))
            if not allowed:
                yield {
                    "type": "error",
                    "message": "None of this chat's documents are in the index.",
                    "remedy": "Edit the chat's document scope, or re-import the documents "
                    "it was scoped to.",
                }
                return

        ctx = QueryContext(
            config=self.config,
            trace=trace,
            chat=self.chat,
            embeddings=self.embeddings,
            reranker=self.reranker,
            store=self.store,
            lexical=self.lexical,
            vectors=index,
            allowed=allowed,
        )

        # ── Transform ──
        queries, transform_rec = await transform_query(ctx, question, history)
        yield stage_event(transform_rec)
        search_query = queries[0]

        # ── Retrieve (concurrently) ──
        try:
            rankings, retrieval_recs = await retrieve(ctx, queries)
        except ProviderError as exc:
            yield _error_event(exc)
            return
        for rec in retrieval_recs:
            yield stage_event(rec)

        # ── Fuse ──
        fused, fuse_rec = fuse_stage(ctx, rankings)
        if fuse_rec is not None:
            yield stage_event(fuse_rec)

        # ── Rerank (optional; degrades to fusion order) ──
        chunk_map = self.store.get_chunks([c.chunk_id for c in fused])
        selected, rerank_rec = await rerank_stage(ctx, search_query, fused, chunk_map)
        if rerank_rec is not None:
            yield stage_event(rerank_rec)

        # ── Assemble ──
        packed, assemble_rec = assemble_stage(ctx, selected, chunk_map)
        yield stage_event(assemble_rec)
        filenames = filenames_for(self.store, packed)
        yield context_event(packed, filenames)

        if not generate:
            trace.total_ms = (time.perf_counter() - started) * 1000
            yield {"type": "done", "trace": trace.to_dict()}
            return

        # ── Generate ──
        generation = Generation(ctx, question, history, packed, filenames)
        try:
            async for token in generation.tokens():
                yield {"type": "token", "text": token}
        except ProviderError as exc:
            yield _error_event(exc)
            return
        generation.finish()

        trace.total_ms = (time.perf_counter() - started) * 1000
        self.store.save_trace(trace.to_dict())

        yield stage_event(generation.rec)
        yield {"type": "done", "trace": trace.to_dict()}

    async def healthcheck(self) -> dict[str, Any]:
        report: dict[str, Any] = {"ok": True, "checks": []}
        for label, provider in (("chat", self.chat), ("embeddings", self.embeddings)):
            entry: dict[str, Any] = {
                "component": label,
                "provider": provider.name,
                "model": getattr(provider, "model", None),
            }
            try:
                await provider.healthcheck()
                entry["ok"] = True
            except ProviderError as exc:
                entry.update(ok=False, error=str(exc), remedy=exc.remedy)
                report["ok"] = False
            report["checks"].append(entry)

        # Reranking is optional, so its absence is reported as a warning rather than
        # folded into report["ok"]: a missing cross-encoder degrades answer quality, it
        # does not stop queries, and a preflight that fails hard on it would train people
        # to ignore a red check.
        rerank_entry: dict[str, Any] = {"component": "rerank", "optional": True}
        if self.reranker is None:
            rerank_entry.update(
                ok=False,
                error="No cross-encoder installed; the rerank stage will be skipped.",
                remedy="Install the optional extra: pip install -e '.[rerank]'",
            )
        else:
            downloaded = getattr(self.reranker, "is_downloaded", lambda: True)()
            rerank_entry.update(ok=True, provider=self.reranker.name)
            if not downloaded:
                rerank_entry["remedy"] = "The model downloads (~23 MB) on the first reranked query."
        report["checks"].append(rerank_entry)

        # Parser backends are optional the same way the reranker is: a missing one
        # degrades PDF structure quality, it never stops ingestion.
        backends = available_backends()
        report["checks"].append(
            {
                "component": "parsers",
                "optional": True,
                "ok": backends.get(self.config.parser, False),
                "backends": backends,
                **(
                    {}
                    if backends.get(self.config.parser, False)
                    else {
                        "error": f"Configured parser '{self.config.parser}' is not installed; "
                        "PDFs fall back to naive extraction.",
                        "remedy": backend_remedy(self.config.parser),
                    }
                ),
            }
        )

        report["documents"] = len(self.store.list_documents())
        report["chunks"] = self.store.count_chunks()
        if (previous := self.store.check_embedder(self.embeddings.id)) is not None:
            report["ok"] = False
            report["checks"].append(
                {
                    "component": "index",
                    "ok": False,
                    "error": f"Index was built with '{previous}', configured embedder is "
                    f"'{self.embeddings.id}'.",
                    "remedy": "Re-index your documents, or restore the previous embedding model.",
                }
            )
        return report


def _error_event(exc: Exception) -> dict[str, Any]:
    return {
        "type": "error",
        "message": str(exc),
        "remedy": getattr(exc, "remedy", None),
    }
