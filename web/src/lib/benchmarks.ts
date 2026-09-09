/**
 * The measurements the Learn pages quote, as chartable data.
 *
 * Every number here also appears in a topic's prose and comes from the bundled
 * benchmarks (`clear-rag ablate`, `clear-rag eval --suite attribution`) — this
 * module only restates them so each page can show the comparison as bars instead
 * of asking the reader to hold four decimals in their head. If a measurement is
 * re-run, update the prose in topics.ts and the row here together.
 *
 * Colours reuse the identities the interface already teaches: keyword aqua,
 * vector blue, fused rankings as ink, reranking violet — never a new hue for a
 * concept that already has one.
 */

const KEYWORD = "var(--color-keyword)";
const VECTOR = "var(--color-vector)";
const INK = "rgb(var(--foreground) / 0.8)";
const RERANK = "var(--color-cat-7)";
// Query expansion happens in the transform stage, so it borrows that stage's hue.
const EXPAND = "var(--color-cat-5)";

export interface BenchmarkRow {
  label: string;
  value: number;
  color: string;
  hint?: string;
}

export interface BenchmarkChart {
  title: string;
  /** One line under the chart: what the comparison shows. */
  note: string;
  /** Bars scale against this instead of the max row, so ratios read absolutely. */
  domain?: number;
  rows: BenchmarkRow[];
}

export const TOPIC_CHARTS: Record<string, BenchmarkChart[]> = {
  "keyword-search": [
    {
      title: "recall@1 — each retriever alone",
      note: "On a corpus full of identifiers like `hb bootstrap` and `422`, exact-term matching beats semantic matching on its own.",
      domain: 1,
      rows: [
        { label: "Keyword (BM25)", value: 0.766, color: KEYWORD },
        { label: "Vector", value: 0.573, color: VECTOR }
      ]
    }
  ],
  embeddings: [
    {
      title: "recall@1 — each retriever alone",
      note: "Vector search loses to keyword search on this identifier-heavy corpus — and wins on paraphrased questions, which is why the pipeline runs both.",
      domain: 1,
      rows: [
        { label: "Vector", value: 0.573, color: VECTOR },
        { label: "Keyword (BM25)", value: 0.766, color: KEYWORD }
      ]
    }
  ],
  "hybrid-fusion": [
    {
      title: "recall@5 — the merge is the whole story",
      note: "Every distractor question either method alone got wrong is resolved by fusing their rankings.",
      domain: 1,
      rows: [
        { label: "Vector alone", value: 0.871, color: VECTOR },
        { label: "Keyword alone", value: 0.903, color: KEYWORD },
        { label: "Hybrid (RRF)", value: 0.968, color: INK }
      ]
    }
  ],
  reranking: [
    {
      title: "recall@1 — before and after the cross-encoder",
      note: "Fusion already put the right chunk somewhere in the top five; the reranker puts it first.",
      domain: 1,
      rows: [
        { label: "Fused ranking", value: 0.734, color: INK },
        { label: "+ Rerank", value: 0.927, color: RERANK }
      ]
    },
    {
      title: "MRR — how high the first relevant chunk sits",
      note: "The largest measured effect of any single technique in this pipeline.",
      domain: 1,
      rows: [
        { label: "Fused ranking", value: 0.841, color: INK },
        { label: "+ Rerank", value: 0.965, color: RERANK }
      ]
    }
  ],
  "phase5-query-understanding": [
    {
      title: "recall@5 on paraphrase questions — what expansion is for",
      note: "Nine questions worded to share almost no vocabulary with their answers. Expansion recovers both that fusion missed outright — and so does the reranker, without it.",
      domain: 1,
      rows: [
        { label: "Hybrid (RRF)", value: 0.778, color: INK },
        { label: "+ Multi-query", value: 1.0, color: EXPAND },
        { label: "+ Rerank, no expansion", value: 1.0, color: RERANK }
      ]
    },
    {
      title: "recall@1 — the bill",
      note: "Extra phrasings pull in near-misses that rank fusion promotes over the exact hit; the reranker pays no such price.",
      domain: 1,
      rows: [
        { label: "Hybrid (RRF)", value: 0.734, color: INK },
        { label: "+ Multi-query", value: 0.653, color: EXPAND },
        { label: "+ Rerank, no expansion", value: 0.927, color: RERANK }
      ]
    }
  ],
  "retrieval-metrics": [
    {
      title: "recall@1 — where the differences live",
      note: "The interesting movement happens at the top of the ranking.",
      domain: 1,
      rows: [
        { label: "Fused ranking", value: 0.734, color: INK },
        { label: "+ Rerank", value: 0.927, color: RERANK }
      ]
    },
    {
      title: "recall@5 — saturated, so it stops discriminating",
      note: "Every configuration hits 1.000 at k=5 on this corpus. A column that cannot distinguish its rows looks like evidence and isn't.",
      domain: 1,
      rows: [
        { label: "Fused ranking", value: 1.0, color: INK },
        { label: "+ Rerank", value: 1.0, color: RERANK }
      ]
    }
  ],
  "answer-metrics": [
    {
      title: "Attribution suite — right words vs right receipts",
      note: "The 3B model mentions the right content while citing the wrong support — invisible to recall@k, decisive in practice. The 9B model scores 100/100.",
      domain: 1,
      rows: [
        { label: "3B · mentions", value: 0.92, color: INK },
        { label: "3B · grounded", value: 0.42, color: "var(--color-critical)" },
        { label: "9B · mentions", value: 1.0, color: INK },
        { label: "9B · grounded", value: 1.0, color: INK }
      ]
    }
  ],
  "parser-backends": [
    {
      title: "recall@5 on the SEC corpus — by parser backend",
      note: "Born-digital single-column renders are flat extraction's best case, and docling's ML table reconstruction loses labels outright. Structure earns its keep downstream, not here.",
      domain: 1,
      rows: [
        { label: "Naive (pypdf)", value: 0.872, color: INK },
        { label: "Primitives", value: 0.846, color: INK },
        {
          label: "docling",
          value: 0.718,
          color: "var(--color-critical)",
          hint: "2 labelled quotes lost to its parse; most misses are financial-table questions."
        }
      ]
    },
    {
      title: "Order similarity vs HTML ground truth (mean of 8 files)",
      note: "The differential parse test. Fixing the two bugs it caught took the primitives parser from 0.78 to 0.99 on the worst files.",
      domain: 1,
      rows: [
        { label: "Naive (pypdf)", value: 1.0, color: INK },
        { label: "Primitives", value: 0.996, color: INK },
        { label: "docling", value: 0.989, color: INK }
      ]
    }
  ],
  "semantic-chunking": [
    {
      title: "Table-question recall@5 — fixed-size vs structural",
      note: "Heading-bounded packing folds financial tables into large mixed chunks that rank worse. A negative result the knob shipped with, pointing at its own fix: atomic table chunks.",
      domain: 1,
      rows: [
        { label: "Fixed-size (512)", value: 0.545, color: INK },
        { label: "Structural", value: 0.273, color: "var(--color-critical)" }
      ]
    }
  ],
  "contextual-retrieval": [
    {
      title: "recall@5 on the SEC corpus — by context mode",
      note: "Three identical bars, honestly drawn: two companies with distinct vocabulary give context nothing to disambiguate. The technique's motivating case is many near-identical documents.",
      domain: 1,
      rows: [
        { label: "No context", value: 0.846, color: INK },
        { label: "Breadcrumb", value: 0.846, color: INK },
        { label: "LLM-written", value: 0.846, color: INK }
      ]
    }
  ],
  ablation: [
    {
      title: "recall@1 by configuration",
      note: "One knob at a time: each bar differs from its neighbour by a single setting, so the gaps are each technique's measured worth.",
      domain: 1,
      rows: [
        { label: "Vector only", value: 0.573, color: VECTOR },
        { label: "Keyword only", value: 0.766, color: KEYWORD },
        { label: "Hybrid (RRF)", value: 0.734, color: INK },
        { label: "Hybrid + rerank", value: 0.927, color: RERANK }
      ]
    }
  ]
};
