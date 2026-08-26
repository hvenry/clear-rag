import { useRef } from "react";

import { KeyValueRow } from "../components/KeyValueRow";
import { AnchoredPopover, useHoverMenu } from "../components/Popover";
import type { Health } from "../lib/types";

/**
 * The health chip: the status dot in a box, with the same hover menu the other
 * header chips have. The dot alone said "something is wrong somewhere"; the menu
 * says which provider, why, and what to do — per check, on hover, like everything
 * else in the header.
 */
export function HealthMenu({ health }: { health: Health | null }) {
  const menu = useHoverMenu();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const ok = health?.ok ?? false;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={menu.toggle}
        {...menu.hover}
        aria-label={ok ? "All providers reachable" : "A provider check failed"}
        className={[
          "flex cursor-default items-center border px-2 py-[7px] transition-colors",
          menu.open ? "border-foreground/50" : "border-line hover:border-foreground/40"
        ].join(" ")}
      >
        <span className={`h-1.5 w-1.5 ${ok ? "bg-keyword" : "bg-critical"}`} />
      </button>

      {menu.open ? (
        <AnchoredPopover
          anchorRef={triggerRef}
          onClose={menu.close}
          backdrop={false}
          {...menu.hover}
          className="w-[min(22rem,calc(100vw-2rem))] p-3"
        >
          <div className="mb-2 menu-label">
            Health
          </div>
          {health ? (
            <>
              <dl className="space-y-1.5">
                {health.checks.map((check) => (
                  <div key={check.component}>
                    <KeyValueRow
                      label={check.component}
                      value={
                        check.ok
                          ? [check.provider, check.model].filter(Boolean).join(" · ") || "ok"
                          : check.optional
                            ? "degraded"
                            : "failed"
                      }
                      valueClassName={check.ok ? "" : check.optional ? "text-slow" : "text-critical"}
                    />
                    {!check.ok && check.error ? (
                      <p className="mt-0.5 text-[10px] leading-relaxed text-muted">
                        {check.error}
                        {check.remedy ? (
                          <span className="block font-mono text-subtle">→ {check.remedy}</span>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                ))}
              </dl>
              <p className="tabular mt-2 border-t border-line pt-2 font-mono text-[10px] text-subtle">
                {health.documents ?? 0} documents · {health.chunks ?? 0} chunks indexed
              </p>
            </>
          ) : (
            <p className="text-[11px] text-muted">
              No health report yet — the backend has not answered.
            </p>
          )}
        </AnchoredPopover>
      ) : null}
    </div>
  );
}
