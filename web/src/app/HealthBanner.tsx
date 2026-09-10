import { WarningIcon } from "@phosphor-icons/react";

import type { Health } from "../lib/types";

/**
 * Preflight failures reach the user as a remedy, not a stack trace. "Ollama isn't
 * running, start it with `ollama serve`" is actionable; ConnectionError is not.
 */
export function HealthBanner({ health }: { health: Health | null }) {
  if (!health || health.ok) return null;
  const failures = health.checks.filter((c) => !c.ok);

  return (
    <div className="glass-strong border-x-0 border-t-0 px-5 py-3">
      {failures.map((check) => (
        <div key={check.component} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="flex items-center gap-1.5 font-display text-meta tracking-[0.18em] uppercase">
            <WarningIcon size={14} weight="fill" className="text-critical" aria-hidden />
            {check.component}
          </span>
          <span className="text-body text-muted">{check.error}</span>
          {check.remedy ? (
            <span className="font-mono text-ui text-subtle">→ {check.remedy}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
