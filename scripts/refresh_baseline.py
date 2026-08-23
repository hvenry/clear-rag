#!/usr/bin/env python
"""Regenerate evals/baseline.json.

Run this only after a *deliberate* retrieval change, and read the diff before
committing it. Refreshing the baseline to make a failing gate pass defeats the gate.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from clearrag.config import PipelineConfig  # noqa: E402
from clearrag.eval.runner import ablate  # noqa: E402
from clearrag.providers.fake import FakeChat, FakeEmbeddings  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BASELINE_CONFIG = PipelineConfig(k_candidates=50, k_final=10, rewrite_followups=False)

COMMENT = (
    "Deterministic fake-provider scores for the default pipeline configuration. These are "
    "a REGRESSION SIGNAL, not a quality measurement: the fake embedder is a bag-of-words "
    "hash projection, so the absolute values mean nothing. What they catch is a change that "
    "silently breaks chunking, BM25, fusion or assembly. Regenerate with "
    "scripts/refresh_baseline.py after a deliberate retrieval change, and read the diff."
)


async def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        runs = await ablate(
            [("default", BASELINE_CONFIG)],
            corpus_dir=ROOT / "evals" / "corpus",
            golden_path=ROOT / "evals" / "golden.jsonl",
            workspace_root=Path(tmp),
            chat_factory=FakeChat,
            embeddings_factory=FakeEmbeddings,
        )

    run = runs[0]
    payload = {
        "_comment": COMMENT,
        "config_hash": run.config.config_hash,
        "n_questions": run.at_k[5].n_questions,
        "at_k": {str(k): agg.to_dict() for k, agg in sorted(run.at_k.items())},
    }
    path = ROOT / "evals" / "baseline.json"
    path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {path}")
    for k, agg in sorted(run.at_k.items()):
        print(f"  @{k:<3} recall {agg.recall:.4f}  mrr {agg.mrr:.4f}  ndcg {agg.ndcg:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
