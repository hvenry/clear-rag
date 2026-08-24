import { useExplainStage, useOpenCitation } from "../../app/navigation";
import { ErrorNotice } from "../../components/ErrorNotice";
import { AnswerText } from "../../components/retrieval/Citations";
import { SourceLegend } from "../../components/retrieval/Legend";
import { RetrievalTable } from "../../components/retrieval/RetrievalTable";
import { StageStrip } from "../../components/retrieval/StageStrip";
import { formatMs } from "../../lib/stages";
import type { Turn } from "../../lib/types";

export interface LabRun {
  id: number;
  hash: string;
  config: Record<string, unknown>;
  changed: { key: string; from: unknown; to: unknown }[];
  turn: Turn;
}

/** One experiment run: the question, what changed, and everything the pipeline did. */
export function RunCard({
  run,
  isLatest,
  selected,
  onSelect
}: {
  run: LabRun;
  isLatest: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { turn } = run;
  const openCitation = useOpenCitation();
  const explainStage = useExplainStage();

  return (
    <article
      className={[
        "reveal relative w-full shrink-0 border bg-background lg:w-[42rem]",
        isLatest ? "panel-ticks border-foreground/30" : "border-line"
      ].join(" ")}
    >
      <header className="border-b border-line px-4 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="min-w-0 truncate font-display text-[13px] tracking-wide">
            {turn.question}
          </h3>
          <span className="flex shrink-0 items-baseline gap-2">
            {turn.trace ? (
              <span
                data-hint="Wall-clock time for the whole pipeline, from receiving the question to the last token of the answer."
                className="hint hint-end tabular font-mono text-[9px]"
              >
                {formatMs(turn.trace.total_ms)}
              </span>
            ) : null}
            <span
              data-hint="Identifies the exact pipeline settings this run used. Two runs with the same hash used identical settings."
              className="hint hint-end tabular font-mono text-[9px] text-subtle"
            >
              {run.hash}
            </span>
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
        <StageStrip stages={turn.stages} streaming={turn.streaming} onExplain={explainStage} />

        {turn.error ? (
          <ErrorNotice message={turn.error.message} remedy={turn.error.remedy} />
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
            <AnswerText text={turn.answer} citations={turn.citations} onCite={openCitation} />
          </div>
        ) : null}
      </div>
    </article>
  );
}
