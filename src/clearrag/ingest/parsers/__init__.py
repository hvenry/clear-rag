"""PDF parser backend registry.

Backends are looked up by name and probed for availability by import, so an optional
heavyweight backend (docling, marker) that is not installed fails with an install
remedy instead of an ImportError, and never fails at import time of this package.
"""

from __future__ import annotations

import importlib
import importlib.util

from .base import BackendResult, ParserUnavailable

#: name -> (import probe module, install remedy). A None probe is always available.
_REGISTRY: dict[str, tuple[str | None, str | None]] = {
    "naive": (None, None),
    "primitives": ("pdfplumber", "pip install pdfplumber"),
    "docling": ("docling", "pip install -e '.[docling]'"),
    "marker": ("marker", "pip install -e '.[marker]'"),
}

BACKEND_NAMES = tuple(_REGISTRY)


def available_backends() -> dict[str, bool]:
    return {
        name: probe is None or importlib.util.find_spec(probe) is not None
        for name, (probe, _) in _REGISTRY.items()
    }


def backend_remedy(name: str) -> str | None:
    return _REGISTRY[name][1] if name in _REGISTRY else None


def parse_pdf(data: bytes, backend: str) -> BackendResult:
    if backend not in _REGISTRY:
        raise ValueError(f"Unknown parser backend {backend!r}; known: {sorted(_REGISTRY)}")
    probe, remedy = _REGISTRY[backend]
    if probe is not None and importlib.util.find_spec(probe) is None:
        raise ParserUnavailable(
            f"Parser backend {backend!r} is not installed.", remedy=remedy or ""
        )
    try:
        module = importlib.import_module(f".{backend}", __package__)
    except ModuleNotFoundError as exc:
        raise ParserUnavailable(
            f"Parser backend {backend!r} is not implemented in this build.",
            remedy=remedy or "",
        ) from exc
    return module.parse_pdf(data)
