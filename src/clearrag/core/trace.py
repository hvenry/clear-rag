"""The trace: a returned value, not a log.

Every query returns ``(answer, trace)``. The trace is a structured record of what each
stage received, produced, and how long it took -- which is what the Retrieval Inspector
renders. Because it is data rather than log lines, it also persists to SQLite and can be
replayed offline by the evaluation harness without re-invoking any model.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

from .types import Candidate, Citation

_SECRET_HINTS = ("key", "token", "secret", "password", "authorization")


def redact(config: dict[str, Any]) -> dict[str, Any]:
    """Strip anything that looks like a credential before a config reaches disk or UI."""
    out: dict[str, Any] = {}
    for k, v in config.items():
        if any(hint in k.lower() for hint in _SECRET_HINTS):
            out[k] = "***" if v else None
        elif isinstance(v, dict):
            out[k] = redact(v)
        else:
            out[k] = v
    return out


@dataclass
class StageRecord:
    """What one stage did.

    ``candidates_in``/``candidates_out`` are populated only by retrieval stages. Their
    presence is the signal the UI uses to decide whether a stage participates in the
    rank-flow diagram.
    """

    name: str
    label: str
    duration_ms: float = 0.0
    config: dict[str, Any] = field(default_factory=dict)
    diagnostics: dict[str, Any] = field(default_factory=dict)
    candidates_in: list[Candidate] | None = None
    candidates_out: list[Candidate] | None = None
    error: str | None = None
    degraded: bool = False
    """True when the stage failed but the pipeline continued with a fallback."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "label": self.label,
            "duration_ms": round(self.duration_ms, 2),
            "config": redact(self.config),
            "diagnostics": self.diagnostics,
            "candidates_in": [asdict(c) for c in self.candidates_in]
            if self.candidates_in is not None
            else None,
            "candidates_out": [asdict(c) for c in self.candidates_out]
            if self.candidates_out is not None
            else None,
            "error": self.error,
            "degraded": self.degraded,
        }


@dataclass
class Trace:
    id: str = field(default_factory=lambda: f"t_{uuid.uuid4().hex[:12]}")
    query: str = ""
    resolved_query: str | None = None
    """The query actually sent to the retrievers, after history-aware rewriting."""
    config_hash: str = ""
    created_at: float = field(default_factory=time.time)
    stages: list[StageRecord] = field(default_factory=list)
    answer: str | None = None
    citations: list[Citation] = field(default_factory=list)
    total_ms: float = 0.0
    session_id: str | None = None
    """The chat session this query ran in, which is what scopes the telemetry panel."""

    def stage(self, name: str, label: str, **config: Any) -> StageRecord:
        """Open a stage record and append it immediately.

        Appending up-front rather than on completion means a stage that raises still
        appears in the trace, which is the case you most want to see.
        """
        rec = StageRecord(name=name, label=label, config=config)
        self.stages.append(rec)
        return rec

    def find(self, name: str) -> StageRecord | None:
        return next((s for s in self.stages if s.name == name), None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "query": self.query,
            "resolved_query": self.resolved_query,
            "config_hash": self.config_hash,
            "created_at": self.created_at,
            "stages": [s.to_dict() for s in self.stages],
            "answer": self.answer,
            "citations": [asdict(c) for c in self.citations],
            "total_ms": round(self.total_ms, 2),
            "session_id": self.session_id,
        }
