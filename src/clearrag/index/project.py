"""2D projection of the embedding space, for the map view.

PCA via plain numpy SVD rather than t-SNE or UMAP: it is deterministic, needs no extra
dependency, projects a *new* point (the query) into the same plane with a single matrix
multiply, and its axes mean something -- the two directions of greatest variance. The
cost is that fine cluster structure is flattened; for "did my question land near the
right documents", that trade is the right one.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Projection:
    """A fitted 2D plane through the corpus embedding space."""

    mean: np.ndarray
    components: np.ndarray  # (2, dims)
    #: Share of total variance each axis captures -- how honest the picture is.
    explained: tuple[float, float]
    scale: float

    def transform(self, vectors: np.ndarray) -> np.ndarray:
        """Project rows into the plane, scaled so corpus points span roughly [-1, 1]."""
        vectors = np.atleast_2d(np.asarray(vectors, dtype=np.float32))
        return ((vectors - self.mean) @ self.components.T) / self.scale


def fit_projection(vectors: np.ndarray) -> Projection:
    if len(vectors) < 3:
        raise ValueError("Need at least 3 vectors to fit a meaningful plane.")

    vectors = np.asarray(vectors, dtype=np.float32)
    mean = vectors.mean(axis=0)
    centered = vectors - mean

    # Economy SVD: right singular vectors are the principal axes.
    _, singular, vt = np.linalg.svd(centered, full_matrices=False)
    components = vt[:2]

    total = float((singular**2).sum()) or 1.0
    explained = (
        round(float(singular[0] ** 2 / total), 4),
        round(float(singular[1] ** 2 / total), 4) if len(singular) > 1 else 0.0,
    )

    projected = centered @ components.T
    scale = float(np.abs(projected).max()) or 1.0
    return Projection(mean=mean, components=components, explained=explained, scale=scale)
