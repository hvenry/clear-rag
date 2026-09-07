"""Query understanding: what happens to the question before any retriever sees it.

Today that is one thing - rewriting a follow-up into a standalone query against the
conversation history.

The prompt rewrites and refuses to answer, which is the predecessor project's bug inverted:
    its contextualisation prompt *answered*, and from turn two onward the index was searched
    with a hallucinated answer.

The rewritten query lands in ``Trace.resolved_query`` so the interface can show exactly what
was searched.

HyDE (hypothetical document embedding) and multi-query expansion belong here too when they arrive;
the config already carries ``query_transform`` for them.
"""

from __future__ import annotations

from collections.abc import Sequence

from ..core.stage import atimed
from ..core.trace import StageRecord
from ..core.types import Message
from ..generate.prompt import build_rewrite_messages
from ..providers.base import ProviderError
from .context import QueryContext


async def transform_query(
    ctx: QueryContext, question: str, history: Sequence[Message]
) -> tuple[str, StageRecord]:
    """Return the query the retrievers should search with, and the stage record.

    A rewrite failure degrades to searching the literal question rather than failing
    the request: the stage records the error and carries on.
    """
    config = ctx.config
    search_query = question
    rec = ctx.trace.stage(
        "transform",
        "Rewrite query",
        mode=config.query_transform,
        rewrite_followups=config.rewrite_followups,
    )
    async with atimed(rec):
        if config.rewrite_followups and history:
            try:
                rewritten = (
                    await ctx.chat.complete(
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
    ctx.trace.resolved_query = search_query
    return search_query, rec
