"""SQLite persistence for documents, chunks and traces.

Also the home of the embedding-space guard. ``meta`` records which embedding model wrote
the current index; if it changes, every stored vector is meaningless and the correct
behaviour is to refuse to serve queries and ask for a re-index -- not to keep answering
with noise, which is what a system without this check does.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from pathlib import Path

from ..core.types import Block, Chunk, Document

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
    id           TEXT PRIMARY KEY,
    filename     TEXT NOT NULL,
    text         TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    page_map     TEXT NOT NULL DEFAULT '[]',
    meta         TEXT NOT NULL DEFAULT '{}',
    blocks       TEXT NOT NULL DEFAULT '[]',
    created_at   REAL NOT NULL DEFAULT (unixepoch('subsec'))
);
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash);

CREATE TABLE IF NOT EXISTS chunks (
    id       TEXT PRIMARY KEY,
    doc_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    text     TEXT NOT NULL,
    context  TEXT,
    start    INTEGER NOT NULL,
    end      INTEGER NOT NULL,
    ordinal  INTEGER NOT NULL,
    page     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id, ordinal);

CREATE TABLE IF NOT EXISTS context_cache (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
    id          TEXT PRIMARY KEY,
    query       TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    created_at  REAL NOT NULL,
    total_ms    REAL NOT NULL,
    payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_traces_created ON traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_config  ON traces(config_hash);
"""


class Store:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.commit()

    def _migrate(self) -> None:
        """Add columns that post-date an existing database. CREATE TABLE IF NOT EXISTS
        leaves an old table untouched, so new columns need an explicit ALTER."""
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(documents)")}
        if "blocks" not in cols:
            self.conn.execute("ALTER TABLE documents ADD COLUMN blocks TEXT NOT NULL DEFAULT '[]'")

    def close(self) -> None:
        self.conn.close()

    # ── Embedding-space guard ──

    def get_meta(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        self.conn.commit()

    def check_embedder(self, embedder_id: str) -> str | None:
        """Return the previously-used embedder id if it differs from ``embedder_id``."""
        recorded = self.get_meta("embedder_id")
        if recorded and recorded != embedder_id and self.count_chunks():
            return recorded
        return None

    # ── Documents ──

    def upsert_document(self, doc: Document) -> None:
        self.conn.execute(
            "INSERT INTO documents(id, filename, text, content_hash, page_map, meta, blocks) "
            "VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
            "filename=excluded.filename, text=excluded.text, "
            "content_hash=excluded.content_hash, page_map=excluded.page_map, "
            "meta=excluded.meta, blocks=excluded.blocks",
            (
                doc.id,
                doc.filename,
                doc.text,
                doc.content_hash,
                json.dumps(doc.page_map),
                json.dumps(doc.meta),
                json.dumps([[b.kind, b.span[0], b.span[1], b.level, b.page] for b in doc.blocks]),
            ),
        )
        self.conn.commit()

    def get_document(self, doc_id: str) -> Document | None:
        row = self.conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
        return _row_to_document(row) if row else None

    def find_by_hash(self, content_hash: str) -> Document | None:
        row = self.conn.execute(
            "SELECT * FROM documents WHERE content_hash = ? LIMIT 1", (content_hash,)
        ).fetchone()
        return _row_to_document(row) if row else None

    def list_documents(self) -> list[dict]:
        rows = self.conn.execute(
            "SELECT d.id, d.filename, d.content_hash, d.created_at, LENGTH(d.text) AS chars, "
            "(SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS n_chunks "
            "FROM documents d ORDER BY d.created_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def delete_document(self, doc_id: str) -> list[str]:
        """Delete a document, returning the chunk ids that must leave the indexes too."""
        ids = [
            r["id"]
            for r in self.conn.execute(
                "SELECT id FROM chunks WHERE doc_id = ?", (doc_id,)
            ).fetchall()
        ]
        self.conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        self.conn.commit()
        return ids

    # ── Chunks ──

    def replace_chunks(self, doc_id: str, chunks: Iterable[Chunk]) -> None:
        self.conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
        self.conn.executemany(
            "INSERT INTO chunks(id, doc_id, text, context, start, end, ordinal, page) "
            "VALUES(?,?,?,?,?,?,?,?)",
            [
                (c.id, c.doc_id, c.text, c.context, c.span[0], c.span[1], c.ordinal, c.page)
                for c in chunks
            ],
        )
        self.conn.commit()

    def get_chunks(self, chunk_ids: list[str]) -> dict[str, Chunk]:
        if not chunk_ids:
            return {}
        marks = ",".join("?" * len(chunk_ids))
        rows = self.conn.execute(
            f"SELECT * FROM chunks WHERE id IN ({marks})", chunk_ids
        ).fetchall()
        return {r["id"]: _row_to_chunk(r) for r in rows}

    def chunks_for_doc(self, doc_id: str) -> list[Chunk]:
        rows = self.conn.execute(
            "SELECT * FROM chunks WHERE doc_id = ? ORDER BY ordinal", (doc_id,)
        ).fetchall()
        return [_row_to_chunk(r) for r in rows]

    def all_chunks(self) -> list[Chunk]:
        rows = self.conn.execute("SELECT * FROM chunks ORDER BY doc_id, ordinal").fetchall()
        return [_row_to_chunk(r) for r in rows]

    def count_chunks(self) -> int:
        return int(self.conn.execute("SELECT COUNT(*) AS n FROM chunks").fetchone()["n"])

    # ── Contextual-retrieval cache ──
    # LLM-written chunk contexts, keyed by content hash + model + prompt version, so
    # re-indexing an unchanged document costs zero generations.

    def get_context(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM context_cache WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def put_context(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO context_cache(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        self.conn.commit()

    # ── Traces ──

    def save_trace(self, trace_dict: dict) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO traces(id, query, config_hash, created_at, total_ms, payload) "
            "VALUES(?,?,?,?,?,?)",
            (
                trace_dict["id"],
                trace_dict["query"],
                trace_dict["config_hash"],
                trace_dict["created_at"],
                trace_dict["total_ms"],
                json.dumps(trace_dict),
            ),
        )
        self.conn.commit()

    def get_trace(self, trace_id: str) -> dict | None:
        row = self.conn.execute("SELECT payload FROM traces WHERE id = ?", (trace_id,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def list_traces(self, limit: int = 50) -> list[dict]:
        """Trace summaries, newest first, with enough per-stage detail to chart.

        The full payload stays behind get_trace(); this pulls out only what a
        telemetry readout needs — stage durations and the generate stage's token
        stats — so listing fifty traces does not ship fifty full candidate lists.
        """
        rows = self.conn.execute(
            "SELECT id, query, config_hash, created_at, total_ms, payload FROM traces "
            "ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()

        summaries = []
        for row in rows:
            summary = {k: row[k] for k in ("id", "query", "config_hash", "created_at", "total_ms")}
            payload = json.loads(row["payload"])
            summary["stages"] = [
                {
                    "name": s["name"],
                    "label": s.get("label", s["name"]),
                    "duration_ms": s["duration_ms"],
                }
                for s in payload.get("stages", [])
            ]
            generate = next((s for s in payload.get("stages", []) if s["name"] == "generate"), None)
            diag = (generate or {}).get("diagnostics") or {}
            summary["ttft_ms"] = diag.get("ttft_ms")
            summary["tokens"] = diag.get("tokens")
            summary["tokens_per_second"] = diag.get("tokens_per_second")
            summary["n_citations"] = len(payload.get("citations") or [])
            summaries.append(summary)
        return summaries


def _row_to_document(row: sqlite3.Row) -> Document:
    return Document(
        id=row["id"],
        filename=row["filename"],
        text=row["text"],
        content_hash=row["content_hash"],
        page_map=[tuple(p) for p in json.loads(row["page_map"])],
        meta=json.loads(row["meta"]),
        blocks=[
            Block(kind=k, span=(s, e), level=lv, page=pg)
            for k, s, e, lv, pg in json.loads(row["blocks"])
        ],
    )


def _row_to_chunk(row: sqlite3.Row) -> Chunk:
    return Chunk(
        id=row["id"],
        doc_id=row["doc_id"],
        text=row["text"],
        context=row["context"],
        span=(row["start"], row["end"]),
        ordinal=row["ordinal"],
        page=row["page"],
    )
