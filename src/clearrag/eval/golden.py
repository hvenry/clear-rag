"""Loading and validating the golden set.

Relevance is anchored to **character spans in source documents**, never to chunk ids.
Chunk ids change whenever chunking configuration changes -- and comparing chunking
strategies is a primary goal of this project -- so id-anchored labels would invalidate
themselves the first time they were useful.

Labels are written as *quotes* rather than raw offsets, because hand-maintaining
character offsets is miserable and silently rots as soon as a document is edited. The
quote is resolved to a span at load time, with whitespace treated flexibly so a label
may span the hard line wraps in a Markdown source. A quote that matches nothing, or
matches more than once, is a hard error: an ambiguous label is worse than no label.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path


class GoldenSetError(ValueError):
    """The golden set does not describe the corpus it is being loaded against."""


@dataclass(frozen=True)
class RelevantSpan:
    doc: str
    """Source filename, which is stable across re-ingestion. Document ids are not."""
    quote: str
    span: tuple[int, int]


@dataclass(frozen=True)
class GoldenQuestion:
    id: str
    question: str
    relevant: list[RelevantSpan]
    must_mention: list[str] = field(default_factory=list)
    must_not_mention: list[str] = field(default_factory=list)
    """Strings whose presence means the answer bled in from the wrong section.

    This is the label that encodes *attribution*: for "what did they do at the AI
    club?", an answer mentioning the day job's "forecasting" work is drawing on the
    wrong part of the document even if every cited fact is individually true.
    """
    unanswerable: bool = False
    tags: list[str] = field(default_factory=list)

    @property
    def docs(self) -> set[str]:
        return {r.doc for r in self.relevant}


def resolve_quote(text: str, quote: str) -> tuple[int, int]:
    """Locate ``quote`` in ``text``, tolerating differences in whitespace.

    Markdown sources wrap at a column, so a labelled sentence frequently contains a
    newline where the label author wrote a space. Matching runs of whitespace against
    ``\\s+`` makes the label robust to rewrapping without making it loose about content.
    """
    pattern = r"\s+".join(re.escape(part) for part in quote.split())
    matches = list(re.finditer(pattern, text))

    if not matches:
        raise GoldenSetError(f"Quote not found: {quote!r}")
    if len(matches) > 1:
        raise GoldenSetError(
            f"Quote appears {len(matches)} times and is therefore ambiguous: {quote!r}. "
            "Extend it until it is unique within the document."
        )
    return matches[0].start(), matches[0].end()


def load_golden(path: Path, corpus: dict[str, str]) -> list[GoldenQuestion]:
    """Parse a JSONL golden set and resolve every quote against ``corpus``.

    ``corpus`` maps filename to full document text.
    """
    questions: list[GoldenQuestion] = []
    errors: list[str] = []
    seen_ids: set[str] = set()

    for lineno, line in enumerate(path.read_text().splitlines(), start=1):
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"line {lineno}: invalid JSON ({exc})")
            continue

        qid = row.get("id") or f"line{lineno}"
        if qid in seen_ids:
            errors.append(f"line {lineno}: duplicate question id {qid!r}")
        seen_ids.add(qid)

        spans: list[RelevantSpan] = []
        for label in row.get("relevant", []):
            doc = label["doc"]
            if doc not in corpus:
                errors.append(f"{qid}: no document named {doc!r} in the corpus")
                continue
            try:
                spans.append(
                    RelevantSpan(
                        doc=doc,
                        quote=label["quote"],
                        span=resolve_quote(corpus[doc], label["quote"]),
                    )
                )
            except GoldenSetError as exc:
                errors.append(f"{qid} ({doc}): {exc}")

        unanswerable = bool(row.get("unanswerable", False))
        if unanswerable and spans:
            errors.append(f"{qid}: marked unanswerable but carries relevant spans")
        if not unanswerable and not spans and not errors:
            errors.append(f"{qid}: answerable but has no relevant spans")

        questions.append(
            GoldenQuestion(
                id=qid,
                question=row["question"],
                relevant=spans,
                must_mention=row.get("must_mention", []),
                must_not_mention=row.get("must_not_mention", []),
                unanswerable=unanswerable,
                tags=row.get("tags", []),
            )
        )

    if errors:
        raise GoldenSetError(f"{len(errors)} problem(s) in {path}:\n  " + "\n  ".join(errors))
    return questions


def load_corpus(directory: Path) -> dict[str, tuple[str, bytes]]:
    """Read every supported file in ``directory`` as ``{filename: (text, raw bytes)}``."""
    from ..ingest.parse import SUPPORTED

    corpus: dict[str, tuple[str, bytes]] = {}
    for path in sorted(directory.iterdir()):
        if path.is_file() and path.suffix.lower() in SUPPORTED:
            data = path.read_bytes()
            # Only text formats can be compared against quotes directly; binary formats
            # are resolved after parsing, in the runner.
            text = data.decode("utf-8", errors="replace") if path.suffix != ".pdf" else ""
            corpus[path.name] = (text, data)
    if not corpus:
        raise GoldenSetError(f"No supported documents found in {directory}")
    return corpus
