import type { ReactNode } from "react";

/**
 * The small bordered mono tag: a setting and its value, a question's tag, a run's
 * changed knob. One shape, a handful of tones, so chips read the same everywhere.
 */
export type ChipTone = "muted" | "ink" | "pin" | "diff" | "slow";

const TONES: Record<ChipTone, string> = {
  muted: "border-line text-subtle",
  ink: "border-foreground/40 text-foreground",
  pin: "border-pin/50 text-pin",
  diff: "border-diff/50 text-diff",
  slow: "border-slow/50 text-slow"
};

export function Chip({
  children,
  tone = "muted",
  dashed = false,
  hint,
  className = ""
}: {
  children: ReactNode;
  tone?: ChipTone;
  dashed?: boolean;
  hint?: string;
  className?: string;
}) {
  return (
    <span
      data-hint={hint}
      className={[
        hint ? "hint" : "",
        "tabular inline-block shrink-0 border px-1 font-mono text-label leading-[14px] whitespace-nowrap",
        dashed ? "border-dashed" : "",
        TONES[tone],
        className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}
