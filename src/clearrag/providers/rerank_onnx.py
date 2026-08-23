"""Cross-encoder reranking via ONNX Runtime.

A bi-encoder (the embedding model) encodes the query and each chunk *separately* and
compares vectors -- fast enough to search a whole corpus, but it can only compare
summaries of meaning. A cross-encoder reads the query and a chunk *together* through one
transformer and scores their actual interaction -- far more accurate, and far too slow to
run over everything. Hence the pipeline shape: cheap retrievers propose ~50 candidates,
the cross-encoder re-scores that shortlist.

The model is ms-marco-MiniLM-L-6-v2, quantized to ~23 MB of ONNX -- small enough to
download on first use and fast enough on CPU that reranking a shortlist costs tenths of
a second, keeping the default install free of torch.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import httpx
import numpy as np

from ..core.types import Candidate
from .base import ProviderError

_REPO = "https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2/resolve/main"
_FILES = {
    "model.onnx": f"{_REPO}/onnx/model_quantized.onnx",
    "tokenizer.json": f"{_REPO}/tokenizer.json",
}
_MAX_TOKENS = 512


def available() -> bool:
    """Whether the optional runtime dependencies are installed."""
    try:
        import onnxruntime  # noqa: F401
        import tokenizers  # noqa: F401
    except ModuleNotFoundError:
        return False
    return True


class OnnxReranker:
    name = "cross-encoder/ms-marco-MiniLM-L-6-v2 (onnx int8)"

    def __init__(self, model_dir: Path) -> None:
        self.model_dir = model_dir
        self._session: Any = None
        self._tokenizer: Any = None

    # ── Model lifecycle ──

    def is_downloaded(self) -> bool:
        return all((self.model_dir / name).exists() for name in _FILES)

    async def download(self) -> None:
        """Fetch the model on first use, atomically per file."""
        self.model_dir.mkdir(parents=True, exist_ok=True)
        async with httpx.AsyncClient(timeout=300.0, follow_redirects=True) as client:
            for name, url in _FILES.items():
                target = self.model_dir / name
                if target.exists():
                    continue
                partial = target.with_suffix(".partial")
                try:
                    async with client.stream("GET", url) as response:
                        response.raise_for_status()
                        with partial.open("wb") as fh:
                            async for chunk in response.aiter_bytes(1 << 16):
                                fh.write(chunk)
                    partial.rename(target)
                except httpx.HTTPError as exc:
                    partial.unlink(missing_ok=True)
                    raise ProviderError(
                        f"Could not download the reranker model ({name}): {exc}",
                        remedy="Check the network connection, or disable reranking.",
                    ) from exc

    def _load(self) -> None:
        if self._session is not None:
            return
        import onnxruntime
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(str(self.model_dir / "tokenizer.json"))
        tokenizer.enable_truncation(max_length=_MAX_TOKENS)
        pad_id = tokenizer.token_to_id("[PAD]") or 0
        tokenizer.enable_padding(pad_id=pad_id, pad_token="[PAD]")
        self._tokenizer = tokenizer

        options = onnxruntime.SessionOptions()
        options.log_severity_level = 3
        self._session = onnxruntime.InferenceSession(
            str(self.model_dir / "model.onnx"),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )

    # ── Scoring ──

    def _score(self, query: str, texts: Sequence[str]) -> np.ndarray:
        """Raw relevance logits, one per (query, text) pair. Runs synchronously on CPU."""
        self._load()
        encodings = self._tokenizer.encode_batch([(query, text) for text in texts])
        feed = {
            "input_ids": np.array([e.ids for e in encodings], dtype=np.int64),
            "attention_mask": np.array([e.attention_mask for e in encodings], dtype=np.int64),
            "token_type_ids": np.array([e.type_ids for e in encodings], dtype=np.int64),
        }
        (logits,) = self._session.run(None, feed)
        return logits.reshape(-1)

    async def rerank(
        self, query: str, candidates: Sequence[Candidate], texts: Sequence[str], *, top_k: int
    ) -> list[Candidate]:
        if len(candidates) != len(texts):
            raise ValueError(f"{len(candidates)} candidates but {len(texts)} texts")
        if not candidates:
            return []
        if not self.is_downloaded():
            await self.download()

        logits = await asyncio.to_thread(self._score, query, texts)
        order = np.argsort(-logits, kind="stable")[:top_k]

        return [
            Candidate(
                chunk_id=candidates[int(i)].chunk_id,
                # Sigmoid maps the unbounded logit to a stable 0-1 relevance for display;
                # ordering is identical either way.
                score=round(float(1.0 / (1.0 + np.exp(-logits[int(i)]))), 6),
                rank=position + 1,
                source="rerank",
                detail={
                    "logit": round(float(logits[int(i)]), 4),
                    "previous_rank": candidates[int(i)].rank,
                },
            )
            for position, i in enumerate(order)
        ]
