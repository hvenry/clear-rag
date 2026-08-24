"""Structure-first chunking: whole sections pack together, boundaries at headings."""

from clearrag.ingest.parse import parse
from clearrag.ingest.structural import chunk_structural

MD = (
    "# Doc\n\n"
    "## Alpha\n\nAlpha body sentence one. Alpha body sentence two.\n\n"
    "## Beta\n\nBeta body sentence.\n\n"
    "## Gamma\n\nGamma body sentence.\n"
)


async def test_small_sections_pack_together_and_spans_hold():
    doc = parse("a.md", MD.encode()).document
    result = await chunk_structural(doc, chunk_size=512)
    assert len(result.chunks) == 1  # everything fits one budget
    for c in result.chunks:
        assert doc.text[c.span[0] : c.span[1]] == c.text


async def test_budget_splits_at_section_boundaries_never_inside():
    doc = parse("a.md", MD.encode()).document
    result = await chunk_structural(doc, chunk_size=24)
    texts = [c.text for c in result.chunks]
    assert len(texts) >= 2
    for t in texts[1:]:
        assert t.lstrip().startswith("##")  # every later chunk opens on a heading


async def test_overlong_section_splits_at_topic_shift_not_at_token_budget():
    from clearrag.providers.fake import FakeEmbeddings

    # One paragraph, no blank line at the topic shift: a size-based splitter cuts
    # wherever the budget lands (mixing topics); embedding-drop cuts at the shift.
    astro = " ".join(
        f"The telescope observed galaxy nebula orbit cluster number {i}." for i in range(6)
    )
    cooking = " ".join(f"The recipe needs flour butter oven dough salt item {i}." for i in range(2))
    md = f"# Doc\n\n## Mixed\n\n{astro} {cooking}\n"
    doc = parse("a.md", md.encode()).document
    fake = FakeEmbeddings()

    async def embed(texts):
        return await fake.embed(texts, kind="document")

    result = await chunk_structural(doc, chunk_size=70, embed=embed)
    assert len(result.chunks) >= 2
    has_astro = ["telescope" in c.text for c in result.chunks]
    has_cook = ["flour" in c.text for c in result.chunks]
    # No chunk mixes the two topics.
    assert not any(a and b for a, b in zip(has_astro, has_cook, strict=True))


async def test_embedding_split_is_deterministic():
    from clearrag.providers.fake import FakeEmbeddings

    md = "# D\n\n## S\n\n" + "\n\n".join(
        " ".join([f"topic{i} word{i} thing{i}"] * 15) for i in range(4)
    )
    doc = parse("a.md", md.encode()).document
    fake = FakeEmbeddings()

    async def embed(texts):
        return await fake.embed(texts, kind="document")

    first = await chunk_structural(doc, chunk_size=80, embed=embed)
    second = await chunk_structural(doc, chunk_size=80, embed=embed)
    assert first.diagnostics["boundaries"] == second.diagnostics["boundaries"]


async def test_blockless_document_falls_back():
    from dataclasses import replace

    doc = parse("a.txt", b"Plain text with no structure at all.").document
    doc = replace(doc, blocks=[])
    result = await chunk_structural(doc, chunk_size=512)
    assert result.diagnostics.get("fallback") == "recursive"
    assert result.chunks
