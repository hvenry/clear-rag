"""CLI entry point: `clear-rag serve`."""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from pathlib import Path

from .config import get_settings

EVAL_DIR = Path("evals")


def main() -> int:
    parser = argparse.ArgumentParser(prog="clear-rag", description=__doc__)
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="Start the server and open the UI.")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument("--reload", action="store_true", help="Auto-reload on code changes.")
    serve.add_argument("--no-browser", action="store_true")

    sub.add_parser("check", help="Verify providers and the index are usable.")

    ev = sub.add_parser("eval", help="Score the golden set against the current config.")
    _add_eval_args(ev)
    ev.add_argument("--generate", action="store_true", help="Also generate answers (slow).")

    ab = sub.add_parser("ablate", help="Sweep configurations and print an ablation table.")
    _add_eval_args(ab)
    ab.add_argument("--markdown", type=Path, default=None, help="Write the table to a file.")

    args = parser.parse_args()
    settings = get_settings()

    if args.command == "check":
        return _check(settings)
    if args.command == "eval":
        return _eval(settings, args)
    if args.command == "ablate":
        return _ablate(settings, args)

    host = args.host or settings.host
    port = args.port or settings.port

    if not args.no_browser and not args.reload:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://{host}:{port}")).start()

    import uvicorn

    uvicorn.run("clearrag.api.app:app", host=host, port=port, reload=args.reload, log_level="info")
    return 0


def _check(settings) -> int:
    import asyncio

    from .config import PipelineConfig
    from .pipeline import Engine
    from .providers.base import ProviderError
    from .providers.registry import build_chat, build_embeddings

    try:
        engine = Engine(
            settings, PipelineConfig(), build_chat(settings), build_embeddings(settings)
        )
        report = asyncio.run(engine.healthcheck())
    except ProviderError as exc:
        print(f"FAIL  {exc}")
        if exc.remedy:
            print(f"      -> {exc.remedy}")
        return 1

    for check in report["checks"]:
        mark = "ok  " if check.get("ok") else "FAIL"
        who = f"{check.get('provider', '')} {check.get('model') or ''}".strip()
        print(f"{mark}  {check['component']}: {who}".rstrip())
        if not check.get("ok"):
            print(f"      {check.get('error', '')}")
            if check.get("remedy"):
                print(f"      -> {check['remedy']}")
    print(f"\n{report['documents']} documents, {report['chunks']} chunks indexed.")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())


def _add_eval_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--corpus", type=Path, default=EVAL_DIR / "corpus")
    parser.add_argument("--golden", type=Path, default=EVAL_DIR / "golden.jsonl")
    parser.add_argument("--k", type=int, default=5, help="Primary cutoff for the summary.")
    parser.add_argument("--json", type=Path, default=None, help="Write the full report here.")
    parser.add_argument(
        "--fake",
        action="store_true",
        help=(
            "Use deterministic fake providers instead of real models. Scores are not "
            "absolute quality, but they are reproducible and need no models installed, "
            "which is what makes the CI regression gate possible."
        ),
    )
    parser.add_argument("--workspace", type=Path, default=None, help="Where to build indexes.")


def _providers(settings, fake: bool):
    if fake:
        from .providers.fake import FakeChat, FakeEmbeddings

        return (lambda: FakeChat(), lambda: FakeEmbeddings())

    from .providers.registry import build_chat, build_embeddings

    return (lambda: build_chat(settings), lambda: build_embeddings(settings))


def _eval(settings, args) -> int:
    import asyncio
    import tempfile

    from .config import PipelineConfig
    from .eval.runner import ablate, write_report

    chat_factory, embeddings_factory = _providers(settings, args.fake)
    workspace = args.workspace or Path(tempfile.mkdtemp(prefix="clearrag-eval-"))
    config = PipelineConfig(k_final=max(args.k, 10))

    runs = asyncio.run(
        ablate(
            [("current config", config)],
            corpus_dir=args.corpus,
            golden_path=args.golden,
            workspace_root=workspace,
            chat_factory=chat_factory,
            embeddings_factory=embeddings_factory,
            generate=args.generate,
        )
    )
    run = runs[0]
    _print_run(run, args.k)

    if args.json:
        write_report(runs, args.json, k=args.k)
        print(f"\nReport written to {args.json}")
    return 0


def _ablate(settings, args) -> int:
    import asyncio
    import tempfile

    from .eval.runner import ablate, markdown_table, write_report
    from .eval.variants import standard_variants

    chat_factory, embeddings_factory = _providers(settings, args.fake)
    workspace = args.workspace or Path(tempfile.mkdtemp(prefix="clearrag-ablate-"))
    variants = standard_variants()

    print(
        f"Sweeping {len(variants)} configurations ({'fake' if args.fake else 'real'} providers)…\n"
    )
    runs = asyncio.run(
        ablate(
            variants,
            corpus_dir=args.corpus,
            golden_path=args.golden,
            workspace_root=workspace,
            chat_factory=chat_factory,
            embeddings_factory=embeddings_factory,
            on_progress=lambda label: print(f"  · {label}"),
        )
    )

    table = markdown_table(runs, k=args.k)
    print(f"\n{table}\n")

    if args.markdown:
        args.markdown.write_text(table + "\n")
        print(f"Table written to {args.markdown}")
    if args.json:
        write_report(runs, args.json, k=args.k)
        print(f"Report written to {args.json}")
    return 0


def _print_run(run, k: int) -> None:
    agg = run.at_k.get(k)
    if agg is None:
        print("No results.")
        return

    print(f"{agg.n_questions} questions ({agg.n_answerable} answerable)\n")
    for cutoff in sorted(run.at_k):
        a = run.at_k[cutoff]
        print(
            f"  @{cutoff:<3} recall {a.recall:.3f}   mrr {a.mrr:.3f}   "
            f"ndcg {a.ndcg:.3f}   hit {a.hit_rate:.3f}"
        )

    if agg.by_tag:
        print("\n  recall by tag:")
        for tag, value in agg.by_tag.items():
            print(f"    {tag:<12} {value:.3f}")

    if agg.refusal_accuracy is not None:
        print(f"\n  refusal accuracy      {agg.refusal_accuracy:.3f}")
    if agg.mention_accuracy is not None:
        print(f"  required-mention rate {agg.mention_accuracy:.3f}")

    misses = [r for r in run.results if not r.hit and not r.unanswerable]
    if misses:
        print(f"\n  {len(misses)} question(s) with nothing relevant in the top {k}:")
        for result in misses:
            print(f"    {result.id:<24} {result.question}")
            for missed in result.missed:
                print(f"      missed → {missed}")
