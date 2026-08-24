import { GraphicsCardIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import type { RuntimeStatus } from "../lib/types";
import { api } from "../lib/api";
import { KeyValueRow } from "../components/KeyValueRow";
import { AnchoredPopover, useHoverMenu } from "../components/Popover";
import { useConfig } from "../lib/queries";

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
  const { data: config } = useConfig();
  const menu = useHoverMenu();
  const triggerRef = useRef<HTMLButtonElement>(null);

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

  // The configured chat model, when it is not among the resident ones. The panel
  // shows runtime reality, not configuration — but reality should say when the
  // model you just selected has not been loaded yet.
  const configuredChat = config?.providers.chat.model ?? null;
  const chatNotLoaded =
    configuredChat !== null &&
    !status.models.some((m) => sameModel(m.name, configuredChat));

  return (
    <div className="relative hidden sm:block">
      <button
        ref={triggerRef}
        onClick={menu.toggle}
        {...menu.hover}
        className={[
          "flex items-center gap-2 border px-2 py-1 font-mono text-[10px] transition-colors",
          menu.open ? "border-foreground/50" : "border-line hover:border-foreground/40",
          // Amber stays amber — the spill colour is data, not chrome. Only the
          // neutral state brightens on hover, matching the model chip beside it.
          spilled
            ? "text-slow"
            : menu.open
              ? "text-foreground"
              : "text-subtle hover:text-foreground"
        ].join(" ")}
      >
        <GraphicsCardIcon size={12} className="shrink-0" />
        <span className="tabular">{formatBytes(status.vram_bytes)}</span>
        <span>{spilled ? "partly CPU" : "100% GPU"}</span>
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
                {/* GPU share as length, amber only when spilled — colour marks
                    the exception, and the % label always rides beside it. */}
                <div className="mt-1 h-[4px] w-full bg-foreground/8">
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.min(100, model.on_gpu_pct)}%`,
                      background:
                        model.on_gpu_pct >= 100
                          ? "rgb(var(--foreground) / 0.55)"
                          : "var(--color-slow)"
                    }}
                  />
                </div>
                <dl className="mt-1 space-y-0.5">
                  <KeyValueRow label="resident" value={formatBytes(model.size_bytes)} />
                  <KeyValueRow
                    label="context"
                    value={model.context_length ? `${model.context_length} tokens` : "—"}
                  />
                  <KeyValueRow
                    label="weights"
                    value={[model.parameters, model.quantization].filter(Boolean).join(" · ") || "—"}
                  />
                  <KeyValueRow label="unloads" value={formatExpiry(model.expires_at)} />
                </dl>
              </div>
            ))}
            {spilled ? (
              <p className="mt-2 border-l-2 border-slow/60 pl-2 text-[10px] leading-relaxed text-muted">
                Part of a resident model is running on the CPU. Ollama splits a model
                that does not fit in VRAM rather than refusing it, and generation slows
                by roughly an order of magnitude. Use a smaller model or a smaller
                context.
              </p>
            ) : null}
            {chatNotLoaded ? (
              <p className="mt-2 border-l-2 border-line pl-2 text-[10px] leading-relaxed text-muted">
                The configured chat model{" "}
                <span className="font-mono text-foreground">{configuredChat}</span> is not
                loaded yet — Ollama loads it on your first question, which costs a cold
                start. Models shown above stay resident until their timers expire.
              </p>
            ) : null}
            <p className="mt-2 border-t border-line pt-2 text-[10px] leading-relaxed text-muted">
              Context is the window the model was <em>loaded</em> with. A query asking for a
              different one forces a reload, which costs the same as a cold start.
            </p>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}


/** "llama3.2" and "llama3.2:latest" are the same model; a bare tag means latest. */
function sameModel(a: string, b: string): boolean {
  const norm = (name: string) => (name.includes(":") ? name : `${name}:latest`);
  return norm(a) === norm(b);
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
