"""Differential parse-quality scoring.

The same pattern that keeps BM25 honest (differential testing against SQLite FTS5),
applied to parsing: score a backend's output against ground truth derived from the
document's HTML source. Two numbers, because parsers fail two different ways:

- **word_recovery** — did the words survive at all? A dropped table cell or a page the
  extractor skipped shows up here. Order-insensitive multiset overlap.
- **order_similarity** — did they come out in reading order? Interleaved columns score
  perfect recovery and poor ordering, which is exactly the failure worth naming.
"""

from __future__ import annotations

import re
from collections import Counter
from difflib import SequenceMatcher

_WORD = re.compile(r"[a-z0-9]+")


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def parse_quality(parsed: str, truth: str) -> dict:
    truth_words = _words(truth)
    parsed_words = _words(parsed)
    if not truth_words:
        return {
            "word_recovery": 0.0,
            "order_similarity": 0.0,
            "parsed_words": len(parsed_words),
            "truth_words": 0,
        }

    overlap = sum((Counter(truth_words) & Counter(parsed_words)).values())
    # autojunk skips "popular" elements on long sequences, which silently corrupts the
    # ratio on real documents — disable it.
    matcher = SequenceMatcher(None, truth_words, parsed_words, autojunk=False)
    return {
        "word_recovery": round(overlap / len(truth_words), 4),
        "order_similarity": round(matcher.ratio(), 4),
        "parsed_words": len(parsed_words),
        "truth_words": len(truth_words),
    }
