import { useCallback, useEffect, useMemo, useState } from "react";

import { Loader } from "./Loader";

/**
 * The corpus embedding space, flattened to 2D by PCA.
 *
 * Every chunk is a dot; ask a question and it drops into the same plane, with its five
 * nearest neighbours ringed. This is vector search made literal: relevance is distance,
 * and a question that lands in the wrong cluster explains a bad retrieval better than
 * any score table.
 *
 * Colour policy: dots are ink. The query point and its neighbours take the vector blue
 * — colour marks the exception (the thing you asked about), never the base data. Hover
 * a document in the legend to isolate its chunks; identity is carried by interaction
 * and labels, not by a ten-colour palette that no one can hold in their head.
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

  const neighbourSet = useMemo(() => new Set(data?.neighbours ?? []), [data]);
  const sx = (v: number) => PAD + ((v + 1) / 2) * (SIZE - 2 * PAD);
  const sy = (v: number) => PAD + ((1 - v) / 2) * (SIZE - 2 * PAD);

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
          Every chunk, projected from {""}
          embedding space onto its two most informative directions (PCA — this picture
          preserves {Math.round((v1 + v2) * 100)}% of the corpus variance). Nearby dots
          mean similar text. Ask a question to drop it into the plane and ring its five
          nearest neighbours — the chunks vector search would return.
        </p>
        {onClose ? (
          <button
            onClick={onClose}
            className="shrink-0 border border-line px-2 py-1 font-mono text-[10px] transition-colors hover:border-foreground/50 lg:hidden"
          >
            close
          </button>
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
            className="h-[34px] border border-line px-3 font-display text-[10px] tracking-[0.16em] uppercase transition-colors hover:border-foreground/60 hover:bg-foreground hover:text-background disabled:opacity-40"
          >
            {busy ? "…" : "Locate"}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-4">
          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="max-h-full w-full max-w-[640px]"
            role="img"
            aria-label="2D projection of the corpus embedding space"
          >
            <rect
              x={PAD / 2}
              y={PAD / 2}
              width={SIZE - PAD}
              height={SIZE - PAD}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.1}
            />
            {data.points.map((point) => {
              const isNeighbour = neighbourSet.has(point.chunk_id);
              const docHovered = hoveredDoc === point.doc_id;
              const dimmed = hoveredDoc !== null && !docHovered;
              return (
                <g
                  key={point.chunk_id}
                  onMouseEnter={() => setHoveredDoc(point.doc_id)}
                  onMouseLeave={() => setHoveredDoc(null)}
                  onClick={() => onOpenDoc(point.doc_id)}
                  className="cursor-pointer"
                >
                  {isNeighbour ? (
                    <circle
                      cx={sx(point.x)}
                      cy={sy(point.y)}
                      r={9}
                      fill="none"
                      stroke="var(--color-vector)"
                      strokeWidth={1.5}
                      strokeOpacity={dimmed ? 0.25 : 0.9}
                    />
                  ) : null}
                  <circle
                    cx={sx(point.x)}
                    cy={sy(point.y)}
                    r={docHovered ? 5 : 4}
                    fill="currentColor"
                    fillOpacity={dimmed ? 0.08 : docHovered ? 0.95 : 0.3}
                  />
                  <title>{`${point.filename} · chunk ${point.ordinal}${isNeighbour ? " · top-5 neighbour" : ""}`}</title>
                </g>
              );
            })}

            {data.query ? (
              <g>
                <path
                  d={`M ${sx(data.query.x)} ${sy(data.query.y) - 9} l 9 9 l -9 9 l -9 -9 Z`}
                  fill="var(--color-vector)"
                />
                <title>your question</title>
              </g>
            ) : null}
          </svg>
        </div>

        <aside className="max-h-44 w-full shrink-0 overflow-y-auto border-t border-line lg:max-h-none lg:w-56 lg:border-t-0 lg:border-l">
          <div className="px-3 pt-3 pb-1.5 font-display text-[9px] tracking-[0.18em] text-subtle uppercase">
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
                    "flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left transition-colors",
                    hoveredDoc === docId ? "bg-foreground/8" : "hover:bg-foreground/4"
                  ].join(" ")}
                >
                  <span className="truncate text-[11px]">{meta.filename}</span>
                  <span className="tabular font-mono text-[9px] text-subtle">{meta.count}</span>
                </button>
              </li>
            ))}
          </ul>
          {data.query ? (
            <div className="border-t border-line px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[10px] text-subtle">
                <span
                  className="inline-block h-2 w-2 rotate-45"
                  style={{ background: "var(--color-vector)" }}
                />
                your question
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[10px] text-subtle">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full border"
                  style={{ borderColor: "var(--color-vector)" }}
                />
                top-5 nearest chunks
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
