import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import { createPortal } from "react-dom";

/**
 * A dropdown card portalled to <body>, anchored under its trigger.
 *
 * Rendering the card inside the header would put it under the header's
 * backdrop-filter, and a nested backdrop-filter cannot sample page content
 * outside that ancestor — the card's blur silently no-ops and whatever sits
 * behind it stays readable. Portalling out of the header makes the blur real.
 *
 * Positioned from the trigger's rect at open time; the header is sticky, so
 * the rect does not move while the card is open.
 *
 * Focus keeps the card alive: while anything inside it has focus (a select's
 * native dropdown, a text input), pointer-leave is ignored — otherwise choosing
 * a model could unmount the menu mid-choice. When focus leaves the card, it
 * closes like a pointer-leave would.
 */
export function AnchoredPopover({
  anchorRef,
  onClose,
  children,
  className = "",
  backdrop = true,
  placement = "below",
  onMouseEnter,
  onMouseLeave
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** The full-screen click-catcher behind the card. Off for hover-driven menus. */
  backdrop?: boolean;
  /**
   * "below": under the trigger, right-aligned — header dropdowns. "right": beside
   * the trigger — flyouts from a side rail, where a dropdown would be clipped by
   * the rail's own scroll container.
   */
  placement?: "below" | "right";
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (placement === "right") {
      setPos({ top: Math.max(8, rect.top - 4), left: rect.right + 8 });
    } else {
      setPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }
  }, [anchorRef, placement]);

  if (!pos) return null;

  return createPortal(
    <>
      {backdrop ? (
        <button
          aria-label="Close"
          onClick={onClose}
          className="fixed inset-0 z-30 cursor-default"
        />
      ) : null}
      <div
        ref={cardRef}
        className={`glass-popover fixed z-40 ${className}`}
        style={{ top: pos.top, left: pos.left, right: pos.right }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={() => {
          if (cardRef.current?.contains(document.activeElement)) return;
          onMouseLeave?.();
        }}
        onFocusCapture={onMouseEnter}
        onBlurCapture={(e) => {
          if (cardRef.current?.contains(e.relatedTarget as Node | null)) return;
          onMouseLeave?.();
        }}
      >
        {children}
      </div>
    </>,
    document.body
  );
}

/**
 * A plain-text hint in a hover card — the shared rendering behind every hover
 * hint that flies from a control (rail rows, segmented options, menu-bar
 * buttons). One width, one type style, one place to change them.
 */
export function HintCard({
  anchorRef,
  menu,
  placement,
  text
}: {
  anchorRef: RefObject<HTMLElement | null>;
  menu: ReturnType<typeof useHoverMenu>;
  placement: "below" | "right";
  text: string;
}) {
  if (!menu.open) return null;
  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      onClose={menu.close}
      backdrop={false}
      placement={placement}
      {...menu.hover}
      className="w-[min(19rem,calc(100vw-4rem))] p-2.5"
    >
      <p className="font-sans text-[11px] leading-relaxed tracking-normal normal-case text-muted">
        {text}
      </p>
    </AnchoredPopover>
  );
}

/**
 * The header-menu interaction pattern: hovering the trigger opens the card and
 * leaving closes it (after a short grace delay, so crossing the gap between
 * trigger and card does not flicker it shut). No pinning — a click simply
 * toggles, which is what makes the menus reachable on touch screens, where
 * hover does not exist.
 */
export function useHoverMenu(closeDelayMs = 150, openDelayMs = 0) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const cancel = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => cancel, []);

  const enter = () => {
    cancel();
    // An open-intent delay keeps whole-row triggers calm: sweeping the pointer
    // down a rail should not flash a card at every row it crosses.
    if (openDelayMs > 0 && !open) {
      timer.current = window.setTimeout(() => setOpen(true), openDelayMs);
    } else {
      setOpen(true);
    }
  };
  const leave = () => {
    cancel();
    timer.current = window.setTimeout(() => setOpen(false), closeDelayMs);
  };
  const toggle = () => {
    cancel();
    setOpen((v) => !v);
  };
  const close = () => {
    cancel();
    setOpen(false);
  };

  return {
    open,
    close,
    toggle,
    hover: { onMouseEnter: enter, onMouseLeave: leave }
  };
}
