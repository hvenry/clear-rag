"""Query understanding: what happens to the question before any retriever sees it.

Two transformations, both optional, applied in this order:

**Rewrite.** A follow-up is rewritten into a standalone query against the conversation
history. The prompt rewrites and refuses to answer, which is the predecessor project's
bug inverted: its contextualisation prompt *answered*, and from turn two onward the index
was searched with a hallucinated answer. The rewritten query lands in
``Trace.resolved_query`` so the interface can show exactly what was searched.

**Expand** (``query_transform="multi"``). The chat model writes alternative phrasings of
the resolved query, and every phrasing is searched. The motivating failure is a question
whose vocabulary diverges from the document's -- "can a customer be relocated to a
different data centre?" against a page that says *moving a tenant between regions* --
where keyword search goes blind and vector search may too.
One generation per question buys a few more chances to land on the document's own words.
The original always searches as well; expansions only add, they never replace.

A provider failure in either step degrades to searching what was already in hand rather
than failing the request, and the stage record says so.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ..core.stage import atimed
from ..core.trace import StageRecord
from ..core.types import Message
from ..generate.prompt import build_expand_messages, build_rewrite_messages, parse_expansions
from ..providers.base import ProviderError
from .context import QueryContext


async def transform_query(
    ctx: QueryContext, question: str, history: Sequence[Message]
) -> tuple[list[str], StageRecord]:
    """Return the queries the retrievers should search with, and the stage record.

    The resolved question comes first and is what reranking and generation see; any
    expansions follow it.
    """
    config = ctx.config
    expanding = config.query_transform == "multi"
    stage_config: dict[str, Any] = {
        "mode": config.query_transform,
        "rewrite_followups": config.rewrite_followups,
    }
    if expanding:
        stage_config["variants"] = config.query_variants
    rec = ctx.trace.stage(
        "transform", "Expand query" if expanding else "Rewrite query", **stage_config
    )

    search_query = question
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

        queries = [search_query]
        if expanding:
            expansions = await _expand(ctx, search_query, rec)
            rec.diagnostics["expansions"] = expansions
            queries.extend(expansions)

    ctx.trace.resolved_query = search_query
    return queries, rec


async def _expand(ctx: QueryContext, query: str, rec: StageRecord) -> list[str]:
    """Alternative phrasings from the chat model, or none if it is unavailable."""
    n = ctx.config.query_variants
    try:
        reply = await ctx.chat.complete(build_expand_messages(query, n), temperature=0.0)
    except ProviderError as exc:
        rec.error = str(exc)
        rec.degraded = True
        return []
    return parse_expansions(reply, query, n)
