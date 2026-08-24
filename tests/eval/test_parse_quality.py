"""The differential parse-quality scorer: word recovery and ordering vs ground truth."""

from clearrag.eval.parse_quality import parse_quality


def test_perfect_recovery():
    scores = parse_quality("The quick brown fox.", "The quick brown fox.")
    assert scores["word_recovery"] == 1.0 and scores["order_similarity"] == 1.0


def test_interleaved_columns_hurt_order_not_recovery():
    truth = "alpha one alpha two beta one beta two"
    interleaved = "alpha one beta one alpha two beta two"
    scores = parse_quality(interleaved, truth)
    assert scores["word_recovery"] == 1.0
    assert scores["order_similarity"] < 1.0


def test_lost_table_hurts_recovery():
    scores = parse_quality("Products", "Products 298,085 316,199")
    assert scores["word_recovery"] < 0.5
