import type { Candidate, ContextChunk, StageRecord } from "../../lib/types";

/** One chunk's journey through retrieval, as the inspector table renders it. */
export interface Row {
  chunkId: string;
  keyword: Candidate | null;
  vector: Candidate | null;
  fused: Candidate | null;
  final: Candidate | null;
  marker: number | null;
  preview: string | null;
  /** "chunk 2 · chars 1799–3913 of resume.pdf", or null when it never reached the prompt. */
  locator: string | null;
  /** Characters at the start of this chunk that also belong to the previous one. */
  overlapChars: number;
}

/** Join every stage's ranking with the packed context into one row per candidate. */
export function buildRows(stages: StageRecord[], context: ContextChunk[]): Row[] {
  const at = (name: string) => stages.find((s) => s.name === name)?.candidates_out ?? null;
  const index = (list: Candidate[] | null) =>
    new Map((list ?? []).map((c) => [c.chunk_id, c]));

  const keyword = index(at("bm25"));
  const vector = index(at("dense"));
  const fused = index(at("fuse"));
  const rerank = index(at("rerank"));
  const packed = new Map(context.map((c) => [c.chunk_id, c]));
  // The assemble stage's output is exactly the packed chunks, in marker order, so the
  // keep-or-drop verdict survives in the stored trace even when the context event
  // (with the passage text) was never streamed, as in a session reloaded from the server.
  const assembled = new Map((at("assemble") ?? []).map((c, i) => [c.chunk_id, i + 1]));

  /**
   * How much of a chunk's opening is shared with an earlier chunk of the same document.
   *
   * Overlap means a chunk routinely *begins* inside its predecessor, so the naive
   * "first 90 characters" preview shows text the reader already attributed to the
   * previous chunk, which reads as the table pointing at the wrong section.
   */
  const overlapAtStart = (chunk: ContextChunk): number => {
    let deepest = 0;
    for (const other of context) {
      if (other.chunk_id === chunk.chunk_id || other.doc_id !== chunk.doc_id) continue;
      if (other.span[0] < chunk.span[0] && other.span[1] > chunk.span[0]) {
        deepest = Math.max(deepest, other.span[1] - chunk.span[0]);
      }
    }
    return deepest;
  };

  // Ordering follows the last stage that produced a ranking: the order that actually
  // decided what the model saw.
  const ordering = at("rerank") ?? at("fuse") ?? at("dense") ?? at("bm25") ?? [];

  return ordering.map((candidate) => {
    const id = candidate.chunk_id;
    const inContext = packed.get(id);
    const overlapChars = inContext ? overlapAtStart(inContext) : 0;

    // Skip past the shared opening so the preview shows what is distinctive to this
    // chunk, but only when enough text remains for the preview to be worth reading.
    let preview: string | null = null;
    if (inContext) {
      const body = inContext.text;
      const from = overlapChars > 0 && body.length - overlapChars > 40 ? overlapChars : 0;
      preview = (from > 0 ? "…" : "") + body.slice(from).replace(/\s+/g, " ").trim().slice(0, 90);
    }

    return {
      chunkId: id,
      keyword: keyword.get(id) ?? null,
      vector: vector.get(id) ?? null,
      fused: fused.get(id) ?? null,
      final: rerank.get(id) ?? null,
      marker: inContext?.marker ?? assembled.get(id) ?? null,
      preview,
      locator: inContext
        // Ordinals are stored 0-based; people count chunks from 1, and the
        // Library says "N chunks", so every displayed chunk number is 1-based.
        ? `chunk ${inContext.ordinal + 1} · chars ${inContext.span[0]}–${inContext.span[1]}`
        : null,
      overlapChars
    };
  });
}
