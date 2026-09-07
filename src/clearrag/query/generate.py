"""The generate stage: the model writes the answer from the packed context.

Split in two because the answer *streams*. ``Generation.tokens`` yields answer text as
it arrives so the engine can forward each token; ``Generation.finish`` then resolves
citations, discards the ones the model invented, and records what the stage did.
Splitting the wait into prefill and decode is what makes a slow answer diagnosable --
see ``generation_speed``.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Sequence
from typing import Any

from ..core.trace import StageRecord
from ..core.types import Message
from ..generate.prompt import (
    build_answer_messages,
    extract_citations,
    hallucinated_markers,
    is_refusal,
)
from ..ingest.chunk import count_tokens
from ..providers.base import ProviderError
from .assemble import AssembledContext
from .context import QueryContext


class Generation:
    """One answer being generated. Opens its stage record on construction so a
    failure before the first token still appears in the trace."""

    def __init__(
        self,
        ctx: QueryContext,
        question: str,
        history: Sequence[Message],
        packed: AssembledContext,
        filenames: dict[str, str],
    ) -> None:
        self.ctx = ctx
        self.question = question
        self.history = history
        self.packed = packed
        self.filenames = filenames
        self.rec: StageRecord = ctx.trace.stage(
            "generate", "Generate", model=getattr(ctx.chat, "model", "unknown")
        )
        self._parts: list[str] = []
        self._start = 0.0
        self._first_token_at: float | None = None

    async def tokens(self) -> AsyncIterator[str]:
        """Stream the answer. A provider failure is recorded on the stage and re-raised
        so the engine can turn it into an error event."""
        self._start = time.perf_counter()
        try:
            async for token in self.ctx.chat.stream(
                build_answer_messages(self.question, self.packed.prompt_context, self.history),
                temperature=self.ctx.config.temperature,
            ):
                if self._first_token_at is None:
                    self._first_token_at = time.perf_counter()
                self._parts.append(token)
                yield token
        except ProviderError as exc:
            self.rec.error = str(exc)
            self.rec.duration_ms = (time.perf_counter() - self._start) * 1000
            raise

    def finish(self) -> str:
        """Close the stage: resolve citations, record diagnostics, stamp the trace."""
        answer = "".join(self._parts).strip()
        self.rec.duration_ms = (time.perf_counter() - self._start) * 1000

        citations = extract_citations(answer, self.packed.used, self.filenames)
        invented = hallucinated_markers(answer, self.packed.used)
        self.rec.diagnostics = {
            "characters": len(answer),
            **generation_speed(
                started=self._start,
                first_token_at=self._first_token_at,
                finished=self._start + self.rec.duration_ms / 1000,
                answer=answer,
                prompt_tokens=self.packed.diagnostics.get("context_tokens", 0),
            ),
            "citations": len(citations),
            # Markers pointing at passages that were never supplied. Dropped rather than
            # rendered, because a citation UI showing a fabricated source is worse than none.
            "hallucinated_markers": invented,
            "refused": is_refusal(answer),
        }

        self.ctx.trace.answer = answer
        self.ctx.trace.citations = citations
        return answer


def generation_speed(
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
