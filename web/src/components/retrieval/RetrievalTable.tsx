import { useMemo } from "react";

import { Th } from "../Table";
import {
  SOURCE_CLASS,
  SOURCE_HINT,
  SOURCE_LABEL,
  sourceOf,
  stageInfo
} from "../../lib/stages";
import type { Candidate, ContextChunk, StageRecord } from "../../lib/types";

/**
 * Per-chunk retrieval detail: where each candidate ranked at every stage, which search
 * found it, and whether it survived into the answer.
 *
 * This is the primary inspector view rather than the bump chart, because a chart only
 * communicates when there is movement to see. On a small corpus every retriever returns
 * every chunk and the lines run flat, but a table still says exactly what happened, and it
 * stays readable at fifty candidates where a chart becomes spaghetti.
 */

interface Row {
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

export function RetrievalTable({
  stages,
  context,
  selected,
  onSelect
}: {
  stages: StageRecord[];
  context: ContextChunk[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const rows = useMemo(() => buildRows(stages, context), [stages, context]);
  const hasVector = stages.some((s) => s.name === "dense");
  const hasKeyword = stages.some((s) => s.name === "bm25");
  const reranked = stages.some((s) => s.name === "rerank" && s.candidates_out);

  // Per-column score ranges, so each cell can draw its score as a bar on the
  // column's own scale (BM25 sums, cosines and cross-encoder logits are not
  // comparable to each other, only within a column).
  const scales = useMemo(
    () => ({
      keyword: scaleOf(rows.map((r) => r.keyword)),
      vector: scaleOf(rows.map((r) => r.vector)),
      fused: scaleOf(rows.map((r) => r.fused)),
      final: scaleOf(rows.map((r) => r.final))
    }),
    [rows]
  );

  if (rows.length === 0) return null;

  return (
    // Capped everywhere so a long candidate list scrolls inside its own panel
    // (the header is sticky) instead of stretching the conversation.
    <div className="scroll-chain max-h-64 overflow-x-auto overflow-y-auto lg:max-h-80">
      <table className="w-full min-w-[42rem] border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="border-b border-line">
            <Th hint="Each row is one chunk of a document that retrieval considered, identified by its position in that document. Click a row to trace it through the pipeline.">
              Chunk
            </Th>
            <Th hint={SOURCE_HINT.both}>Found by</Th>
            {hasKeyword ? <Th hint={stageInfo("bm25").what} align="right">Keyword</Th> : null}
            {hasVector ? <Th hint={stageInfo("dense").what} align="right">Vector</Th> : null}
            <Th hint={stageInfo("fuse").what} align="right">
              Fused
            </Th>
            {reranked ? (
              <Th hint={stageInfo("rerank").what} align="right">Reranked</Th>
            ) : null}
            <Th
              hint="Whether this chunk was packed into the prompt, and the citation number the model was told to use for it."
              hintEnd
            >
              In answer
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const source = sourceOf(row.fused?.detail?.found_by as string[] | undefined);
            const active = selected === row.chunkId;

            return (
              <tr
                key={row.chunkId}
                onClick={() => onSelect(active ? null : row.chunkId)}
                className={[
                  "cursor-pointer border-b border-line/60 transition-colors",
                  active ? "bg-foreground/8" : "hover:bg-foreground/4"
                ].join(" ")}
              >
                <td className="max-w-[18rem] py-1.5 pr-3">
                  <div className="truncate text-ui text-muted">
                    {row.preview ?? <span className="text-subtle">not in final context</span>}
                  </div>
                  <div className="tabular flex items-center gap-1.5 font-mono text-label text-subtle">
                    <span>{row.locator ?? row.chunkId}</span>
                    {row.overlapChars > 0 ? (
                      <span
                        data-hint={`This chunk opens with ${row.overlapChars} characters that also belong to the previous chunk: the overlap window, which exists so an answer sitting on a boundary is still retrievable. The preview above skips past it to show what is actually distinctive to this chunk.`}
                        className="hint hint-right border border-line px-1 text-label text-slow"
                      >
                        overlap {row.overlapChars}c
                      </span>
                    ) : null}
                  </div>
                </td>

                <td className="py-1.5 pr-3">
                  {source ? (
                    <span
                      className={`hint hint-right inline-flex items-center gap-1.5 ${SOURCE_CLASS[source]}`}
                      data-hint={SOURCE_HINT[source]}
                    >
                      <Dot source={source} />
                      <span className="text-meta whitespace-nowrap">{SOURCE_LABEL[source]}</span>
                    </span>
                  ) : (
                    <span className="text-meta text-subtle">—</span>
                  )}
                </td>

                {hasKeyword ? <RankCell candidate={row.keyword} scale={scales.keyword} /> : null}
                {hasVector ? <RankCell candidate={row.vector} scale={scales.vector} /> : null}
                <RankCell candidate={row.fused} scale={scales.fused} />
                {reranked ? (
                  <RankCell candidate={row.final} moveFrom={row.fused} scale={scales.final} />
                ) : null}

                <td className="py-1.5">
                  {row.marker !== null ? (
                    <span className="inline-flex h-[17px] min-w-[17px] items-center justify-center border border-line px-1 font-mono text-meta">
                      {row.marker}
                    </span>
                  ) : (
                    <span
                      className="hint hint-right hint-end text-meta text-subtle"
                      data-hint="Retrieved, but dropped before the prompt: either the token budget ran out or a higher-ranked chunk already covered the same text."
                    >
                      dropped
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Scale {
  min: number;
  max: number;
}

/** The score range a column actually spans, for drawing scores as bars. */
function scaleOf(candidates: (Candidate | null)[]): Scale {
  const scores = candidates.filter((c): c is Candidate => c !== null).map((c) => c.score);
  return { min: Math.min(...scores, Infinity), max: Math.max(...scores, -Infinity) };
}

function RankCell({
  candidate,
  moveFrom,
  scale
}: {
  candidate: Candidate | null;
  moveFrom?: Candidate | null;
  scale: Scale;
}) {
  if (!candidate) {
    return (
      <td className="py-1.5 pr-3 text-right">
        <span
          className="hint hint-right hint-end text-meta text-subtle"
          data-hint="This search did not return this chunk at all."
        >
          —
        </span>
      </td>
    );
  }

  const move = moveFrom ? moveFrom.rank - candidate.rank : 0;
  const spread = scale.max - scale.min;
  const fraction = spread > 0 ? (candidate.score - scale.min) / spread : 1;

  return (
    <td className="tabular py-1.5 pr-3 text-right font-mono">
      <span className="text-ui">#{candidate.rank}</span>
      {move !== 0 ? (
        <span
          className={`ml-1 text-label ${move > 0 ? "text-vector" : "text-slow"}`}
          title={move > 0 ? `moved up ${move}` : `moved down ${-move}`}
        >
          {move > 0 ? `↑${move}` : `↓${-move}`}
        </span>
      ) : null}
      <div className="text-label text-subtle">{candidate.score.toFixed(3)}</div>
      {/* The score, as length, on this column's own scale, since raw scores
          from different stages are not comparable to each other. */}
      <div className="mt-0.5 ml-auto h-[3px] w-12 bg-foreground/8">
        <div
          className="h-full bg-foreground/45"
          style={{ width: `${Math.max(3, 100 * fraction)}%` }}
        />
      </div>
    </td>
  );
}

function Dot({ source }: { source: "keyword" | "vector" | "both" }) {
  if (source === "both") {
    return (
      <span className="inline-flex gap-px">
        <span className="h-1.5 w-1.5 bg-keyword" />
        <span className="h-1.5 w-1.5 bg-vector" />
      </span>
    );
  }
  return (
    <span className={`h-1.5 w-1.5 ${source === "keyword" ? "bg-keyword" : "bg-vector"}`} />
  );
}

function buildRows(stages: StageRecord[], context: ContextChunk[]): Row[] {
  const at = (name: string) => stages.find((s) => s.name === name)?.candidates_out ?? null;
  const index = (list: Candidate[] | null) =>
    new Map((list ?? []).map((c) => [c.chunk_id, c]));

  const keyword = index(at("bm25"));
  const vector = index(at("dense"));
  const fused = index(at("fuse"));
  const rerank = index(at("rerank"));
  const packed = new Map(context.map((c) => [c.chunk_id, c]));

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
      marker: inContext?.marker ?? null,
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
