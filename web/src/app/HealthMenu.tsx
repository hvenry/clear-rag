import { useRef } from "react";

import { KeyValueRow } from "../components/KeyValueRow";
import { AnchoredPopover, useHoverMenu } from "../components/Popover";
import { headerControl } from "./headerControl";
import type { Health } from "../lib/types";

/**
 * The health chip: the status dot in a box, with the same hover menu the other
 * header chips have. The dot alone said "something is wrong somewhere"; the menu
 * says which provider, why, and what to do, per check, on hover, like everything
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
        className={headerControl(menu.open)}
      >
        <span className={`h-2 w-2 ${ok ? "bg-keyword" : "bg-critical"}`} />
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
                      <p className="mt-0.5 text-meta leading-relaxed text-muted">
                        {check.error}
                        {check.remedy ? (
                          <span className="block font-mono text-subtle">→ {check.remedy}</span>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                ))}
              </dl>
              <p className="tabular mt-2 border-t border-line pt-2 font-mono text-meta text-subtle">
                {health.documents ?? 0} documents · {health.chunks ?? 0} chunks indexed
              </p>
            </>
          ) : (
            <p className="text-ui text-muted">
              No health report yet: the backend has not answered.
            </p>
          )}
        </AnchoredPopover>
      ) : null}
    </div>
  );
}
