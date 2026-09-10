"""The standard sweep's embedder dimension: rows that differ from a base row by the
embedding model alone, so the table can say what the model is worth."""

from __future__ import annotations

from clearrag.eval.variants import Variant, attribution_variants, standard_variants


def test_standard_sweep_has_no_embedder_rows_by_default():
    variants = standard_variants()
    assert all(v.embed_model is None for v in variants)
    assert len({v.label for v in variants}) == len(variants)


def test_each_extra_embedder_adds_a_dense_and_a_hybrid_row():
    base = standard_variants()
    variants = standard_variants(embedders=["all-minilm"])
    extra = variants[len(base) :]

    assert [v.label for v in extra] == ["dense only, all-minilm", "hybrid + RRF, all-minilm"]
    assert all(v.embed_model == "all-minilm" for v in extra)

    # The mirrored base rows use exactly the same configuration: one variable moved.
    by_label = {v.label: v for v in base}
    assert extra[0].config == by_label["dense only"].config
    assert extra[1].config == by_label["hybrid + RRF"].config


def test_a_plain_pair_is_a_variant_with_no_embedder():
    variant = Variant("x", standard_variants()[0].config)
    assert variant.embed_model is None
    assert all(v.embed_model is None for v in attribution_variants())
