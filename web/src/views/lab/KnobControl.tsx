import { useState } from "react";

import { Segmented } from "../../components/Segmented";
import type { Knob } from "../../lib/knobs";

/**
 * A slider's numeric readout, editable in place: click, type an exact value,
 * Enter (or blur) commits. Out-of-range input clamps to the nearer bound.
 */
function RangeValue({
  value,
  min,
  max,
  step,
  disabled,
  onCommit
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (step !== undefined && step < 1 ? value.toFixed(2) : String(value));

  const commit = () => {
    if (draft !== null) {
      const parsed = Number(draft);
      if (!Number.isNaN(parsed)) {
        let next = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, parsed));
        if (step === undefined || step >= 1) next = Math.round(next);
        onCommit(next);
      }
    }
    setDraft(null);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      value={shown}
      onFocus={(e) => {
        setDraft(String(value));
        e.target.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      aria-label="Exact value"
      className="tabular w-12 shrink-0 border border-transparent bg-transparent px-1 py-0.5 text-right font-mono text-[10px] outline-none transition-colors hover:border-line focus:border-foreground/45"
    />
  );
}

/** One pipeline setting rendered as its control type, disabled state included. */
export function KnobControl({
  knob,
  value,
  onChange
}: {
  knob: Knob;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const disabled = !knob.implemented;

  return (
    <div className={disabled ? "opacity-45" : ""}>
      {/* The knob's explanation lives in the Lab's slide-out hint card, keyed by
          hovering this row — not in a per-label popover. */}
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="text-[11px] text-muted">{knob.label}</label>
        {disabled ? (
          <span className="font-mono text-[8px] tracking-wide text-subtle uppercase">
            not built yet
          </span>
        ) : null}
      </div>

      {knob.type === "segmented" && knob.options ? (
        <Segmented
          options={knob.options}
          value={value as string | undefined}
          onChange={onChange}
          disabled={disabled}
        />
      ) : null}

      {knob.type === "number" ? (
        <input
          type="number"
          disabled={disabled}
          value={String(value ?? "")}
          min={knob.min}
          max={knob.max}
          onChange={(e) => onChange(clamp(Number(e.target.value), knob.min, knob.max))}
          className="tabular w-24 border border-line bg-transparent px-2 py-1 font-mono text-[11px] outline-none transition-colors focus:border-foreground/45"
        />
      ) : null}

      {knob.type === "range" ? (
        <div className="flex items-center gap-2.5">
          <input
            type="range"
            disabled={disabled}
            value={Number(value ?? 0)}
            min={knob.min}
            max={knob.max}
            step={knob.step}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-px flex-1 appearance-none bg-foreground/25 accent-current"
          />
          <RangeValue
            value={Number(value ?? 0)}
            min={knob.min}
            max={knob.max}
            step={knob.step}
            disabled={disabled}
            onCommit={onChange}
          />
        </div>
      ) : null}

      {knob.type === "toggle" ? (
        <button
          disabled={disabled}
          onClick={() => onChange(!value)}
          className={[
            "border px-2.5 py-1 font-mono text-[10px] transition-colors",
            value
              ? "border-foreground/60 bg-foreground text-background"
              : "border-line text-subtle hover:border-foreground/40",
            "disabled:pointer-events-none"
          ].join(" ")}
        >
          {value ? "on" : "off"}
        </button>
      ) : null}
    </div>
  );
}

function clamp(n: number, min?: number, max?: number): number {
  if (Number.isNaN(n)) return min ?? 0;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}
