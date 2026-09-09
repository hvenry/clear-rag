#!/usr/bin/env python
"""Snapshot every query event stream so a refactor can be checked for identical output.

    python scripts/snapshot_query_events.py before.json          # before the change
    python scripts/snapshot_query_events.py after.json --compare before.json

The regression gate (``evals/baseline.json``) compares *metrics*, which is the right
gate for a retrieval change and the wrong one for a refactor: two implementations can
score identically while emitting different stage records, diagnostics or event order,
and the interface renders all of those. This script records the events themselves --
on fake providers, and with the real ONNX reranker when its model is present -- across
several configurations, follow-up rewriting, document scoping and generation on and
off, with the volatile fields (ids, timestamps, durations) stripped. A refactor that
changes nothing observable produces a byte-identical file.

``--compare`` reports the first streams that differ, or nothing and exit code 0.
``--ignore KEY`` strips extra fields when a change is expected -- adding a config
field changes every ``config_hash``, for instance -- so the rest can still be checked.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from clearrag.config import PipelineConfig, Settings  # noqa: E402
from clearrag.core.types import Message  # noqa: E402
from clearrag.eval.golden import load_corpus  # noqa: E402
from clearrag.pipeline import Engine  # noqa: E402
from clearrag.providers.fake import FakeChat, FakeEmbeddings  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "workspace" / "models"

VOLATILE = {
    "id",
    "created_at",
    "duration_ms",
    "total_ms",
    "ttft_ms",
    "decode_ms",
    "tokens_per_second",
    "prefill_tokens_per_second",
    "extract_ms",
    "trace_id",
}

QUESTIONS: list[tuple[str, list[Message]]] = [
    ("How do I roll back a bad release?", []),
    ("How long are metrics kept?", []),
    ("What percentage of traffic does a canary receive?", []),
    (
        "Does it also undo migrations?",
        [
            Message(role="user", content="How do I roll back a bad release?"),
            Message(role="assistant", content="Use hb deploy --rollback [1]."),
        ],
    ),
]

CONFIGS = {
    "hybrid-rrf": PipelineConfig(k_candidates=50, k_final=5),
    "hybrid-weighted": PipelineConfig(k_candidates=50, k_final=5, fusion="weighted"),
    "dense-only": PipelineConfig(k_candidates=20, k_final=3, retrieval="dense"),
    "lexical-only": PipelineConfig(k_candidates=20, k_final=3, retrieval="lexical"),
    "rerank-requested": PipelineConfig(k_candidates=50, k_final=5, rerank=True),
    "no-rewrite": PipelineConfig(k_candidates=50, k_final=5, rewrite_followups=False),
    "tiny-budget": PipelineConfig(k_candidates=50, k_final=10, max_context_tokens=256),
    "multi-query": PipelineConfig(k_candidates=50, k_final=5, query_transform="multi"),
}


def scrub(obj, volatile: set[str]):
    if isinstance(obj, dict):
        return {k: scrub(v, volatile) for k, v in obj.items() if k not in volatile}
    if isinstance(obj, list):
        return [scrub(v, volatile) for v in obj]
    return obj


async def run(reranker, volatile: set[str]) -> dict:
    out: dict = {}
    with tempfile.TemporaryDirectory() as tmp:
        workspace = Path(tmp) / "ws"
        if reranker is not None and MODELS.is_dir():
            shutil.copytree(MODELS, workspace / "models")
        engine = Engine(
            Settings(workspace=workspace),
            PipelineConfig(),
            FakeChat(),
            FakeEmbeddings(),
            reranker=reranker,
        )
        for filename, (_, data) in load_corpus(ROOT / "evals" / "corpus").items():
            await engine.ingest(filename, data)

        doc_ids = [d["id"] for d in engine.store.list_documents()][:3]
        for label, config in CONFIGS.items():
            engine.config = config
            for qi, (question, history) in enumerate(QUESTIONS):
                for generate in (True, False):
                    for scoped in (False, True):
                        events = []
                        async for event in engine.query(
                            question,
                            history,
                            generate=generate,
                            doc_ids=doc_ids if scoped else None,
                            session_id="s_fixed" if generate else None,
                        ):
                            events.append(scrub(event, volatile))
                        out[f"{label}/q{qi}/gen={generate}/scoped={scoped}"] = events
        out["_persisted"] = scrub(engine.store.list_traces(limit=5), volatile)
        engine.store.close()
    return out


async def snapshot(volatile: set[str]) -> dict:
    result = {"fake": await run(None, volatile)}
    from clearrag.providers import rerank_onnx

    if rerank_onnx.available() and MODELS.is_dir():
        result["onnx"] = await run(
            rerank_onnx.OnnxReranker(MODELS / "ms-marco-minilm-l6"), volatile
        )
    return result


def compare(current: dict, previous: dict) -> int:
    differences = 0
    for provider in sorted(set(current) | set(previous)):
        a, b = current.get(provider, {}), previous.get(provider, {})
        for key in sorted(set(a) | set(b)):
            if a.get(key) != b.get(key):
                differences += 1
                if differences <= 10:
                    print(f"differs: {provider}/{key}")
    if differences:
        print(f"{differences} stream(s) differ")
        return 1
    print("identical")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("out", type=Path, help="Where to write the snapshot (JSON).")
    parser.add_argument("--compare", type=Path, default=None, help="A previous snapshot.")
    parser.add_argument(
        "--ignore", action="append", default=[], help="Extra fields to strip before comparing."
    )
    args = parser.parse_args()

    volatile = VOLATILE | set(args.ignore)
    # Round-trip through JSON so tuples become lists and the comparison below is
    # between two documents of the same shape, not memory against disk.
    current = json.loads(json.dumps(asyncio.run(snapshot(volatile))))
    args.out.write_text(json.dumps(current, indent=1, sort_keys=True))
    streams = sum(len(v) for v in current.values())
    print(f"wrote {args.out} ({streams} event streams)")

    if args.compare is None:
        return 0
    previous = scrub(json.loads(args.compare.read_text()), volatile)
    return compare(current, previous)


if __name__ == "__main__":
    raise SystemExit(main())
