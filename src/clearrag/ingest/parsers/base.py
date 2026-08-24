"""Shared types for PDF parser backends.

Every backend — naive text extraction, the hand-rolled primitives parser, docling,
marker — returns the same shape, which is what makes the parser an ablatable knob:
the rest of the pipeline cannot tell backends apart, so swapping one is a config
change with a measurable effect rather than a rewrite.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ...core.types import Block


@dataclass
class BackendResult:
    text: str
    blocks: list[Block]
    page_map: list[tuple[int, int]]
    diagnostics: dict = field(default_factory=dict)


class ParserUnavailable(RuntimeError):
    """The configured backend's dependencies are not installed."""

    def __init__(self, message: str, *, remedy: str) -> None:
        super().__init__(message)
        self.remedy = remedy
