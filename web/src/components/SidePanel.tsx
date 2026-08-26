import { SidebarSimpleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { IconButton } from "./IconButton";

/**
 * A sidebar that knows what a phone is — and how to get out of the way.
 *
 * Desktop (lg and up): a static bordered rail. Pass `collapsed`/`onCollapse` and it
 * gains a collapse control; collapsed, it shrinks to a slim strip holding only the
 * expand button and its title turned on its side, so the main pane gets the width
 * back without the rail vanishing entirely.
 *
 * Below lg: the rail disappears and renders instead as a full-screen overlay when
 * opened — because a 320px settings column beside a 390px viewport leaves nothing
 * to read. Collapsing is a desktop concern only.
 *
 * Children render in both slots; controlled inputs stay consistent because state
 * lives with the caller.
 */
export function SidePanel({
  title,
  open,
  onClose,
  widthClass = "lg:w-64",
  collapsed = false,
  onCollapse,
  headerExtra,
  footer,
  children
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  widthClass?: string;
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
  /** Rendered in the desktop header, left of the collapse button. */
  headerExtra?: ReactNode;
  /** Docked below the scrolling content — always visible, like the header. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      {collapsed && onCollapse ? (
        <aside className="hidden shrink-0 flex-col items-center gap-3 border-r border-line px-1.5 pt-2 lg:flex">
          <IconButton label={`Expand ${title}`} onClick={() => onCollapse(false)}>
            <SidebarSimpleIcon size={13} />
          </IconButton>
          <span
            className="menu-label"
            style={{ writingMode: "vertical-rl" }}
          >
            {title}
          </span>
        </aside>
      ) : (
        // Header and footer stay in the foreground; only the content between
        // them scrolls.
        <aside
          // Positioned and painted so anything at a lower z-index (the Lab's hint
          // card) can slide out from underneath its right border.
          className={`relative z-10 hidden shrink-0 flex-col border-r border-line bg-background lg:flex ${widthClass}`}
        >
          {onCollapse ? (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2">
              <span className="font-display text-[10px] tracking-[0.18em] text-subtle uppercase">
                {title}
              </span>
              <div className="flex shrink-0 items-center gap-2">
                {headerExtra}
                <IconButton label={`Collapse ${title}`} onClick={() => onCollapse(true)}>
                  <SidebarSimpleIcon size={12} />
                </IconButton>
              </div>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer ? <div className="shrink-0 border-t border-line">{footer}</div> : null}
        </aside>
      )}

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
          {footer ? <div className="shrink-0 border-t border-line">{footer}</div> : null}
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
