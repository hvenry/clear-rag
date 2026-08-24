import { useRef, type ReactNode } from "react";

import { HintCard, useHoverMenu } from "./Popover";

/**
 * Wraps a header or label row so that hovering anywhere inside it flies an
 * explanation card out to the right — the side-rail counterpart of the header
 * chips' drop-below menus. A portalled card, so the rail's scroll container
 * (which clipped the old CSS tooltips) cannot clip it. The open-intent delay
 * keeps a pointer sweeping down the rail from flashing every row's card.
 */
export function HoverInfo({
  text,
  children,
  className = ""
}: {
  text: string;
  children: ReactNode;
  className?: string;
}) {
  const menu = useHoverMenu(150, 250);
  const anchorRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={anchorRef}
      onClick={menu.toggle}
      {...menu.hover}
      className={`cursor-help ${className}`}
    >
      {children}
      <HintCard anchorRef={anchorRef} menu={menu} placement="right" text={text} />
    </div>
  );
}
