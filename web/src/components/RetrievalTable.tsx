import { useMemo } from "react";

import {
  SOURCE_CLASS,
  SOURCE_HINT,
  SOURCE_LABEL,
  sourceOf,
  stageInfo
} from "../lib/stages";
import type { Candidate, ContextChunk, StageRecord } from "../lib/types";

/**
 * Per-chunk retrieval detail: where each candidate ranked at every stage, which search
 * found it, and whether it survived into the answer.
 *
 * This is the primary inspector view rather than the bump chart, because a chart only
 * communicates when there is movement to see. On a small corpus every retriever returns
 * every chunk and the lines run flat — a table still says exactly what happened, and it
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

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[42rem] border-collapse text-left">
        <thead>
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
            <Th hint="Whether this chunk was packed into the prompt, and the citation number the model was told to use for it.">
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
                <td className="max-w-[18rem] py-2 pr-3">
                  <div className="truncate text-[11px] text-muted">
                    {row.preview ?? <span className="text-subtle">not in final context</span>}
                  </div>
                  <div className="tabular flex items-center gap-1.5 font-mono text-[9px] text-subtle">
                    <span>{row.locator ?? row.chunkId}</span>
                    {row.overlapChars > 0 ? (
                      <span
                        data-hint={`This chunk opens with ${row.overlapChars} characters that also belong to the previous chunk — the overlap window, which exists so an answer sitting on a boundary is still retrievable. The preview above skips past it to show what is actually distinctive to this chunk.`}
                        className="hint hint-right border border-line px-1 text-[8px] text-slow"
                      >
                        overlap {row.overlapChars}c
                      </span>
                    ) : null}
                  </div>
                </td>

                <td className="py-2 pr-3">
                  {source ? (
                    <span
                      className={`hint hint-right inline-flex items-center gap-1.5 ${SOURCE_CLASS[source]}`}
                      data-hint={SOURCE_HINT[source]}
                    >
                      <Dot source={source} />
                      <span className="text-[10px] whitespace-nowrap">{SOURCE_LABEL[source]}</span>
                    </span>
                  ) : (
                    <span className="text-[10px] text-subtle">—</span>
                  )}
                </td>

                {hasKeyword ? <RankCell candidate={row.keyword} /> : null}
                {hasVector ? <RankCell candidate={row.vector} /> : null}
                <RankCell candidate={row.fused} />
                {reranked ? <RankCell candidate={row.final} moveFrom={row.fused} /> : null}

                <td className="py-2">
                  {row.marker !== null ? (
                    <span className="inline-flex h-[17px] min-w-[17px] items-center justify-center border border-line px-1 font-mono text-[10px]">
                      {row.marker}
                    </span>
                  ) : (
                    <span
                      className="hint hint-right hint-end text-[10px] text-subtle"
                      data-hint="Retrieved, but dropped before the prompt — either the token budget ran out or a higher-ranked chunk already covered the same text."
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

function Th({
  children,
  hint,
  align = "left"
}: {
  children: React.ReactNode;
  hint: string;
  align?: "left" | "right";
}) {
  return (
    <th
      data-hint={hint}
      className={`hint pb-2 font-display text-[9px] font-medium tracking-[0.16em] text-subtle uppercase ${
        align === "right" ? "pr-3 text-right" : "pr-3 text-left"
      }`}
    >
      {children}
    </th>
  );
}

function RankCell({
  candidate,
  moveFrom
}: {
  candidate: Candidate | null;
  moveFrom?: Candidate | null;
}) {
  if (!candidate) {
    return (
      <td className="py-2 pr-3 text-right">
        <span
          className="hint hint-right hint-end text-[10px] text-subtle"
          data-hint="This search did not return this chunk at all."
        >
          —
        </span>
      </td>
    );
  }

  const move = moveFrom ? moveFrom.rank - candidate.rank : 0;

  return (
    <td className="tabular py-2 pr-3 text-right font-mono">
      <span className="text-[11px]">#{candidate.rank}</span>
      {move !== 0 ? (
        <span
          className={`ml-1 text-[9px] ${move > 0 ? "text-vector" : "text-slow"}`}
          title={move > 0 ? `moved up ${move}` : `moved down ${-move}`}
        >
          {move > 0 ? `↑${move}` : `↓${-move}`}
        </span>
      ) : null}
      <div className="text-[9px] text-subtle">{candidate.score.toFixed(3)}</div>
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
   * previous chunk — which reads as the table pointing at the wrong section.
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

  // Ordering follows the last stage that produced a ranking — the order that actually
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
        ? `chunk ${inContext.ordinal} · chars ${inContext.span[0]}–${inContext.span[1]}`
        : null,
      overlapChars
    };
  });
}
