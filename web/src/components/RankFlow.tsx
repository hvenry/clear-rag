import { useMemo, useState } from "react";

import { SOURCE_LABEL, sourceOf } from "../lib/stages";
import type { Candidate, StageRecord } from "../lib/types";

/**
 * The rank-flow diagram: a bump chart of documents moving between pipeline stages.
 *
 * This component knows nothing about BM25, vectors, fusion or reranking. It reads
 * `candidates_out` from any stage that has one and draws the movement between adjacent
 * stages. That is the payoff of making `Candidate` the universal currency of the
 * retrieval half — a retrieval technique added later appears here for free.
 *
 * Hand-rolled SVG rather than a charting library: a bump chart is about eighty lines of
 * geometry, and owning it keeps the hairline-and-monochrome treatment exact.
 */

const MAX_RANK = 12;

/**
 * Below this many candidates every retriever returns nearly everything, the lines run
 * flat, and the chart says less than the table beside it. The caller checks this before
 * rendering rather than drawing something uninformative.
 */
export const MIN_CANDIDATES_FOR_FLOW = 5;

const STROKE: Record<string, string> = {
  keyword: "var(--color-keyword)",
  vector: "var(--color-vector)",
  both: "currentColor"
};
const ROW = 22;
const PAD = { top: 30, right: 16, bottom: 34, left: 34 };

interface RankFlowProps {
  stages: StageRecord[];
  onSelect?: (chunkId: string | null) => void;
  selected?: string | null;
}

interface Point {
  stage: number;
  rank: number;
  candidate: Candidate;
}

export function RankFlow({ stages, onSelect, selected }: RankFlowProps) {
  const [hovered, setHovered] = useState<string | null>(null);

  const flow = useMemo(() => {
    const cols = stages.filter((s) => s.candidates_out && s.candidates_out.length > 0);
    if (cols.length < 2) return null;

    // Which chunks are worth drawing: everything that survived to the last stage, plus
    // anything that ever cracked the top few. Drawing all 50 candidates would be noise.
    const survivors = new Set((cols.at(-1)?.candidates_out ?? []).map((c) => c.chunk_id));
    const contenders = new Set<string>(survivors);
    cols.forEach((col) =>
      col.candidates_out!.slice(0, 6).forEach((c) => contenders.add(c.chunk_id))
    );

    const fused = cols.find((c) => c.name === "fuse")?.candidates_out ?? [];
    const sourceById = new Map(
      fused.map((c) => [c.chunk_id, sourceOf(c.detail?.found_by as string[] | undefined)])
    );

    const tracks = [...contenders]
      .map((chunkId) => {
        const points: Point[] = [];
        cols.forEach((col, i) => {
          const candidate = col.candidates_out!.find((c) => c.chunk_id === chunkId);
          if (candidate && candidate.rank <= MAX_RANK) {
            points.push({ stage: i, rank: candidate.rank, candidate });
          }
        });
        return {
          chunkId,
          points,
          survived: survivors.has(chunkId),
          source: sourceById.get(chunkId) ?? null
        };
      })
      .filter((t) => t.points.length > 0)
      .sort((a, b) => (a.points.at(-1)?.rank ?? 99) - (b.points.at(-1)?.rank ?? 99));

    return { cols, tracks: tracks.slice(0, MAX_RANK) };
  }, [stages]);

  if (!flow) return null;

  const { cols, tracks } = flow;
  const colWidth = 128;
  const width = PAD.left + cols.length * colWidth + PAD.right;
  const height = PAD.top + MAX_RANK * ROW + PAD.bottom;

  const x = (stage: number) => PAD.left + stage * colWidth + colWidth / 2;
  const y = (rank: number) => PAD.top + (rank - 0.5) * ROW;

  const active = hovered ?? selected ?? null;

  return (
    <div className="overflow-x-auto scrollbar-hide">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        className="max-w-none"
        role="img"
        aria-label="Document rank changes across retrieval stages"
      >
        {/* Rank gridlines */}
        {Array.from({ length: MAX_RANK }, (_, i) => i + 1).map((rank) => (
          <g key={rank}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(rank)}
              y2={y(rank)}
              stroke="currentColor"
              strokeOpacity={0.06}
            />
            <text
              x={PAD.left - 10}
              y={y(rank) + 3}
              textAnchor="end"
              className="fill-current font-mono text-[9px] opacity-35"
            >
              {rank}
            </text>
          </g>
        ))}

        {/* Stage columns */}
        {cols.map((col, i) => (
          <g key={col.name}>
            <line
              x1={x(i)}
              x2={x(i)}
              y1={PAD.top - 8}
              y2={height - PAD.bottom + 4}
              stroke="currentColor"
              strokeOpacity={0.1}
              strokeDasharray="2 4"
            />
            <text
              x={x(i)}
              y={height - PAD.bottom + 20}
              textAnchor="middle"
              className="fill-current font-display text-[10px] tracking-[0.12em] uppercase opacity-70"
            >
              {SHORT[col.name] ?? col.name}
            </text>
            <text
              x={x(i)}
              y={PAD.top - 16}
              textAnchor="middle"
              className="fill-current font-mono text-[9px] opacity-40"
            >
              {col.duration_ms.toFixed(1)}ms
            </text>
          </g>
        ))}

        {/* Tracks */}
        {tracks.map((track) => {
          const isActive = active === track.chunkId;
          const dimmed = active !== null && !isActive;
          const opacity = dimmed ? 0.12 : isActive ? 1 : track.survived ? 0.62 : 0.28;

          return (
            <g
              key={track.chunkId}
              onMouseEnter={() => setHovered(track.chunkId)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => onSelect?.(active === track.chunkId ? null : track.chunkId)}
              className="cursor-pointer"
            >
              {/* Segments are drawn pairwise so a stage that never saw this chunk leaves
                  a visible gap rather than a misleading straight line through it. */}
              {track.points.slice(0, -1).map((point, i) => {
                const next = track.points[i + 1];
                const contiguous = next.stage === point.stage + 1;
                return (
                  <line
                    key={i}
                    x1={x(point.stage)}
                    y1={y(point.rank)}
                    x2={x(next.stage)}
                    y2={y(next.rank)}
                    stroke={track.source ? STROKE[track.source] : "currentColor"}
                    strokeOpacity={opacity}
                    strokeWidth={isActive ? 2.25 : 1.5}
                    strokeDasharray={contiguous ? undefined : "3 3"}
                  />
                );
              })}

              {track.points.map((point) => (
                <circle
                  key={`${point.stage}-${point.rank}`}
                  cx={x(point.stage)}
                  cy={y(point.rank)}
                  r={isActive ? 4 : 3}
                  className="fill-background"
                  stroke={track.source ? STROKE[track.source] : "currentColor"}
                  strokeOpacity={opacity}
                  strokeWidth={isActive ? 2.25 : 1.5}
                />
              ))}

              <title>
                {`${track.chunkId}` +
                  (track.source ? ` · ${SOURCE_LABEL[track.source]}` : "") +
                  "\n" +
                  track.points
                    .map((p) => `${SHORT[cols[p.stage].name] ?? cols[p.stage].name}: rank ${p.rank}`)
                    .join("\n")}
              </title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const SHORT: Record<string, string> = {
  bm25: "Keyword",
  dense: "Vector",
  rrf: "Fuse",
  fuse: "Fuse",
  rerank: "Rerank",
  assemble: "Context"
};
