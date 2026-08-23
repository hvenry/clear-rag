"""The stage protocol and its tracing wrapper.

A stage is deliberately tiny: a name, a label for the UI, and ``run``. Everything about
observability lives in ``traced`` rather than in the stages themselves, so adding a new
retrieval technique means writing the technique -- not writing instrumentation for it.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, contextmanager
from typing import Any, TypeVar

from .trace import StageRecord, Trace

T = TypeVar("T")


@contextmanager
def timed(rec: StageRecord):
    """Time a synchronous stage, recording failure without swallowing it."""
    start = time.perf_counter()
    try:
        yield rec
    except Exception as exc:
        rec.error = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        rec.duration_ms = (time.perf_counter() - start) * 1000


@asynccontextmanager
async def atimed(rec: StageRecord):
    """Time an async stage, recording failure without swallowing it."""
    start = time.perf_counter()
    try:
        yield rec
    except Exception as exc:
        rec.error = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        rec.duration_ms = (time.perf_counter() - start) * 1000


async def degradable(
    trace: Trace,
    name: str,
    label: str,
    fn: Callable[[StageRecord], Awaitable[T]],
    fallback: T,
    **config: Any,
) -> T:
    """Run an optional stage such that failure degrades the answer instead of killing it.

    This is the operating principle for anything non-essential: if the reranker cannot
    load its model, the pipeline should continue with fusion order and *say so* in the
    trace, rather than returning a 500 for a query that was otherwise answerable.
    """
    rec = trace.stage(name, label, **config)
    start = time.perf_counter()
    try:
        result = await fn(rec)
        return result
    except Exception as exc:
        rec.error = f"{type(exc).__name__}: {exc}"
        rec.degraded = True
        rec.candidates_out = rec.candidates_in
        return fallback
    finally:
        rec.duration_ms = (time.perf_counter() - start) * 1000
