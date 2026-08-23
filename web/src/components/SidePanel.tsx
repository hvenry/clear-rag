import type { ReactNode } from "react";

/**
 * A sidebar that knows what a phone is.
 *
 * Desktop (lg and up): a static bordered rail, exactly as before. Below that: the rail
 * disappears entirely and renders instead as a full-screen overlay when opened — because
 * a 320px settings column beside a 390px viewport leaves nothing to read.
 *
 * Children render in both slots; controlled inputs stay consistent because state lives
 * with the caller.
 */
export function SidePanel({
  title,
  open,
  onClose,
  widthClass = "lg:w-64",
  children
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  widthClass?: string;
  children: ReactNode;
}) {
  return (
    <>
      <aside
        className={`hidden shrink-0 overflow-y-auto border-r border-line lg:block ${widthClass}`}
      >
        {children}
      </aside>

      {open ? (
        <div className="fixed inset-0 z-40 flex flex-col bg-background lg:hidden">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="font-display text-[11px] tracking-[0.18em] text-subtle uppercase">
              {title}
            </span>
            <button
              onClick={onClose}
              className="border border-line px-3 py-1.5 font-display text-[10px] tracking-[0.14em] uppercase transition-colors hover:border-foreground/50"
            >
              Done
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </div>
      ) : null}
    </>
  );
}

/** The button that summons a SidePanel on mobile; invisible on desktop. */
export function PanelTrigger({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="border border-line px-2.5 py-1.5 font-display text-[10px] tracking-[0.14em] uppercase transition-colors hover:border-foreground/50 lg:hidden"
    >
      {label}
    </button>
  );
}
