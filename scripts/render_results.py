#!/usr/bin/env python
"""Render the committed results files into the READMEs, or check that they already match.

    python scripts/render_results.py          # rewrite every marked region
    python scripts/render_results.py --check  # exit 1 if anything would change

Each ``evals/results/<suite>.json`` is the output of ``clear-rag ablate --save-results``
(or ``clear-rag parse-quality --save-results``). Its table lands between
``<!-- results:<suite> -->`` and ``<!-- /results:<suite> -->`` markers in the documents
that show it. ``--check`` also scans the hand-written prose -- the READMEs, the Learn
page's topics and the Lab's knob hints -- for three-decimal numbers that no results file
can vouch for, which is how a stale ``0.972`` gets caught after a golden set grows.
Wrap a table that is measured elsewhere in ``<!-- prose-check:off -->`` … ``on``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from clearrag.eval.results import (  # noqa: E402
    PROSE_DOCUMENTS,
    RENDERED_IN,
    RESULTS_DIR,
    apply_to_document,
    find_drift,
    known_values,
    render_table,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="Report instead of writing.")
    args = parser.parse_args()

    files = sorted((ROOT / RESULTS_DIR).glob("*.json"))
    if not files:
        print(f"no results files under {RESULTS_DIR}; run clear-rag ablate --save-results")
        return 1
    results = [json.loads(path.read_text()) for path in files]

    changed: list[str] = []
    for result in results:
        table = render_table(result)
        for relative in RENDERED_IN.get(result["suite"], ()):
            document = ROOT / relative
            text = document.read_text()
            try:
                rendered = apply_to_document(text, result["suite"], table)
            except ValueError as exc:
                print(f"warning: {relative}: {exc}")
                continue
            if rendered != text:
                changed.append(f"{relative} ({result['suite']})")
                if not args.check:
                    document.write_text(rendered)

    values = known_values(results)
    stale = {
        relative: find_drift((ROOT / relative).read_text(), values)
        for relative in PROSE_DOCUMENTS
        if (ROOT / relative).exists()
    }
    stale = {doc: hits for doc, hits in stale.items() if hits}

    if changed:
        verb = "would change" if args.check else "rendered"
        print(f"{verb}: " + ", ".join(changed))
    else:
        print("tables up to date")
    for doc, hits in stale.items():
        print(f"prose drift in {doc}:")
        for lineno, number in hits:
            print(f"  line {lineno}: {number} is in no results file")

    return 1 if args.check and (changed or stale) else 0


if __name__ == "__main__":
    raise SystemExit(main())
