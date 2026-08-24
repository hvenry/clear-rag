"""Contextual retrieval: what gets prepended to a chunk before it is indexed.

The problem being solved: a chunk that says "the Company's revenue grew 12%" is
unambiguous inside its document and meaningless in an index holding three companies'
filings. Prepending situating context to the *indexed* text (never the stored text —
spans, citations and highlighting are untouched) disambiguates it for both the
embedder and BM25.

Two modes, and the difference is the ablation's headline question:

- **breadcrumb** — deterministic, free: the document label plus the heading path above
  the chunk, straight from parse structure. Reproducible in CI with fake providers.
- **llm** — the Anthropic technique: a model writes one or two situating sentences per
  chunk. Costs one generation per chunk at index time, cached by content hash so
  re-indexing an unchanged document is free. Does it beat the free breadcrumb? That is
  what the table is for.
"""

from __future__ import annotations

import dataclasses
import hashlib

from ..core.types import Chunk, Document, Message
from ..providers.base import ChatProvider, ProviderError

#: Bump when the prompt changes: cached contexts are keyed on it, so a prompt change
#: invalidates the cache instead of silently mixing generations from two prompts.
CONTEXT_PROMPT_VERSION = 1

_SYSTEM = (
    "You situate document excerpts. Reply with one or two sentences stating which "
    "document and section this excerpt is from and what it discusses. Reply with the "
    "sentences only."
)

#: How much of the document head the LLM sees for situating context.
_DOC_HEAD_CHARS = 2000
_MAX_CONTEXT_CHARS = 300


def breadcrumb(document: Document, chunk: Chunk) -> str:
    """`doc label › heading path` for the chunk's position, from parse structure.

    The path is anchored at the chunk's first non-heading content rather than its
    first character: a chunk that *opens* with its section heading belongs to that
    section, and a chunk spanning several sections is named for the first.
    """
    anchor = next(
        (
            block.span[0]
            for block in document.blocks
            if block.kind != "heading"
            and block.span[1] > chunk.span[0]
            and block.span[0] < chunk.span[1]
        ),
        chunk.span[0],
    )
    label: str | None = None
    path: dict[int, str] = {}
    for block in document.blocks:
        if block.kind != "heading" or block.span[0] > anchor:
            continue
        text = document.text[block.span[0] : block.span[1]].lstrip("# ").strip()
        if label is None and block.level == 1:
            label = text
            continue
        level = max(block.level, 1)
        path[level] = text
        # A new heading at level L invalidates everything deeper.
        for deeper in [lv for lv in path if lv > level]:
            del path[deeper]
    parts = [label or document.filename]
    parts += [path[level] for level in sorted(path)]
    return " › ".join(parts)


def apply_breadcrumbs(document: Document, chunks: list[Chunk]) -> list[Chunk]:
    return [dataclasses.replace(c, context=breadcrumb(document, c)) for c in chunks]


def _cache_key(document: Document, chunk: Chunk, model: str) -> str:
    payload = (
        f"{document.content_hash}:{chunk.span[0]}:{chunk.span[1]}:{model}:{CONTEXT_PROMPT_VERSION}"
    )
    return hashlib.blake2b(payload.encode(), digest_size=8).hexdigest()


async def apply_llm_context(
    document: Document,
    chunks: list[Chunk],
    chat: ChatProvider,
    store,
    model: str,
) -> list[Chunk]:
    """LLM-written context per chunk, cached in the store by content.

    A provider failure on one chunk degrades that chunk to a breadcrumb rather than
    failing the whole ingestion — index-time context is an enhancement, not a
    correctness requirement.
    """
    out: list[Chunk] = []
    for chunk in chunks:
        key = _cache_key(document, chunk, model)
        context = store.get_context(key)
        if context is None:
            messages = [
                Message(role="system", content=_SYSTEM),
                Message(
                    role="user",
                    content=(
                        f"Document '{document.filename}' begins:\n"
                        f"{document.text[:_DOC_HEAD_CHARS]}\n\n---\nExcerpt:\n{chunk.text}"
                    ),
                ),
            ]
            try:
                context = (await chat.complete(messages, temperature=0.0)).strip()
                context = context[:_MAX_CONTEXT_CHARS]
                store.put_context(key, context)
            except ProviderError:
                context = breadcrumb(document, chunk)
        out.append(dataclasses.replace(chunk, context=context))
    return out
