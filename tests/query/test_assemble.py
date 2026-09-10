"""Context assembly: what the model is shown, and what it must never be shown."""

from clearrag.core.types import Candidate, Chunk
from clearrag.query.assemble import assemble


def _chunk(id_: str, text: str, start: int) -> Chunk:
    return Chunk(id=id_, doc_id="d_1", text=text, span=(start, start + len(text)), ordinal=0)


def test_prompt_labels_passages_by_marker_only():
    """Chunk ids are internal. A small model shown "(c_…)" in its context will
    parrot it into answers, the regression this test pins."""
    chunks = {
        "c_aaa111": _chunk("c_aaa111", "The effective tax rate was 19%.", 0),
        "c_bbb222": _chunk("c_bbb222", "Revenue grew twelve percent.", 100),
    }
    candidates = [
        Candidate(chunk_id="c_aaa111", score=1.0, rank=1, source="rrf"),
        Candidate(chunk_id="c_bbb222", score=0.5, rank=2, source="rrf"),
    ]
    packed = assemble(candidates, chunks, max_tokens=512)

    assert "[1]" in packed.prompt_context and "[2]" in packed.prompt_context
    assert "c_aaa111" not in packed.prompt_context
    assert "(c_" not in packed.prompt_context
    # The id→marker mapping lives beside the prompt, not inside it.
    assert [(m, c.id) for m, c in packed.used] == [(1, "c_aaa111"), (2, "c_bbb222")]
