"""`clear-rag eval --set KEY=VALUE`: any pipeline knob from the command line.

The values arrive as strings and go through the same model that validates the config
everywhere else, so a typo is a validation error rather than a silently ignored key.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from clearrag.__main__ import _embedders_to_sweep, parse_overrides
from clearrag.config import PipelineConfig, Settings
from clearrag.providers import registry


def test_overrides_are_validated_and_coerced_by_the_config_model():
    overrides = parse_overrides(
        ["query_transform=multi", "rerank=true", "k_final=3", "dense_weight=0.25"]
    )
    config = PipelineConfig(**overrides)  # type: ignore[arg-type]

    assert config.query_transform == "multi"
    assert config.rerank is True
    assert config.k_final == 3
    assert config.dense_weight == 0.25


@pytest.mark.parametrize("bad", [["rerank"], ["=true"], ["k_final="]])
def test_malformed_override_is_rejected_up_front(bad):
    with pytest.raises(SystemExit):
        parse_overrides(bad)


def test_unknown_value_is_a_validation_error_not_a_silent_default():
    with pytest.raises(ValidationError):
        PipelineConfig(**parse_overrides(["query_transform=hyper"]))  # type: ignore[arg-type]


# ── `clear-rag ablate --embedder MODEL` ──


def test_embedder_sweep_leaves_out_the_process_default(monkeypatch):
    """The base rows already measure the configured embedder; a row repeating it under
    its own name would be the same measurement twice."""
    monkeypatch.setattr(registry, "available_embedders", lambda settings, c: (list(c), []))
    settings = Settings(embed_provider="ollama", embed_model="nomic-embed-text:latest")
    args = SimpleNamespace(embedders=["nomic-embed-text", "all-minilm"], fake=False)
    assert _embedders_to_sweep(settings, args) == (["all-minilm"], [])


def test_fake_sweep_measures_embedders_only_when_asked():
    settings = Settings(embed_provider="ollama", embed_model="nomic-embed-text")
    assert _embedders_to_sweep(settings, SimpleNamespace(embedders=None, fake=True)) == ([], [])
    args = SimpleNamespace(embedders=["alt"], fake=True)
    assert _embedders_to_sweep(settings, args) == (["alt"], [])
