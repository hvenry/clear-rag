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
          <span className="font-display text-[10px] tracking-[0.18em] uppercase">
            {check.component}
          </span>
          <span className="text-[12px] text-muted">{check.error}</span>
          {check.remedy ? (
            <span className="font-mono text-[11px] text-subtle">→ {check.remedy}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
