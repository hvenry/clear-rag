/**
 * What each pipeline stage is, in plain language.
 *
 * The stage names are accurate but jargon-heavy ("Fuse (RRF)" means nothing until
 * someone tells you what reciprocal rank fusion does). Every stage and every number
 * shown in the UI has an entry here, surfaced on hover, so the interface explains
 * itself instead of requiring the README.
 */

import type { StageRecord } from "./types";

export interface StageInfo {
  /** Short label shown in the pipeline strip. */
  short: string;
  /** One line: what this stage does. */
  what: string;
  /** What the count beside it means, if it shows one. */
  count?: string;
  /** Why it might be slow: the question a big number actually raises. */
  timing?: string;
}

export const STAGE_INFO: Record<string, StageInfo> = {
  transform: {
    short: "Rewrite",
    what: "Rewrites a follow-up question into one that stands on its own before searching and, with query expansion on, has the model write alternative phrasings that are searched alongside it.",
    timing: "Skipped on the first question unless expansion is on; a rewrite and an expansion each cost one LLM call.",
  },
  bm25: {
    short: "Keyword",
    what: "BM25 keyword search over an inverted index. Strong on exact terms, blind to synonyms.",
    count: "Chunks returned, ranked best first.",
    timing: "In-memory arithmetic; single-digit milliseconds.",
  },
  dense: {
    short: "Vector",
    what: "Semantic search: the question is embedded and compared to every chunk by cosine similarity, matching meaning rather than shared words.",
    count: "Chunks returned, ranked best first.",
    timing: "Dominated by embedding the question; the search is one matrix multiply.",
  },
  fuse: {
    short: "Fuse",
    what: "Merges the keyword and vector rankings with Reciprocal Rank Fusion: a chunk both methods liked beats one only a single method ranked first.",
    count: "Unique chunks after merging.",
    timing: "Arithmetic on two short lists; effectively free.",
  },
  rerank: {
    short: "Rerank",
    what: "A cross-encoder reads question and chunk together and re-scores the fused shortlist. Too slow for the whole corpus, more accurate than either retriever.",
    count: "Chunks kept after re-scoring.",
    timing: "One model pass per candidate; scales with shortlist length.",
  },
  assemble: {
    short: "Context",
    what: "Packs the surviving chunks into the token budget, drops overlap-duplicates, and numbers them for citations.",
    count: "Chunks that reached the model.",
    timing: "Token counting; milliseconds.",
  },
  generate: {
    short: "Generate",
    what: "The model writes the answer from the packed context only, citing by number. Citations to passages never supplied are discarded.",
    timing:
      "The slowest stage. `ttft_ms` is the model reading the context before writing. Shrink it with fewer or smaller chunks. `tokens_per_second` is the model's own writing speed.",
  },
};

export function stageInfo(name: string): StageInfo {
  return STAGE_INFO[name] ?? { short: name, what: "" };
}

/* ── Latency tiers ────────────────────────────────────────────────────────── */

export type Speed = "fast" | "slow" | "critical";

/**
 * Fast is deliberately uncoloured: colour marks the exception, not the rule.
 * Thresholds are set where a human starts to notice waiting.
 */
export function speedOf(ms: number): Speed {
  if (ms >= 5000) return "critical";
  if (ms >= 1000) return "slow";
  return "fast";
}

export const SPEED_CLASS: Record<Speed, string> = {
  fast: "text-subtle",
  slow: "text-slow",
  critical: "text-critical",
};

export const SPEED_HINT: Record<Speed, string> = {
  fast: "Under 1 second.",
  slow: "Over 1 second: noticeable.",
  critical: "Over 5 seconds: this stage dominates the response time.",
};

export function formatMs(ms: number): string {
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

/* ── Stage identity (charts) ──────────────────────────────────────────────── */

/**
 * One colour per pipeline stage, used wherever stage durations are charted.
 * The retrieval stages reuse the retriever-identity hues the interface already
 * taught (keyword aqua, vector blue); generate (the segment that dominates
 * every latency bar) stays deliberately quiet ink so the chart reads calm and
 * the retrieval slices stay visible. Always drawn beside a text label.
 */
export const STAGE_COLOR: Record<string, string> = {
  transform: "var(--color-cat-5)",
  bm25: "var(--color-keyword)",
  dense: "var(--color-vector)",
  fuse: "rgb(var(--foreground) / 0.8)",
  rerank: "var(--color-cat-7)",
  assemble: "var(--color-cat-2)",
  generate: "rgb(var(--foreground) / 0.32)",
};

export function stageColor(name: string): string {
  return STAGE_COLOR[name] ?? "rgb(var(--foreground) / 0.5)";
}

/* ── Retriever identity ───────────────────────────────────────────────────── */

export type Source = "keyword" | "vector" | "both";

/** Which retrievers found a chunk, from a fused candidate's `found_by` detail. */
export function sourceOf(foundBy: string[] | undefined): Source | null {
  if (!foundBy || foundBy.length === 0) return null;
  const keyword = foundBy.includes("bm25");
  const vector = foundBy.includes("dense");
  if (keyword && vector) return "both";
  if (keyword) return "keyword";
  if (vector) return "vector";
  return null;
}

export const SOURCE_LABEL: Record<Source, string> = {
  keyword: "Keyword only",
  vector: "Vector only",
  both: "Both",
};

/** Colour is always paired with this label, never used alone to carry meaning. */
export const SOURCE_CLASS: Record<Source, string> = {
  keyword: "text-keyword",
  vector: "text-vector",
  both: "text-foreground",
};

export const SOURCE_HINT: Record<Source, string> = {
  keyword: "Found by keyword search only. The vector search missed it, which usually means the wording matched but the meaning did not.",
  vector: "Found by vector search only: semantically close without sharing the question’s words.",
  both: "Found by both searches independently. This is the strongest signal a chunk is relevant, and fusion ranks it accordingly.",
};

/** Stage events can arrive more than once for the same stage; last write wins. */
export function mergeStage(stages: StageRecord[], incoming: StageRecord): StageRecord[] {
  const at = stages.findIndex((s) => s.name === incoming.name);
  if (at === -1) return [...stages, incoming];
  const next = [...stages];
  next[at] = incoming;
  return next;
}
