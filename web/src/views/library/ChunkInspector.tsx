import {
  ChartBarIcon,
  ClockIcon,
  CubeIcon,
  FileMagnifyingGlassIcon,
  FileTextIcon,
  IntersectIcon,
  ScissorsIcon,
  SquaresFourIcon,
  TextIndentIcon,
  TextTIcon,
  TreeStructureIcon,
  XIcon,
  type Icon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HintCard, useHoverMenu } from "../../components/Popover";
import { IconButton } from "../../components/IconButton";
import { Segmented } from "../../components/Segmented";
import { api } from "../../lib/api";
import type { DocumentDetail } from "../../lib/types";

/** The overlap-bands toggle: hover explains below (header-nav style), click toggles. */
function BandsToggle({ showBands, onToggle }: { showBands: boolean; onToggle: () => void }) {
  const menu = useHoverMenu(150);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        onClick={onToggle}
        {...menu.hover}
        className="border border-line px-2 py-1 font-mono text-meta transition-colors hover:border-foreground/50"
      >
        {showBands ? "hide bands" : "show bands"}
      </button>
      <HintCard
        anchorRef={triggerRef}
        menu={menu}
        placement="below"
        text="Shade the text by how many chunks cover it. A darker band is text that appears in two chunks at once: the overlap window, which exists so an answer spanning a boundary is still retrievable."
      />
    </>
  );
}

/** How each non-PDF format is extracted: fixed per format, not a backend choice. */
const FORMAT_EXTRACTORS: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  docx: "docx",
  txt: "plain text",
  csv: "plain text"
};

function MetaCell({
  icon: CellIcon,
  label,
  value,
  wide = false
}: {
  icon: Icon;
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <div className="flex items-center gap-1 menu-label">
        <CellIcon size={14} aria-hidden />
        {label}
      </div>
      <div className="tabular mt-0.5 truncate font-mono text-meta" title={value}>
        {value}
      </div>
    </div>
  );
}

/**
 * The document's vital signs: parse-level stats plus what its chunks and vectors
 * were actually built with: the settings stamped at ingest (and re-stamped on
 * re-index), not whatever the config currently says. Documents indexed before
 * stamping existed show only their stats and ingestion time.
 */
function MetaGrid({
  doc,
  stats
}: {
  doc: DocumentDetail;
  stats: { chunks: number; chars: number; overlapPct: number } | null;
}) {
  const meta = doc.meta;
  const str = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : null);
  const num = (key: string) => (typeof meta[key] === "number" ? (meta[key] as number) : null);

  const cells: { icon: Icon; label: string; value: string; wide?: boolean }[] = [];
  if (stats) {
    cells.push(
      { icon: TextTIcon, label: "chars", value: stats.chars.toLocaleString() },
      { icon: IntersectIcon, label: "overlap", value: `${stats.overlapPct.toFixed(1)}%` }
    );
  }
  if (doc.blocks.length > 0) {
    cells.push({ icon: TreeStructureIcon, label: "blocks", value: String(doc.blocks.length) });
  }
  // The parser backend knob applies to PDFs only; every other format has one fixed
  // extraction path, and naming it here is more honest than leaving the cell blank
  // (or worse, echoing a PDF backend the file never went through).
  const extractor = str("parser") ?? FORMAT_EXTRACTORS[str("format") ?? ""] ?? null;
  if (extractor) {
    cells.push({ icon: FileMagnifyingGlassIcon, label: "parser", value: extractor });
  }
  const chunker = str("chunker");
  if (chunker && num("chunk_size") !== null) {
    cells.push({
      icon: ScissorsIcon,
      label: "chunker",
      value: `${chunker} ${num("chunk_size")}/${num("chunk_overlap") ?? 0} tok`,
      wide: true
    });
  }
  const contextMode = str("context_mode");
  if (contextMode) cells.push({ icon: TextIndentIcon, label: "context", value: contextMode });
  const embedder = str("embedder");
  if (embedder) cells.push({ icon: CubeIcon, label: "embedding", value: embedder, wide: true });
  if (doc.created_at !== null) {
    cells.push({
      icon: ClockIcon,
      label: "ingested",
      value: new Date(doc.created_at * 1000).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      })
    });
  }

  if (cells.length === 0) return null;
  return (
    <div className="mt-2.5 grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-x-4 gap-y-2">
      {cells.map((cell) => (
        <MetaCell key={cell.label} {...cell} />
      ))}
    </div>
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
 * readout at each cut, which was the flicker. A hovered overlap segment now keeps the chunk
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
  const [scrollOrdinal, setScrollOrdinal] = useState(0);
  const markRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const scrollTick = useRef(false);

  useEffect(() => {
    setDoc(null);
    setError(null);
    setPinned(null);
    setHovered(null);
    setScrollOrdinal(0);
    if (textRef.current) textRef.current.scrollTop = 0;
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
   * each of which knows how many chunks cover it, which is exactly what makes the
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
  // says "N chunks", so every displayed chunk number is 1-based.
  const focusNo = focusChunk ? focusChunk.ordinal + 1 : null;

  /** Stable hover: entering an overlap segment keeps the chunk we came from. */
  const hoverSegment = (covering: { ordinal: number }[]) => {
    setHovered((prev) => {
      if (prev !== null && covering.some((c) => c.ordinal === prev)) return prev;
      return covering[0]?.ordinal ?? null;
    });
  };

  /** Centre a chunk's rendered region (not just its first character) in the view. */
  const scrollToChunk = (ordinal: number) => {
    const el = textRef.current;
    if (!el) return;
    const anchors = [...el.querySelectorAll<HTMLElement>("[data-chunk-first]")];
    const index = anchors.findIndex((a) => Number(a.dataset.chunkFirst) === ordinal);
    if (index < 0) return;
    const elTop = el.getBoundingClientRect().top;
    const contentY = (anchor: HTMLElement) =>
      anchor.getBoundingClientRect().top - elTop + el.scrollTop;
    const start = contentY(anchors[index]);
    const end = index + 1 < anchors.length ? contentY(anchors[index + 1]) : el.scrollHeight;
    el.scrollTo({ top: (start + end) / 2 - el.clientHeight / 2, behavior: "smooth" });
  };

  /**
   * Where the reader is, as a chunk, measured from the rendered layout, not
   * estimated from character counts (wrapping makes rendered height per char
   * uneven, which drifted the indicator off small chunks). The current chunk is
   * the one whose region contains the viewport's centre line, the same line
   * `scrollToChunk` centres on, so clicking a bar lands the indicator under that
   * bar. The scroll extremes are pinned: at the very top the reader is at chunk
   * one, at the very bottom the last chunk, whatever happens to sit at centre.
   */
  const updateScrollOrdinal = useCallback(() => {
    const el = textRef.current;
    if (!el || !doc || doc.chunks.length === 0) return;
    const range = el.scrollHeight - el.clientHeight;
    if (range <= 0 || el.scrollTop <= 1) {
      setScrollOrdinal(0);
      return;
    }
    if (el.scrollTop >= range - 1) {
      setScrollOrdinal(doc.chunks[doc.chunks.length - 1].ordinal);
      return;
    }
    const centerY = el.getBoundingClientRect().top + el.clientHeight / 2;
    let current = 0;
    el.querySelectorAll<HTMLElement>("[data-chunk-first]").forEach((anchor) => {
      if (anchor.getBoundingClientRect().top <= centerY) {
        current = Number(anchor.dataset.chunkFirst);
      }
    });
    setScrollOrdinal(current);
  }, [doc]);

  /** Coalesce scroll events to one measurement per frame. */
  const onTextScroll = () => {
    if (scrollTick.current) return;
    scrollTick.current = true;
    requestAnimationFrame(() => {
      scrollTick.current = false;
      updateScrollOrdinal();
    });
  };

  // A fresh document (or returning to the chunks view) needs one measurement
  // before any scroll happens.
  useEffect(() => {
    if (view === "chunks") updateScrollOrdinal();
  }, [view, updateScrollOrdinal]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-4 py-3">
        {/* Title and actions share one row; the metadata grid gets the full width below. */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5 truncate font-display text-body tracking-wide">
            <FileTextIcon size={16} className="shrink-0 text-subtle" />
            {doc?.filename ?? "Loading…"}
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
                hint: "The typed structure the parser recovered (headings, paragraphs, tables) before any chunking. This is what the structural chunker cuts along and what breadcrumb contexts are built from."
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
                <XIcon size={14} />
              </IconButton>
            ) : null}
          </div>
        </div>
        {doc ? <MetaGrid doc={doc} stats={stats} /> : null}
      </div>

      {error ? <p className="p-4 font-mono text-ui text-critical">{error}</p> : null}

      {view === "chunks" && doc ? (
        <>
          {/* ── Chunk sizes at a glance: one thin bar per chunk ── */}
          <div className="border-b border-line px-4 py-2.5">
            <div className="mb-1 flex items-center gap-1.5 menu-label">
              <ChartBarIcon size={14} />
              Chunk sizes
              <span className="tabular ml-auto font-mono text-label normal-case">
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
            {/* ── Reading position: an underline tracking the scroll, cell-aligned
                with the bars above so it always sits under the current chunk ── */}
            <div aria-hidden className="mt-[3px] flex gap-[2px]">
              {doc.chunks.map((chunk) => (
                <div
                  key={chunk.id}
                  className="h-[2px] min-w-[3px] flex-1 transition-colors duration-150"
                  style={{
                    maxWidth: 18,
                    background:
                      chunk.ordinal === scrollOrdinal
                        ? "rgb(var(--foreground))"
                        : "rgb(var(--foreground) / 0.08)"
                  }}
                />
              ))}
            </div>
          </div>

          {/* ── Stable readout: chunk-level, pinned on click ── */}
          <div className="border-b border-line px-4 py-2">
            <p className="tabular font-mono text-meta">
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
                    {pinned !== null ? " · pinned, click again to release" : ""}
                  </span>
                  {focusChunk.context ? (
                    <span
                      data-hint="Contextual retrieval: this preamble is prepended to the chunk when it is embedded and keyword-indexed. It is never part of the stored text, so spans and citations are untouched."
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
            onScroll={onTextScroll}
            className="flex-1 overflow-auto p-4 font-mono text-body leading-[1.85] whitespace-pre-wrap"
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
              <p className="text-ui leading-relaxed text-subtle">
                What the parser inferred from the file's geometry: headings sized by
                level, tables boxed, paragraphs plain. The structural chunker cuts
                along these boundaries, and breadcrumb contexts are these headings,
                joined. A table shredded here was shredded at parse time, and no
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
                    <span className="tabular w-28 shrink-0 pt-0.5 text-right font-mono text-label text-subtle opacity-60 transition-opacity group-hover:opacity-100">
                      {meta}
                    </span>
                    {block.kind === "heading" ? (
                      <h4
                        className={[
                          "min-w-0 font-display tracking-wide",
                          block.level <= 1
                            ? "text-lead"
                            : block.level === 2
                              ? "text-body"
                              : "text-body text-muted"
                        ].join(" ")}
                      >
                        {text}
                      </h4>
                    ) : block.kind === "table" ? (
                      <div className="min-w-0 overflow-x-auto border border-line bg-foreground/3 px-3 py-2">
                        <pre className="font-mono text-ui leading-[1.7] whitespace-pre">
                          {text}
                        </pre>
                      </div>
                    ) : (
                      <p className="min-w-0 font-mono text-ui leading-[1.8] whitespace-pre-wrap text-muted">
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
            <p className="text-body leading-relaxed text-muted">
              The parser found no structure in this document: no headings, tables or
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
            <p className="text-ui leading-relaxed text-subtle">
              The parsed text, exactly as extracted from the file, what chunking,
              indexing and retrieval all start from. If something looks wrong here, no
              retrieval setting downstream can fix it.
            </p>
          </div>
          <div className="flex-1 overflow-auto p-4 font-mono text-body leading-[1.85] whitespace-pre-wrap select-text">
            {doc.text}
          </div>
        </>
      ) : null}
    </div>
  );
}
