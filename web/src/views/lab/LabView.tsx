import {
  ArrowCounterClockwiseIcon,
  ChatsCircleIcon,
  MagnifyingGlassIcon,
  ScissorsIcon,
  SparkleIcon,
  type Icon
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from "react";
import { useNavigate } from "react-router-dom";

import { Composer } from "../../components/Composer";
import { EmptyState } from "../../components/EmptyState";
import { Loader } from "../../components/Loader";
import { PanelTrigger, SidePanel } from "../../components/SidePanel";
import { api } from "../../lib/api";
import { diffConfigs, KNOB_GROUPS, REINDEX_KEYS } from "../../lib/knobs";
import { formatElapsed, useElapsedSeconds } from "../../lib/importer";
import { useDocuments, useHealth, useInvalidateCorpus, useUpdateConfig } from "../../lib/queries";
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

/** Hints preference survives view switches but not a reload — a mode, not an address. */
let hintsPref = true;

export function LabView() {
  const { data: health } = useHealth();
  const { data: documents = [] } = useDocuments();
  const updateConfig = useUpdateConfig();
  const invalidateCorpus = useInvalidateCorpus();
  const chunkCount = health?.chunks ?? 0;
  const docCount = documents.length;

  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [applied, setApplied] = useState<Record<string, unknown> | null>(null);
  const [defaults, setDefaults] = useState<Record<string, unknown> | null>(null);
  const [needsReindex, setNeedsReindex] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [reindexProgress, setReindexProgress] = useState<{
    filename: string;
    index: number;
    total: number;
  } | null>(null);
  const [reindexStartedAt, setReindexStartedAt] = useState<number | null>(null);
  const reindexElapsed = useElapsedSeconds(
    reindexStartedAt ?? 0,
    reindexStartedAt === null ? 0 : null
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [runs, setRuns] = useState<LabRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);

  // ── Hint card: slides out from under the rail's right border, at the hovered
  // row's height. Content persists while hidden so the slide-back animates. ──
  const navigate = useNavigate();
  const [hintsOn, setHintsOn] = useState(hintsPref);
  const [hintCard, setHintCard] = useState<{
    title: string;
    text: string;
    learn: string | null;
    top: number;
    left: number;
  } | null>(null);
  const [hintVisible, setHintVisible] = useState(false);
  const hintHideTimer = useRef<number | undefined>(undefined);

  const showHint = (
    e: ReactMouseEvent<HTMLElement>,
    title: string,
    text: string,
    learn?: string
  ) => {
    if (!hintsOn) return;
    window.clearTimeout(hintHideTimer.current);
    const rect = e.currentTarget.getBoundingClientRect();
    setHintCard({
      title,
      text,
      learn: learn ?? null,
      top: Math.max(8, Math.min(rect.top, window.innerHeight - 220)),
      left: rect.right
    });
    setHintVisible(true);
  };
  // A short grace, not a delay: the card shows instantly, but the pointer needs a
  // moment to cross from the row into the card without it sliding away.
  const hideHint = () => {
    window.clearTimeout(hintHideTimer.current);
    hintHideTimer.current = window.setTimeout(() => setHintVisible(false), 150);
  };
  const holdHint = () => window.clearTimeout(hintHideTimer.current);
  const toggleHints = () => {
    setHintsOn((on) => {
      hintsPref = !on;
      if (on) setHintVisible(false);
      return !on;
    });
  };
  const hintRow = `-mx-4 px-4 py-1 transition-colors ${hintsOn ? "hover:bg-foreground/5" : ""}`;

  useEffect(() => {
    api.config().then((response) => {
      setDraft(response.config);
      setApplied(response.config);
      setDefaults(response.defaults);
    });
  }, []);

  const isDefault = useMemo(
    () => defaults !== null && JSON.stringify(draft) === JSON.stringify(defaults),
    [draft, defaults]
  );

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
    setReindexStartedAt(Date.now());
    // The backend's note flags what a re-index could NOT do — e.g. PDFs keeping
    // text from a different parser backend. Dropping it made the parser knob look
    // broken after a re-index, and a warning deserves more screen time than a count.
    let linger = 6000;
    try {
      await applyDraft();
      for await (const event of api.reindexStream()) {
        switch (event.type) {
          case "start":
            setReindexProgress({ filename: "", index: 0, total: event.filenames.length });
            break;
          case "doc":
            setReindexProgress({
              filename: event.filename,
              index: event.index,
              total: event.total
            });
            break;
          case "done":
            setNeedsReindex(false);
            if (event.note) linger = 15000;
            setNotice(
              `Re-indexed ${event.total_chunks} chunks in ${formatMs(event.duration_ms)}.` +
                (event.note ? ` ${event.note}` : "")
            );
            break;
          case "error":
            setNotice(event.message + (event.remedy ? ` — ${event.remedy}` : ""));
            break;
        }
      }
    } catch (error) {
      setNotice(String(error));
    } finally {
      setReindexing(false);
      setReindexProgress(null);
      setReindexStartedAt(null);
      void invalidateCorpus();
      setTimeout(() => setNotice(null), linger);
    }
  }, [applyDraft, invalidateCorpus]);

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
        onCollapse={(collapsed) => {
          setRailCollapsed(collapsed);
          // Unmount, not just slide away: "hidden" tucks the card under the wide
          // panel, and the collapsed strip is too narrow to cover it.
          if (collapsed) {
            window.clearTimeout(hintHideTimer.current);
            setHintVisible(false);
            setHintCard(null);
          }
        }}
        headerExtra={
          <button
            onClick={toggleHints}
            className="font-display text-[9px] tracking-[0.14em] text-subtle uppercase transition-colors hover:text-foreground"
          >
            {hintsOn ? "hide hints" : "show hints"}
          </button>
        }
        footer={
          // Only when something actually deviates from the defaults — a reset
          // button with nothing to reset is furniture. Restores the backend's own
          // defaults into the draft; it applies on the next ask like any other
          // edit, so the re-index banner still guards chunking changes.
          defaults !== null && !isDefault ? (
            <div className="px-4 py-3">
              <button
                onClick={() => setDraft({ ...defaults })}
                className="flex w-full items-center justify-center gap-1.5 border border-line px-2 py-1 font-mono text-[10px] text-subtle transition-colors hover:border-foreground/50"
              >
                <ArrowCounterClockwiseIcon size={12} />
                reset to defaults
              </button>
            </div>
          ) : undefined
        }
      >
        {KNOB_GROUPS.map((group) => {
          const GroupIcon = GROUP_ICON[group.title];
          return (
            <section key={group.title} className="border-b border-line/60 px-4 py-3">
              <div
                onMouseEnter={(e) => showHint(e, group.title, group.hint, group.learn)}
                onMouseLeave={hideHint}
                className={`mb-1 ${hintRow}`}
              >
                <h3 className="flex items-center gap-1.5 font-display text-[10px] tracking-[0.16em] text-subtle uppercase">
                  {GroupIcon ? <GroupIcon size={12} /> : null}
                  {group.title}
                </h3>
              </div>
              <div className="space-y-1">
                {group.knobs
                  .filter((knob) => !knob.visibleWhen || knob.visibleWhen(draft))
                  .map((knob) => (
                    <div
                      key={knob.key}
                      onMouseEnter={(e) => showHint(e, knob.label, knob.hint, knob.learn)}
                      onMouseLeave={hideHint}
                      className={hintRow}
                    >
                      <KnobControl
                        knob={knob}
                        value={draft[knob.key]}
                        onChange={(value) => setDraft((d) => ({ ...d!, [knob.key]: value }))}
                      />
                    </div>
                  ))}
              </div>
            </section>
          );
        })}

      </SidePanel>

      {/* ── The hint card: fixed at the hovered row's height, sliding out from
          under the rail's right border (the rail paints above it at z-10).
          Hovering the card itself keeps it open. Desktop only — on mobile the
          settings drawer covers the screen and there is no hover. ── */}
      {hintCard ? (
        <div
          onMouseEnter={holdHint}
          onMouseLeave={hideHint}
          style={{ left: hintCard.left, top: hintCard.top }}
          className={[
            // Same elevation as the header dropdown cards.
            "fixed z-[5] hidden w-72 border border-line bg-background py-3 pr-3 pl-5 shadow-[0_8px_28px_rgb(0_0_0/0.4)] lg:block",
            "transition-all duration-150 ease-out",
            hintVisible && hintsOn ? "translate-x-0" : "pointer-events-none -translate-x-full"
          ].join(" ")}
        >
          <p className="menu-label mb-1">{hintCard.title}</p>
          <p className="text-[11px] leading-relaxed text-muted">{hintCard.text}</p>
          {hintCard.learn ? (
            // Same affordance as the chat's stage inspector: one step from a
            // setting to the concept page explaining it.
            <button
              onClick={() => navigate(`/learn/${hintCard.learn}`)}
              className="mt-2 w-full border border-line px-2 py-1 text-left font-mono text-[10px] text-subtle transition-colors hover:border-foreground/50 hover:text-foreground"
            >
              more info →
            </button>
          ) : null}
        </div>
      ) : null}

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
              {!reindexing ? (
                <button
                  onClick={() => void runReindex()}
                  className="border border-slow/60 px-2.5 py-1 font-display text-[10px] tracking-[0.14em] text-slow uppercase transition-colors hover:bg-slow hover:text-background"
                >
                  re-index now
                </button>
              ) : null}
            </div>
            {reindexing && reindexProgress ? (
              <div className="mt-2">
                <div className="h-1 w-full bg-slow/15">
                  <div
                    className="h-full bg-slow transition-[width] duration-300"
                    style={{
                      width: `${
                        reindexProgress.total
                          ? Math.round((reindexProgress.index / reindexProgress.total) * 100)
                          : 0
                      }%`
                    }}
                  />
                </div>
                <p className="tabular mt-1 flex justify-between gap-2 font-mono text-[10px] text-subtle">
                  <span className="truncate">
                    {reindexProgress.index}/{reindexProgress.total}
                    {reindexProgress.filename ? ` · ${reindexProgress.filename}` : ""}
                  </span>
                  <span className="shrink-0">{formatElapsed(reindexElapsed)}</span>
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Re-index results surface here now that the corpus section is gone —
            document management itself lives in the Library. */}
        {notice ? (
          <div className="border-t border-line px-3 py-1.5 sm:px-5">
            <p className="tabular font-mono text-[10px] text-subtle">{notice}</p>
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
