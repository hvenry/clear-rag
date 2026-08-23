"""Exact flat vector index.

Deliberately exhaustive rather than approximate. Under roughly 100k chunks a full
matrix-vector product is single-digit milliseconds, and being exact means there are no
index parameters to misconfigure and no recall loss to explain away.

Swapping in an approximate index (FAISS HNSW) is Phase 5 precisely so that it arrives as
a *measured* experiment -- recall@k against latency, plotted -- rather than as an
unexamined day-one default whose cost nobody ever checks.

Because every vector is L2-normalised on the way in (see ``providers.base.l2_normalise``),
the inner product below *is* cosine similarity. The predecessor project normalised only
the document side and left query vectors raw, which left its reported scores meaningless
even though the ranking accidentally survived.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from ..core.types import Candidate


class VectorIndex:
    def __init__(self, dimensions: int) -> None:
        self.dimensions = dimensions
        self._vectors = np.zeros((0, dimensions), dtype=np.float32)
        self._ids: list[str] = []
        self._row_of: dict[str, int] = {}

    def __len__(self) -> int:
        return len(self._ids)

    @property
    def ids(self) -> list[str]:
        return list(self._ids)

    def add(self, chunk_ids: list[str], vectors: np.ndarray) -> None:
        if len(chunk_ids) != len(vectors):
            raise ValueError(f"{len(chunk_ids)} ids but {len(vectors)} vectors")
        if len(vectors) == 0:
            return
        if vectors.shape[1] != self.dimensions:
            raise ValueError(
                f"Expected {self.dimensions}-dim vectors, got {vectors.shape[1]}. "
                "The embedding model has changed; the index must be rebuilt."
            )
        start = len(self._ids)
        self._vectors = np.vstack([self._vectors, vectors.astype(np.float32)])
        self._ids.extend(chunk_ids)
        self._row_of.update({cid: start + i for i, cid in enumerate(chunk_ids)})

    def remove_doc(self, chunk_ids: set[str]) -> None:
        """Drop rows for the given chunks, compacting the matrix."""
        if not chunk_ids:
            return
        keep = [i for i, cid in enumerate(self._ids) if cid not in chunk_ids]
        self._vectors = self._vectors[keep] if keep else np.zeros((0, self.dimensions), np.float32)
        self._ids = [self._ids[i] for i in keep]
        self._row_of = {cid: i for i, cid in enumerate(self._ids)}

    def search(self, query_vector: np.ndarray, k: int = 50) -> list[Candidate]:
        if len(self._ids) == 0:
            return []
        query = np.asarray(query_vector, dtype=np.float32).reshape(-1)
        scores = self._vectors @ query

        k = min(k, len(scores))
        # argpartition finds the top k without fully sorting the rest -- the sort then
        # only touches k elements instead of the whole corpus.
        top = np.argpartition(-scores, k - 1)[:k]
        top = top[np.argsort(-scores[top], kind="stable")]

        return [
            Candidate(
                chunk_id=self._ids[int(row)],
                score=round(float(scores[row]), 6),
                rank=i + 1,
                source="dense",
                detail={"cosine": round(float(scores[row]), 6)},
            )
            for i, row in enumerate(top)
        ]

    # ── Persistence ──

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(
            path.with_suffix(".npz"), vectors=self._vectors, ids=np.array(self._ids, dtype=object)
        )

    @classmethod
    def load(cls, path: Path, dimensions: int) -> VectorIndex:
        npz = path.with_suffix(".npz")
        index = cls(dimensions)
        if not npz.exists():
            return index
        with np.load(npz, allow_pickle=True) as data:
            vectors = data["vectors"].astype(np.float32)
            ids = [str(x) for x in data["ids"].tolist()]
        if vectors.size and vectors.shape[1] != dimensions:
            # Dimension mismatch means a different embedding model wrote this file.
            # Returning empty forces a re-index instead of silently mixing spaces.
            return index
        index._vectors = vectors
        index._ids = ids
        index._row_of = {cid: i for i, cid in enumerate(ids)}
        return index
