"""The runtime readout: which models are resident, and how much of each is on the GPU."""

from __future__ import annotations

import httpx
import pytest

from clearrag.providers.runtime import ollama_runtime


@pytest.fixture
def ps(monkeypatch):
    """Serve a scripted /api/ps response."""

    def install(payload, status=200):
        real = httpx.AsyncClient

        def patched(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(
                lambda request: httpx.Response(status, json=payload)
            )
            return real(*args, **kwargs)

        monkeypatch.setattr(httpx, "AsyncClient", patched)

    return install


def model(name: str, size: int, vram: int) -> dict:
    return {
        "name": name,
        "size": size,
        "size_vram": vram,
        "context_length": 8192,
        "details": {"parameter_size": "9.7B", "quantization_level": "Q4_K_M"},
        "expires_at": "2026-08-23T13:27:17.150006-04:00",
    }


async def test_a_fully_resident_model_reports_all_of_it_on_gpu(ps):
    ps({"models": [model("qwen3.5:9b", 5_787_950_775, 5_787_950_775)]})
    status = await ollama_runtime("http://x")

    assert status["available"] is True
    assert status["fully_on_gpu"] is True
    assert status["models"][0]["on_gpu_pct"] == 100.0


async def test_a_split_model_is_reported_rather_than_hidden(ps):
    """Ollama does not refuse a model that overflows VRAM -- it runs part of it on the
    CPU and everything still works, an order of magnitude slower. This ratio is the only
    place that becomes visible."""
    ps({"models": [model("too-big:70b", 1000, 600)]})
    status = await ollama_runtime("http://x")

    assert status["fully_on_gpu"] is False
    assert status["models"][0]["on_gpu_pct"] == 60.0


async def test_an_unreachable_runtime_is_a_readout_not_an_error(ps):
    """This is a readout beside the answer, not a preflight. It degrades to silence."""
    ps({}, status=500)
    status = await ollama_runtime("http://x")

    assert status["available"] is False
    assert status["models"] == []


async def test_nothing_loaded_is_not_a_failure(ps):
    ps({"models": []})
    status = await ollama_runtime("http://x")

    assert status["available"] is True
    assert status["fully_on_gpu"] is True
    assert status["vram_bytes"] == 0
