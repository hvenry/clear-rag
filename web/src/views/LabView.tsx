import { useCallback, useEffect, useMemo, useState } from "react";

import { AnswerText } from "../components/Citations";
import { SourceLegend } from "../components/Legend";
import { Loader } from "../components/Loader";
import { RetrievalTable } from "../components/RetrievalTable";
import { StageStrip } from "../components/StageStrip";
import { api } from "../lib/api";
import { diffConfigs, KNOB_GROUPS, REINDEX_KEYS, type Knob } from "../lib/knobs";
import { formatMs } from "../lib/stages";
import type { Citation, StageRecord, Turn } from "../lib/types";

/**
 * The Lab: change one retrieval setting, ask the same question again, and read the runs
 * side by side. Watching the pipeline explains what RAG does; experimenting on it
 * explains why.
 *
 * Settings apply when you ask — a dirty draft is applied automatically before the run,
 * so a card always shows results produced under exactly the settings it displays. The
 * one exception is chunking: those settings rewrite the stored index, so the re-index
 * stays an explicit button with its cost stated, never a side effect.
 */

interface LabRun {
  id: number;
  hash: string;
  config: Record<string, unknown>;
  changed: { key: string; from: unknown; to: unknown }[];
  turn: Turn;
}

let runCounter = 0;

export function LabView({
  chunkCount,
  docCount,
  onCorpusChanged,
  onCite
}: {
  chunkCount: number;
  docCount: number;
  onCorpusChanged: () => void;
  onCite: (citation: Citation) => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [applied, setApplied] = useState<Record<string, unknown> | null>(null);
  const [needsReindex, setNeedsReindex] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [loadingSample, setLoadingSample] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [runs, setRuns] = useState<LabRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null);

  useEffect(() => {
    api.config().then((response) => {
      setDraft(response.config);
      setApplied(response.config);
    });
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(applied),
    [draft, applied]
  );

  const dirtyChunking = useMemo(() => {
    if (!draft || !applied) return false;
    return [...REINDEX_KEYS].some(
      (key) => JSON.stringify(draft[key]) !== JSON.stringify(applied[key])
    );
  }, [draft, applied]);

  const applyDraft = useCallback(async (): Promise<boolean> => {
    if (!draft || !dirty) return true;
    const response = await api.updateConfig(draft);
    setApplied(response.config);
    setDraft(response.config);
    if (response.reindex_needed) setNeedsReindex(true);
    return !response.reindex_needed;
  }, [draft, dirty]);

  const runReindex = useCallback(async () => {
    setReindexing(true);
    try {
      await applyDraft();
      const report = await api.reindex();
      setNeedsReindex(false);
      setNotice(
        `Re-indexed ${report.total_chunks} chunks in ${formatMs(report.duration_ms)}.`
      );
      onCorpusChanged();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setReindexing(false);
      setTimeout(() => setNotice(null), 6000);
    }
  }, [applyDraft, onCorpusChanged]);

  const loadSample = useCallback(async () => {
    setLoadingSample(true);
    try {
      const report = await api.loadSample();
      setNotice(
        report.indexed
          ? `Indexed ${report.indexed} sample documents.`
          : "Sample corpus already indexed."
      );
      onCorpusChanged();
    } catch (error) {
      setNotice(String(error));
    } finally {
      setLoadingSample(false);
      setTimeout(() => setNotice(null), 6000);
    }
  }, [onCorpusChanged]);

  const ask = useCallback(async () => {
    const text = question.trim();
    if (!text || busy || !draft) return;

    setBusy(true);
    try {
      const ready = await applyDraft();
      if (!ready) return; // chunking changed — the banner asks for a re-index first

      const config = { ...draft };
      const response = await api.config();
      const id = ++runCounter;

      setRuns((prev) => [
        {
          id,
          hash: response.config_hash,
          config,
          changed: diffConfigs(prev[0]?.config ?? null, config),
          turn: {
            question: text,
            answer: "",
            citations: [],
            context: [],
            stages: [],
            trace: null,
            error: null,
            streaming: true
          }
        },
        ...prev
      ]);

      const patch = (fn: (turn: Turn) => Turn) =>
        setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, turn: fn(r.turn) } : r)));

      // The Lab always asks standalone questions — no history — so every run is a fair
      // comparison of settings rather than of conversational context.
      for await (const event of api.chat(text, [])) {
        switch (event.type) {
          case "stage":
            patch((t) => ({ ...t, stages: mergeStage(t.stages, event.stage) }));
            break;
          case "context":
            patch((t) => ({ ...t, context: event.chunks }));
            break;
          case "token":
            patch((t) => ({ ...t, answer: t.answer + event.text }));
            break;
          case "done":
            patch((t) => ({
              ...t,
              trace: event.trace,
              citations: event.trace.citations,
              answer: event.trace.answer ?? t.answer,
              streaming: false
            }));
            break;
          case "error":
            patch((t) => ({
              ...t,
              error: { message: event.message, remedy: event.remedy },
              streaming: false
            }));
            break;
        }
      }
    } finally {
      setRuns((prev) => prev.map((r) => ({ ...r, turn: { ...r.turn, streaming: false } })));
      setBusy(false);
    }
  }, [question, busy, draft, applyDraft]);

  if (!draft) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader label="loading configuration" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ── Config rail ── */}
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-line">
        <div className="px-4 pt-4 pb-1">
          <h2 className="font-display text-[11px] tracking-[0.18em] text-subtle uppercase">
            Pipeline settings
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-subtle">
            Settings apply when you ask. Greyed-out controls are on the roadmap but not
            built yet — they are shown so the config never pretends.
          </p>
        </div>

        {KNOB_GROUPS.map((group) => (
          <section key={group.title} className="border-b border-line/60 px-4 py-3">
            <h3
              data-hint={group.hint}
              className="hint mb-2 font-display text-[10px] tracking-[0.16em] text-subtle uppercase"
            >
              {group.title}
            </h3>
            <div className="space-y-2.5">
              {group.knobs
                .filter((knob) => !knob.visibleWhen || knob.visibleWhen(draft))
                .map((knob) => (
                  <KnobControl
                    key={knob.key}
                    knob={knob}
                    value={draft[knob.key]}
                    onChange={(value) => setDraft((d) => ({ ...d!, [knob.key]: value }))}
                  />
                ))}
            </div>
          </section>
        ))}

        {/* Corpus */}
        <section className="px-4 py-3">
          <h3 className="mb-2 font-display text-[10px] tracking-[0.16em] text-subtle uppercase">
            Corpus
          </h3>
          <p className="tabular font-mono text-[10px] text-subtle">
            {docCount} documents · {chunkCount} chunks indexed
          </p>
          {chunkCount < 20 ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-subtle">
              With this few chunks every search returns everything and settings barely
              differ. The bundled corpus (10 documents, ~60 chunks) makes comparisons
              meaningful.
            </p>
          ) : null}
          <button
            onClick={() => void loadSample()}
            disabled={loadingSample}
            className="mt-2 border border-line px-2.5 py-1 font-mono text-[10px] transition-colors hover:border-foreground/50 disabled:opacity-40"
          >
            {loadingSample ? "indexing…" : "load sample corpus"}
          </button>
          {notice ? (
            <p className="mt-2 font-mono text-[10px] text-subtle">{notice}</p>
          ) : null}
        </section>
      </aside>

      {/* ── Runs ── */}
      <section className="flex min-w-0 flex-1 flex-col">
        {needsReindex || dirtyChunking ? (
          <div className="border-b border-slow/40 bg-slow/5 px-5 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <p className="text-[11px] text-muted">
                Chunking changed — the {chunkCount} stored chunks were cut under the old
                settings. Re-index to apply ({docCount} documents will be re-chunked and
                re-embedded).
              </p>
              <button
                onClick={() => void runReindex()}
                disabled={reindexing}
                className="border border-slow/60 px-2.5 py-1 font-display text-[10px] tracking-[0.14em] text-slow uppercase transition-colors hover:bg-slow hover:text-background disabled:opacity-40"
              >
                {reindexing ? "re-indexing…" : "re-index now"}
              </button>
            </div>
          </div>
        ) : null}

        <div className="glass-strong border-x-0 border-t-0">
          <div className="flex items-end gap-2 px-5 py-3">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask();
                }
              }}
              rows={1}
              placeholder="Ask the same question under different settings…"
              className="max-h-32 min-h-[38px] flex-1 resize-none border border-line bg-transparent px-3 py-2 text-[13px] outline-none transition-colors focus:border-foreground/45"
            />
            <button
              onClick={() => void ask()}
              disabled={busy || !question.trim() || (needsReindex && dirtyChunking)}
              data-hint={
                dirty
                  ? "Your edited settings will be applied first, then the question runs under them."
                  : "Runs the question under the settings on the left."
              }
              className="hint hint-end h-[38px] border border-line px-4 font-display text-[11px] tracking-[0.16em] uppercase transition-colors hover:border-foreground/60 hover:bg-foreground hover:text-background disabled:pointer-events-none disabled:opacity-30"
            >
              {dirty ? "Apply + Ask" : "Ask"}
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 items-start gap-4 overflow-x-auto p-4">
          {runs.length === 0 ? <LabEmptyState /> : null}
          {runs.map((run, i) => (
            <RunCard
              key={run.id}
              run={run}
              isLatest={i === 0}
              selected={selectedChunk}
              onSelect={setSelectedChunk}
              onCite={onCite}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

/* ── Controls ─────────────────────────────────────────────────────────────── */

function KnobControl({
  knob,
  value,
  onChange
}: {
  knob: Knob;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const disabled = !knob.implemented;

  return (
    <div className={disabled ? "opacity-45" : ""}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label data-hint={knob.hint} className="hint text-[11px] text-muted">
          {knob.label}
        </label>
        {disabled ? (
          <span
            data-hint={knob.hint}
            className="hint hint-end font-mono text-[8px] tracking-wide text-subtle uppercase"
          >
            not built yet
          </span>
        ) : knob.reindexes ? (
          <span
            data-hint="Changing this rewrites the stored index, so applying it offers a re-index of everything already uploaded."
            className="hint hint-end font-mono text-[8px] tracking-wide text-slow uppercase"
          >
            re-index
          </span>
        ) : null}
      </div>

      {knob.type === "segmented" && knob.options ? (
        <div className="flex">
          {knob.options.map((option) => (
            <button
              key={option.value}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={[
                "-ml-px border px-2.5 py-1 font-mono text-[10px] transition-colors first:ml-0",
                value === option.value
                  ? "z-10 border-foreground/60 bg-foreground text-background"
                  : "border-line text-subtle hover:border-foreground/40 hover:text-foreground",
                "disabled:pointer-events-none"
              ].join(" ")}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}

      {knob.type === "number" ? (
        <input
          type="number"
          disabled={disabled}
          value={String(value ?? "")}
          min={knob.min}
          max={knob.max}
          onChange={(e) => onChange(clamp(Number(e.target.value), knob.min, knob.max))}
          className="tabular w-24 border border-line bg-transparent px-2 py-1 font-mono text-[11px] outline-none transition-colors focus:border-foreground/45"
        />
      ) : null}

      {knob.type === "range" ? (
        <div className="flex items-center gap-2.5">
          <input
            type="range"
            disabled={disabled}
            value={Number(value ?? 0)}
            min={knob.min}
            max={knob.max}
            step={knob.step}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-px flex-1 appearance-none bg-foreground/25 accent-current"
          />
          <span className="tabular w-9 text-right font-mono text-[10px]">
            {Number(value ?? 0).toFixed(knob.step && knob.step < 1 ? 2 : 0)}
          </span>
        </div>
      ) : null}

      {knob.type === "toggle" ? (
        <button
          disabled={disabled}
          onClick={() => onChange(!value)}
          className={[
            "border px-2.5 py-1 font-mono text-[10px] transition-colors",
            value
              ? "border-foreground/60 bg-foreground text-background"
              : "border-line text-subtle hover:border-foreground/40",
            "disabled:pointer-events-none"
          ].join(" ")}
        >
          {value ? "on" : "off"}
        </button>
      ) : null}
    </div>
  );
}

function clamp(n: number, min?: number, max?: number): number {
  if (Number.isNaN(n)) return min ?? 0;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/* ── Run cards ────────────────────────────────────────────────────────────── */

function RunCard({
  run,
  isLatest,
  selected,
  onSelect,
  onCite
}: {
  run: LabRun;
  isLatest: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onCite: (citation: Citation) => void;
}) {
  const { turn } = run;

  return (
    <article
      className={[
        "reveal relative w-[42rem] shrink-0 border bg-background",
        isLatest ? "panel-ticks border-foreground/30" : "border-line"
      ].join(" ")}
    >
      <header className="border-b border-line px-4 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="min-w-0 truncate font-display text-[13px] tracking-wide">
            {turn.question}
          </h3>
          <span
            data-hint="Identifies the exact pipeline settings this run used. Two runs with the same hash used identical settings."
            className="hint hint-end tabular shrink-0 font-mono text-[9px] text-subtle"
          >
            {run.hash}
          </span>
        </div>
        {run.changed.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {run.changed.map((change) => (
              <span
                key={change.key}
                data-hint="What changed relative to the previous run — the variable this comparison isolates."
                className="hint tabular border border-foreground/30 px-1.5 py-0.5 font-mono text-[9px]"
              >
                {change.key}: {String(change.from)} → {String(change.to)}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1 font-mono text-[9px] text-subtle">baseline</p>
        )}
      </header>

      <div className="space-y-3 px-4 py-3">
        <StageStrip stages={turn.stages} streaming={turn.streaming} />

        {turn.error ? (
          <div className="border border-critical/50 px-3 py-2">
            <p className="text-[12px] text-muted">{turn.error.message}</p>
            {turn.error.remedy ? (
              <p className="mt-1 font-mono text-[10px] text-subtle">→ {turn.error.remedy}</p>
            ) : null}
          </div>
        ) : null}

        {turn.stages.some((s) => s.candidates_out) ? (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-display text-[9px] tracking-[0.16em] text-subtle uppercase">
                Retrieval
              </span>
              <SourceLegend />
            </div>
            <RetrievalTable
              stages={turn.stages}
              context={turn.context}
              selected={selected}
              onSelect={onSelect}
            />
          </div>
        ) : null}

        {turn.answer || turn.streaming ? (
          <div className={turn.streaming ? "caret" : ""}>
            <AnswerText text={turn.answer} citations={turn.citations} onCite={onCite} />
          </div>
        ) : null}
      </div>
    </article>
  );
}

function LabEmptyState() {
  return (
    <div className="reveal max-w-md px-2 py-8">
      <p className="text-[13px] leading-relaxed text-muted">
        Ask a question, then change one setting and ask it again. Each run becomes a card,
        newest on the left, with the changed setting highlighted — so the difference
        between two configurations is something you read, not something you remember.
      </p>
      <div className="rule-dashed my-5" />
      <ul className="space-y-1.5 font-mono text-[11px] text-subtle">
        <li>try: hybrid vs vector-only on the same question</li>
        <li>try: chunk size 512 vs 192 on a structured document</li>
        <li>try: RRF damping k at 5 vs 60</li>
      </ul>
    </div>
  );
}

/** Stage events can arrive more than once for the same stage; last write wins. */
function mergeStage(stages: StageRecord[], incoming: StageRecord): StageRecord[] {
  const at = stages.findIndex((s) => s.name === incoming.name);
  if (at === -1) return [...stages, incoming];
  const next = [...stages];
  next[at] = incoming;
  return next;
}
