"""Committed benchmark results: one file per suite, rendered everywhere else.

The ablation table is the artifact this project exists to produce, and it used to live
in four hand-copied places -- the README, the Learn page's prose, its charts and the
Lab's knob hints -- which drifted the first time the golden set grew. These files are
the tool's own output, committed under ``evals/results/``, and everything else derives
from them: the README tables are rendered by ``scripts/render_results.py`` (and checked
in CI), the interface imports the JSON directly.

Rows are keyed by configuration label, plus the chat model when the row's answers were
generated -- an answer depends on the model, retrieval does not. Writing *merges*: rows a
sweep produced replace their predecessors, rows it did not produce survive. So a sweep in
an environment without an optional parser backend leaves that backend's row in place,
and a row measured elsewhere can be imported by hand with ``provenance.source =
"imported"`` and stays until something re-measures it. Every row says what measured it
and when.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

from .runner import EvalRun

RESULTS_DIR = Path("evals") / "results"
SUITES = ("retrieval", "sec", "attribution", "parse-quality")

#: Which per-tag recall columns each suite's table shows, in order.
TAG_COLUMNS: dict[str, tuple[str, ...]] = {
    "retrieval": ("lexical", "semantic", "distractor", "paraphrase"),
    "sec": ("table", "structure", "cross-company"),
}

#: Which documents show each suite's table, relative to the repository root.
RENDERED_IN: dict[str, tuple[str, ...]] = {
    "retrieval": ("README.md",),
    "attribution": ("README.md",),
    "sec": ("README.md", "evals/sec/README.md"),
    "parse-quality": ("evals/sec/README.md",),
}

#: Hand-written prose that quotes benchmark numbers, checked for drift.
PROSE_DOCUMENTS: tuple[str, ...] = (
    "README.md",
    "evals/sec/README.md",
    "web/src/lib/topics.ts",
    "web/src/lib/knobs.ts",
)

MARKER = "<!-- results:{suite} -->"
END_MARKER = "<!-- /results:{suite} -->"
PROSE_OFF = "<!-- prose-check:off -->"
PROSE_ON = "<!-- prose-check:on -->"


def results_path(suite: str, root: Path | None = None) -> Path:
    return (root or Path(".")) / RESULTS_DIR / f"{suite}.json"


def load_results(path: Path) -> dict[str, Any] | None:
    return json.loads(path.read_text()) if path.exists() else None


def save_results(path: Path, results: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(results, indent=1) + "\n")


def row_identity(row: dict[str, Any]) -> tuple[str, str | None]:
    """What makes two rows the same measurement: the label, and the chat model when
    the row's answers were generated."""
    provenance = row.get("provenance") or {}
    return (row["label"], provenance.get("chat_model") if row.get("generated") else None)


def merge_results(
    existing: dict[str, Any] | None,
    runs: Sequence[EvalRun],
    *,
    suite: str,
    k: int,
    order: Sequence[str],
) -> dict[str, Any]:
    """Fold a sweep's runs into a results file, replacing rows with the same identity.

    Rows keep the order of the variant list they came from; rows the list does not
    know (imported ones, or a backend not installed here) follow, in the order they
    already had.
    """
    fresh = [run.to_dict() for run in runs]
    fresh_ids = {row_identity(row) for row in fresh}
    kept = [row for row in (existing or {}).get("rows", []) if row_identity(row) not in fresh_ids]

    position = {label: i for i, label in enumerate(order)}
    merged = fresh + kept
    merged.sort(key=lambda row: position.get(row["label"], len(order)))

    corpus = dict((existing or {}).get("corpus", {}))
    if runs:
        primary = runs[0].at_k.get(k) or runs[0].primary
        corpus.update(
            {
                "documents": runs[0].documents,
                "questions": primary.n_questions,
                "answerable": primary.n_answerable,
            }
        )
    return {"suite": suite, "k": k, "corpus": corpus, "rows": merged}


BACKEND_ORDER = ("naive", "primitives", "docling", "marker")


def merge_parse_quality(
    existing: dict[str, Any] | None, rows: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    """Parse-quality rows are keyed by (file, backend); means are recomputed over all."""
    fresh_ids = {(r["file"], r["backend"]) for r in rows}
    kept = [
        r for r in (existing or {}).get("rows", []) if (r["file"], r["backend"]) not in fresh_ids
    ]
    merged = sorted(
        list(rows) + kept,
        key=lambda r: (
            r["file"],
            BACKEND_ORDER.index(r["backend"]) if r["backend"] in BACKEND_ORDER else 99,
        ),
    )
    means: dict[str, dict[str, float]] = {}
    for backend in BACKEND_ORDER:
        mine = [r for r in merged if r["backend"] == backend]
        if mine:
            means[backend] = {
                "word_recovery": sum(r["word_recovery"] for r in mine) / len(mine),
                "order_similarity": sum(r["order_similarity"] for r in mine) / len(mine),
            }
    return {"suite": "parse-quality", "rows": merged, "means": means}


# ── Rendering ───────────────────────────────────────────────────────────────────


def _fmt(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.3f}"


def _model_short(provenance: dict[str, Any]) -> str:
    model = provenance.get("chat_model") or "?"
    return model.split(":", 1)[1] if ":" in model else model


def _display_label(row: dict[str, Any], suite: str) -> str:
    label = row["label"]
    if suite == "attribution":
        label = f"{_model_short(row.get('provenance') or {})} · {row['config']['chunk_size']}"
    if (row.get("provenance") or {}).get("source") == "imported":
        label += " †"
    return label


def render_table(results: dict[str, Any]) -> str:
    """The suite's Markdown table, ready to sit between its markers in a README."""
    suite = results["suite"]
    rows = results["rows"]
    if suite == "parse-quality":
        return _render_parse_quality(results)

    k = str(results["k"])
    lines: list[str]
    if suite == "attribution":
        header = (
            f"| Model · chunk size | retrieval recall@{k} | required mentions | grounding "
            "| citation precision |"
        )
        lines = [header, "|---|---|---|---|---|"]
        for row in rows:
            agg = row["at_k"][k]
            lines.append(
                f"| {_display_label(row, suite)} | {_fmt(agg['recall'])} | "
                f"{_fmt(agg['mention_accuracy'])} | {_fmt(agg['grounding_rate'])} | "
                f"{_fmt(agg['citation_precision'])} |"
            )
    else:
        tags = TAG_COLUMNS.get(suite, ())
        header = f"| Configuration | recall@1 | recall@{k} | MRR | nDCG@{k} |"
        header += "".join(f" {tag} |" for tag in tags)
        lines = [header, "|" + "---|" * (5 + len(tags))]
        best = max(((r["at_k"][k]["recall"], r["at_k"][k]["ndcg"]) for r in rows), default=None)
        for row in rows:
            agg = row["at_k"][k]
            at_one = row["at_k"].get("1")
            name = _display_label(row, suite)
            if best is not None and (agg["recall"], agg["ndcg"]) == best:
                name = f"**{name}**"
            cells = [
                _fmt(at_one["recall"] if at_one else None),
                _fmt(agg["recall"]),
                _fmt(agg["mrr"]),
                _fmt(agg["ndcg"]),
            ] + [_fmt(agg["by_tag"].get(tag)) for tag in tags]
            lines.append(f"| {name} | " + " | ".join(cells) + " |")

    imported = [r for r in rows if (r.get("provenance") or {}).get("source") == "imported"]
    if imported:
        notes = sorted(
            {
                f"{r['provenance'].get('measured_at', '?')}"
                + (f", {r['provenance']['note']}" if r["provenance"].get("note") else "")
                for r in imported
            }
        )
        lines.append("")
        lines.append(
            "† imported from an earlier measurement rather than re-run here: " + "; ".join(notes)
        )
    return "\n".join(lines)


def _render_parse_quality(results: dict[str, Any]) -> str:
    lines = ["| file | backend | word recovery | order similarity |", "|---|---|---|---|"]
    for row in results["rows"]:
        mark = " †" if (row.get("provenance") or {}).get("source") == "imported" else ""
        lines.append(
            f"| {row['file']} | {row['backend']}{mark} | {_fmt(row['word_recovery'])} | "
            f"{_fmt(row['order_similarity'])} |"
        )
    means = results.get("means") or {}
    if means:
        lines.append("")
        lines.append(
            "Per-backend means: "
            + "; ".join(
                f"{backend} recovery {_fmt(m['word_recovery'])}, "
                f"order {_fmt(m['order_similarity'])}"
                for backend, m in means.items()
            )
        )
    if any((r.get("provenance") or {}).get("source") == "imported" for r in results["rows"]):
        lines.append("")
        lines.append("† imported from an earlier measurement rather than re-run here.")
    return "\n".join(lines)


def apply_to_document(text: str, suite: str, table: str) -> str:
    """Replace whatever sits between the suite's markers with ``table``."""
    start, end = MARKER.format(suite=suite), END_MARKER.format(suite=suite)
    if start not in text or end not in text:
        raise ValueError(f"document has no {start} … {end} region")
    head, rest = text.split(start, 1)
    _, tail = rest.split(end, 1)
    return f"{head}{start}\n{table}\n{end}{tail}"


# ── Drift check ─────────────────────────────────────────────────────────────────

_NUMBER = re.compile(r"(?<![\d.])[01]\.\d{3}(?![\d])")


def known_values(results_files: Iterable[dict[str, Any]]) -> set[str]:
    """Every three-decimal value the results files can vouch for."""
    values: set[str] = set()

    def visit(obj: Any) -> None:
        if isinstance(obj, dict):
            for v in obj.values():
                visit(v)
        elif isinstance(obj, list):
            for v in obj:
                visit(v)
        elif isinstance(obj, float):
            values.add(f"{obj:.3f}")

    for results in results_files:
        visit(results)
    return values


def prose_numbers(text: str) -> list[tuple[int, str]]:
    """Three-decimal numbers in hand-written prose: outside generated regions and
    outside explicit ``prose-check:off`` … ``on`` spans."""
    found: list[tuple[int, str]] = []
    skipping = False
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("<!-- results:") or stripped == PROSE_OFF:
            skipping = True
            continue
        if stripped.startswith("<!-- /results:") or stripped == PROSE_ON:
            skipping = False
            continue
        if skipping:
            continue
        found.extend((lineno, m.group(0)) for m in _NUMBER.finditer(line))
    return found


def find_drift(text: str, values: set[str]) -> list[tuple[int, str]]:
    """Numbers in prose that no results file can vouch for -- stale, or never measured."""
    return [(lineno, number) for lineno, number in prose_numbers(text) if number not in values]
