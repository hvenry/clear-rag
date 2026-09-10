/**
 * The committed benchmark results, imported straight from `evals/results/*.json`.
 *
 * Those files are written by `clear-rag ablate --save-results`; nothing here is typed
 * by hand. The Results view renders them, the Learn page's charts and prose read from
 * them through the accessors below, and `scripts/render_results.py` renders the same
 * files into the README — so a re-run that changes a number changes it everywhere,
 * or nowhere. Every row carries its provenance: which models measured it, and when.
 */

import attribution from "../../../evals/results/attribution.json";
import parseQuality from "../../../evals/results/parse-quality.json";
import retrieval from "../../../evals/results/retrieval.json";
import sec from "../../../evals/results/sec.json";

export type Suite = "retrieval" | "sec" | "attribution";

export interface Provenance {
  measured_at: string;
  chat_model?: string | null;
  embed_model?: string | null;
  reranker?: string | null;
  source: "measured" | "imported";
  note?: string;
}

/** Mirrors `clearrag.eval.metrics.Aggregate.to_dict`. Nulls are "not measured". */
export interface Aggregate {
  k: number;
  n_questions: number;
  n_answerable: number;
  recall: number | null;
  precision: number | null;
  mrr: number | null;
  ndcg: number | null;
  hit_rate: number | null;
  refusal_accuracy: number | null;
  mention_accuracy: number | null;
  false_refusal_rate: number | null;
  confusion_rate: number | null;
  grounding_rate: number | null;
  citation_precision: number | null;
  by_tag: Record<string, number>;
}

export interface QuestionResult {
  id: string;
  /** Present in rows measured after the field was added; older rows show the id. */
  question?: string;
  tags: string[];
  recall: number;
  first_relevant_rank: number | null;
  missed: string[];
  refused: boolean | null;
  mentioned: boolean | null;
  confused: boolean | null;
  grounded: boolean | null;
}

export interface ResultRow {
  label: string;
  config_hash: string;
  config: Record<string, unknown>;
  generated: boolean;
  documents: number;
  provenance: Provenance;
  ingest_ms: number | null;
  query_ms: number | null;
  at_k: Record<string, Aggregate>;
  questions: QuestionResult[];
}

export interface ResultsFile {
  suite: Suite;
  k: number;
  corpus: { documents?: number; questions?: number; answerable?: number };
  rows: ResultRow[];
}

export interface ParseQualityRow {
  file: string;
  backend: string;
  word_recovery: number;
  order_similarity: number;
  provenance: Provenance;
}

export interface ParseQualityFile {
  suite: "parse-quality";
  rows: ParseQualityRow[];
  means: Record<string, { word_recovery: number; order_similarity: number }>;
}

export const RESULTS: Record<Suite, ResultsFile> = {
  retrieval: retrieval as unknown as ResultsFile,
  sec: sec as unknown as ResultsFile,
  attribution: attribution as unknown as ResultsFile
};

export const PARSE_QUALITY = parseQuality as unknown as ParseQualityFile;

export const SUITES: Suite[] = ["retrieval", "sec", "attribution"];

export const SUITE_INFO: Record<Suite, { title: string; what: string; command: string }> = {
  retrieval: {
    title: "Retrieval",
    what: "The standard sweep over the developer-docs corpus: each row differs from a neighbour by one setting, so the gaps are each technique's measured worth.",
    command: "clear-rag ablate --save-results"
  },
  sec: {
    title: "SEC 10-K",
    what: "Real PDFs. Parser backend, chunker and contextual retrieval become variables, judged on financial-table, structure and cross-company questions.",
    command: "clear-rag ablate --suite sec --save-results"
  },
  attribution: {
    title: "Attribution",
    what: "One document, so retrieval is trivially perfect and every failure is the generator's: did it say the right thing, cite the right chunk, refuse when it should?",
    command: "clear-rag ablate --suite attribution --generate --save-results"
  }
};

/* ── Accessors ────────────────────────────────────────────────────────────── */

export type MetricName = Exclude<keyof Aggregate, "by_tag" | "k" | "n_questions" | "n_answerable">;

export function row(suite: Suite, label: string): ResultRow | undefined {
  return RESULTS[suite].rows.find((r) => r.label === label);
}

export function metric(suite: Suite, label: string, k: number, name: MetricName): number | null {
  const agg = row(suite, label)?.at_k[String(k)];
  return agg ? agg[name] : null;
}

export function tagRecall(suite: Suite, label: string, k: number, tag: string): number | null {
  const agg = row(suite, label)?.at_k[String(k)];
  return agg?.by_tag[tag] ?? null;
}

export function fmt(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(3);
}

/** Formatted metric for prose, e.g. `recall@1 rises from ${m("retrieval", "hybrid + RRF", 1, "recall")}`. */
export function m(suite: Suite, label: string, k: number, name: MetricName): string {
  return fmt(metric(suite, label, k, name));
}

export function t(suite: Suite, label: string, k: number, tag: string): string {
  return fmt(tagRecall(suite, label, k, tag));
}

/** "ollama:qwen3.5:9b" → "qwen3.5:9b". */
export function modelShort(model: string | null | undefined): string {
  if (!model) return "?";
  const at = model.indexOf(":");
  return at === -1 ? model : model.slice(at + 1);
}

/** The label the table shows: attribution rows are named by the model that answered. */
export function displayLabel(suite: Suite, r: ResultRow): string {
  if (suite === "attribution") {
    return `${modelShort(r.provenance.chat_model)} · ${String(r.config.chunk_size)}`;
  }
  return r.label;
}

/** What makes a row unique: its label, plus the chat model when its answers were generated. */
export function rowKey(r: ResultRow): string {
  return r.generated ? `${r.label}|${r.provenance.chat_model ?? ""}` : r.label;
}

/**
 * Model differences between two rows: the embedder always, the chat model when either
 * row generated answers. These live in provenance rather than config — the embedder is
 * the identity of an index, not a query setting — so `diffConfigs` cannot see them.
 */
export function diffModels(a: ResultRow, b: ResultRow): { key: string; from: string; to: string }[] {
  const out: { key: string; from: string; to: string }[] = [];
  const pair = (key: string, x: string | null | undefined, y: string | null | undefined) => {
    if (x && y && modelShort(x) !== modelShort(y)) out.push({ key, from: modelShort(x), to: modelShort(y) });
  };
  pair("embedder", a.provenance.embed_model, b.provenance.embed_model);
  if (a.generated || b.generated) pair("chat", a.provenance.chat_model, b.provenance.chat_model);
  return out;
}

/** A one-line description of what measured a suite, from its rows' provenance. */
export function provenanceSummary(file: ResultsFile): string {
  const measured = file.rows.filter((r) => r.provenance.source === "measured");
  const rows = measured.length ? measured : file.rows;
  const dates = [...new Set(rows.map((r) => r.provenance.measured_at))].sort();
  const embed = [...new Set(rows.map((r) => modelShort(r.provenance.embed_model)))];
  const chat = [...new Set(rows.map((r) => modelShort(r.provenance.chat_model)))];
  const parts = [
    file.corpus.questions ? `${file.corpus.questions} questions` : null,
    file.corpus.documents ? `${file.corpus.documents} documents` : null,
    embed.length ? `embed ${embed.join(", ")}` : null,
    chat.length ? `chat ${chat.join(", ")}` : null,
    dates.length ? `measured ${dates.length === 1 ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`}` : null
  ];
  return parts.filter(Boolean).join(" · ");
}
