import { useCallback, useEffect, useRef, useState } from "react";

import { AnswerText, CitationList } from "./components/Citations";
import { HealthBanner } from "./components/HealthBanner";
import { SourceLegend } from "./components/Legend";
import { Panel, SectionLabel } from "./components/Panel";
import { MIN_CANDIDATES_FOR_FLOW, RankFlow } from "./components/RankFlow";
import { RetrievalTable } from "./components/RetrievalTable";
import { StageStrip } from "./components/StageStrip";
import { ThemeToggle } from "./components/ThemeToggle";
import { api } from "./lib/api";
import { formatMs } from "./lib/stages";
import { LabView } from "./views/LabView";
import { LibraryView } from "./views/LibraryView";
import type {
  Citation,
  ConfigResponse,
  DocumentSummary,
  Health,
  StageRecord,
  Turn
} from "./lib/types";

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "library" | "lab">("chat");
  const [inspecting, setInspecting] = useState<{ docId: string; span?: [number, number] } | null>(
    null
  );
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);

  const refresh = useCallback(async () => {
    const [h, d, c] = await Promise.allSettled([api.health(), api.documents(), api.config()]);
    if (h.status === "fulfilled") setHealth(h.value);
    if (d.status === "fulfilled") setDocuments(d.value);
    if (c.status === "fulfilled") setConfig(c.value);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  // ── Upload ──

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploading(`Indexing ${files.length} file${files.length > 1 ? "s" : ""}…`);
      try {
        const { results } = await api.upload(files);
        const rejected = results.filter((r) => r.status !== "indexed" && r.status !== "unchanged");
        setUploading(
          rejected.length
            ? rejected.map((r) => `${r.filename}: ${r.message}`).join(" · ")
            : null
        );
        if (rejected.length) setTimeout(() => setUploading(null), 6000);
        await refresh();
      } catch (error) {
        setUploading(String(error));
        setTimeout(() => setUploading(null), 6000);
      }
    },
    [refresh]
  );

  // Drag events fire for every nested element, so depth counting is what keeps the
  // overlay from flickering as the cursor crosses child boundaries.
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) setDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void upload(Array.from(e.dataTransfer.files));
  };

  // ── Ask ──

  const ask = useCallback(async () => {
    const text = question.trim();
    if (!text || busy) return;

    setQuestion("");
    setBusy(true);
    setSelectedChunk(null);

    const history = turns.flatMap((t) =>
      t.answer
        ? [
            { role: "user", content: t.question },
            { role: "assistant", content: t.answer }
          ]
        : []
    );

    const index = turns.length;
    setTurns((prev) => [
      ...prev,
      {
        question: text,
        answer: "",
        citations: [],
        context: [],
        stages: [],
        trace: null,
        error: null,
        streaming: true
      }
    ]);

    const patch = (fn: (turn: Turn) => Turn) =>
      setTurns((prev) => prev.map((t, i) => (i === index ? fn(t) : t)));

    try {
      for await (const event of api.chat(text, history)) {
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
    } catch (error) {
      patch((t) => ({ ...t, error: { message: String(error) }, streaming: false }));
    } finally {
      patch((t) => ({ ...t, streaming: false }));
      setBusy(false);
      void refresh();
    }
  }, [question, busy, turns, refresh]);

  const openCitation = (citation: Citation) => {
    setInspecting({ docId: citation.doc_id, span: citation.span });
    setView("library");
  };

  return (
    <div
      className="flex h-full flex-col"
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* ── Header ── */}
      <header className="glass-strong sticky top-0 z-20 border-x-0 border-t-0">
        <div className="flex items-center justify-between gap-4 px-5 py-3">
          <div className="flex items-baseline gap-5">
            <h1 className="font-display text-[15px] font-medium tracking-[0.2em] uppercase">
              clear<span className="opacity-45">-rag</span>
            </h1>
            <nav className="flex items-center gap-1">
              {(["chat", "library", "lab"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  data-hint={
                    v === "chat"
                      ? "Ask questions and watch each retrieval stage as it runs."
                      : v === "library"
                        ? "Inspect how each document was split into the chunks retrieval searches over."
                        : "Change pipeline settings and compare runs of the same question side by side."
                  }
                  className={[
                    "hint border px-2.5 py-1 font-display text-[10px] tracking-[0.16em] uppercase transition-colors",
                    view === v
                      ? "border-foreground/50 bg-foreground text-background"
                      : "border-line text-subtle hover:border-foreground/40 hover:text-foreground"
                  ].join(" ")}
                >
                  {v}
                  {v === "library" && documents.length ? (
                    <span className="tabular ml-1.5 opacity-60">{documents.length}</span>
                  ) : null}
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {config ? (
              <span
                data-hint={`Chat model: ${config.providers.chat.model} via ${config.providers.chat.provider}. Embedding model: ${config.providers.embeddings.model}. Config hash ${config.config_hash} identifies the exact retrieval settings every trace was recorded under.`}
                className="hint hint-end hidden font-mono text-[10px] text-subtle md:inline"
              >
                {config.providers.chat.model} · {config.providers.embeddings.model} ·{" "}
                {config.config_hash}
              </span>
            ) : null}
            <span
              data-hint={
                health?.ok
                  ? "All providers reachable and the index matches the configured embedding model."
                  : "A provider check failed — see the banner below."
              }
              className={`hint hint-end h-1.5 w-1.5 ${health?.ok ? "bg-keyword" : "bg-critical"}`}
            />
            <ThemeToggle />
          </div>
        </div>
        <HealthBanner health={health} />
      </header>

      {view === "library" ? (
        <div className="min-h-0 flex-1">
          <LibraryView
            documents={documents}
            onChanged={() => void refresh()}
            initialDocId={inspecting?.docId ?? null}
          />
        </div>
      ) : view === "lab" ? (
        <div className="min-h-0 flex-1">
          <LabView
            chunkCount={health?.chunks ?? 0}
            docCount={documents.length}
            onCorpusChanged={() => void refresh()}
            onCite={openCitation}
          />
        </div>
      ) : (
        <main className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-5 py-6">
              {turns.length === 0 ? <EmptyState /> : null}

              {turns.map((turn, i) => (
                <article key={i} className="reveal mb-10">
                  <h2 className="mb-3 font-display text-[16px] leading-snug tracking-wide">
                    {turn.question}
                  </h2>

                  <StageStrip stages={turn.stages} streaming={turn.streaming} />

                  {turn.trace?.resolved_query &&
                  turn.trace.resolved_query !== turn.question ? (
                    <p
                      data-hint="Your question referred back to the conversation, so it was rewritten into a standalone query before searching. This is the text the retrievers actually received."
                      className="hint mt-2 font-mono text-[10px] text-subtle"
                    >
                      searched as: “{turn.trace.resolved_query}”
                    </p>
                  ) : null}

                  {turn.stages.some((s) => s.candidates_out) ? (
                    <Panel ticks className="mt-4">
                      <SectionLabel
                        right={
                          turn.trace ? (
                            <span
                              data-hint="Wall-clock time for the whole pipeline, from receiving the question to the last token of the answer."
                              className="hint hint-end tabular"
                            >
                              {formatMs(turn.trace.total_ms)}
                            </span>
                          ) : undefined
                        }
                      >
                        Retrieval inspector
                      </SectionLabel>

                      <div className="border-y border-line px-4 py-2.5">
                        <p className="text-[11px] leading-relaxed text-subtle">
                          Two searches run at once over the same documents. Keyword search
                          matches words; vector search matches meaning. Their rankings are
                          merged, and whatever survives is packed into the prompt. Every
                          column below is one of those steps.
                        </p>
                        <div className="mt-2">
                          <SourceLegend />
                        </div>
                      </div>

                      <div className="px-4 py-2">
                        <RetrievalTable
                          stages={turn.stages}
                          context={turn.context}
                          selected={selectedChunk}
                          onSelect={setSelectedChunk}
                        />
                      </div>

                      {countCandidates(turn.stages) >= MIN_CANDIDATES_FOR_FLOW ? (
                        <>
                          <div className="border-t border-line px-4 pt-3 pb-1">
                            <h3 className="font-display text-[10px] tracking-[0.16em] text-subtle uppercase">
                              Rank flow
                            </h3>
                            <p className="mt-1 text-[10px] text-subtle">
                              Each line is a chunk; height is its rank. Watch lines cross as
                              merging and reranking change the order.
                            </p>
                          </div>
                          <div className="px-2 pb-2">
                            <RankFlow
                              stages={turn.stages}
                              selected={selectedChunk}
                              onSelect={setSelectedChunk}
                            />
                          </div>
                        </>
                      ) : null}
                    </Panel>
                  ) : null}

                  {turn.error ? (
                    <Panel className="mt-4 border-critical/50 px-4 py-3">
                      <p className="text-[13px] text-muted">{turn.error.message}</p>
                      {turn.error.remedy ? (
                        <p className="mt-1 font-mono text-[11px] text-subtle">
                          → {turn.error.remedy}
                        </p>
                      ) : null}
                    </Panel>
                  ) : null}

                  {turn.answer || turn.streaming ? (
                    <div className="mt-4">
                      <div className={turn.streaming ? "caret" : ""}>
                        <AnswerText
                          text={turn.answer}
                          citations={turn.citations}
                          onCite={openCitation}
                        />
                      </div>
                      <CitationList citations={turn.citations} onCite={openCitation} />
                    </div>
                  ) : null}
                </article>
              ))}
              <div ref={bottomRef} />
            </div>
          </div>

          {/* ── Composer ── */}
          <div className="glass-strong border-x-0 border-b-0">
            <div className="mx-auto w-full max-w-4xl px-5 py-4">
              {uploading ? (
                <p className="mb-2 font-mono text-[10px] text-subtle">{uploading}</p>
              ) : null}
              <div className="flex items-end gap-2">
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
                  placeholder={
                    documents.length
                      ? "Ask a question about your documents…"
                      : "Drop a document anywhere to begin…"
                  }
                  className="max-h-40 min-h-[42px] flex-1 resize-none border border-line bg-transparent px-3 py-2.5 text-[13px] outline-none transition-colors focus:border-foreground/45"
                />
                <button
                  onClick={() => void ask()}
                  disabled={busy || !question.trim()}
                  className="h-[42px] border border-line px-4 font-display text-[11px] tracking-[0.16em] uppercase transition-colors hover:border-foreground/60 hover:bg-foreground hover:text-background disabled:pointer-events-none disabled:opacity-30"
                >
                  Ask
                </button>
              </div>
            </div>
          </div>
        </main>
      )}

      {/* ── Drop overlay ── */}
      {dragging ? (
        <div className="glass-strong pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
          <div className="panel-ticks relative border border-foreground/40 px-10 py-8 text-center">
            <p className="font-display text-[14px] tracking-[0.2em] uppercase">Drop to index</p>
            <p className="mt-1.5 font-mono text-[10px] text-subtle">
              pdf · docx · md · csv · txt
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** How many distinct chunks retrieval considered — decides whether a chart earns space. */
function countCandidates(stages: StageRecord[]): number {
  const ids = new Set<string>();
  stages.forEach((s) => s.candidates_out?.forEach((c) => ids.add(c.chunk_id)));
  return ids.size;
}

/** Stage events can arrive more than once for the same stage; last write wins. */
function mergeStage(stages: StageRecord[], incoming: StageRecord): StageRecord[] {
  const at = stages.findIndex((s) => s.name === incoming.name);
  if (at === -1) return [...stages, incoming];
  const next = [...stages];
  next[at] = incoming;
  return next;
}

function EmptyState() {
  return (
    <div className="reveal py-14">
      <p className="max-w-lg text-[14px] leading-relaxed text-muted">
        Ask a question and watch retrieval happen — keyword search and vector search run
        side by side, their rankings fuse, and documents change position before a single
        word of the answer is written.
      </p>
      <div className="rule-dashed my-6 max-w-lg" />
      <ul className="space-y-1.5 font-mono text-[11px] text-subtle">
        <li>drop a file anywhere on this window to index it</li>
        <li>hover anything to find out what it means</li>
        <li>click a citation to open the source, highlighted at the exact sentence</li>
        <li>open Library to see how a document was split into chunks</li>
      </ul>
    </div>
  );
}
