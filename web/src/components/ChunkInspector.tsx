import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api";
import type { DocumentDetail } from "../lib/types";

/**
 * Draws chunk boundaries directly over the source text.
 *
 * This is the fastest way to build intuition about chunking: overlap that is too large,
 * a splitter cutting mid-sentence, or a table shredded across three chunks are all
 * obvious the moment they are visible, and nearly undetectable when they are not.
 */
export function ChunkInspector({
  docId,
  highlight,
  onClose
}: {
  docId: string;
  highlight?: { span: [number, number] } | null;
  onClose?: () => void;
}) {
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focus, setFocus] = useState<{ start: number; end: number; covering: number[] } | null>(
    null
  );
  const [showBands, setShowBands] = useState(true);
  const markRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setDoc(null);
    setError(null);
    api.document(docId).then(setDoc).catch((e) => setError(String(e)));
  }, [docId]);

  useEffect(() => {
    if (doc && highlight) {
      markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [doc, highlight]);

  /**
   * Chunks overlap by design, so their spans cannot be rendered as a flat list of
   * ranges. The text is cut at every boundary instead, producing disjoint segments
   * each of which knows how many chunks cover it — which is exactly what makes the
   * overlap regions visible as darker bands.
   */
  const segments = useMemo(() => {
    if (!doc) return [];
    const cuts = new Set<number>([0, doc.text.length]);
    doc.chunks.forEach((c) => {
      cuts.add(c.span[0]);
      cuts.add(c.span[1]);
    });
    const sorted = [...cuts].sort((a, b) => a - b);

    return sorted.slice(0, -1).map((start, i) => {
      const end = sorted[i + 1];
      const covering = doc.chunks.filter((c) => c.span[0] <= start && c.span[1] >= end);
      return { start, end, text: doc.text.slice(start, end), covering };
    });
  }, [doc]);

  const stats = useMemo(() => {
    if (!doc || segments.length === 0) return null;
    const overlapped = segments.filter((s) => s.covering.length > 1);
    const overlapChars = overlapped.reduce((sum, s) => sum + (s.end - s.start), 0);
    return {
      chunks: doc.chunks.length,
      chars: doc.text.length,
      overlapPct: doc.text.length ? (100 * overlapChars) / doc.text.length : 0
    };
  }, [doc, segments]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="truncate font-display text-[13px] tracking-wide">
            {doc?.filename ?? "Loading…"}
          </div>
          {stats ? (
            <div className="font-mono text-[10px] text-subtle">
              {stats.chunks} chunks · {stats.chars.toLocaleString()} chars ·{" "}
              {stats.overlapPct.toFixed(1)}% overlapped
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => setShowBands((v) => !v)}
            data-hint="Shade the text by how many chunks cover it. A darker band is text that appears in two chunks at once — the overlap window, which exists so an answer spanning a boundary is still retrievable."
            className="hint hint-end border border-line px-2 py-1 font-mono text-[10px] transition-colors hover:border-foreground/50"
          >
            {showBands ? "hide bands" : "show bands"}
          </button>
          {onClose ? (
            <button
              onClick={onClose}
              className="border border-line px-2 py-1 font-mono text-[10px] transition-colors hover:border-foreground/50"
            >
              close
            </button>
          ) : null}
        </div>
      </div>

      {error ? <p className="p-4 font-mono text-[11px] text-critical">{error}</p> : null}

      <div className="border-b border-line px-4 py-2.5">
        <p className="text-[11px] leading-relaxed text-subtle">
          The document as retrieval sees it. Each shaded band is one chunk — the unit that
          gets embedded, indexed and returned. Darker bands belong to{" "}
          <span className="text-slow">two chunks at once</span>: that is the overlap
          window, which exists so an answer sitting on a boundary is still retrievable.
        </p>
        <p className="tabular mt-1.5 font-mono text-[10px]">
          {focus ? (
            <>
              <span className="text-subtle">chars {focus.start}–{focus.end} · </span>
              {focus.covering.length > 1 ? (
                <span className="text-slow">
                  in chunks {focus.covering.join(" and ")} — overlap
                </span>
              ) : (
                <span className="text-muted">in chunk {focus.covering[0] ?? "—"}</span>
              )}
            </>
          ) : (
            <span className="text-subtle">hover the text to see which chunks cover it</span>
          )}
        </p>
      </div>

      <div className="flex-1 overflow-auto p-4 font-mono text-[12px] leading-[1.85] whitespace-pre-wrap">
        {segments.map((segment, i) => {
          const depth = segment.covering.length;
          const isHovered = hovered !== null && segment.covering.some((c) => c.ordinal === hovered);
          const isCited =
            highlight &&
            segment.start >= highlight.span[0] &&
            segment.end <= highlight.span[1];

          return (
            <span
              key={i}
              ref={isCited && !markRef.current ? markRef : undefined}
              onMouseEnter={() => {
                setHovered(segment.covering[0]?.ordinal ?? null);
                setFocus({
                  start: segment.start,
                  end: segment.end,
                  covering: segment.covering.map((c) => c.ordinal)
                });
              }}
              onMouseLeave={() => setHovered(null)}
              title={
                depth
                  ? `chunk ${segment.covering.map((c) => c.ordinal).join(", ")} · chars ${segment.start}–${segment.end}`
                  : undefined
              }
              className={[
                "transition-colors",
                isCited ? "bg-foreground text-background" : "",
                !isCited && isHovered ? "bg-foreground/20" : "",
                // Overlap depth reads as tone: the darker the band, the more chunks
                // contain that text. Two-deep regions are the overlap window itself.
                !isCited && !isHovered && showBands && depth > 1 ? "bg-foreground/12" : "",
                !isCited && !isHovered && showBands && depth === 1 ? "bg-foreground/4" : "",
                showBands && depth > 0 ? "border-l border-foreground/25" : ""
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {segment.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}
