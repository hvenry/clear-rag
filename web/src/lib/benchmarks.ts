/**
 * The measurements the Learn pages chart.
 *
 * Every value here is read from the committed results files through `results.ts`
 * and nothing is typed by hand, so a re-run of `clear-rag ablate --save-results` that
 * changes a number changes these bars with it. The prose in `topics.ts` still quotes
 * numbers; CI checks those against the same files.
 *
 * Colours reuse the identities the interface already teaches: keyword aqua,
 * vector blue, fused rankings as ink, reranking violet, expansion in the transform
 * stage's hue, never a new hue for a concept that already has one.
 */

import { metric, modelShort, PARSE_QUALITY, RESULTS, tagRecall } from "./results";

const KEYWORD = "var(--color-keyword)";
const VECTOR = "var(--color-vector)";
const INK = "rgb(var(--foreground) / 0.8)";
const RERANK = "var(--color-cat-7)";
// Query expansion happens in the transform stage, so it borrows that stage's hue.
const EXPAND = "var(--color-cat-5)";
const CRITICAL = "var(--color-critical)";

/** A missing row draws as an empty bar rather than a made-up number. */
const v = (value: number | null | undefined) => value ?? 0;
const r1 = (label: string) => v(metric("retrieval", label, 1, "recall"));
const r5 = (label: string) => v(metric("retrieval", label, 5, "recall"));
const mrr = (label: string) => v(metric("retrieval", label, 5, "mrr"));
const para = (label: string) => v(tagRecall("retrieval", label, 5, "paraphrase"));
const sec5 = (label: string) => v(metric("sec", label, 5, "recall"));
const secTable = (label: string) => v(tagRecall("sec", label, 5, "table"));
const pqOrder = (backend: string) => v(PARSE_QUALITY.means[backend]?.order_similarity);

/** An attribution row by the model's short name and chunk size. */
function attribution(
  modelPrefix: string,
  chunkSize: number,
  name: "mention_accuracy" | "grounding_rate"
) {
  const row = RESULTS.attribution.rows.find(
    (r) =>
      modelShort(r.provenance.chat_model).startsWith(modelPrefix) &&
      r.config.chunk_size === chunkSize
  );
  return v(row?.at_k[String(RESULTS.attribution.k)]?.[name]);
}

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
      title: "recall@1: each retriever alone",
      note: "On a corpus full of identifiers like `hb bootstrap` and `422`, exact-term matching beats semantic matching on its own.",
      domain: 1,
      rows: [
        { label: "Keyword (BM25)", value: r1("keyword only (BM25)"), color: KEYWORD },
        { label: "Vector", value: r1("dense only"), color: VECTOR }
      ]
    }
  ],
  embeddings: [
    {
      title: "recall@1: each retriever alone",
      note: "Vector search loses to keyword search on this identifier-heavy corpus, and wins on paraphrased questions, which is why the pipeline runs both.",
      domain: 1,
      rows: [
        { label: "Vector", value: r1("dense only"), color: VECTOR },
        { label: "Keyword (BM25)", value: r1("keyword only (BM25)"), color: KEYWORD }
      ]
    }
  ],
  "hybrid-fusion": [
    {
      title: "recall@5: the merge is the whole story",
      note: "Every distractor question either method alone got wrong is resolved by fusing their rankings.",
      domain: 1,
      rows: [
        { label: "Vector alone", value: r5("dense only"), color: VECTOR },
        { label: "Keyword alone", value: r5("keyword only (BM25)"), color: KEYWORD },
        { label: "Hybrid (RRF)", value: r5("hybrid + RRF"), color: INK }
      ]
    }
  ],
  reranking: [
    {
      title: "recall@1: before and after the cross-encoder",
      note: "Fusion already put the right chunk somewhere in the top five; the reranker puts it first.",
      domain: 1,
      rows: [
        { label: "Fused ranking", value: r1("hybrid + RRF"), color: INK },
        { label: "+ Rerank", value: r1("hybrid + RRF + cross-encoder rerank"), color: RERANK }
      ]
    },
    {
      title: "MRR: how high the first relevant chunk sits",
      note: "The largest measured effect of any single technique in this pipeline.",
      domain: 1,
      rows: [
        { label: "Fused ranking", value: mrr("hybrid + RRF"), color: INK },
        { label: "+ Rerank", value: mrr("hybrid + RRF + cross-encoder rerank"), color: RERANK }
      ]
    }
  ],
  "phase5-query-understanding": [
    {
      title: "recall@5 on paraphrase questions: what expansion is for",
      note: "Nine questions worded to share almost no vocabulary with their answers. Expansion recovers both that fusion missed outright, and so does the reranker, without it.",
      domain: 1,
      rows: [
        { label: "Hybrid (RRF)", value: para("hybrid + RRF"), color: INK },
        { label: "+ Multi-query", value: para("hybrid + RRF + multi-query"), color: EXPAND },
        { label: "+ Rerank, no expansion", value: para("hybrid + RRF + cross-encoder rerank"), color: RERANK }
      ]
    },
    {
      title: "recall@1: the bill",
      note: "Extra phrasings pull in near-misses that rank fusion promotes over the exact hit; the reranker pays no such price.",
      domain: 1,
      rows: [
        { label: "Hybrid (RRF)", value: r1("hybrid + RRF"), color: INK },
        { label: "+ Multi-query", value: r1("hybrid + RRF + multi-query"), color: EXPAND },
        { label: "+ Rerank, no expansion", value: r1("hybrid + RRF + cross-encoder rerank"), color: RERANK }
      ]
    }
  ],
  "retrieval-metrics": [
    {
      title: "recall@1: where the differences live",
      note: "The interesting movement happens at the top of the ranking.",
      domain: 1,
      rows: [
        { label: "Fused ranking", value: r1("hybrid + RRF"), color: INK },
        { label: "+ Rerank", value: r1("hybrid + RRF + cross-encoder rerank"), color: RERANK }
      ]
    },
    {
      title: "recall@5: nearly saturated, so it stops discriminating",
      note: "Every hybrid configuration sits at or near 1.000 at k=5 on this corpus. A column that cannot distinguish its rows looks like evidence and isn't.",
      domain: 1,
      rows: [
        { label: "Fused ranking", value: r5("hybrid + RRF"), color: INK },
        { label: "+ Rerank", value: r5("hybrid + RRF + cross-encoder rerank"), color: RERANK }
      ]
    }
  ],
  "answer-metrics": [
    {
      title: "Attribution suite: right words vs right receipts",
      note: "The 3B model mentions the right content while citing the wrong support, invisible to recall@k, decisive in practice. The 9B model scores 100/100.",
      domain: 1,
      rows: [
        { label: "3B · mentions", value: attribution("llama3.2", 512, "mention_accuracy"), color: INK },
        { label: "3B · grounded", value: attribution("llama3.2", 512, "grounding_rate"), color: CRITICAL },
        { label: "9B · mentions", value: attribution("qwen3.5", 512, "mention_accuracy"), color: INK },
        { label: "9B · grounded", value: attribution("qwen3.5", 512, "grounding_rate"), color: INK }
      ]
    }
  ],
  "parser-backends": [
    {
      title: "recall@5 on the SEC corpus, by parser backend",
      note: "Born-digital single-column renders are flat extraction's best case, and docling's ML table reconstruction loses labels outright. Structure earns its keep downstream, not here.",
      domain: 1,
      rows: [
        { label: "Naive (pypdf)", value: sec5("naive parser"), color: INK },
        { label: "Primitives", value: sec5("primitives parser"), color: INK },
        {
          label: "docling",
          value: sec5("docling parser"),
          color: CRITICAL,
          hint: "2 labelled quotes lost to its parse; most misses are financial-table questions."
        }
      ]
    },
    {
      title: "Order similarity vs HTML ground truth (mean of 8 files)",
      note: "The differential parse test. Fixing the two bugs it caught took the primitives parser from 0.78 to 0.99 on the worst files.",
      domain: 1,
      rows: [
        { label: "Naive (pypdf)", value: pqOrder("naive"), color: INK },
        { label: "Primitives", value: pqOrder("primitives"), color: INK },
        { label: "docling", value: pqOrder("docling"), color: INK }
      ]
    }
  ],
  "semantic-chunking": [
    {
      title: "Table-question recall@5: fixed-size vs structural",
      note: "Heading-bounded packing folds financial tables into large mixed chunks that rank worse. A negative result the knob shipped with, pointing at its own fix: atomic table chunks.",
      domain: 1,
      rows: [
        { label: "Fixed-size (512)", value: secTable("primitives parser"), color: INK },
        { label: "Structural", value: secTable("primitives + semantic chunking"), color: CRITICAL }
      ]
    }
  ],
  "contextual-retrieval": [
    {
      title: "recall@5 on the SEC corpus, by context mode",
      note: "Three identical bars, honestly drawn: two companies with distinct vocabulary give context nothing to disambiguate. The technique's motivating case is many near-identical documents.",
      domain: 1,
      rows: [
        { label: "No context", value: sec5("primitives parser"), color: INK },
        { label: "Breadcrumb", value: sec5("primitives + breadcrumb context"), color: INK },
        { label: "LLM-written", value: sec5("primitives + LLM context"), color: INK }
      ]
    }
  ],
  ablation: [
    {
      title: "recall@1 by configuration",
      note: "One knob at a time: each bar differs from its neighbour by a single setting, so the gaps are each technique's measured worth.",
      domain: 1,
      rows: [
        { label: "Vector only", value: r1("dense only"), color: VECTOR },
        { label: "Keyword only", value: r1("keyword only (BM25)"), color: KEYWORD },
        { label: "Hybrid (RRF)", value: r1("hybrid + RRF"), color: INK },
        { label: "Hybrid + rerank", value: r1("hybrid + RRF + cross-encoder rerank"), color: RERANK }
      ]
    }
  ]
};
