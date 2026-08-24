"""BM25 correctness, including a differential test against SQLite FTS5.

The differential test is the point of this file. A from-scratch ranking function is easy
to write plausibly and hard to verify by inspection; agreeing with an independent
implementation on the same corpus is real evidence.
"""

from __future__ import annotations

import sqlite3

import pytest

from clearrag.index.lexical import K1, B, LexicalIndex, tokenize

DOCS = {
    "c1": "the quick brown fox jumps over the lazy dog",
    "c2": "a quick brown dog outpaces a quick fox",
    "c3": "lorem ipsum dolor sit amet consectetur adipiscing elit",
    "c4": "the dog barked at the fox and the fox ran away quickly",
    "c5": "database indexing and retrieval with inverted indexes",
    "c6": "quick sorting algorithms and quick selection in arrays",
}


@pytest.fixture
def index() -> LexicalIndex:
    idx = LexicalIndex()
    for chunk_id, text in DOCS.items():
        idx.add(chunk_id, text)
    return idx


def test_tokenize_folds_case_and_strips_punctuation():
    assert tokenize("Hello, World! It's 2026.") == ["hello", "world", "it", "s", "2026"]


def test_empty_index_returns_nothing():
    assert LexicalIndex().search("anything") == []


def test_unmatched_query_returns_nothing(index):
    assert index.search("helicopter submarine") == []


def test_ranks_are_contiguous_and_one_based(index):
    results = index.search("quick fox")
    assert [c.rank for c in results] == list(range(1, len(results) + 1))


def test_scores_are_descending(index):
    scores = [c.score for c in index.search("quick brown dog")]
    assert scores == sorted(scores, reverse=True)


def test_matched_terms_are_reported(index):
    top = index.search("quick fox")[0]
    matched = top.detail["matched_terms"]
    assert set(matched) <= {"quick", "fox"}
    assert all(count >= 1 for count in matched.values())


def test_idf_is_never_negative_for_common_terms(index):
    # "the" appears in a majority of documents. Without the +1 inside the logarithm this
    # would be negative, and adding a stopword to a query would *lower* matching scores.
    assert index.idf("the") >= 0.0


def test_rarer_term_earns_higher_idf(index):
    assert index.idf("lorem") > index.idf("quick")


def test_term_saturation(index):
    # BM25 saturates: a second occurrence adds less than the first. c6 contains "quick"
    # twice but should not score twice what a single-occurrence document of equal
    # length would.
    single = LexicalIndex()
    single.add("a", "quick")
    single.add("b", "quick quick")
    scores = {c.chunk_id: c.score for c in single.search("quick")}
    assert scores["b"] < 2 * scores["a"]


def test_remove_doc_purges_postings(index):
    index.remove_doc("c1")
    assert "c1" not in index.doc_len
    assert all("c1" not in postings for postings in index.postings.values())
    assert all(c.chunk_id != "c1" for c in index.search("quick brown fox"))


def test_roundtrip_persistence(index, tmp_path):
    path = tmp_path / "lexical.pkl"
    index.save(path)
    restored = LexicalIndex.load(path)
    assert restored.n_docs == index.n_docs
    assert [c.chunk_id for c in restored.search("quick fox")] == [
        c.chunk_id for c in index.search("quick fox")
    ]


def test_load_missing_file_gives_empty_index(tmp_path):
    assert LexicalIndex.load(tmp_path / "absent.pkl").n_docs == 0


# ── Differential test against SQLite FTS5 ───────────────────────────────────────


def _fts5_ranking(query: str) -> list[str] | None:
    """Rank DOCS with SQLite's own BM25. Returns None if FTS5 is unavailable."""
    conn = sqlite3.connect(":memory:")
    try:
        conn.execute("CREATE VIRTUAL TABLE d USING fts5(cid UNINDEXED, body, tokenize='unicode61')")
    except sqlite3.OperationalError:
        return None
    conn.executemany("INSERT INTO d(cid, body) VALUES(?,?)", list(DOCS.items()))
    # FTS5's bm25() returns a negative value where more-negative means a better match,
    # so ascending order here is best-first.
    rows = conn.execute(
        "SELECT cid FROM d WHERE d MATCH ? ORDER BY bm25(d, 1.0) ASC",
        (" OR ".join(tokenize(query)),),
    ).fetchall()
    conn.close()
    return [r[0] for r in rows]


@pytest.mark.parametrize(
    "query", ["quick fox", "dog", "quick brown dog", "inverted indexes", "the fox"]
)
def test_matches_sqlite_fts5_ranking(index, query):
    expected = _fts5_ranking(query)
    if expected is None:
        pytest.skip("This SQLite build has no FTS5 support.")

    actual = [c.chunk_id for c in index.search(query)]

    # Same documents matched: both implementations use OR semantics over the query terms.
    assert set(actual) == set(expected), f"{query}: matched a different document set"
    # And the same document ranked first, which is what actually reaches the generator.
    assert actual[0] == expected[0], f"{query}: disagreed on the top result"


def test_parameters_match_fts5_defaults():
    assert (K1, B) == (1.2, 0.75)
