"""The sec suite's files exist and its golden set is well-formed."""

import json
from pathlib import Path


def test_sec_suite_files_exist_and_golden_is_well_formed():
    base = Path("evals/sec")
    pdfs = sorted((base / "corpus").glob("*.pdf"))
    assert len(pdfs) >= 6
    rows = [
        json.loads(line)
        for line in (base / "golden.jsonl").read_text().splitlines()
        if line.strip() and not line.startswith("//")
    ]
    assert len(rows) >= 35
    tags = {t for row in rows for t in row.get("tags", [])}
    assert {"table", "structure", "cross-company"} <= tags
    assert sum(1 for row in rows if row.get("unanswerable")) >= 3
    for pdf in pdfs:
        assert (base / "ground_truth" / f"{pdf.stem}.txt").exists()
