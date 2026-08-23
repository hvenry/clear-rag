/**
 * What each pipeline stage is, in plain language.
 *
 * The stage names are accurate but jargon-heavy ("Fuse (RRF)" means nothing until
 * someone tells you what reciprocal rank fusion does). Every stage and every number
 * shown in the UI has an entry here, surfaced on hover, so the interface explains
 * itself instead of requiring the README.
 */

export interface StageInfo {
  /** Short label shown in the pipeline strip. */
  short: string;
  /** One line: what this stage does. */
  what: string;
  /** What the count beside it means, if it shows one. */
  count?: string;
  /** Why it might be slow — the question a big number actually raises. */
  timing?: string;
}

export const STAGE_INFO: Record<string, StageInfo> = {
  transform: {
    short: "Rewrite",
    what: "Rewrites a follow-up question into one that stands on its own, so “what about his school?” becomes “what school did Henry attend?” before anything is searched.",
    timing:
      "Skipped entirely on the first question of a conversation. On later turns it is a full LLM call, so it costs about as much as generating a short answer.",
  },
  bm25: {
    short: "Keyword",
    what: "Classic keyword search over a hand-built inverted index, scored with BM25. Strong on exact terms — names, error codes, API headers — and blind to synonyms.",
    count: "Chunks returned, ranked best first.",
    timing: "Pure arithmetic over an in-memory index. Single-digit milliseconds is normal.",
  },
  dense: {
    short: "Vector",
    what: "Semantic search. Your question is turned into a vector and compared against every chunk by cosine similarity, so it matches on meaning rather than shared words.",
    count: "Chunks returned, ranked best first.",
    timing:
      "Dominated by embedding the question — one round trip to the embedding model. The search itself is a single matrix multiply.",
  },
  fuse: {
    short: "Fuse",
    what: "Merges the keyword and vector rankings using Reciprocal Rank Fusion: each chunk scores Σ 1/(60 + rank) across both lists. A chunk both methods liked beats one that only a single method ranked first.",
    count: "Unique chunks after merging the two lists.",
    timing: "Arithmetic on two short lists. Effectively free.",
  },
  rerank: {
    short: "Rerank",
    what: "A cross-encoder reads the question and each chunk together and re-scores them. More accurate than either retriever, and far too slow to run over the whole corpus — which is why it only sees the fused shortlist.",
    count: "Chunks kept after re-scoring.",
    timing: "Runs a model over every candidate, so it scales with the shortlist length.",
  },
  assemble: {
    short: "Context",
    what: "Packs the surviving chunks into the model’s token budget, drops chunks whose text is already covered by a higher-ranked one, and numbers them so the answer can cite [1], [2].",
    count: "Chunks that actually reached the model.",
    timing: "Counts tokens for each chunk. Milliseconds.",
  },
  generate: {
    short: "Generate",
    what: "The language model writes the answer using only the packed context, citing each claim by number. Citations pointing at passages that were never supplied are discarded rather than shown.",
    timing:
      "By far the slowest stage, and the only one worth splitting in two. `ttft_ms` is the model reading the packed context before it writes anything — shrink it with fewer or smaller chunks. `tokens_per_second` is the rate it writes at afterwards — that one is a property of the model, not the retrieval. A reasoning model also spends extra time thinking before its first word; clear-rag disables that by default.",
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
  slow: "Over 1 second — noticeable.",
  critical: "Over 5 seconds — this stage dominates the response time.",
};

export function formatMs(ms: number): string {
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
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

/** Colour is always paired with this label — never used alone to carry meaning. */
export const SOURCE_CLASS: Record<Source, string> = {
  keyword: "text-keyword",
  vector: "text-vector",
  both: "text-foreground",
};

export const SOURCE_HINT: Record<Source, string> = {
  keyword: "Found by keyword search only — the vector search missed it, which usually means the wording matched but the meaning did not.",
  vector: "Found by vector search only — semantically close without sharing the question’s words.",
  both: "Found by both searches independently. This is the strongest signal a chunk is relevant, and fusion ranks it accordingly.",
};
