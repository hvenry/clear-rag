"""The sec ablation sweep covers parser, chunker and context dimensions."""

from clearrag.eval.variants import sec_variants


def test_sec_variants_cover_all_three_dimensions():
    variants, skipped = sec_variants()
    labels = [v.label for v in variants]
    parsers = {v.config.parser for v in variants}
    assert {"naive", "primitives"} <= parsers
    assert any(v.config.chunker == "semantic" for v in variants)
    assert {v.config.context_mode for v in variants} >= {"none", "breadcrumb", "llm"}
    assert len(labels) == len(set(labels))
    assert all(v.embed_model is None for v in variants), "the sec sweep varies parsing"
    for name in skipped:
        assert name in ("docling", "marker")
