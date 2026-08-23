"""BM25 over a hand-built inverted index.

Written from the formula rather than pulled from a library, because this is one of the
two places the project exists to teach. The parameters match SQLite FTS5's defaults
(k1=1.2, b=0.75) so that ``tests/test_bm25.py`` can assert agreement with FTS5 on a
shared corpus -- a differential test is how you find out a from-scratch implementation is
actually correct, rather than merely plausible.

    idf(q)      = ln(1 + (N - df(q) + 0.5) / (df(q) + 0.5))
    score(D, Q) = sum over q in Q of
                  idf(q) * (f(q,D) * (k1 + 1)) / (f(q,D) + k1 * (1 - b + b * |D|/avgdl))

The ``+1`` inside the idf logarithm is the standard non-negative variant: without it, a
term appearing in more than half the corpus gets a negative idf, and adding a common word
to a query would *lower* the score of documents containing it.
"""

from __future__ import annotations

import math
import pickle
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from ..core.types import Candidate

K1 = 1.2
B = 0.75

# Mirrors SQLite FTS5's unicode61 tokenizer closely enough for the differential test:
# case-folded, split on anything that is not a letter or digit.
_TOKEN = re.compile(r"[^\W_]+", re.UNICODE)


def tokenize(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


@dataclass
class LexicalIndex:
    """An inverted index plus the statistics BM25 needs."""

    postings: dict[str, dict[str, int]] = field(default_factory=lambda: defaultdict(dict))
    """term -> {chunk_id: term frequency in that chunk}"""
    doc_len: dict[str, int] = field(default_factory=dict)
    """chunk_id -> token count"""

    @property
    def n_docs(self) -> int:
        return len(self.doc_len)

    @property
    def avg_doc_len(self) -> float:
        return (sum(self.doc_len.values()) / self.n_docs) if self.n_docs else 0.0

    def add(self, chunk_id: str, text: str) -> None:
        tokens = tokenize(text)
        self.doc_len[chunk_id] = len(tokens)
        for term, freq in Counter(tokens).items():
            self.postings[term][chunk_id] = freq

    def remove_doc(self, chunk_id: str) -> None:
        if self.doc_len.pop(chunk_id, None) is None:
            return
        for term in list(self.postings):
            if self.postings[term].pop(chunk_id, None) is not None and not self.postings[term]:
                del self.postings[term]

    def idf(self, term: str) -> float:
        df = len(self.postings.get(term, ()))
        if df == 0:
            return 0.0
        return math.log(1 + (self.n_docs - df + 0.5) / (df + 0.5))

    def search(self, query: str, k: int = 50) -> list[Candidate]:
        """Score every chunk containing at least one query term, best first.

        Only chunks that appear in some query term's postings list are scored, which is
        the entire point of an inverted index: the corpus size stops mattering and only
        the number of matching documents does.
        """
        if self.n_docs == 0:
            return []

        terms = tokenize(query)
        avgdl = self.avg_doc_len or 1.0
        scores: dict[str, float] = defaultdict(float)
        matched: dict[str, dict[str, int]] = defaultdict(dict)

        for term in set(terms):
            postings = self.postings.get(term)
            if not postings:
                continue
            idf = self.idf(term)
            for chunk_id, freq in postings.items():
                norm = 1 - B + B * (self.doc_len[chunk_id] / avgdl)
                scores[chunk_id] += idf * (freq * (K1 + 1)) / (freq + K1 * norm)
                matched[chunk_id][term] = freq

        ordered = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))[:k]
        return [
            Candidate(
                chunk_id=chunk_id,
                score=round(score, 6),
                rank=i + 1,
                source="bm25",
                # Which terms fired, and how often. This is what the inspector highlights,
                # and it is the fastest way to see *why* a chunk was retrieved.
                detail={"matched_terms": dict(sorted(matched[chunk_id].items()))},
            )
            for i, (chunk_id, score) in enumerate(ordered)
        ]

    # ── Persistence ──

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "postings": {t: dict(p) for t, p in self.postings.items()},
            "doc_len": self.doc_len,
        }
        path.write_bytes(pickle.dumps(payload, protocol=pickle.HIGHEST_PROTOCOL))

    @classmethod
    def load(cls, path: Path) -> LexicalIndex:
        if not path.exists():
            return cls()
        payload = pickle.loads(path.read_bytes())
        index = cls(doc_len=payload["doc_len"])
        index.postings = defaultdict(dict, {t: dict(p) for t, p in payload["postings"].items()})
        return index
