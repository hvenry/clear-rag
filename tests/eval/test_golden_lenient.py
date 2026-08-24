"""Lenient quote resolution: parse loss scores as a miss instead of erroring.

Golden quotes resolve against *parsed* text, and different parser backends produce
different text — so in ablation runs an unresolvable quote means the parse lost the
answer, which is signal to score, not an authoring error to crash on. Ambiguity stays
a hard error in every mode: an ambiguous label is always the author's problem.
"""

import pytest

from clearrag.eval.golden import GoldenSetError, load_golden


def _write(tmp_path, row):
    p = tmp_path / "g.jsonl"
    p.write_text(row + "\n")
    return p


ROW = (
    '{"id": "q1", "question": "What?", '
    '"relevant": [{"doc": "a.md", "quote": "not present anywhere"}]}'
)


def test_strict_mode_still_errors(tmp_path):
    with pytest.raises(GoldenSetError):
        load_golden(_write(tmp_path, ROW), {"a.md": "other text"}, strict=True)


def test_lenient_mode_scores_unresolved_as_sentinel(tmp_path):
    qs = load_golden(_write(tmp_path, ROW), {"a.md": "other text"}, strict=False)
    assert qs[0].relevant[0].span == (-1, -1)


def test_ambiguous_quote_anchors_first_match_in_lenient_mode(tmp_path):
    # A quote unique under one parser can be duplicated under another (repeated table
    # rows flatten differently) — lenient mode anchors the first occurrence.
    row = '{"id": "q1", "question": "What?", "relevant": [{"doc": "a.md", "quote": "twice"}]}'
    with pytest.raises(GoldenSetError):
        load_golden(_write(tmp_path, row), {"a.md": "twice and twice"}, strict=True)
    qs = load_golden(_write(tmp_path, row), {"a.md": "twice and twice"}, strict=False)
    assert qs[0].relevant[0].span == (0, 5)
