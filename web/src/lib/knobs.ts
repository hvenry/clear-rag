/**
 * The Lab's control metadata: every pipeline knob, what it does in plain language,
 * and — critically — whether it is actually implemented.
 *
 * The config model advertises several settings whose machinery does not exist yet
 * (semantic chunking, contextual retrieval, HyDE, reranking, self-correction). The Lab
 * shows them disabled with an honest note rather than hiding them or letting them
 * pretend: a visible roadmap beats a knob that silently does nothing.
 */

export type KnobType = "segmented" | "number" | "range" | "toggle";

export interface Knob {
  key: string;
  label: string;
  type: KnobType;
  hint: string;
  options?: { value: string; label: string; hint?: string }[];
  min?: number;
  max?: number;
  step?: number;
  /** Only render when this predicate over the draft config holds. */
  visibleWhen?: (draft: Record<string, unknown>) => boolean;
  /** False = shown disabled with a "not built yet" note. */
  implemented: boolean;
  /** Changing this invalidates the stored chunks/vectors and needs a re-index. */
  reindexes?: boolean;
}

export interface KnobGroup {
  title: string;
  hint: string;
  knobs: Knob[];
}

export const KNOB_GROUPS: KnobGroup[] = [
  {
    title: "Retrieval",
    hint: "How candidate chunks are found and ranked before the model sees anything.",
    knobs: [
      {
        key: "retrieval",
        label: "Mode",
        type: "segmented",
        implemented: true,
        hint: "Which searches run. Hybrid runs both and merges them — turn one off and re-ask the same question to see what each contributes alone.",
        options: [
          { value: "hybrid", label: "hybrid" },
          { value: "dense", label: "vector" },
          { value: "lexical", label: "keyword" }
        ]
      },
      {
        key: "k_candidates",
        label: "Candidates per search",
        type: "number",
        min: 1,
        max: 500,
        implemented: true,
        hint: "How many chunks each search returns before merging. More candidates give fusion more to work with at almost no cost — this is not the number the model sees."
      },
      {
        key: "fusion",
        label: "Fusion",
        type: "segmented",
        implemented: true,
        visibleWhen: (d) => d.retrieval === "hybrid",
        hint: "How the two rankings merge. RRF uses only rank positions, so it needs no tuning; weighted normalises raw scores and lets you bias toward one search.",
        options: [
          { value: "rrf", label: "RRF" },
          { value: "weighted", label: "weighted" }
        ]
      },
      {
        key: "rrf_k",
        label: "RRF damping (k)",
        type: "number",
        min: 1,
        max: 500,
        implemented: true,
        visibleWhen: (d) => d.retrieval === "hybrid" && d.fusion === "rrf",
        hint: "The constant in 1/(k + rank). Small k lets a single #1 dominate; large k flattens the rankings so agreement between searches matters more than position. 60 is the value from the original paper."
      },
      {
        key: "dense_weight",
        label: "Vector weight",
        type: "range",
        min: 0,
        max: 1,
        step: 0.05,
        implemented: true,
        visibleWhen: (d) => d.retrieval === "hybrid" && d.fusion === "weighted",
        hint: "1.0 trusts vector search entirely, 0.0 trusts keyword search entirely. Keyword weight is always the remainder."
      },
      {
        key: "k_final",
        label: "Chunks to the model",
        type: "number",
        min: 1,
        max: 50,
        implemented: true,
        hint: "How many top chunks are packed into the prompt. More context can help — or bury the answer in noise a small model cannot attribute correctly."
      },
      {
        key: "rerank",
        label: "Cross-encoder rerank",
        type: "toggle",
        implemented: false,
        hint: "A model that reads question and chunk together and re-scores the shortlist. Not built yet — enabling it today records a skipped stage and changes nothing."
      }
    ]
  },
  {
    title: "Chunking",
    hint: "How documents are split. These change the stored index, so applying them offers a re-index of everything already uploaded.",
    knobs: [
      {
        key: "chunk_size",
        label: "Chunk size (tokens)",
        type: "number",
        min: 64,
        max: 4096,
        implemented: true,
        reindexes: true,
        hint: "The unit of retrieval. Large chunks carry more context but blur together unrelated sections — a one-page resume at 512 tokens becomes three chunks that each mix several jobs. Small chunks are precise but can orphan their context."
      },
      {
        key: "chunk_overlap",
        label: "Overlap (tokens)",
        type: "number",
        min: 0,
        max: 1024,
        implemented: true,
        reindexes: true,
        hint: "Text duplicated between neighbouring chunks so an answer sitting on a boundary is still retrievable. Insurance, not free: 50% overlap doubles the index. Around 10–15% is typical."
      },
      {
        key: "contextualize",
        label: "Contextual retrieval",
        type: "toggle",
        implemented: false,
        reindexes: true,
        hint: "Prepend an LLM-written situating sentence to each chunk before indexing (Anthropic's contextual retrieval). Not built yet."
      }
    ]
  },
  {
    title: "Conversation",
    hint: "What happens to your question before any search runs.",
    knobs: [
      {
        key: "rewrite_followups",
        label: "Rewrite follow-ups",
        type: "toggle",
        implemented: true,
        hint: "Turn “what about his school?” into a standalone query using the chat history before searching. Costs one LLM call per follow-up; without it, follow-up questions search the index with unresolved pronouns."
      },
      {
        key: "query_transform",
        label: "Query expansion",
        type: "segmented",
        implemented: false,
        hint: "HyDE (search with a hypothetical answer) and multi-query expansion. Not built yet — only “none” does anything.",
        options: [
          { value: "none", label: "none" },
          { value: "hyde", label: "HyDE" },
          { value: "multi", label: "multi" }
        ]
      },
      {
        key: "self_correct",
        label: "Self-correction",
        type: "toggle",
        implemented: false,
        hint: "Grade the retrieved chunks, rewrite the query and retry once if they look irrelevant. Not built yet."
      }
    ]
  },
  {
    title: "Generation",
    hint: "How the answer itself is produced from the packed context.",
    knobs: [
      {
        key: "max_context_tokens",
        label: "Context budget (tokens)",
        type: "number",
        min: 256,
        max: 32768,
        implemented: true,
        hint: "Hard ceiling on packed context. Chunks that do not fit are dropped and the trace records exactly which ones."
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "range",
        min: 0,
        max: 2,
        step: 0.1,
        implemented: true,
        hint: "Sampling randomness. Grounded answering wants it low — creativity in a RAG answer is another word for drifting from the sources."
      }
    ]
  }
];

/** Keys whose change requires rebuilding the index for already-stored documents. */
export const REINDEX_KEYS = new Set(
  KNOB_GROUPS.flatMap((g) => g.knobs.filter((k) => k.reindexes).map((k) => k.key))
);

/** Human-readable diff between two config snapshots, for run-card chips. */
export function diffConfigs(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>
): { key: string; from: unknown; to: unknown }[] {
  if (!prev) return [];
  return Object.keys(next)
    .filter((key) => JSON.stringify(prev[key]) !== JSON.stringify(next[key]))
    .map((key) => ({ key, from: prev[key], to: next[key] }));
}
