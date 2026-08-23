import type { ReactNode } from "react";

interface PanelProps {
  children: ReactNode;
  className?: string;
  /** Crop-mark corner ticks over the border. */
  ticks?: boolean;
  /** Translucent blurred surface — reserved for live or overlaid content. */
  glass?: boolean;
  interactive?: boolean;
}

export function Panel({
  children,
  className = "",
  ticks = false,
  glass = false,
  interactive = false
}: PanelProps) {
  return (
    <div
      className={[
        "relative",
        glass ? "glass" : "border border-line bg-background",
        ticks ? "panel-ticks" : "",
        interactive ? "glow transition-colors duration-300 hover:border-foreground/40" : "",
        className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 pt-3 pb-2">
      <h2 className="font-display text-[11px] font-medium tracking-[0.18em] text-subtle uppercase">
        {children}
      </h2>
      {right ? <div className="font-mono text-[10px] text-subtle">{right}</div> : null}
    </div>
  );
}
