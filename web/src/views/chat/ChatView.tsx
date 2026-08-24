import {
  BooksIcon,
  CaretDownIcon,
  ChartLineIcon,
  CursorIcon,
  FlaskIcon,
  QuotesIcon
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";

import { useExplainStage, useOpenCitation } from "../../app/navigation";
import type { AppOutletContext } from "../../app/session";
import { Composer } from "../../components/Composer";
import { EmptyState } from "../../components/EmptyState";
import { ErrorNotice } from "../../components/ErrorNotice";
import { Panel, SectionLabel } from "../../components/Panel";
import { AnswerText, CitationList } from "../../components/retrieval/Citations";
import { SourceLegend } from "../../components/retrieval/Legend";
import { MIN_CANDIDATES_FOR_FLOW, RankFlow } from "../../components/retrieval/RankFlow";
import { RetrievalTable } from "../../components/retrieval/RetrievalTable";
import { StageStrip } from "../../components/retrieval/StageStrip";
import { useDocuments } from "../../lib/queries";
import { formatMs } from "../../lib/stages";
import type { StageRecord, Turn } from "../../lib/types";
import { TelemetryPanel } from "./TelemetryPanel";

/**
 * The chat view. Its *session* — the turns, the streaming state, the composer's
 * draft — lives in the layout above the routes, so navigating to the Library and
 * back never wipes a conversation. This component only renders it.
 */
export function ChatView() {
  const { session, uploading } = useOutletContext<AppOutletContext>();
  const { turns, question, setQuestion, ask, busy } = session;
  const { data: documents = [] } = useDocuments();
  const openCitation = useOpenCitation();
  const explainStage = useExplainStage();
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <TelemetryPanel refreshKey={turns.filter((t) => !t.streaming).length} />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-3 py-4 sm:px-5 sm:py-6">
          {turns.length === 0 ? <ChatEmptyState /> : null}

          {turns.map((turn, i) => (
            <article key={i} className="reveal mb-10">
              <h2 className="mb-3 font-display text-[16px] leading-snug tracking-wide">
                {turn.question}
              </h2>

              <StageStrip
                stages={turn.stages}
                streaming={turn.streaming}
                onExplain={explainStage}
              />

              {turn.trace?.resolved_query && turn.trace.resolved_query !== turn.question ? (
                <p
                  data-hint="Your question referred back to the conversation, so it was rewritten into a standalone query before searching. This is the text the retrievers actually received."
                  className="hint mt-2 font-mono text-[10px] text-subtle"
                >
                  searched as: “{turn.trace.resolved_query}”
                </p>
              ) : null}

              {turn.stages.some((s) => s.candidates_out) ? (
                <RetrievalInspector
                  turn={turn}
                  selected={selectedChunk}
                  onSelect={setSelectedChunk}
                />
              ) : null}

              {turn.error ? (
                <div className="mt-4">
                  <ErrorNotice message={turn.error.message} remedy={turn.error.remedy} />
                </div>
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

      <Composer
        value={question}
        onChange={setQuestion}
        onSubmit={() => void ask()}
        disabled={busy}
        placeholder={documents.length ? "Ask about your documents…" : "Add a document to begin…"}
        notice={uploading}
      />
    </main>
  );
}

/**
 * The retrieval inspector for one turn, collapsible from its header. Expanded by
 * default — watching retrieval is the app's point — but a long conversation can
 * fold finished inspectors away. Each turn remembers its own state.
 */
function RetrievalInspector({
  turn,
  selected,
  onSelect
}: {
  turn: Turn;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Panel ticks className="mt-4">
      <SectionLabel
        right={
          <span className="flex items-center gap-2">
            {turn.trace ? (
              <span
                data-hint="Wall-clock time for the whole pipeline, from receiving the question to the last token of the answer."
                className="hint hint-end tabular"
              >
                {formatMs(turn.trace.total_ms)}
              </span>
            ) : null}
            <button
              onClick={() => setOpen((v) => !v)}
              aria-label={open ? "Collapse retrieval inspector" : "Expand retrieval inspector"}
              className="text-subtle transition-colors hover:text-foreground"
            >
              <CaretDownIcon
                size={11}
                className={`transition-transform ${open ? "rotate-180" : ""}`}
              />
            </button>
          </span>
        }
      >
        Retrieval inspector
      </SectionLabel>

      {open ? (
        <>
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
              selected={selected}
              onSelect={onSelect}
            />
          </div>

          {countCandidates(turn.stages) >= MIN_CANDIDATES_FOR_FLOW ? (
            <RankFlowSection stages={turn.stages} selected={selected} onSelect={onSelect} />
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

/**
 * The bump chart, folded behind a toggle and collapsed by default. The table
 * above is the primary inspector; the chart earns its ~350px only when someone
 * actually wants to watch ranks move, so it should not sit between every
 * question and its answer.
 */
function RankFlowSection({
  stages,
  selected,
  onSelect
}: {
  stages: StageRecord[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-t border-line">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left transition-colors hover:bg-foreground/4"
      >
        <span className="flex items-center gap-1.5 font-display text-[10px] tracking-[0.16em] text-subtle uppercase">
          <ChartLineIcon size={11} />
          Rank flow
        </span>
        <span className="flex items-center gap-2">
          {!open ? (
            <span className="text-[10px] text-subtle">how ranks changed between stages</span>
          ) : null}
          <CaretDownIcon
            size={11}
            className={`text-subtle transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open ? (
        <>
          <p className="px-4 pb-1 text-[10px] text-subtle">
            Each line is a chunk; height is its rank. Watch lines cross as merging and
            reranking change the order.
          </p>
          <div className="px-2 pb-2">
            <RankFlow stages={stages} selected={selected} onSelect={onSelect} />
          </div>
        </>
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

function ChatEmptyState() {
  return (
    <EmptyState
      lead="Ask a question and watch retrieval happen — keyword search and vector search run side by side, their rankings fuse, and documents change position before a single word of the answer is written."
    >
      <ul className="space-y-1.5 font-mono text-[11px] text-subtle">
        <li className="flex items-center gap-2">
          <BooksIcon size={13} className="shrink-0" />
          add documents in the Library (or drop files anywhere, on desktop)
        </li>
        <li className="flex items-center gap-2">
          <CursorIcon size={13} className="shrink-0" />
          hover anything to find out what it means
        </li>
        <li className="flex items-center gap-2">
          <QuotesIcon size={13} className="shrink-0" />
          click a citation to open the source, highlighted at the exact sentence
        </li>
        <li className="flex items-center gap-2">
          <FlaskIcon size={13} className="shrink-0" />
          open the Lab to change a setting and compare runs side by side
        </li>
      </ul>
    </EmptyState>
  );
}
