import { useState } from "react";

import {
  formatMs,
  SPEED_CLASS,
  SPEED_HINT,
  speedOf,
  stageInfo
} from "../lib/stages";
import { STAGE_TOPIC } from "../lib/topics";
import type { StageRecord } from "../lib/types";
import { Loader } from "./Loader";

/**
 * The live pipeline readout: each stage appears as its event arrives, so retrieval is
 * watched rather than waited on.
 *
 * Every chip explains itself on hover, and its duration is coloured only when slow
 * enough to be worth noticing — so a 32-second generate stage is visible at a glance
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
  const info = stageInfo(stage.name);
  const speed = speedOf(stage.duration_ms);
  const share = total > 0 ? (100 * stage.duration_ms) / total : 0;

  const hint = [
    info.what,
    info.timing ? `\n\n${info.timing}` : "",
    `\n\n${formatMs(stage.duration_ms)} — ${SPEED_HINT[speed]} ${share.toFixed(0)}% of this query.`,
    stage.error ? `\n\nFailed: ${stage.error}` : ""
  ].join("");

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        data-hint={hint}
        className={[
          "hint stage-enter glass flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
          stage.error ? "border-critical/50" : "hover:border-foreground/35",
          open ? "border-foreground/50" : ""
        ].join(" ")}
      >
        <span className="font-display text-[10px] tracking-[0.12em] uppercase">
          {stage.label}
        </span>
        <span className={`tabular font-mono text-[9px] ${SPEED_CLASS[speed]}`}>
          {formatMs(stage.duration_ms)}
        </span>
        {stage.candidates_out ? (
          <span className="tabular border-l border-line pl-2 font-mono text-[9px] text-subtle">
            {stage.candidates_out.length}
          </span>
        ) : null}
        {stage.degraded ? (
          <span className="font-mono text-[9px] text-slow">degraded</span>
        ) : null}
      </button>

      {open ? (
        <>
          {/* Mobile: a tap-away backdrop; the popover is a centered page-width sheet
              instead of a box anchored to a chip that may sit at the screen edge. */}
          <button
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default bg-background/50 lg:hidden"
          />
          <div className="glass-strong fixed inset-x-4 top-1/2 z-40 max-h-[70vh] -translate-y-1/2 overflow-auto p-3 text-[11px] lg:absolute lg:inset-x-auto lg:top-full lg:left-0 lg:mt-1.5 lg:max-h-80 lg:w-[min(24rem,calc(100vw-2rem))] lg:-translate-y-0">
          <p className="mb-3 leading-relaxed text-muted">{info.what}</p>
          {stage.error ? (
            <p className="mb-3 border-l-2 border-critical pl-2 font-mono text-[10px] text-muted">
              {stage.error}
            </p>
          ) : null}
          <Rows title="Diagnostics" data={stage.diagnostics} />
          <Rows title="Settings used" data={stage.config} />
          {onExplain && STAGE_TOPIC[stage.name] ? (
            <button
              onClick={() => onExplain(stage.name)}
              className="mt-1 w-full border border-line px-2 py-1 text-left font-mono text-[10px] text-subtle transition-colors hover:border-foreground/50 hover:text-foreground"
            >
              why does this stage exist? →
            </button>
          ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function Rows({ title, data }: { title: string; data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return null;

  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 font-display text-[9px] tracking-[0.18em] text-subtle uppercase">
        {title}
      </div>
      <dl className="space-y-1">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-start justify-between gap-3">
            <dt className="font-mono text-[10px] text-subtle">{key}</dt>
            <dd className="tabular max-w-[62%] text-right font-mono text-[10px] break-words">
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
