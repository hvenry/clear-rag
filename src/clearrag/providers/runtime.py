"""What the local inference runtime is actually doing right now.

Ollama already knows which models are resident, how much of each sits in VRAM, and what
context size each was loaded with. None of that is visible from the app, which is how the
two most expensive local-inference mistakes stay invisible:

* **Layers spilled to CPU.** A model that does not fit in VRAM is not refused -- it is
  split, and generation slows by an order of magnitude while everything still "works".
  ``size_vram / size`` is the only number that says so.
* **A model loaded at the wrong context size.** Ollama allocates the KV cache at load
  time and reloads on a different ``num_ctx``, so a mismatch silently pays a full reload
  on the first real query.

Reported rather than computed from the host: no psutil, no nvidia-smi, nothing to install
and nothing platform-specific. The cost is that this describes the model runtime, not the
machine -- which is the part that actually explains a slow answer.
"""

from __future__ import annotations

from typing import Any

import httpx


async def ollama_runtime(base_url: str, timeout: float = 5.0) -> dict[str, Any]:
    """Resident models and where they live. Never raises: this is a readout, not a check."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(f"{base_url.rstrip('/')}/api/ps")
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        return {"available": False, "error": str(exc), "models": []}

    models = [_describe(m) for m in payload.get("models", [])]
    return {
        "available": True,
        "models": models,
        "resident_bytes": sum(m["size_bytes"] for m in models),
        "vram_bytes": sum(m["vram_bytes"] for m in models),
        # The headline: anything below 100% means part of the model is running on the CPU.
        "fully_on_gpu": all(m["on_gpu_pct"] >= 100 for m in models) if models else True,
    }


def _describe(model: dict[str, Any]) -> dict[str, Any]:
    size = int(model.get("size") or 0)
    vram = int(model.get("size_vram") or 0)
    details = model.get("details") or {}
    return {
        "name": model.get("name") or model.get("model") or "unknown",
        "size_bytes": size,
        "vram_bytes": vram,
        "on_gpu_pct": round(100 * vram / size, 1) if size else 0.0,
        "context_length": model.get("context_length"),
        "parameters": details.get("parameter_size"),
        "quantization": details.get("quantization_level"),
        "expires_at": model.get("expires_at"),
    }
