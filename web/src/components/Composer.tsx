import { PaperPlaneRightIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * The ask box: auto-growing textarea plus submit, Enter to send. Chat and the Lab
 * each had a hand-rolled copy of this; the differences that matter (leading
 * controls, button label, disabled logic) are props, everything else is shared.
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
    <div className="glass-strong border-x-0 border-b-0">
      <div className="mx-auto w-full max-w-4xl px-3 py-3 sm:px-5 sm:py-4">
        {notice ? <p className="mb-2 font-mono text-[10px] text-subtle">{notice}</p> : null}
        <div className="flex items-end gap-2">
          {leading}
          <textarea
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
            rows={1}
            placeholder={placeholder}
            className="max-h-40 min-h-[42px] flex-1 resize-none border border-line bg-transparent px-3 py-2.5 text-[13px] outline-none transition-colors focus:border-foreground/45"
          />
          <button
            onClick={onSubmit}
            disabled={disabled || !value.trim()}
            data-hint={actionHint}
            className={[
              actionHint ? "hint hint-end" : "",
              "flex h-[42px] items-center gap-1.5 border border-line px-4 font-display text-[11px] tracking-[0.16em] uppercase transition-colors hover:border-foreground/60 hover:bg-foreground hover:text-background disabled:pointer-events-none disabled:opacity-30"
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <PaperPlaneRightIcon size={12} />
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
