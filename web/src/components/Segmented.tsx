import type { Icon } from "@phosphor-icons/react";
import { useRef } from "react";

import { HintCard, useHoverMenu } from "./Popover";

/**
 * The segmented control — one bordered strip of mutually exclusive options.
 *
 * This pattern appeared three times (Lab knobs, the Library's mode switch, the
 * chunk inspector's view switch) with drifting styles. One component, two variants:
 * `mono` for dense settings rows, `display` for view-level switches.
 *
 * Option hints render two ways: the default CSS tooltip, or — with `hintFlyout` —
 * a portalled hover card that no scroll or overflow container can clip: "right"
 * flies it out beside a side rail, "below" drops it under a menu bar, matching
 * the header nav's dropdowns.
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: Icon;
  hint?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  variant = "mono",
  disabled = false,
  grow = false,
  hintFlyout
}: {
  options: readonly SegmentedOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  variant?: "mono" | "display";
  disabled?: boolean;
  grow?: boolean;
  hintFlyout?: "right" | "below";
}) {
  return (
    <div className="flex">
      {options.map((option) => (
        <OptionButton
          key={option.value}
          option={option}
          active={value === option.value}
          disabled={disabled}
          variant={variant}
          grow={grow}
          hintFlyout={hintFlyout}
          onSelect={() => onChange(option.value)}
        />
      ))}
    </div>
  );
}

function OptionButton<T extends string>({
  option,
  active,
  disabled,
  variant,
  grow,
  hintFlyout,
  onSelect
}: {
  option: SegmentedOption<T>;
  active: boolean;
  disabled: boolean;
  variant: "mono" | "display";
  grow: boolean;
  hintFlyout?: "right" | "below";
  onSelect: () => void;
}) {
  const menu = useHoverMenu(150, 250);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const flyout = hintFlyout !== undefined && option.hint !== undefined;
  const OptionIcon = option.icon;

  const face =
    variant === "display"
      ? "gap-1.5 px-2 py-1.5 font-display text-[10px] tracking-[0.14em] uppercase"
      : "gap-1.5 px-2.5 py-1 font-mono text-[10px]";

  return (
    <>
      <button
        ref={triggerRef}
        disabled={disabled}
        onClick={onSelect}
        data-hint={flyout ? undefined : option.hint}
        {...(flyout ? menu.hover : {})}
        className={[
          !flyout && option.hint ? "hint hint-end" : "",
          grow ? "flex-1 justify-center" : "",
          "-ml-px flex items-center border transition-colors first:ml-0",
          face,
          active
            ? "z-10 border-foreground/60 bg-foreground text-background"
            : "border-line text-subtle hover:border-foreground/40 hover:text-foreground",
          "disabled:pointer-events-none"
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {OptionIcon ? <OptionIcon size={variant === "display" ? 12 : 11} /> : null}
        {option.label}
      </button>

      {flyout ? (
        <HintCard
          anchorRef={triggerRef}
          menu={menu}
          placement={hintFlyout!}
          text={option.hint!}
        />
      ) : null}
    </>
  );
}
