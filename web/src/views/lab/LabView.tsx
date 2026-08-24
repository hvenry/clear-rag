import {
  ChatsCircleIcon,
  DatabaseIcon,
  MagnifyingGlassIcon,
  ScissorsIcon,
  SparkleIcon,
  type Icon
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Composer } from "../../components/Composer";
import { EmptyState } from "../../components/EmptyState";
import { HoverInfo } from "../../components/HoverInfo";
import { Loader } from "../../components/Loader";
import { PanelTrigger, SidePanel } from "../../components/SidePanel";
import { api } from "../../lib/api";
import { diffConfigs, KNOB_GROUPS, REINDEX_KEYS } from "../../lib/knobs";
import { useDocuments, useHealth, useLoadSample, useReindex, useUpdateConfig } from "../../lib/queries";
import { formatMs, mergeStage } from "../../lib/stages";
import type { Turn } from "../../lib/types";
import { KnobControl } from "./KnobControl";
import { RunCard, type LabRun } from "./RunCard";

/**
 * The Lab: change one retrieval setting, ask the same question again, and read the runs
 * side by side. Watching the pipeline explains what RAG does; experimenting on it
 * explains why.
 *
 * Settings apply when you ask — a dirty draft is applied automatically before the run,
 * so a card always shows results produced under exactly the settings it displays. The
 * one exception is ingestion: those settings rewrite the stored index, so the re-index
 * stays an explicit button with its cost stated, never a side effect.
 */

const GROUP_ICON: Record<string, Icon> = {
  Retrieval: MagnifyingGlassIcon,
  Ingestion: ScissorsIcon,
  Conversation: ChatsCircleIcon,
  Generation: SparkleIcon
};

let runCounter = 0;

export function LabView() {
  const { data: health } = useHealth();
  const { data: documents = [] } = useDocuments();
  const updateConfig = useUpdateConfig();
  const reindexMutation = useReindex();
  const loadSampleMutation = useLoadSample();
  const chunkCount = health?.chunks ?? 0;
  const docCount = documents.length;

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);

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

  const dirtyParser = useMemo(
    () => draft != null && applied != null && draft.parser !== applied.parser,
    [draft, applied]
  );

  const applyDraft = useCallback(async (): Promise<boolean> => {
    if (!draft || !dirty) return true;
    const response = await updateConfig.mutateAsync(draft);
    setApplied(response.config);
    setDraft(response.config);
    if (response.reindex_needed) setNeedsReindex(true);
    return !response.reindex_needed;
  }, [draft, dirty, updateConfig]);

  const runReindex = useCallback(async () => {
    setReindexing(true);
    try {
      await applyDraft();
      const report = await reindexMutation.mutateAsync();
      setNeedsReindex(false);
      setNotice(
        `Re-indexed ${report.total_chunks} chunks in ${formatMs(report.duration_ms)}.`
      );
    } catch (error) {
      setNotice(String(error));
    } finally {
      setReindexing(false);
      setTimeout(() => setNotice(null), 6000);
    }
  }, [applyDraft, reindexMutation]);

  const loadSample = useCallback(async () => {
    setLoadingSample(true);
    try {
      const report = await loadSampleMutation.mutateAsync();
      setNotice(
        report.indexed
          ? `Indexed ${report.indexed} sample documents.`
          : "Sample corpus already indexed."
      );
    } catch (error) {
      setNotice(String(error));
    } finally {
      setLoadingSample(false);
      setTimeout(() => setNotice(null), 6000);
    }
  }, [loadSampleMutation]);

  const ask = useCallback(async () => {
    const text = question.trim();
    if (!text || busy || !draft) return;

    setBusy(true);
    try {
      const ready = await applyDraft();
      if (!ready) return; // ingestion changed — the banner asks for a re-index first

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
      {/* ── Config rail: collapsible on desktop, full-screen drawer on mobile ── */}
      <SidePanel
        title="Pipeline settings"
        widthClass="lg:w-80"
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        collapsed={railCollapsed}
        onCollapse={setRailCollapsed}
      >
        <div className="px-4 pt-3 pb-1">
          <p className="text-[11px] leading-relaxed text-subtle">
            Settings apply when you ask. Greyed-out controls are on the roadmap but not
            built yet — they are shown so the config never pretends.
          </p>
        </div>

        {KNOB_GROUPS.map((group) => {
          const GroupIcon = GROUP_ICON[group.title];
          return (
            <section key={group.title} className="border-b border-line/60 px-4 py-3">
              <HoverInfo text={group.hint} className="mb-2">
                <h3 className="flex items-center gap-1.5 font-display text-[10px] tracking-[0.16em] text-subtle uppercase">
                  {GroupIcon ? <GroupIcon size={12} /> : null}
                  {group.title}
                  {/* One marker for the whole group; the banner above the composer
                      carries the explanation. */}
                  {group.knobs.some((k) => k.reindexes) ? (
                    <span className="ml-auto font-mono text-[8px] tracking-wide text-slow">
                      re-index
                    </span>
                  ) : null}
                </h3>
              </HoverInfo>
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
          );
        })}

        {/* Corpus */}
        <section className="px-4 py-3">
          <h3 className="mb-2 flex items-center gap-1.5 font-display text-[10px] tracking-[0.16em] text-subtle uppercase">
            <DatabaseIcon size={12} />
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
      </SidePanel>

      {/* ── Runs on top; the composer is pinned to the bottom, matching Chat ── */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:p-4 lg:flex-row lg:items-start lg:overflow-x-auto lg:overflow-y-hidden">
          {runs.length === 0 ? (
            <div className="mx-auto w-full max-w-4xl pt-1 sm:px-1 sm:pt-2">
              <LabEmptyState />
            </div>
          ) : null}
          {runs.map((run, i) => (
            <RunCard
              key={run.id}
              run={run}
              isLatest={i === 0}
              selected={selectedChunk}
              onSelect={setSelectedChunk}
            />
          ))}
        </div>

        {needsReindex || dirtyChunking ? (
          <div className="border-t border-slow/40 bg-slow/5 px-3 py-2.5 sm:px-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <p className="text-[11px] text-muted">
                Ingestion settings changed — the {chunkCount} stored chunks were built
                under the old settings. Re-index to apply ({docCount} documents will be
                re-chunked and re-embedded).
                {dirtyParser
                  ? " The parser change only affects files uploaded from now on — re-indexing rebuilds from stored text and cannot re-parse."
                  : ""}
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

        <Composer
          value={question}
          onChange={setQuestion}
          onSubmit={() => void ask()}
          disabled={busy || (needsReindex && dirtyChunking)}
          placeholder="Ask under these settings…"
          actionLabel={dirty ? "Apply + Ask" : "Ask"}
          actionHint={
            dirty
              ? "Your edited settings will be applied first, then the question runs under them."
              : "Runs the question under the settings on the left."
          }
          leading={
            <PanelTrigger
              label={dirty ? "Settings ·" : "Settings"}
              onOpen={() => setSettingsOpen(true)}
            />
          }
        />
      </section>
    </div>
  );
}

function LabEmptyState() {
  return (
    <EmptyState lead="Ask a question, then change one setting and ask it again. Each run becomes a card, newest first, with the changed setting highlighted — so the difference between two configurations is something you read, not something you remember.">
      <ul className="space-y-1.5 font-mono text-[11px] text-subtle">
        <li>try: hybrid vs vector-only on the same question</li>
        <li>try: chunk size 512 vs 192 on a structured document</li>
        <li>try: RRF damping k at 5 vs 60</li>
        <li>try: recursive vs semantic chunking on a table question</li>
        <li>try: breadcrumb context on, then pin a chunk in the Library</li>
      </ul>
    </EmptyState>
  );
}
