"""The sec ablation sweep covers parser, chunker and context dimensions."""

from clearrag.eval.variants import sec_variants


def test_sec_variants_cover_all_three_dimensions():
    variants, skipped = sec_variants()
    labels = [label for label, _ in variants]
    parsers = {cfg.parser for _, cfg in variants}
    assert {"naive", "primitives"} <= parsers
    assert any(cfg.chunker == "semantic" for _, cfg in variants)
    assert {cfg.context_mode for _, cfg in variants} >= {"none", "breadcrumb", "llm"}
    assert len(labels) == len(set(labels))
    for name in skipped:
        assert name in ("docling", "marker")
