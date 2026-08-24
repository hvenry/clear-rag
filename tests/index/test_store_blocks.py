"""Blocks survive a store round-trip, and old databases gain the column on open."""

import sqlite3

from clearrag.core.types import Block, Document
from clearrag.index.store import Store


def _doc(blocks):
    return Document(id="d_1", filename="a.md", text="# T\n\nbody", content_hash="h", blocks=blocks)


def test_blocks_round_trip(tmp_path):
    store = Store(tmp_path / "t.db")
    blocks = [Block(kind="heading", span=(0, 3), level=1), Block(kind="paragraph", span=(5, 9))]
    store.upsert_document(_doc(blocks))
    loaded = store.get_document("d_1")
    assert loaded is not None and loaded.blocks == blocks
    store.close()


def test_missing_blocks_column_is_migrated(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as conn:
        # A documents table from before this change: no blocks column.
        conn.execute(
            "CREATE TABLE documents (id TEXT PRIMARY KEY, filename TEXT NOT NULL, "
            "text TEXT NOT NULL, content_hash TEXT NOT NULL, "
            "page_map TEXT NOT NULL DEFAULT '[]', meta TEXT NOT NULL DEFAULT '{}', "
            "created_at REAL NOT NULL DEFAULT (unixepoch('subsec')))"
        )
    store = Store(path)
    cols = [r[1] for r in store.conn.execute("PRAGMA table_info(documents)")]
    assert "blocks" in cols
    store.close()
