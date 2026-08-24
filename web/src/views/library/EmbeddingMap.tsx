import { CrosshairIcon, FilesIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { assignSlots, catColor } from "../../lib/palette";
import { Loader } from "../../components/Loader";
import { IconButton } from "../../components/IconButton";

/**
 * The corpus embedding space, flattened to 2D by PCA.
 *
 * Every chunk is a dot; ask a question and it drops into the same plane, with its
 * five nearest neighbours ringed. This is vector search made literal: relevance is
 * distance, and a question that lands in the wrong cluster explains a bad retrieval
 * better than any score table.
 *
 * Colour policy: each document takes a categorical slot, in filename order, so the
 * clusters read at a glance — but identity never rides on hue alone. The legend
 * carries the labels, hovering a document isolates its chunks, and the tooltip
 * names every point (a scatter can only guarantee CVD-safe pairs for three hues,
 * so the interaction is the mechanism and the colour is the reinforcement).
 * The query point and its neighbour rings stay in the vector blue the rest of the
 * interface already uses for "found by vector search".
 */

interface MapPoint {
  chunk_id: string;
  doc_id: string;
  filename: string;
  ordinal: number;
  x: number;
  y: number;
}

interface MapData {
  points: MapPoint[];
  query: { x: number; y: number } | null;
  neighbours: string[];
  explained_variance: number[];
}

const SIZE = 640;
const PAD = 40;

export function EmbeddingMap({
  onOpenDoc,
  onClose
}: {
  onOpenDoc: (docId: string) => void;
  onClose?: () => void;
}) {
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [hoveredDoc, setHoveredDoc] = useState<string | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<MapPoint | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (q?: string) => {
    setBusy(true);
    setError(null);
    try {
      const params = q ? `?query=${encodeURIComponent(q)}` : "";
      const response = await fetch(`/api/map${params}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.detail?.message ?? body?.detail ?? `HTTP ${response.status}`);
      }
      setData((await response.json()) as MapData);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const docs = useMemo(() => {
    const byDoc = new Map<string, { filename: string; count: number }>();
    data?.points.forEach((p) => {
      const entry = byDoc.get(p.doc_id) ?? { filename: p.filename, count: 0 };
      entry.count += 1;
      byDoc.set(p.doc_id, entry);
    });
    return [...byDoc.entries()].sort((a, b) => a[1].filename.localeCompare(b[1].filename));
  }, [data]);

  /** Colour follows the document, in filename order — stable across renders. */
  const slots = useMemo(() => assignSlots(docs.map(([id]) => id)), [docs]);
  const docColor = (docId: string) => catColor(slots.get(docId) ?? -1);

  const neighbourRank = useMemo(
    () => new Map((data?.neighbours ?? []).map((id, i) => [id, i + 1])),
    [data]
  );
  const pointById = useMemo(
    () => new Map((data?.points ?? []).map((p) => [p.chunk_id, p])),
    [data]
  );
  const sx = (v: number) => PAD + ((v + 1) / 2) * (SIZE - 2 * PAD);
  const sy = (v: number) => PAD + ((1 - v) / 2) * (SIZE - 2 * PAD);

  const trackCursor = (e: React.MouseEvent) => {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box) return;
    setCursor({ x: e.clientX - box.left, y: e.clientY - box.top });
  };

  if (error) {
    return (
      <div className="p-6">
        <p className="text-[12px] text-muted">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader label="projecting corpus" />
      </div>
    );
  }

  const [v1, v2] = data.explained_variance;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-2.5">
        <p className="text-[11px] leading-relaxed text-subtle">
          Every chunk, projected from embedding space onto its two most informative
          directions (PCA — this picture preserves {Math.round((v1 + v2) * 100)}% of the
          corpus variance). Nearby dots mean similar text. Ask a question to drop it into
          the plane and ring its five nearest neighbours — the chunks vector search would
          return.
        </p>
        {onClose ? (
          <IconButton label="Close map" onClick={onClose} className="shrink-0 lg:hidden">
            <XIcon size={12} />
          </IconButton>
        ) : null}
      </div>

      <div className="glass-strong border-x-0 border-t-0">
        <div className="flex items-end gap-2 px-4 py-2.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load(query);
            }}
            placeholder="Drop a question into the space…"
            className="h-[34px] flex-1 border border-line bg-transparent px-3 text-[12px] outline-none transition-colors focus:border-foreground/45"
          />
          <button
            onClick={() => void load(query)}
            disabled={busy}
            className="flex h-[34px] items-center gap-1.5 border border-line px-3 font-display text-[10px] tracking-[0.16em] uppercase transition-colors hover:border-foreground/60 hover:bg-foreground hover:text-background disabled:opacity-40"
          >
            <CrosshairIcon size={12} />
            {busy ? "…" : "Locate"}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div
          ref={plotRef}
          onMouseMove={trackCursor}
          className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-4"
        >
          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="max-h-full w-full max-w-[820px]"
            role="img"
            aria-label="2D projection of the corpus embedding space"
          >
            {/* Frame and recessive quarter grid */}
            <rect
              x={PAD / 2}
              y={PAD / 2}
              width={SIZE - PAD}
              height={SIZE - PAD}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.1}
            />
            {[0.25, 0.5, 0.75].map((f) => (
              <g key={f}>
                <line
                  x1={PAD / 2}
                  x2={SIZE - PAD / 2}
                  y1={PAD / 2 + f * (SIZE - PAD)}
                  y2={PAD / 2 + f * (SIZE - PAD)}
                  stroke="currentColor"
                  strokeOpacity={0.04}
                />
                <line
                  y1={PAD / 2}
                  y2={SIZE - PAD / 2}
                  x1={PAD / 2 + f * (SIZE - PAD)}
                  x2={PAD / 2 + f * (SIZE - PAD)}
                  stroke="currentColor"
                  strokeOpacity={0.04}
                />
              </g>
            ))}
            <text
              x={SIZE / 2}
              y={SIZE - 8}
              textAnchor="middle"
              className="fill-current font-mono text-[9px] opacity-35"
            >
              PC1 · {Math.round(v1 * 100)}% of variance
            </text>
            <text
              x={10}
              y={SIZE / 2}
              textAnchor="middle"
              transform={`rotate(-90 10 ${SIZE / 2})`}
              className="fill-current font-mono text-[9px] opacity-35"
            >
              PC2 · {Math.round(v2 * 100)}% of variance
            </text>

            {data.points.map((point) => {
              const rank = neighbourRank.get(point.chunk_id);
              const docHovered = hoveredDoc === point.doc_id;
              const dimmed = hoveredDoc !== null && !docHovered;
              const color = docColor(point.doc_id);
              return (
                <g
                  key={point.chunk_id}
                  onMouseEnter={() => {
                    setHoveredDoc(point.doc_id);
                    setHoveredPoint(point);
                  }}
                  onMouseLeave={() => {
                    setHoveredDoc(null);
                    setHoveredPoint(null);
                  }}
                  onClick={() => onOpenDoc(point.doc_id)}
                  className="cursor-pointer"
                >
                  {rank !== undefined ? (
                    <circle
                      cx={sx(point.x)}
                      cy={sy(point.y)}
                      r={10}
                      fill="none"
                      stroke="var(--color-vector)"
                      strokeWidth={1.5}
                      strokeOpacity={dimmed ? 0.25 : 0.9}
                    />
                  ) : null}
                  {/* An oversized invisible hit target keeps small dots hoverable. */}
                  <circle cx={sx(point.x)} cy={sy(point.y)} r={9} fill="transparent" />
                  <circle
                    cx={sx(point.x)}
                    cy={sy(point.y)}
                    r={docHovered ? 5.5 : 4.5}
                    fill={color}
                    fillOpacity={dimmed ? 0.12 : docHovered ? 1 : 0.75}
                    stroke="rgb(var(--background))"
                    strokeWidth={1}
                  />
                </g>
              );
            })}

            {data.query ? (
              <g>
                {/* Crosshair through the question, so its position reads against
                    both axes even at the edge of the plot. */}
                <line
                  x1={PAD / 2}
                  x2={SIZE - PAD / 2}
                  y1={sy(data.query.y)}
                  y2={sy(data.query.y)}
                  stroke="var(--color-vector)"
                  strokeOpacity={0.25}
                  strokeDasharray="2 5"
                />
                <line
                  y1={PAD / 2}
                  y2={SIZE - PAD / 2}
                  x1={sx(data.query.x)}
                  x2={sx(data.query.x)}
                  stroke="var(--color-vector)"
                  strokeOpacity={0.25}
                  strokeDasharray="2 5"
                />
                <path
                  d={`M ${sx(data.query.x)} ${sy(data.query.y) - 9} l 9 9 l -9 9 l -9 -9 Z`}
                  fill="var(--color-vector)"
                  stroke="rgb(var(--background))"
                  strokeWidth={1.5}
                />
                <title>your question</title>
              </g>
            ) : null}
          </svg>

          {/* Cursor tooltip: names the point, since colour never stands alone. */}
          {hoveredPoint && cursor ? (
            <div
              className="glass-popover pointer-events-none absolute z-30 max-w-[16rem] px-2.5 py-1.5"
              style={{
                left: Math.min(cursor.x + 14, (plotRef.current?.clientWidth ?? 0) - 200),
                top: cursor.y + 14
              }}
            >
              <div className="flex items-center gap-1.5 text-[11px]">
                <span
                  className="h-2 w-2 shrink-0"
                  style={{ background: docColor(hoveredPoint.doc_id) }}
                />
                <span className="truncate">{hoveredPoint.filename}</span>
              </div>
              <div className="tabular mt-0.5 font-mono text-[9px] text-subtle">
                {/* Ordinals are 0-based internally; displayed chunk numbers are 1-based. */}
                chunk {hoveredPoint.ordinal + 1}
                {neighbourRank.has(hoveredPoint.chunk_id)
                  ? ` · #${neighbourRank.get(hoveredPoint.chunk_id)} nearest to your question`
                  : ""}
                {" · click to open"}
              </div>
            </div>
          ) : null}
        </div>

        <aside className="max-h-56 w-full shrink-0 overflow-y-auto border-t border-line lg:max-h-none lg:w-60 lg:border-t-0 lg:border-l">
          <div className="flex items-center gap-1.5 px-3 pt-3 pb-1.5 menu-label">
            <FilesIcon size={11} />
            Documents
          </div>
          <ul className="pb-2">
            {docs.map(([docId, meta]) => (
              <li key={docId}>
                <button
                  onMouseEnter={() => setHoveredDoc(docId)}
                  onMouseLeave={() => setHoveredDoc(null)}
                  onClick={() => onOpenDoc(docId)}
                  className={[
                    "flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors",
                    hoveredDoc === docId ? "bg-foreground/8" : "hover:bg-foreground/4"
                  ].join(" ")}
                >
                  <span
                    className="h-2 w-2 shrink-0 self-center"
                    style={{ background: docColor(docId) }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px]">{meta.filename}</span>
                  <span className="tabular shrink-0 font-mono text-[9px] text-subtle">
                    {meta.count}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {data.query ? (
            <div className="border-t border-line px-3 py-2.5">
              <div className="flex items-center gap-1.5 pb-1.5 menu-label">
                <CrosshairIcon size={11} />
                Nearest to your question
              </div>
              <ol className="space-y-1">
                {data.neighbours.map((id, i) => {
                  const point = pointById.get(id);
                  if (!point) return null;
                  return (
                    <li key={id}>
                      <button
                        onMouseEnter={() => setHoveredDoc(point.doc_id)}
                        onMouseLeave={() => setHoveredDoc(null)}
                        onClick={() => onOpenDoc(point.doc_id)}
                        className="flex w-full items-center gap-2 text-left transition-colors hover:bg-foreground/4"
                      >
                        <span className="tabular w-4 shrink-0 font-mono text-[9px] text-subtle">
                          #{i + 1}
                        </span>
                        <span
                          className="h-2 w-2 shrink-0"
                          style={{ background: docColor(point.doc_id) }}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-[10px]">
                          {point.filename}
                        </span>
                        <span className="tabular shrink-0 font-mono text-[9px] text-subtle">
                          c{point.ordinal + 1}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-2 flex items-center gap-1.5 border-t border-line pt-2 text-[10px] text-subtle">
                <span
                  className="inline-block h-2 w-2 rotate-45"
                  style={{ background: "var(--color-vector)" }}
                />
                your question
                <span
                  className="ml-2 inline-block h-2.5 w-2.5 rounded-full border"
                  style={{ borderColor: "var(--color-vector)" }}
                />
                top-5 ring
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
