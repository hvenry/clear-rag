"""The engine: composes stages from configuration and emits a trace as it goes.

Two pipelines live here.

``ingest`` runs Parse -> Chunk -> Embed -> Index. Documents are content-hashed, so
re-ingesting an unchanged file is a no-op instead of re-embedding it -- the predecessor
project rebuilt its entire index on every launch.

``query`` runs Transform -> [BM25 || Dense] -> Fuse -> Rerank -> Assemble -> Generate as an
async generator of events. The events are the point: the UI receives each stage as it
completes, so the retrieval process is visible *while it happens* rather than summarised
after the answer arrives.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator, Sequence
from typing import Any

from .config import PipelineConfig, Settings
from .core.stage import atimed, degradable
from .core.trace import StageRecord, Trace
from .core.types import Candidate, Message
from .generate.prompt import (
    build_answer_messages,
    build_rewrite_messages,
    extract_citations,
    hallucinated_markers,
    is_refusal,
)
from .index.lexical import LexicalIndex
from .index.store import Store
from .index.vector import VectorIndex
from .ingest.chunk import ChunkResult, chunk_document, count_tokens
from .ingest.contextualize import apply_breadcrumbs, apply_llm_context
from .ingest.parse import parse
from .ingest.parsers import available_backends, backend_remedy
from .ingest.structural import chunk_structural
from .providers.base import ChatProvider, EmbeddingProvider, ProviderError, Reranker
from .query.assemble import assemble
from .query.fuse import reciprocal_rank_fusion, weighted_fusion


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
        """Apply the configured context mode. Touches only ``Chunk.context`` — the
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

    async def reindex(self) -> dict[str, Any]:
        """Re-chunk and re-embed every stored document under the current configuration.

        Documents keep their full extracted text in SQLite, so changing an ingestion
        setting (chunk size, overlap) does not require the original files -- the corpus
        is rebuilt from stored text. Without this path, editing chunk_size in the config
        would look like it worked while every existing document stayed chunked the old
        way, which is indistinguishable from the knob being broken.

        This is also the recovery path for a changed embedding model: it deliberately
        does NOT go through the embedding-space guard, because rebuilding every vector
        is exactly what the guard's error message asks for.
        """
        summaries = self.store.list_documents()
        started = time.perf_counter()

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
        for row in summaries:
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
            "status": "reindexed",
            "documents": documents,
            "total_chunks": total_chunks,
            "config_hash": self.config.config_hash,
            "embedder": self.embeddings.id,
            "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        }
        if stale_parses:
            result["note"] = (
                f"{stale_parses} PDF(s) keep text from a different parser backend — "
                "re-indexing cannot re-parse. Re-upload the files to apply the new parser."
            )
        return result

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
        self, question: str, history: Sequence[Message] = (), *, generate: bool = True
    ) -> AsyncIterator[dict[str, Any]]:
        """Run the query pipeline, yielding events as each stage completes.

        ``generate=False`` stops after context assembly. Retrieval quality is measured
        far more often than answer quality, and evaluating a golden set should not cost
        one LLM generation per question just to score what was retrieved.
        """
        trace = Trace(query=question, config_hash=self.config.config_hash)
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

        # ── Transform ──
        search_query = question
        rec = trace.stage(
            "transform",
            "Rewrite query",
            mode=self.config.query_transform,
            rewrite_followups=self.config.rewrite_followups,
        )
        async with atimed(rec):
            if self.config.rewrite_followups and history:
                try:
                    rewritten = (
                        await self.chat.complete(
                            build_rewrite_messages(question, history), temperature=0.0
                        )
                    ).strip()
                    if rewritten:
                        search_query = rewritten.splitlines()[0][:512]
                except ProviderError as exc:
                    rec.error = str(exc)
                    rec.degraded = True
            rec.diagnostics = {
                "original": question,
                "search_query": search_query,
                "rewritten": search_query != question,
            }
        trace.resolved_query = search_query
        yield {"type": "stage", "stage": rec.to_dict()}

        # ── Retrieve (concurrently) ──
        rankings: dict[str, list[Candidate]] = {}
        use_dense = self.config.retrieval in ("dense", "hybrid")
        use_lexical = self.config.retrieval in ("lexical", "hybrid")

        dense_rec = (
            trace.stage("dense", "Vector search", k=self.config.k_candidates) if use_dense else None
        )
        lexical_rec = (
            trace.stage("bm25", "Keyword search (BM25)", k=self.config.k_candidates)
            if use_lexical
            else None
        )

        async def run_dense() -> list[Candidate]:
            start = time.perf_counter()
            vector = await self.embeddings.embed([search_query], kind="query")
            results = index.search(vector[0], k=self.config.k_candidates)
            assert dense_rec is not None
            dense_rec.duration_ms = (time.perf_counter() - start) * 1000
            dense_rec.candidates_out = results
            dense_rec.diagnostics = {
                "corpus_size": len(index),
                "returned": len(results),
                "top_score": results[0].score if results else None,
            }
            return results

        async def run_lexical() -> list[Candidate]:
            start = time.perf_counter()
            results = await asyncio.to_thread(
                self.lexical.search, search_query, self.config.k_candidates
            )
            assert lexical_rec is not None
            lexical_rec.duration_ms = (time.perf_counter() - start) * 1000
            lexical_rec.candidates_out = results
            lexical_rec.diagnostics = {
                "vocabulary_terms": len(self.lexical.postings),
                "returned": len(results),
                "query_terms": sorted(
                    {t for c in results for t in c.detail.get("matched_terms", {})}
                ),
            }
            return results

        tasks = []
        if use_dense:
            tasks.append(("dense", run_dense()))
        if use_lexical:
            tasks.append(("bm25", run_lexical()))

        try:
            results = await asyncio.gather(*(t for _, t in tasks))
        except ProviderError as exc:
            yield _error_event(exc)
            return
        for (name, _), result in zip(tasks, results, strict=True):
            rankings[name] = result

        for retrieval_rec in (lexical_rec, dense_rec):
            if retrieval_rec is not None:
                yield {"type": "stage", "stage": retrieval_rec.to_dict()}

        # ── Fuse ──
        if len(rankings) > 1:
            rec = trace.stage(
                "fuse", "Fuse (RRF)", method=self.config.fusion, rrf_k=self.config.rrf_k
            )
            async with atimed(rec):
                if self.config.fusion == "rrf":
                    fused = reciprocal_rank_fusion(rankings, k=self.config.rrf_k)
                else:
                    fused = weighted_fusion(
                        rankings,
                        weights={
                            "dense": self.config.dense_weight,
                            "bm25": 1.0 - self.config.dense_weight,
                        },
                    )
                rec.candidates_out = fused
                rec.diagnostics = {
                    "inputs": {k: len(v) for k, v in rankings.items()},
                    "unique_candidates": len(fused),
                    "found_by_both": sum(1 for c in fused if len(c.detail.get("found_by", [])) > 1),
                }
            yield {"type": "stage", "stage": rec.to_dict()}
        else:
            fused = next(iter(rankings.values()), [])

        # ── Rerank (optional; degrades to fusion order) ──
        chunk_map = self.store.get_chunks([c.chunk_id for c in fused])
        if self.config.rerank and self.reranker is not None:
            reranker = self.reranker

            async def do_rerank(rec: StageRecord) -> list[Candidate]:
                rec.candidates_in = fused
                texts = [chunk_map[c.chunk_id].text for c in fused if c.chunk_id in chunk_map]
                out = await reranker.rerank(search_query, fused, texts, top_k=self.config.k_final)
                rec.candidates_out = out
                before = {c.chunk_id: c.rank for c in fused}
                rec.diagnostics = {
                    "moves": {c.chunk_id: before.get(c.chunk_id, 0) - c.rank for c in out}
                }
                return out

            selected = await degradable(
                trace,
                "rerank",
                "Rerank (cross-encoder)",
                do_rerank,
                fallback=fused[: self.config.k_final],
                model=reranker.name,
            )
            if (rerank_rec := trace.find("rerank")) is not None:
                yield {"type": "stage", "stage": rerank_rec.to_dict()}
        else:
            if self.config.rerank and self.reranker is None:
                # Requested but unavailable. A config knob that silently does nothing is
                # worse than one that says so; the trace records the skip so the UI can
                # show it rather than implying a stage ran.
                rec = trace.stage("rerank", "Rerank (unavailable)", requested=True)
                rec.candidates_in = fused
                rec.candidates_out = fused[: self.config.k_final]
                rec.degraded = True
                rec.error = "Reranking is enabled in config but no reranker is installed."
                rec.diagnostics = {
                    "skipped": True,
                    "remedy": "Not yet implemented — fusion order was used unchanged.",
                }
                yield {"type": "stage", "stage": rec.to_dict()}
            selected = fused[: self.config.k_final]

        # ── Assemble ──
        rec = trace.stage("assemble", "Assemble context", max_tokens=self.config.max_context_tokens)
        async with atimed(rec):
            packed = assemble(selected, chunk_map, max_tokens=self.config.max_context_tokens)
            rec.candidates_in = list(selected)
            rec.candidates_out = [
                c for c in selected if c.chunk_id in {ch.id for _, ch in packed.used}
            ]
            rec.diagnostics = packed.diagnostics
        yield {"type": "stage", "stage": rec.to_dict()}
        packed_filenames = {
            doc_id: (doc.filename if (doc := self.store.get_document(doc_id)) else "unknown")
            for doc_id in {chunk.doc_id for _, chunk in packed.used}
        }
        yield {
            "type": "context",
            "chunks": [
                {
                    "marker": marker,
                    "chunk_id": chunk.id,
                    "doc_id": chunk.doc_id,
                    "filename": packed_filenames.get(chunk.doc_id, "unknown"),
                    # Position within its document. Without it a chunk is an opaque id,
                    # and a preview drawn from an overlap region looks like it belongs to
                    # the neighbouring chunk.
                    "ordinal": chunk.ordinal,
                    "text": chunk.text,
                    "span": list(chunk.span),
                    "page": chunk.page,
                }
                for marker, chunk in packed.used
            ],
        }

        if not generate:
            trace.total_ms = (time.perf_counter() - started) * 1000
            yield {"type": "done", "trace": trace.to_dict()}
            return

        # ── Generate ──
        rec = trace.stage("generate", "Generate", model=getattr(self.chat, "model", "unknown"))
        answer_parts: list[str] = []
        start = time.perf_counter()
        first_token_at: float | None = None
        try:
            async for token in self.chat.stream(
                build_answer_messages(question, packed.prompt_context, history),
                temperature=self.config.temperature,
            ):
                if first_token_at is None:
                    first_token_at = time.perf_counter()
                answer_parts.append(token)
                yield {"type": "token", "text": token}
        except ProviderError as exc:
            rec.error = str(exc)
            rec.duration_ms = (time.perf_counter() - start) * 1000
            yield _error_event(exc)
            return

        answer = "".join(answer_parts).strip()
        rec.duration_ms = (time.perf_counter() - start) * 1000

        filenames = {
            doc_id: (doc.filename if (doc := self.store.get_document(doc_id)) else "unknown")
            for doc_id in {chunk.doc_id for _, chunk in packed.used}
        }
        citations = extract_citations(answer, packed.used, filenames)
        invented = hallucinated_markers(answer, packed.used)
        rec.diagnostics = {
            "characters": len(answer),
            **_generation_speed(
                started=start,
                first_token_at=first_token_at,
                finished=start + rec.duration_ms / 1000,
                answer=answer,
                prompt_tokens=packed.diagnostics.get("context_tokens", 0),
            ),
            "citations": len(citations),
            # Markers pointing at passages that were never supplied. Dropped rather than
            # rendered, because a citation UI showing a fabricated source is worse than none.
            "hallucinated_markers": invented,
            "refused": is_refusal(answer),
        }

        trace.answer = answer
        trace.citations = citations
        trace.total_ms = (time.perf_counter() - started) * 1000
        self.store.save_trace(trace.to_dict())

        yield {"type": "stage", "stage": rec.to_dict()}
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


def _generation_speed(
    *,
    started: float,
    first_token_at: float | None,
    finished: float,
    answer: str,
    prompt_tokens: int,
) -> dict[str, Any]:
    """Split the generate stage into the two waits that have different causes.

    One duration cannot answer the only question a slow answer actually raises. Before
    the first token the model is reading: it processes the whole packed context in one
    compute-bound pass, so that number moves with ``k_final`` and ``chunk_size`` and
    barely at all with model size. After it, the model is writing: one pass over every
    weight per token, so that number is set by model size against memory bandwidth and
    is unaffected by how much context was retrieved.

    Retrieving less fixes the first. A smaller model fixes the second. Reporting a single
    total tells you to do both, which is how a pipeline ends up with neither its context
    nor its model chosen on evidence.

    Token counts use the same cl100k approximation the context budget uses, so they are
    comparable to ``chunk_size`` and ``context_tokens`` -- not to the model's own
    tokenizer, which nothing else in the app speaks either.
    """
    if first_token_at is None:
        return {"ttft_ms": None, "decode_ms": None, "tokens": 0}

    ttft_ms = (first_token_at - started) * 1000
    decode_ms = max(0.0, (finished - first_token_at) * 1000)
    tokens = count_tokens(answer)

    return {
        "ttft_ms": round(ttft_ms, 1),
        "decode_ms": round(decode_ms, 1),
        "tokens": tokens,
        # Decode rate excludes the prefill wait; including it would make a long context
        # look like a slow model.
        "tokens_per_second": round(tokens / (decode_ms / 1000), 1) if decode_ms > 0 else None,
        "prompt_tokens": prompt_tokens,
        "prefill_tokens_per_second": (
            round(prompt_tokens / (ttft_ms / 1000), 1) if ttft_ms > 0 and prompt_tokens else None
        ),
    }


def _error_event(exc: Exception) -> dict[str, Any]:
    return {
        "type": "error",
        "message": str(exc),
        "remedy": getattr(exc, "remedy", None),
    }
