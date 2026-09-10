import { ArrowUpIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * The ask box: auto-growing textarea plus submit, Enter to send. Chat and the Lab
 * each had a hand-rolled copy of this; the differences that matter (leading
 * controls, accessible label, disabled logic) are props, everything else is shared.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled = false,
  actionLabel = "Ask",
  actionHint,
  leading,
  notice
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  actionLabel?: string;
  actionHint?: string;
  leading?: ReactNode;
  notice?: string | null;
}) {
  return (
    <div className="glass-strong border-0">
      <div className="mx-auto w-full max-w-4xl px-3 py-3 sm:px-5 sm:py-4">
        {notice ? <p className="mb-2 font-mono text-meta text-subtle">{notice}</p> : null}
        <div className="flex items-end gap-2">
          {leading}
          <textarea
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              const el = e.currentTarget;
              el.style.height = "auto";
              // scrollHeight excludes the border; add it back or the box loses two
              // pixels on the first keystroke and everything above it shifts.
              const border = el.offsetHeight - el.clientHeight;
              el.style.height = `${el.scrollHeight + border}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
            rows={1}
            placeholder={placeholder}
            className="max-h-40 min-h-[42px] flex-1 resize-none border border-line bg-transparent px-3 py-2.5 text-body leading-5 outline-none transition-colors hover:border-foreground/50 focus:border-foreground/90 no-ring"
          />
          <button
            onClick={onSubmit}
            disabled={disabled || !value.trim()}
            aria-label={actionLabel}
            data-hint={actionHint}
            className={[
              actionHint ? "hint hint-end hint-block" : "",
              // Same border as the textarea beside it. Empty: an outline. With text:
              // filled ink with a paper arrow, so the ready state is unmistakable.
              "flex h-[42px] w-[42px] shrink-0 items-center justify-center border transition-colors",
              value.trim() && !disabled
                ? "border-foreground bg-foreground text-background hover:bg-foreground/85"
                : "border-line text-subtle disabled:pointer-events-none"
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <ArrowUpIcon size={18} weight="bold" />
          </button>
        </div>
      </div>
    </div>
  );
}
