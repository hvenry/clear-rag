import {
  GitMergeIcon,
  GraphIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  SortAscendingIcon,
  SparkleIcon,
  StackSimpleIcon,
  type Icon
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import {
  formatMs,
  SPEED_CLASS,
  SPEED_HINT,
  speedOf,
  stageColor,
  stageInfo
} from "../../lib/stages";
import { STAGE_TOPIC } from "../../lib/topics";
import type { StageRecord } from "../../lib/types";
import { Loader } from "../Loader";

const STAGE_ICON: Record<string, Icon> = {
  transform: PencilSimpleIcon,
  bm25: MagnifyingGlassIcon,
  dense: GraphIcon,
  fuse: GitMergeIcon,
  rerank: SortAscendingIcon,
  assemble: StackSimpleIcon,
  generate: SparkleIcon
};

/**
 * The live pipeline readout: each stage appears as its event arrives, so retrieval is
 * watched rather than waited on.
 *
 * Every chip explains itself on hover, and its duration is coloured only when slow
 * enough to be worth noticing, so a 32-second generate stage is visible at a glance
 * without painting the whole strip.
 */
export function StageStrip({
  stages,
  streaming,
  onExplain
}: {
  stages: StageRecord[];
  streaming: boolean;
  onExplain?: (stageName: string) => void;
}) {
  const total = stages.reduce((sum, s) => sum + s.duration_ms, 0);

  return (
    <div>
      <div className="flex flex-wrap items-stretch gap-1.5">
        {stages.map((stage) => (
          <StageChip key={stage.name} stage={stage} total={total} onExplain={onExplain} />
        ))}
        {streaming ? (
          <div className="glass flex items-center px-3 py-1.5">
            <Loader />
          </div>
        ) : null}
      </div>
      {/* Where the time went, annotated like a trace inspector: one bar for the
          whole query, and a leader line dropping from each slice to a row that
          states its stage, duration and share, no hover required. */}
      {!streaming && stages.length >= 2 && total > 0 ? (
        <div className="mt-1.5">
          <StageTimeline stages={stages} total={total} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The share bar with callout rows. Rows are ordered right-to-left, top-to-bottom
 * (last stage first): a drop line then only ever passes through the empty space
 * left of the labels below it, so lines never cross text no matter how the
 * durations are distributed. Labels for slices past ~55% flip to sit left of
 * their line so they cannot run off the panel's right edge.
 */
function StageTimeline({ stages, total }: { stages: StageRecord[]; total: number }) {
  const ROW = 17;

  // Slice widths sit on a square-root scale, not a linear one. Generate wins
  // every query by an order of magnitude, and drawn linearly it flattens the
  // retrieval stages into indistinguishable slivers with their drop lines piled
  // on top of each other. √ compresses the giant and expands the small while
  // preserving order; the printed durations and shares stay linear truth, and
  // the caption under the rows declares the scale.
  const weights = stages.map((s) => Math.sqrt(s.duration_ms));
  const weightTotal = weights.reduce((sum, w) => sum + w, 0);

  let acc = 0;
  const segments = stages.map((stage, i) => {
    const start = acc;
    acc += weights[i];
    return { ...stage, start, weight: weights[i] };
  });
  const rows = [...segments].reverse();

  const shareOf = (ms: number) => {
    const share = (100 * ms) / total;
    return share > 0 && share < 1 ? "<1%" : `${share.toFixed(0)}%`;
  };

  if (weightTotal <= 0) return null;

  return (
    <div>
      <div className="flex h-[5px] w-full gap-[2px]">
        {segments
          .filter((s) => s.weight > 0)
          .map((s) => (
            <div
              key={s.name}
              className="min-w-[3px]"
              style={{
                width: `${(100 * s.weight) / weightTotal}%`,
                background: stageColor(s.name)
              }}
            />
          ))}
      </div>

      <div className="relative" style={{ height: rows.length * ROW + 3 }}>
        {rows.map((s, i) => {
          const x = Math.min(99, (100 * s.start) / weightTotal);
          const flip = x > 55;
          return (
            <div key={s.name}>
              <div
                className="absolute w-px"
                style={{
                  left: `${x}%`,
                  top: 0,
                  height: i * ROW + ROW / 2 + 3,
                  background: stageColor(s.name),
                  opacity: 0.55
                }}
              />
              <div
                className="tabular absolute flex items-center gap-1.5 font-mono text-label whitespace-nowrap"
                style={{
                  top: i * ROW + 3,
                  height: ROW,
                  ...(flip
                    ? { right: `calc(${100 - x}% + 5px)` }
                    : { left: `calc(${x}% + 5px)` })
                }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0"
                  style={{ background: stageColor(s.name) }}
                  aria-hidden
                />
                <span className="text-muted">{s.label}</span>
                <span>{s.duration_ms > 0 ? formatMs(s.duration_ms) : "skipped"}</span>
                {s.duration_ms > 0 ? (
                  <span className="text-subtle">{shareOf(s.duration_ms)}</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-0.5 text-right font-mono text-label text-subtle">
        bar widths √-scaled for legibility; times and shares are real
      </p>
    </div>
  );
}

function StageChip({
  stage,
  total,
  onExplain
}: {
  stage: StageRecord;
  total: number;
  onExplain?: (stageName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const info = stageInfo(stage.name);
  const speed = speedOf(stage.duration_ms);
  const share = total > 0 ? (100 * stage.duration_ms) / total : 0;
  const color = stageColor(stage.name);

  const clearTimers = () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  // The detail card opens on hover: instantly, no separate hover hint, no click
  // required. A grace period on leave lets the pointer cross the 6px gap between
  // the chip and the card without the card snapping shut. Touch has no hover, so
  // there the click toggles and the backdrop closes.
  const hoverOpen = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimers();
    setOpen(true);
  };
  // A 0ms timer, not a direct close: the card hangs below the wrapper's box, so
  // chip → card briefly reads as leave-then-enter, and the timer lets the enter
  // cancel the close within the same event turn.
  const hoverClose = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), 0);
  };

  return (
    <div className="relative" onPointerEnter={hoverOpen} onPointerLeave={hoverClose}>
      <button
        onClick={() =>
          window.matchMedia("(hover: hover)").matches ? setOpen(true) : setOpen((v) => !v)
        }
        className={[
          "stage-enter glass flex cursor-default items-center gap-2 border-l-2 px-3 py-1.5 text-left transition-colors",
          stage.error ? "border-critical/50" : "hover:border-foreground/35",
          open ? "border-foreground/50" : ""
        ].join(" ")}
        style={{ borderLeftColor: stage.error ? undefined : color }}
      >
        <StageIcon name={stage.name} color={color} />
        <span className="font-display text-meta tracking-[0.12em] uppercase">
          {stage.label}
        </span>
        <span className={`tabular font-mono text-label ${SPEED_CLASS[speed]}`}>
          {formatMs(stage.duration_ms)}
        </span>
        {stage.candidates_out ? (
          <span className="tabular border-l border-line pl-2 font-mono text-label text-subtle">
            {stage.candidates_out.length}
          </span>
        ) : null}
        {stage.degraded ? (
          <span className="font-mono text-label text-slow">degraded</span>
        ) : null}
      </button>

      {open ? (
        <>
          {/* Tap-away backdrop for touch, where hover-out cannot close the card.
              With a mouse, leaving the chip or the card closes it, so no
              click-swallowing overlay is needed. */}
          <button
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default bg-background/50 lg:hidden"
          />
          {/* The visual gap under the chip is padding inside this wrapper, so the
              hover area is contiguous and the instant close cannot fire mid-gap. */}
          <div className="fixed inset-x-4 top-1/2 z-40 -translate-y-1/2 lg:absolute lg:inset-x-auto lg:top-full lg:left-0 lg:translate-y-0 lg:pt-1.5">
          <div className="glass-popover max-h-[70vh] overflow-auto p-3 text-ui lg:max-h-80 lg:w-[min(24rem,calc(100vw-2rem))]"
            style={{ borderTopColor: color, borderTopWidth: 2 }}
          >
          <p className="tabular mb-2 font-mono text-meta">
            {formatMs(stage.duration_ms)}
            <span className="text-subtle">
              {". "}{SPEED_HINT[speed]} {share.toFixed(0)}% of this query.
            </span>
          </p>
          <p className="mb-3 leading-relaxed text-muted">{info.what}</p>
          {info.timing ? (
            <p className="mb-3 leading-relaxed text-subtle">{info.timing}</p>
          ) : null}
          {stage.error ? (
            <p className="mb-3 border-l-2 border-critical pl-2 font-mono text-meta text-muted">
              {stage.error}
            </p>
          ) : null}
          <Rows title="Diagnostics" data={stage.diagnostics} />
          <Rows title="Settings used" data={stage.config} />
          {onExplain && STAGE_TOPIC[stage.name] ? (
            <button
              onClick={() => onExplain(stage.name)}
              className="mt-1 w-full border border-line px-2 py-1 text-left font-mono text-meta text-subtle transition-colors hover:border-foreground/50 hover:text-foreground"
            >
              why does this stage exist? →
            </button>
          ) : null}
          </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function StageIcon({ name, color }: { name: string; color?: string }) {
  const Icon = STAGE_ICON[name];
  if (!Icon) return null;
  return <Icon size={14} className="shrink-0" style={{ color }} aria-hidden />;
}

function Rows({ title, data }: { title: string; data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return null;

  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 menu-label">
        {title}
      </div>
      <dl className="space-y-1">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-start justify-between gap-3">
            <dt className="font-mono text-meta text-subtle">{key}</dt>
            <dd className="tabular max-w-[62%] text-right font-mono text-meta break-words">
              {format(value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function format(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 8 ? `[${value.length} items]` : JSON.stringify(value);
  }
  if (typeof value === "object" && value !== null) {
    const json = JSON.stringify(value);
    return json.length > 120 ? `${json.slice(0, 117)}…` : json;
  }
  return String(value);
}
