"""The parser knob: config field, trace stamping, graceful fallback, healthcheck."""

import pytest

from clearrag.config import PipelineConfig, Settings
from clearrag.pipeline import Engine
from clearrag.providers.fake import FakeChat, FakeEmbeddings


def _engine(tmp_path, **cfg):
    return Engine(Settings(workspace=tmp_path), PipelineConfig(**cfg), FakeChat(), FakeEmbeddings())


def test_config_has_parser_and_context_mode():
    cfg = PipelineConfig()
    assert cfg.parser == "primitives" and cfg.context_mode == "none"
    with pytest.raises(ValueError):
        PipelineConfig(parser="bogus")
    with pytest.raises(ValueError):
        PipelineConfig(context_mode="bogus")


async def test_ingest_stamps_parser_into_trace(tmp_path):
    result = await _engine(tmp_path).ingest("a.md", b"# T\n\nBody text here.")
    parse_stage = next(s for s in result["trace"]["stages"] if s["name"] == "parse")
    assert parse_stage["config"]["parser"] == "primitives"


async def test_unavailable_backend_degrades_to_naive_for_pdfs(tmp_path, monkeypatch):
    import clearrag.pipeline as pl

    monkeypatch.setattr(
        pl,
        "available_backends",
        lambda: {"naive": True, "primitives": False, "docling": False, "marker": False},
    )
    from tests.conftest import TINY_PDF

    engine = _engine(tmp_path, parser="primitives")
    result = await engine.ingest("a.pdf", TINY_PDF)
    assert result["status"] == "indexed"
    parse_stage = next(s for s in result["trace"]["stages"] if s["name"] == "parse")
    assert parse_stage["config"]["parser"] == "naive"
    assert parse_stage["degraded"] is True
    assert "primitives" in (parse_stage["error"] or "")


async def test_healthcheck_reports_parsers(tmp_path):
    report = await _engine(tmp_path).healthcheck()
    comp = next(c for c in report["checks"] if c["component"] == "parsers")
    assert comp["optional"] is True and comp["backends"]["naive"] is True
