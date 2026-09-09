"""Prompts and citation extraction.

The rewrite prompt below is the one the predecessor project got backwards. Its
contextualisation prompt said "provide a response that directly addresses the user's
query based on the provided documents" -- but a history-aware retriever feeds the model's
output straight into the search index, and at that point no documents exist. From turn two
onward it searched using a hallucinated answer. The prompt here rewrites and refuses to
answer, and the result is shown in the trace so the failure mode is visible rather than silent.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

from ..core.types import Chunk, Citation, Message

REWRITE_SYSTEM = """\
You rewrite follow-up questions so they can be understood on their own.

Given the conversation so far and the latest user message, produce a single standalone \
search query that captures what the user is asking, resolving pronouns and implicit \
references against the history.

Do NOT answer the question. Do NOT add information. Do NOT explain. Output only the \
rewritten query as one line of plain text. If the latest message already stands alone, \
output it unchanged."""

ANSWER_SYSTEM = """\
You answer questions using only the numbered context passages provided.

Rules:
- Use only information present in the context. Never rely on outside knowledge.
- Cite every claim with the bracketed number of the passage supporting it, like [1] or [2][3].
- If the context does not contain the answer, reply exactly: \
I don't have that information in the provided documents.
- Be concise. Do not restate the question or describe your process."""


EXPAND_SYSTEM = """\
You rewrite a search query into alternative phrasings, so that a search engine which \
matches words can find passages the original wording would miss.

Given a question, write {n} different ways of asking the same thing. Vary the vocabulary: \
prefer synonyms and the terms a technical document would use over the words in the \
question. Keep each phrasing to a single line.

Do NOT answer the question. Do NOT add information. Do NOT number or explain the lines. \
Output only the {n} phrasings, one per line."""


def build_expand_messages(question: str, n: int) -> list[Message]:
    return [
        Message(role="system", content=EXPAND_SYSTEM.format(n=n)),
        Message(role="user", content=question),
    ]


_LEADING_MARK = re.compile(r"^\s*(?:[-*\u2022]|\d+[.)])\s*")
_WORDS = re.compile(r"[a-z0-9]+")


def parse_expansions(text: str, original: str, n: int) -> list[str]:
    """Distinct phrasings from the model's reply, in order, at most ``n``.

    Models number and quote their lines despite instructions, so that decoration is
    stripped. A line that is the original question in different punctuation is dropped:
    searching it again would only double-count the primary query.
    """
    seen = {_normalise(original)}
    phrasings: list[str] = []
    for line in text.splitlines():
        candidate = _LEADING_MARK.sub("", line).strip().strip("\"'").strip()
        if not candidate:
            continue
        key = _normalise(candidate)
        if not key or key in seen:
            continue
        seen.add(key)
        phrasings.append(candidate)
        if len(phrasings) == n:
            break
    return phrasings


def _normalise(text: str) -> str:
    return " ".join(_WORDS.findall(text.lower()))


def build_rewrite_messages(question: str, history: Sequence[Message]) -> list[Message]:
    transcript = "\n".join(f"{m.role}: {m.content}" for m in history[-6:])
    return [
        Message(role="system", content=REWRITE_SYSTEM),
        Message(
            role="user",
            content=f"Conversation so far:\n{transcript}\n\nLatest message: {question}",
        ),
    ]


def build_answer_messages(question: str, context: str, history: Sequence[Message]) -> list[Message]:
    messages = [Message(role="system", content=ANSWER_SYSTEM)]
    messages.extend(m for m in history[-6:] if m.role != "system")
    messages.append(
        Message(role="user", content=f"Context passages:\n{context}\n\nQuestion: {question}")
    )
    return messages


_MARKER = re.compile(r"\[(\d{1,2})\]")


def extract_citations(
    answer: str, used: Sequence[tuple[int, Chunk]], filenames: dict[str, str]
) -> list[Citation]:
    """Resolve ``[n]`` markers in the answer back to the chunks they refer to.

    Markers that do not correspond to a passage actually sent to the model are discarded.
    A model inventing ``[7]`` when five passages were supplied is exactly the case where a
    citation UI would otherwise manufacture false confidence.
    """
    by_marker = {marker: chunk for marker, chunk in used}
    citations: list[Citation] = []
    seen: set[int] = set()

    for match in _MARKER.finditer(answer):
        marker = int(match.group(1))
        chunk = by_marker.get(marker)
        if chunk is None or marker in seen:
            continue
        seen.add(marker)
        citations.append(
            Citation(
                chunk_id=chunk.id,
                doc_id=chunk.doc_id,
                filename=filenames.get(chunk.doc_id, "unknown"),
                span=chunk.span,
                page=chunk.page,
                quote=chunk.text.strip()[:280],
                marker=marker,
            )
        )

    return sorted(citations, key=lambda c: c.marker)


def is_refusal(answer: str) -> bool:
    """Whether an answer is the instructed refusal rather than an attempt.

    A substring check over the opening rather than an exact match, because models wrap
    the instructed sentence ("I'm sorry, but I don't have that information...") often
    enough that strict matching under-counts refusals.
    """
    return "don't have that information" in answer.lower()[:160]


def hallucinated_markers(answer: str, used: Sequence[tuple[int, Chunk]]) -> list[int]:
    """Markers the model produced that were never supplied to it."""
    valid = {marker for marker, _ in used}
    return sorted({int(m.group(1)) for m in _MARKER.finditer(answer)} - valid)
