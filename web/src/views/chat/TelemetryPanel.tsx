import {
  CaretDownIcon,
  ChartBarIcon,
  ClockCountdownIcon,
  GaugeIcon,
  ListMagnifyingGlassIcon,
  QuotesIcon,
  TimerIcon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "../../lib/api";
import { formatMs, stageColor } from "../../lib/stages";
import type { TraceSummary } from "../../lib/types";
import { ChartLegend, ColumnChart, SegmentBar, StatTile, type Column } from "../../components/charts";

/**
 * The telemetry readout: every query this index has answered, as a dashboard.
 *
 * Collapsed it is one quiet summary line above the conversation; expanded it
 * sections into stat tiles, a stacked latency-by-stage chart, a TTFT chart, and
 * the query log. Data comes from /api/traces — the same traces the store already
 * persists — so history survives reloads and covers Lab runs too.
 */
export function TelemetryPanel({
  refreshKey,
  sessionId
}: {
  refreshKey: number;
  /** Scope the readout to one chat session's queries; omit for everything. */
  sessionId?: string;
}) {
  const [traces, setTraces] = useState<TraceSummary[] | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await api.traces(30, sessionId);
      // A server built before stage summaries existed sends bare rows; charts
      // degrade to totals-only rather than crashing the whole chat view.
      setTraces(rows.map((t) => ({ ...t, stages: t.stages ?? [] })));
    } catch {
      // Telemetry is a readout, not a feature the chat depends on; fail quiet.
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const stats = useMemo(() => {
    if (!traces || traces.length === 0) return null;
    const chrono = [...traces].reverse(); // oldest → newest, for sparks and charts
    const totals = chrono.map((t) => t.total_ms);
    const ttfts = chrono.map((t) => t.ttft_ms).filter((v): v is number => v != null);
    const rates = chrono
      .map((t) => t.tokens_per_second)
      .filter((v): v is number => v != null);

    return {
      chrono,
      count: traces.length,
      p50: quantile(totals, 0.5),
      p95: quantile(totals, 0.95),
      ttftP50: ttfts.length ? quantile(ttfts, 0.5) : null,
      rate: rates.length ? rates.reduce((s, v) => s + v, 0) / rates.length : null,
      totals,
      ttfts: chrono.map((t) => t.ttft_ms ?? 0)
    };
  }, [traces]);

  if (!stats) return null;

  const latencyColumns: Column[] = stats.chrono.map((t) => ({
    key: t.id,
    label: `“${truncate(t.query, 40)}”`,
    segments: t.stages.map((s) => ({
      key: s.name,
      label: s.label,
      value: s.duration_ms,
      color: stageColor(s.name)
    }))
  }));

  const ttftColumns: Column[] = stats.chrono
    .filter((t) => t.ttft_ms != null)
    .map((t) => ({
      key: t.id,
      label: `“${truncate(t.query, 40)}”`,
      segments: [
        { key: "ttft", label: "TTFT", value: t.ttft_ms ?? 0, color: "var(--color-cat-1)" }
      ]
    }));

  const stageNames = new Map<string, string>();
  stats.chrono.forEach((t) => t.stages.forEach((s) => stageNames.set(s.name, s.label)));

  return (
    <section className="border-b border-line">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-foreground/4 sm:px-5"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChartBarIcon size={13} weight="bold" className="shrink-0 text-subtle" />
          <span className="font-display text-[10px] tracking-[0.16em] uppercase">
            Telemetry
          </span>
          <span className="tabular hidden truncate font-mono text-[10px] text-subtle sm:inline">
            {stats.count} queries · p50 {formatMs(stats.p50)} · p95 {formatMs(stats.p95)}
            {stats.ttftP50 != null ? ` · ttft ${formatMs(stats.ttftP50)}` : ""}
          </span>
        </span>
        <CaretDownIcon
          size={12}
          className={`shrink-0 text-subtle transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div className="reveal space-y-4 border-t border-line px-3 pt-3 pb-4 sm:px-5">
          <p className="text-[11px] leading-relaxed text-subtle">
            Latency and throughput for every query this index has answered — including
            Lab runs. Traces persist in the store, so this history survives reloads.
          </p>

          {/* ── Stat tiles ── */}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <StatTile
              icon={<ListMagnifyingGlassIcon size={12} />}
              label="Queries traced"
              value={String(stats.count)}
              sub="newest 30 shown"
              spark={stats.totals}
              hint="How many answered queries the trace store currently holds, capped at the newest 30 for this readout."
            />
            <StatTile
              icon={<TimerIcon size={12} />}
              label="Total latency"
              value={formatMs(stats.p50)}
              sub={`p95 ${formatMs(stats.p95)}`}
              spark={stats.totals}
              hint="Median wall-clock time from question to last token. The spark is per query, oldest left."
            />
            <StatTile
              icon={<ClockCountdownIcon size={12} />}
              label="First token"
              value={stats.ttftP50 != null ? formatMs(stats.ttftP50) : "—"}
              sub="median TTFT"
              spark={stats.ttfts}
              sparkColor="var(--color-cat-1)"
              hint="Median time to first token — the model reading the packed context before it writes anything. Shrinks with fewer or smaller chunks, not with a faster model."
            />
            <StatTile
              icon={<GaugeIcon size={12} />}
              label="Decode rate"
              value={stats.rate != null ? `${stats.rate.toFixed(1)}` : "—"}
              sub="tokens / second"
              hint="How fast the model writes once it starts — a property of the model against memory bandwidth, unaffected by retrieval settings."
            />
          </div>

          {/* ── Charts ── */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="border border-line px-3 py-2.5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-display text-[9px] tracking-[0.16em] text-subtle uppercase">
                  <ChartBarIcon size={11} />
                  Latency by stage, per query
                </span>
                <ChartLegend
                  items={[...stageNames].map(([name, label]) => ({
                    label,
                    color: stageColor(name)
                  }))}
                />
              </div>
              <ColumnChart columns={latencyColumns} format={formatMs} />
            </div>
            <div className="border border-line px-3 py-2.5">
              <div className="mb-2 flex items-center gap-1.5 font-display text-[9px] tracking-[0.16em] text-subtle uppercase">
                <ClockCountdownIcon size={11} />
                Time to first token
              </div>
              <ColumnChart
                columns={ttftColumns}
                format={formatMs}
                emptyLabel="no generation timings yet"
              />
            </div>
          </div>

          {/* ── Query log ── */}
          <div className="border border-line">
            <div className="flex items-center gap-1.5 border-b border-line px-3 py-2 font-display text-[9px] tracking-[0.16em] text-subtle uppercase">
              <QuotesIcon size={11} />
              Query log
            </div>
            <div className="max-h-64 overflow-x-auto overflow-y-auto">
              <table className="w-full min-w-[38rem] border-collapse text-left">
                <thead className="sticky top-0 z-10 bg-background">
                  <tr className="border-b border-line font-display text-[9px] tracking-[0.14em] text-subtle uppercase">
                    <th className="px-3 py-1.5 font-medium">Question</th>
                    <th className="py-1.5 pr-3 font-medium">Stages</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Total</th>
                    <th className="py-1.5 pr-3 text-right font-medium">TTFT</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Tok/s</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Cites</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Config</th>
                  </tr>
                </thead>
                <tbody>
                  {traces?.map((t) => (
                    <tr key={t.id} className="border-b border-line/60 hover:bg-foreground/4">
                      <td className="max-w-[16rem] truncate px-3 py-1.5 text-[11px] text-muted">
                        {t.query}
                      </td>
                      <td className="w-36 py-1.5 pr-3">
                        <SegmentBar
                          height={6}
                          readout={false}
                          format={formatMs}
                          segments={t.stages.map((s) => ({
                            key: s.name,
                            label: s.label,
                            value: s.duration_ms,
                            color: stageColor(s.name)
                          }))}
                        />
                      </td>
                      <td className="tabular py-1.5 pr-3 text-right font-mono text-[10px]">
                        {formatMs(t.total_ms)}
                      </td>
                      <td className="tabular py-1.5 pr-3 text-right font-mono text-[10px] text-subtle">
                        {t.ttft_ms != null ? formatMs(t.ttft_ms) : "—"}
                      </td>
                      <td className="tabular py-1.5 pr-3 text-right font-mono text-[10px] text-subtle">
                        {t.tokens_per_second != null ? t.tokens_per_second.toFixed(1) : "—"}
                      </td>
                      <td className="tabular py-1.5 pr-3 text-right font-mono text-[10px] text-subtle">
                        {t.n_citations}
                      </td>
                      <td className="tabular py-1.5 pr-3 text-right font-mono text-[9px] text-subtle">
                        {t.config_hash}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
