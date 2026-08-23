"""Retrieval metrics.

All of these are pure arithmetic over a ranked list -- no model, no randomness -- which
is what makes them safe to run as a CI gate.

One definition here is deliberately unusual and worth stating plainly.

**recall@k counts labelled spans covered, not relevant chunks retrieved.** The obvious
denominator, "how many relevant chunks exist", is not stable: change the chunk size and
the same passage becomes one chunk or four, so the score moves without retrieval having
got better or worse. Counting how many of the *labelled answer spans* were surfaced keeps
the denominator fixed no matter how the corpus is cut, which is the entire reason the
golden set is span-anchored.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

from ..core.types import Chunk
from .golden import GoldenQuestion, RelevantSpan

#: A chunk counts as covering a labelled span when it contains at least this much of it.
#: Without a threshold, a chunk clipping the final two characters of the answer would
#: score as a hit; at 0.5 the chunk has to actually carry the substance of the answer.
DEFAULT_COVERAGE = 0.5


def covers(
    chunk: Chunk, label: RelevantSpan, doc_name: str, threshold: float = DEFAULT_COVERAGE
) -> bool:
    """True when ``chunk`` contains enough of ``label`` to answer from."""
    if doc_name != label.doc:
        return False
    start, end = chunk.span
    overlap = min(end, label.span[1]) - max(start, label.span[0])
    label_length = max(1, label.span[1] - label.span[0])
    return overlap / label_length >= threshold


@dataclass
class QuestionResult:
    """Per-question scores, kept so failures can be inspected individually."""

    id: str
    question: str
    tags: list[str]
    unanswerable: bool
    hit: bool = False
    recall: float = 0.0
    precision: float = 0.0
    reciprocal_rank: float = 0.0
    ndcg: float = 0.0
    first_relevant_rank: int | None = None
    retrieved: list[str] = field(default_factory=list)
    #: Labelled spans no retrieved chunk covered — the actionable part of a bad score.
    missed: list[str] = field(default_factory=list)
    answer: str | None = None
    mentioned: bool | None = None
    refused: bool | None = None


def score_question(
    question: GoldenQuestion,
    ranked: Sequence[tuple[Chunk, str]],
    *,
    k: int,
    threshold: float = DEFAULT_COVERAGE,
) -> QuestionResult:
    """Score one question against a ranked list of ``(chunk, document filename)``."""
    result = QuestionResult(
        id=question.id,
        question=question.question,
        tags=list(question.tags),
        unanswerable=question.unanswerable,
        retrieved=[c.id for c, _ in ranked[:k]],
    )

    # Unanswerable questions have nothing to retrieve; they are judged on the answer side.
    if question.unanswerable or not question.relevant:
        return result

    top = list(ranked[:k])
    relevance = [
        any(covers(chunk, label, doc, threshold) for label in question.relevant)
        for chunk, doc in top
    ]

    covered = [
        label
        for label in question.relevant
        if any(covers(chunk, label, doc, threshold) for chunk, doc in top)
    ]
    result.recall = len(covered) / len(question.relevant)
    result.missed = [
        f"{label.doc}: {label.quote[:60]}" for label in question.relevant if label not in covered
    ]

    result.precision = (sum(relevance) / len(relevance)) if relevance else 0.0
    result.hit = any(relevance)

    for rank, is_relevant in enumerate(relevance, start=1):
        if is_relevant:
            result.first_relevant_rank = rank
            result.reciprocal_rank = 1.0 / rank
            break

    result.ndcg = _ndcg(relevance, n_relevant=len(question.relevant))
    return result


def _ndcg(relevance: Sequence[bool], *, n_relevant: int) -> float:
    """Normalised discounted cumulative gain with binary gains.

    Rewards placing relevant chunks near the top rather than merely inside the window,
    which is what actually matters when the generator only sees the first few.
    """
    dcg = sum(1.0 / math.log2(rank + 1) for rank, hit in enumerate(relevance, start=1) if hit)
    ideal_hits = min(n_relevant, len(relevance))
    idcg = sum(1.0 / math.log2(rank + 1) for rank in range(1, ideal_hits + 1))
    return (dcg / idcg) if idcg else 0.0


@dataclass
class Aggregate:
    """Corpus-level scores. Answerable and unanswerable questions are scored separately
    because averaging them together hides both."""

    k: int
    n_questions: int
    n_answerable: int
    recall: float
    precision: float
    mrr: float
    ndcg: float
    hit_rate: float
    #: Fraction of unanswerable questions the model correctly declined to answer.
    refusal_accuracy: float | None = None
    #: Fraction of answerable questions whose answer contained the required strings.
    mention_accuracy: float | None = None
    by_tag: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "k": self.k,
            "n_questions": self.n_questions,
            "n_answerable": self.n_answerable,
            "recall": round(self.recall, 4),
            "precision": round(self.precision, 4),
            "mrr": round(self.mrr, 4),
            "ndcg": round(self.ndcg, 4),
            "hit_rate": round(self.hit_rate, 4),
            "refusal_accuracy": None
            if self.refusal_accuracy is None
            else round(self.refusal_accuracy, 4),
            "mention_accuracy": None
            if self.mention_accuracy is None
            else round(self.mention_accuracy, 4),
            "by_tag": {tag: round(value, 4) for tag, value in sorted(self.by_tag.items())},
        }


def aggregate(results: Sequence[QuestionResult], *, k: int) -> Aggregate:
    answerable = [r for r in results if not r.unanswerable]
    unanswerable = [r for r in results if r.unanswerable]

    def mean(values: Sequence[float]) -> float:
        return (sum(values) / len(values)) if values else 0.0

    by_tag: dict[str, float] = {}
    for tag in sorted({t for r in answerable for t in r.tags}):
        tagged = [r for r in answerable if tag in r.tags]
        by_tag[tag] = mean([r.recall for r in tagged])

    refused = [r.refused for r in unanswerable if r.refused is not None]
    mentioned = [r.mentioned for r in answerable if r.mentioned is not None]

    return Aggregate(
        k=k,
        n_questions=len(results),
        n_answerable=len(answerable),
        recall=mean([r.recall for r in answerable]),
        precision=mean([r.precision for r in answerable]),
        mrr=mean([r.reciprocal_rank for r in answerable]),
        ndcg=mean([r.ndcg for r in answerable]),
        hit_rate=mean([1.0 if r.hit else 0.0 for r in answerable]),
        refusal_accuracy=mean([1.0 if r else 0.0 for r in refused]) if refused else None,
        mention_accuracy=mean([1.0 if m else 0.0 for m in mentioned]) if mentioned else None,
        by_tag=by_tag,
    )
