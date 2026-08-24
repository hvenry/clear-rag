import { HoverInfo } from "../../components/HoverInfo";
import { Segmented } from "../../components/Segmented";
import type { Knob } from "../../lib/knobs";

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
      <HoverInfo text={knob.hint} className="mb-1">
        <div className="flex items-center justify-between gap-2">
          <label className="text-[11px] text-muted">{knob.label}</label>
          {disabled ? (
            <span className="font-mono text-[8px] tracking-wide text-subtle uppercase">
              not built yet
            </span>
          ) : null}
        </div>
      </HoverInfo>

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
          <span className="tabular w-9 text-right font-mono text-[10px]">
            {Number(value ?? 0).toFixed(knob.step && knob.step < 1 ? 2 : 0)}
          </span>
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
