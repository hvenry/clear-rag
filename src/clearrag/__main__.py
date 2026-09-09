"""CLI entry point: `clear-rag serve`."""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser
from collections.abc import Sequence
from pathlib import Path

from pydantic import ValidationError

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

    pq = sub.add_parser(
        "parse-quality",
        help="Score parser backends against HTML-derived ground truth (word recovery "
        "and reading order), the differential test for the parse stage.",
    )
    pq.add_argument("--corpus", type=Path, default=EVAL_DIR / "sec" / "corpus")
    pq.add_argument("--ground-truth", type=Path, default=EVAL_DIR / "sec" / "ground_truth")
    pq.add_argument(
        "--parser", default=None, help="Score only this backend (default: every installed one)."
    )

    args = parser.parse_args()
    settings = get_settings()

    if args.command == "check":
        return _check(settings)
    if args.command == "eval":
        return _eval(settings, args)
    if args.command == "ablate":
        return _ablate(settings, args)
    if args.command == "parse-quality":
        return _parse_quality(args)

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
    from .providers.registry import build_chat, build_embeddings, build_reranker

    try:
        engine = Engine(
            settings,
            PipelineConfig(),
            build_chat(settings),
            build_embeddings(settings),
            build_reranker(settings),
        )
        report = asyncio.run(engine.healthcheck())
    except ProviderError as exc:
        print(f"FAIL  {exc}")
        if exc.remedy:
            print(f"      -> {exc.remedy}")
        return 1

    for check in report["checks"]:
        # Optional components warn instead of failing: a missing reranker degrades
        # quality, it does not stop queries.
        mark = "ok  " if check.get("ok") else "warn" if check.get("optional") else "FAIL"
        who = f"{check.get('provider', '')} {check.get('model') or ''}".strip()
        print(f"{mark}  {check['component']}: {who}".rstrip())
        if not check.get("ok"):
            print(f"      {check.get('error', '')}")
            if check.get("remedy"):
                print(f"      -> {check['remedy']}")
    print(f"\n{report['documents']} documents, {report['chunks']} chunks indexed.")
    return 0 if report["ok"] else 1


def _add_eval_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--suite",
        choices=["retrieval", "attribution", "sec"],
        default="retrieval",
        help=(
            "Which bundled benchmark to run. 'retrieval' measures search quality over a "
            "multi-document corpus; 'attribution' is a single structured document where "
            "retrieval is trivially perfect and the entire burden falls on generation -- "
            "run it with --generate. 'sec' is the 10-K corpus (real PDFs): parsing, "
            "chunking and contextual retrieval all become measurable variables."
        ),
    )
    parser.add_argument("--corpus", type=Path, default=None)
    parser.add_argument("--golden", type=Path, default=None)
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
    parser.add_argument(
        "--chunk-size", type=int, default=None, help="Override chunk size (tokens)."
    )
    parser.add_argument("--chunk-overlap", type=int, default=None, help="Override chunk overlap.")
    parser.add_argument(
        "--set",
        action="append",
        default=[],
        dest="overrides",
        metavar="KEY=VALUE",
        help=(
            "Override any pipeline setting for `eval`, e.g. --set query_transform=multi "
            "--set rerank=true. Repeatable; values are validated exactly as the config is."
        ),
    )


def parse_overrides(pairs: Sequence[str]) -> dict[str, str]:
    """``KEY=VALUE`` strings into a dict the config model can validate and coerce."""
    overrides: dict[str, str] = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep or not key.strip() or not value.strip():
            raise SystemExit(f"--set expects KEY=VALUE, got {pair!r}")
        overrides[key.strip()] = value.strip()
    return overrides


def _resolve_suite(args) -> tuple[Path, Path]:
    """Explicit --corpus/--golden win; otherwise the named suite picks both."""
    base = EVAL_DIR if args.suite == "retrieval" else EVAL_DIR / args.suite
    return (args.corpus or base / "corpus", args.golden or base / "golden.jsonl")


def _providers(settings, fake: bool):
    if fake:
        from .providers.fake import FakeChat, FakeEmbeddings

        return (lambda: FakeChat(), lambda: FakeEmbeddings(), lambda: None)

    from .providers.registry import build_chat, build_embeddings, build_reranker

    return (
        lambda: build_chat(settings),
        lambda: build_embeddings(settings),
        lambda: build_reranker(settings),
    )


def _eval(settings, args) -> int:
    import asyncio
    import tempfile

    from .config import PipelineConfig
    from .eval.runner import ablate, write_report

    chat_factory, embeddings_factory, reranker_factory = _providers(settings, args.fake)
    workspace = args.workspace or Path(tempfile.mkdtemp(prefix="clearrag-eval-"))
    overrides: dict = {"k_final": max(args.k, 10)}
    if args.chunk_size is not None:
        overrides["chunk_size"] = args.chunk_size
    if args.chunk_overlap is not None:
        overrides["chunk_overlap"] = args.chunk_overlap
    overrides.update(parse_overrides(args.overrides))
    try:
        config = PipelineConfig(**overrides)
    except ValidationError as exc:
        raise SystemExit(f"Invalid --set override:\n{exc}") from exc

    corpus_dir, golden_path = _resolve_suite(args)
    runs = asyncio.run(
        ablate(
            [("current config", config)],
            corpus_dir=corpus_dir,
            golden_path=golden_path,
            workspace_root=workspace,
            chat_factory=chat_factory,
            embeddings_factory=embeddings_factory,
            reranker_factory=reranker_factory,
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
    from .eval.variants import sec_variants, standard_variants

    chat_factory, embeddings_factory, reranker_factory = _providers(settings, args.fake)
    workspace = args.workspace or Path(tempfile.mkdtemp(prefix="clearrag-ablate-"))
    table_tags: tuple[str, ...] = ("lexical", "semantic", "distractor", "paraphrase")
    if args.suite == "sec":
        variants, skipped = sec_variants()
        table_tags = ("table", "structure", "cross-company")
        for name in skipped:
            print(f"note: {name} backend not installed — pip install -e '.[{name}]'")
    else:
        variants = standard_variants()

    print(
        f"Sweeping {len(variants)} configurations ({'fake' if args.fake else 'real'} providers)…\n"
    )
    corpus_dir, golden_path = _resolve_suite(args)
    runs = asyncio.run(
        ablate(
            variants,
            corpus_dir=corpus_dir,
            golden_path=golden_path,
            workspace_root=workspace,
            chat_factory=chat_factory,
            embeddings_factory=embeddings_factory,
            reranker_factory=reranker_factory,
            on_progress=lambda label: print(f"  · {label}"),
        )
    )

    table = markdown_table(runs, k=args.k, tags=table_tags)
    print(f"\n{table}\n")
    lost = max((run.parse_lost for run in runs), default=0)
    if lost:
        print(f"note: up to {lost} labelled quote(s) unresolved in some runs (parse loss).\n")

    if args.markdown:
        args.markdown.write_text(table + "\n")
        print(f"Table written to {args.markdown}")
    if args.json:
        write_report(runs, args.json, k=args.k)
        print(f"Report written to {args.json}")
    return 0


def _parse_quality(args) -> int:
    from .eval.parse_quality import parse_quality
    from .ingest.parsers import available_backends, parse_pdf

    pdfs = sorted(args.corpus.glob("*.pdf")) if args.corpus.is_dir() else []
    if not pdfs:
        print(f"No PDFs found in {args.corpus}. Run scripts/fetch_sec.py first?")
        return 1

    backends = (
        [args.parser] if args.parser else [name for name, ok in available_backends().items() if ok]
    )
    print(f"{'file':<36} {'backend':<12} {'recovery':>9} {'order':>7}")
    worst = 1.0
    for pdf in pdfs:
        truth_path = args.ground_truth / f"{pdf.stem}.txt"
        if not truth_path.exists():
            print(f"{pdf.name:<36} (no ground truth at {truth_path.name}, skipped)")
            continue
        truth = truth_path.read_text()
        data = pdf.read_bytes()
        for backend in backends:
            try:
                result = parse_pdf(data, backend)
            except Exception as exc:  # a backend crashing on one file is itself a result
                print(f"{pdf.name:<36} {backend:<12} FAILED: {exc}")
                worst = 0.0
                continue
            scores = parse_quality(result.text, truth)
            worst = min(worst, scores["word_recovery"])
            print(
                f"{pdf.name:<36} {backend:<12} "
                f"{scores['word_recovery']:>9.3f} {scores['order_similarity']:>7.3f}"
            )
    return 0 if worst > 0 else 1


def _print_run(run, k: int) -> None:
    agg = run.at_k.get(k)
    if agg is None:
        print("No results.")
        return

    print(f"{agg.n_questions} questions ({agg.n_answerable} answerable)")
    if run.parse_lost:
        print(
            f"  {run.parse_lost} labelled quote(s) not found in this run's parsed text "
            "(parse loss, scored as misses)"
        )
    print()
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

    answer_side = [
        ("refusal accuracy", agg.refusal_accuracy, "unanswerables correctly declined"),
        ("false refusals", agg.false_refusal_rate, "answerables wrongly declined"),
        ("required mentions", agg.mention_accuracy, "answers containing what they must"),
        ("wrong-section bleed", agg.confusion_rate, "answers containing what they must not"),
        ("grounding", agg.grounding_rate, "answers citing a chunk that covers the labelled span"),
        (
            "citation precision",
            agg.citation_precision,
            "share of citations covering a labelled span",
        ),
    ]
    if any(value is not None for _, value, _ in answer_side):
        print("\n  answer quality:")
        for label, value, note in answer_side:
            if value is not None:
                print(f"    {label:<20} {value:.3f}   ({note})")

    misses = [r for r in run.results if not r.hit and not r.unanswerable]
    if misses:
        print(f"\n  {len(misses)} question(s) with nothing relevant in the top {k}:")
        for result in misses:
            print(f"    {result.id:<24} {result.question}")
            for missed in result.missed:
                print(f"      missed → {missed}")


if __name__ == "__main__":
    sys.exit(main())
