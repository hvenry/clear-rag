import { useEffect, useState } from "react";

import type { RuntimeStatus } from "../lib/types";
import { api } from "../lib/api";

/**
 * What the inference runtime is doing right now: which models are resident, how much of
 * each is in VRAM, and what context size they were loaded at.
 *
 * The colour policy applies unchanged — a healthy runtime is uncoloured. The one number
 * that earns colour is the GPU share, because a model split between VRAM and system RAM
 * still answers correctly, just an order of magnitude slower, and nothing else in the
 * interface would ever say so.
 */
export function RuntimePanel() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.runtime();
        if (!cancelled) setStatus(next);
      } catch {
        // A readout that fails is not worth an error state; the chip simply hides.
      }
    };
    void poll();
    // Slow enough to be free, fast enough that an unload or a spill shows up while you
    // are still looking at the query that caused it.
    const timer = setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!status?.available || status.models.length === 0) return null;

  const spilled = !status.fully_on_gpu;
  const hint = spilled
    ? "Part of a resident model is running on the CPU. Ollama splits a model that does not fit in VRAM rather than refusing it, and generation slows by roughly an order of magnitude. Use a smaller model or a smaller context."
    : "Every resident model is fully in VRAM. Click for per-model detail.";

  return (
    <div className="relative hidden sm:block">
      <button
        onClick={() => setOpen((v) => !v)}
        data-hint={hint}
        className={[
          "hint hint-end flex items-center gap-2 border px-2 py-1 font-mono text-[10px] transition-colors",
          open ? "border-foreground/50" : "border-line hover:border-foreground/40",
          spilled ? "text-slow" : "text-subtle"
        ].join(" ")}
      >
        <span className="tabular">{formatBytes(status.vram_bytes)}</span>
        <span>{spilled ? "partly CPU" : "100% GPU"}</span>
      </button>

      {open ? (
        <>
          <button
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />
          <div className="glass-strong absolute top-full right-0 z-40 mt-1.5 w-[min(22rem,calc(100vw-2rem))] p-3">
            <div className="mb-2 font-display text-[9px] tracking-[0.18em] text-subtle uppercase">
              Resident models
            </div>
            {status.models.map((model) => (
              <div key={model.name} className="mb-3 last:mb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-[11px]">{model.name}</span>
                  <span
                    className={`tabular font-mono text-[10px] ${
                      model.on_gpu_pct >= 100 ? "text-subtle" : "text-slow"
                    }`}
                  >
                    {model.on_gpu_pct >= 100 ? "100% GPU" : `${model.on_gpu_pct}% GPU`}
                  </span>
                </div>
                <dl className="mt-1 space-y-0.5">
                  <Row label="resident" value={formatBytes(model.size_bytes)} />
                  <Row
                    label="context"
                    value={model.context_length ? `${model.context_length} tokens` : "—"}
                  />
                  <Row
                    label="weights"
                    value={[model.parameters, model.quantization].filter(Boolean).join(" · ") || "—"}
                  />
                  <Row label="unloads" value={formatExpiry(model.expires_at)} />
                </dl>
              </div>
            ))}
            <p className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-muted">
              Context is the window the model was <em>loaded</em> with. A query asking for a
              different one forces a reload, which costs the same as a cold start.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="font-mono text-[10px] text-subtle">{label}</dt>
      <dd className="tabular font-mono text-[10px]">{value}</dd>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${bytes} B`;
}

function formatExpiry(iso: string | null): string {
  if (!iso) return "—";
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (Number.isNaN(minutes)) return "—";
  if (minutes <= 0) return "any moment";
  return minutes >= 60 ? `in ${Math.round(minutes / 60)} h` : `in ${minutes} min`;
}
