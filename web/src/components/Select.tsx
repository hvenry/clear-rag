import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

/**
 * A styled listbox: the app's monochrome answer to the OS-default `<select>`.
 *
 * Deliberately NOT portalled: it positions absolutely inside its own subtree, so
 * a parent that closes on focus-out (the ConfigMenu card) still counts a click on
 * an option as "inside". The cost is that a clipping ancestor could cut it off:
 * fine in popover cards, which don't clip; use with care inside scroll containers.
 * The list background is solid, not glass: a nested backdrop-filter inside an
 * already-filtered card silently no-ops.
 */
export function Select({
  value,
  options,
  onChange,
  className = ""
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`relative ${className}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={[
          "flex w-full items-center justify-between gap-2 border bg-transparent px-2 py-1 font-mono text-ui outline-none transition-colors",
          open ? "border-foreground/50" : "border-line hover:border-foreground/50",
          "focus-visible:border-foreground/45"
        ].join(" ")}
      >
        <span className="truncate">{value}</span>
        <CaretDownIcon
          size={14}
          className={`shrink-0 text-subtle transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <ul
          role="listbox"
          className="absolute top-[calc(100%+4px)] right-0 left-0 z-50 max-h-56 overflow-y-auto border border-foreground/30 bg-background"
        >
          {options.map((name) => {
            const selected = name === value;
            return (
              <li key={name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(name);
                    setOpen(false);
                  }}
                  className={[
                    "flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left font-mono text-ui transition-colors",
                    selected
                      ? "bg-foreground text-background"
                      : "text-muted hover:bg-foreground/8 hover:text-foreground"
                  ].join(" ")}
                >
                  <span className="truncate">{name}</span>
                  {selected ? <CheckIcon size={14} className="shrink-0" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
