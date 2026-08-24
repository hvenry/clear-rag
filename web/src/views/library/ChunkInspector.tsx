import {
  ChartBarIcon,
  FileTextIcon,
  SquaresFourIcon,
  TreeStructureIcon,
  XIcon
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { HintCard, useHoverMenu } from "../../components/Popover";
import { IconButton } from "../../components/IconButton";
import { Segmented } from "../../components/Segmented";
import { api } from "../../lib/api";
import type { DocumentDetail } from "../../lib/types";

/** The overlap-bands toggle: hover explains below (header-nav style), click toggles. */
function BandsToggle({ showBands, onToggle }: { showBands: boolean; onToggle: () => void }) {
  const menu = useHoverMenu(150, 250);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={onToggle}
        {...menu.hover}
        className="border border-line px-2 py-1 font-mono text-[10px] transition-colors hover:border-foreground/50"
      >
        {showBands ? "hide bands" : "show bands"}
      </button>
      <HintCard
        anchorRef={triggerRef}
        menu={menu}
        placement="below"
        text="Shade the text by how many chunks cover it. A darker band is text that appears in two chunks at once — the overlap window, which exists so an answer spanning a boundary is still retrievable."
      />
    </>
  );
}

/**
 * Draws chunk boundaries directly over the source text.
 *
 * This is the fastest way to build intuition about chunking: overlap that is too large,
 * a splitter cutting mid-sentence, or a table shredded across three chunks are all
 * obvious the moment they are visible, and nearly undetectable when they are not.
 *
 * Hover state is tracked per CHUNK, not per text segment. Overlap cuts every chunk
 * into up to three segments, and the earlier per-segment hover flipped highlight and
 * readout at each cut — the flicker. A hovered overlap segment now keeps the chunk
 * you came from, so the highlight is stable across a whole chunk, and clicking pins
 * a chunk so the readout survives the mouse leaving.
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
  const [pinned, setPinned] = useState<number | null>(null);
  const [view, setView] = useState<"chunks" | "structure" | "raw">("chunks");
  const [showBands, setShowBands] = useState(true);
  const markRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDoc(null);
    setError(null);
    setPinned(null);
    setHovered(null);
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

  /** The chunk whose info the readout shows: pinned wins, hover fills in. */
  const focusOrdinal = pinned ?? hovered;
  const focusChunk = doc?.chunks.find((c) => c.ordinal === focusOrdinal) ?? null;
  // Ordinals are stored 0-based; people count chunks from 1, and the header
  // says "N chunks" — so every displayed chunk number is 1-based.
  const focusNo = focusChunk ? focusChunk.ordinal + 1 : null;

  /** Stable hover: entering an overlap segment keeps the chunk we came from. */
  const hoverSegment = (covering: { ordinal: number }[]) => {
    setHovered((prev) => {
      if (prev !== null && covering.some((c) => c.ordinal === prev)) return prev;
      return covering[0]?.ordinal ?? null;
    });
  };

  const scrollToChunk = (ordinal: number) => {
    const el = textRef.current?.querySelector(`[data-chunk-first="${ordinal}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 truncate font-display text-[13px] tracking-wide">
            <FileTextIcon size={14} className="shrink-0 text-subtle" />
            {doc?.filename ?? "Loading…"}
          </div>
          {stats ? (
            <div className="tabular font-mono text-[10px] text-subtle">
              {stats.chunks} chunks · {stats.chars.toLocaleString()} chars ·{" "}
              {stats.overlapPct.toFixed(1)}% overlapped
              {doc && doc.blocks.length > 0 ? ` · ${doc.blocks.length} blocks` : ""}
              {doc && typeof doc.meta.parser === "string" ? ` · ${doc.meta.parser}` : ""}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {view === "chunks" ? (
            <BandsToggle showBands={showBands} onToggle={() => setShowBands((v) => !v)} />
          ) : null}
          <Segmented
            hintFlyout="below"
            value={view}
            onChange={setView}
            options={[
              {
                value: "chunks",
                label: "chunks",
                icon: SquaresFourIcon,
                hint: "The document with its chunk boundaries drawn over the text."
              },
              {
                value: "structure",
                label: "structure",
                icon: TreeStructureIcon,
                hint: "The typed structure the parser recovered — headings, paragraphs, tables — before any chunking. This is what the structural chunker cuts along and what breadcrumb contexts are built from."
              },
              {
                value: "raw",
                label: "raw",
                icon: FileTextIcon,
                hint: "The parsed text exactly as it was extracted from the file, with nothing drawn over it."
              }
            ]}
          />
          {onClose ? (
            <IconButton label="Close document" onClick={onClose}>
              <XIcon size={12} />
            </IconButton>
          ) : null}
        </div>
      </div>

      {error ? <p className="p-4 font-mono text-[11px] text-critical">{error}</p> : null}

      {view === "chunks" && doc ? (
        <>
          {/* ── Chunk sizes at a glance: one thin bar per chunk ── */}
          <div className="border-b border-line px-4 py-2.5">
            <div className="mb-1 flex items-center gap-1.5 font-display text-[9px] tracking-[0.16em] text-subtle uppercase">
              <ChartBarIcon size={11} />
              Chunk sizes
              <span className="tabular ml-auto font-mono text-[9px] normal-case">
                {focusChunk
                  ? `chunk ${focusNo} of ${doc.chunks.length} · ${focusChunk.span[1] - focusChunk.span[0]} chars`
                  : "hover or click a bar to locate a chunk"}
              </span>
            </div>
            <div className="flex h-8 items-end gap-[2px]">
              {doc.chunks.map((chunk) => {
                const size = chunk.span[1] - chunk.span[0];
                const max = Math.max(...doc.chunks.map((c) => c.span[1] - c.span[0]), 1);
                const active = focusOrdinal === chunk.ordinal;
                return (
                  <button
                    key={chunk.id}
                    onMouseEnter={() => setHovered(chunk.ordinal)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => {
                      setPinned((p) => (p === chunk.ordinal ? null : chunk.ordinal));
                      scrollToChunk(chunk.ordinal);
                    }}
                    aria-label={`Chunk ${chunk.ordinal + 1}, ${size} characters`}
                    className="min-w-[3px] flex-1 transition-colors"
                    style={{
                      height: `${Math.max(12, (100 * size) / max)}%`,
                      maxWidth: 18,
                      background: active
                        ? "rgb(var(--foreground))"
                        : "rgb(var(--foreground) / 0.25)"
                    }}
                  />
                );
              })}
            </div>
          </div>

          {/* ── Stable readout: chunk-level, pinned on click ── */}
          <div className="border-b border-line px-4 py-2">
            <p className="tabular font-mono text-[10px]">
              {focusChunk ? (
                <>
                  <span className={pinned !== null ? "text-foreground" : "text-muted"}>
                    chunk {focusNo}
                  </span>
                  <span className="text-subtle">
                    {" "}
                    · chars {focusChunk.span[0]}–{focusChunk.span[1]} ·{" "}
                    {focusChunk.span[1] - focusChunk.span[0]} chars
                    {focusChunk.page != null ? ` · page ${focusChunk.page}` : ""}
                    {pinned !== null ? " · pinned — click again to release" : ""}
                  </span>
                  {focusChunk.context ? (
                    <span
                      data-hint="Contextual retrieval: this preamble is prepended to the chunk when it is embedded and keyword-indexed. It is never part of the stored text — spans and citations are untouched."
                      className="hint mt-0.5 block truncate text-subtle italic"
                    >
                      indexed as: “{focusChunk.context}”
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-subtle">
                  hover the text to trace a chunk · click to pin it · darker bands are
                  the overlap window shared by two chunks
                </span>
              )}
            </p>
          </div>

          <div
            ref={textRef}
            className="flex-1 overflow-auto p-4 font-mono text-[12px] leading-[1.85] whitespace-pre-wrap"
          >
            {segments.map((segment, i) => {
              const depth = segment.covering.length;
              const isFocus =
                focusOrdinal !== null &&
                segment.covering.some((c) => c.ordinal === focusOrdinal);
              const isCited =
                highlight &&
                segment.start >= highlight.span[0] &&
                segment.end <= highlight.span[1];
              // The first segment of each chunk carries an anchor for scroll-to.
              const firstOf = segment.covering.find((c) => c.span[0] === segment.start);

              return (
                <span
                  key={i}
                  ref={isCited && !markRef.current ? markRef : undefined}
                  data-chunk-first={firstOf?.ordinal}
                  onMouseEnter={() => hoverSegment(segment.covering)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => {
                    const ordinal = segment.covering[0]?.ordinal;
                    if (ordinal === undefined) return;
                    setPinned((p) => (p === ordinal ? null : ordinal));
                  }}
                  className={[
                    "transition-colors",
                    depth > 0 ? "cursor-pointer" : "",
                    isCited ? "bg-foreground text-background" : "",
                    !isCited && isFocus ? "bg-foreground/20" : "",
                    // Overlap depth reads as tone: the darker the band, the more chunks
                    // contain that text. Two-deep regions are the overlap window itself.
                    !isCited && !isFocus && showBands && depth > 1 ? "bg-foreground/12" : "",
                    !isCited && !isFocus && showBands && depth === 1 ? "bg-foreground/4" : "",
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
        </>
      ) : null}

      {view === "structure" && doc ? (
        doc.blocks.length > 0 ? (
          <>
            <div className="border-b border-line px-4 py-2">
              <p className="text-[11px] leading-relaxed text-subtle">
                What the parser inferred from the file's geometry: headings sized by
                level, tables boxed, paragraphs plain. The structural chunker cuts
                along these boundaries, and breadcrumb contexts are these headings,
                joined. A table shredded here was shredded at parse time — no
                retrieval setting downstream can reassemble it.
              </p>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {doc.blocks.map((block, i) => {
                const text = doc.text.slice(block.span[0], block.span[1]);
                const meta = [
                  block.kind + (block.kind === "heading" ? ` ${block.level}` : ""),
                  block.page != null ? `p.${block.page}` : null,
                  `${block.span[0]}–${block.span[1]}`
                ]
                  .filter(Boolean)
                  .join(" · ");

                return (
                  <div key={i} className="group mb-3 flex gap-3">
                    <span className="tabular w-28 shrink-0 pt-0.5 text-right font-mono text-[9px] text-subtle opacity-60 transition-opacity group-hover:opacity-100">
                      {meta}
                    </span>
                    {block.kind === "heading" ? (
                      <h4
                        className={[
                          "min-w-0 font-display tracking-wide",
                          block.level <= 1
                            ? "text-[15px]"
                            : block.level === 2
                              ? "text-[13px]"
                              : "text-[12px] text-muted"
                        ].join(" ")}
                      >
                        {text}
                      </h4>
                    ) : block.kind === "table" ? (
                      <div className="min-w-0 overflow-x-auto border border-line bg-foreground/3 px-3 py-2">
                        <pre className="font-mono text-[11px] leading-[1.7] whitespace-pre">
                          {text}
                        </pre>
                      </div>
                    ) : (
                      <p className="min-w-0 font-mono text-[11.5px] leading-[1.8] whitespace-pre-wrap text-muted">
                        {text}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="p-4">
            <p className="text-[12px] leading-relaxed text-muted">
              The parser found no structure in this document — no headings, tables or
              paragraph blocks to draw. Plain text files and PDFs ingested before the
              structural parser existed both land here; re-uploading a PDF under the
              primitives backend will populate this view.
            </p>
          </div>
        )
      ) : null}

      {view === "raw" && doc ? (
        <>
          <div className="border-b border-line px-4 py-2">
            <p className="text-[11px] leading-relaxed text-subtle">
              The parsed text, exactly as extracted from the file — what chunking,
              indexing and retrieval all start from. If something looks wrong here, no
              retrieval setting downstream can fix it.
            </p>
          </div>
          <div className="flex-1 overflow-auto p-4 font-mono text-[12px] leading-[1.85] whitespace-pre-wrap select-text">
            {doc.text}
          </div>
        </>
      ) : null}
    </div>
  );
}
