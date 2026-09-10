import { useState, type ReactNode } from "react";

/**
 * The chart kit: the small set of marks every data section in the app is built
 * from. Hand-rolled rather than a charting library so the hairline-and-square
 * treatment stays exact, and so every mark obeys the same rules:
 *
 *   · thin marks, square ends, 2px surface gaps between touching fills
 *   · colour only where it carries identity, always beside a visible label
 *   · numbers in tabular mono; grid and axes recessive
 *   · every mark hoverable, with the value readable without colour
 */

/* ── Stat tile ────────────────────────────────────────────────────────────── */

export function StatTile({
  icon,
  label,
  value,
  sub,
  hint,
  spark,
  sparkColor
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  sub?: string;
  hint?: string;
  /** Oldest → newest; drawn as a baseline-anchored spark of thin bars. */
  spark?: number[];
  sparkColor?: string;
}) {
  return (
    <div
      data-hint={hint}
      className={`${hint ? "hint hint-block hover:border-foreground/50" : ""} relative flex min-w-0 flex-col border border-line px-3 py-2.5 transition-colors`}
    >
      <div className="flex items-center gap-1.5 menu-label">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 flex flex-1 items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="tabular font-display text-[20px] leading-none tracking-wide">
            {value}
          </div>
          {sub ? (
            <div className="tabular mt-1 truncate font-mono text-label text-subtle">{sub}</div>
          ) : null}
        </div>
        {spark && spark.length > 1 ? <SparkBars values={spark} color={sparkColor} /> : null}
      </div>
    </div>
  );
}

/** Baseline-anchored thin bars, oldest left. Pure shape: the tile's value and
 *  sub-line carry the numbers, so the spark needs no axis and no tooltip. */
export function SparkBars({ values, color }: { values: number[]; color?: string }) {
  const max = Math.max(...values, 1e-9);
  return (
    <div className="flex h-7 shrink-0 items-end gap-[2px]" aria-hidden>
      {values.slice(-16).map((v, i) => (
        <span
          key={i}
          className="w-[4px]"
          style={{
            height: `${Math.max(8, (100 * v) / max)}%`,
            background: color ?? "rgb(var(--foreground) / 0.55)"
          }}
        />
      ))}
    </div>
  );
}

/* ── Horizontal meter row ─────────────────────────────────────────────────── */

/** One labelled horizontal bar: identity on the left, magnitude as length,
 *  the exact value on the right. The workhorse for comparisons and shares. */
export function MeterRow({
  label,
  value,
  fraction,
  color,
  hint,
  labelWidth = "8rem",
  swatch = true
}: {
  label: ReactNode;
  value: string;
  /** 0–1 share of the longest bar in the group. */
  fraction: number;
  color?: string;
  hint?: string;
  labelWidth?: string;
  swatch?: boolean;
}) {
  const fill = color ?? "rgb(var(--foreground) / 0.6)";
  return (
    <div
      data-hint={hint}
      className={`${hint ? "hint" : ""} relative flex items-center gap-2.5 py-[3px]`}
    >
      <div
        className="flex shrink-0 items-center gap-1.5 truncate text-meta text-muted"
        style={{ width: labelWidth }}
      >
        {swatch && color ? (
          <span className="h-2 w-2 shrink-0" style={{ background: color }} aria-hidden />
        ) : null}
        <span className="truncate">{label}</span>
      </div>
      <div className="h-[6px] flex-1 bg-foreground/8">
        <div
          className="h-full transition-[width] duration-300"
          style={{ width: `${Math.max(0.5, 100 * Math.min(1, fraction))}%`, background: fill }}
        />
      </div>
      <div className="tabular w-16 shrink-0 text-right font-mono text-ui text-foreground">{value}</div>
    </div>
  );
}

/* ── Segmented (stacked) bar ──────────────────────────────────────────────── */

export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** One horizontal 100% bar whose segments share the total, separated by 2px of
 *  surface. Hover a segment for its label and value; pair with a legend. */
export function SegmentBar({
  segments,
  height = 8,
  format,
  readout = true
}: {
  segments: Segment[];
  height?: number;
  format: (value: number) => string;
  /** false renders the bar alone (dense tables); hover falls back to a title. */
  readout?: boolean;
}) {
  const [active, setActive] = useState<string | null>(null);
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return null;
  const shown = segments.filter((s) => s.value > 0);
  const current = shown.find((s) => s.key === active) ?? null;

  return (
    <div>
      <div className="flex w-full gap-[2px]" style={{ height }}>
        {shown.map((s) => (
          <div
            key={s.key}
            onMouseEnter={() => setActive(s.key)}
            onMouseLeave={() => setActive(null)}
            title={readout ? undefined : `${s.label} · ${format(s.value)}`}
            className="min-w-[3px] transition-opacity"
            style={{
              width: `${(100 * s.value) / total}%`,
              background: s.color,
              opacity: active !== null && active !== s.key ? 0.3 : 1
            }}
          />
        ))}
      </div>
      {readout ? (
        <div className="tabular mt-1 h-[14px] font-mono text-label text-subtle">
          {current
            ? `${current.label} · ${format(current.value)} · ${((100 * current.value) / total).toFixed(0)}%`
            : ""}
        </div>
      ) : null}
    </div>
  );
}

/* ── Column chart ─────────────────────────────────────────────────────────── */

export interface Column {
  key: string;
  /** Shown in the tooltip line and under the axis (sparingly). */
  label: string;
  segments: Segment[];
}

/**
 * Vertical bars, oldest left, optionally stacked. Grid stays recessive (three
 * hairlines), the y-scale is announced once at the top-left, and hovering a
 * column pins its breakdown into the readout line below the plot. A readout
 * line rather than a floating tooltip, so it never occludes the marks.
 */
export function ColumnChart({
  columns,
  height = 96,
  format,
  emptyLabel = "no data yet"
}: {
  columns: Column[];
  height?: number;
  format: (value: number) => string;
  emptyLabel?: string;
}) {
  const [active, setActive] = useState<string | null>(null);

  const totals = columns.map((c) => c.segments.reduce((s, x) => s + x.value, 0));
  const max = Math.max(...totals, 1e-9);
  if (columns.length === 0) {
    return <p className="py-6 text-center font-mono text-meta text-subtle">{emptyLabel}</p>;
  }

  const current = columns.find((c) => c.key === active) ?? null;
  const currentTotal = current ? current.segments.reduce((s, x) => s + x.value, 0) : 0;

  return (
    <div>
      <div className="tabular mb-1 font-mono text-label text-subtle">↑ {format(max)}</div>
      <div className="relative" style={{ height }}>
        {/* Recessive grid: quarter lines only. */}
        {[0.25, 0.5, 0.75].map((f) => (
          <div
            key={f}
            className="absolute inset-x-0 border-t border-line/50"
            style={{ top: `${100 * f}%` }}
            aria-hidden
          />
        ))}
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {columns.map((c, i) => {
            const total = totals[i];
            const dimmed = active !== null && active !== c.key;
            return (
              <div
                key={c.key}
                onMouseEnter={() => setActive(c.key)}
                onMouseLeave={() => setActive(null)}
                className="flex h-full max-w-7 flex-1 items-end"
              >
                <div
                  className="flex w-full flex-col-reverse gap-[2px] transition-opacity"
                  style={{ height: `${Math.max(2, (100 * total) / max)}%`, opacity: dimmed ? 0.3 : 1 }}
                >
                  {c.segments
                    .filter((s) => s.value > 0)
                    .map((s) => (
                      <div
                        key={s.key}
                        className="w-full"
                        style={{
                          flexGrow: s.value,
                          flexBasis: 0,
                          minHeight: 1,
                          background: s.color
                        }}
                      />
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1 border-t border-line pt-1">
        <div className="tabular h-[14px] truncate font-mono text-label text-subtle">
          {current
            ? `${current.label} · ${format(currentTotal)}` +
              (current.segments.filter((s) => s.value > 0).length > 1
                ? ` (${current.segments
                    .filter((s) => s.value > 0)
                    .map((s) => `${s.label} ${format(s.value)}`)
                    .join(" · ")})`
                : "")
            : "hover a bar"}
        </div>
      </div>
    </div>
  );
}

/* ── Legend ───────────────────────────────────────────────────────────────── */

export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5 text-label text-subtle">
          <span className="h-2 w-2" style={{ background: item.color }} aria-hidden />
          {item.label}
        </span>
      ))}
    </div>
  );
}
