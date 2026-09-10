import { CaretDownIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

interface PanelProps {
  children: ReactNode;
  className?: string;
  /** Crop-mark corner ticks over the border. */
  ticks?: boolean;
  /** Translucent blurred surface, reserved for live or overlaid content. */
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
        interactive ? "glow transition-colors duration-300 hover:border-foreground/50" : "",
        className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

export function SectionLabel({
  children,
  right,
  collapsed,
  onToggle
}: {
  children: ReactNode;
  right?: ReactNode;
  /** With `onToggle`, the label becomes a disclosure: click to fold the panel body. */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const heading = (
    <h2 className="font-display text-ui font-medium tracking-[0.18em] text-subtle uppercase">
      {children}
    </h2>
  );
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex items-center gap-2 text-left transition-colors hover:text-foreground"
        >
          <CaretDownIcon
            size={14}
            className={`shrink-0 text-subtle transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
          {heading}
        </button>
      ) : (
        heading
      )}
      {right ? <div className="font-mono text-meta text-subtle">{right}</div> : null}
    </div>
  );
}
