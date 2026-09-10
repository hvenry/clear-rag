import { useMemo, useState } from "react";

import { Segmented } from "../../components/Segmented";
import { Select } from "../../components/Select";
import {
  displayLabel,
  rowKey,
  type QuestionResult,
  type ResultRow,
  type ResultsFile,
  type Suite
} from "../../lib/results";

/**
 * Per-question results for the pinned row, and the honest half of any ablation claim:
 * a metric that moved is some questions that moved. Pick a second row and every
 * question shows both ranks, so "recall@1 fell 0.081" becomes "the first relevant chunk
 * moved up on ten questions and down on fourteen" — and you can read which.
 */

type Filter = "all" | "changed" | "misses";

const FILTERS = [
  { value: "all", label: "all", hint: "Every question in the golden set." },
  { value: "changed", label: "changed", hint: "Questions whose first relevant rank differs between the two rows." },
  { value: "misses", label: "misses", hint: "Questions with no relevant chunk in the top-k for the pinned row." }
] as const;

export function QuestionPanel({
  suite,
  file,
  pinned,
  compare,
  onCompare
}: {
  suite: Suite;
  file: ResultsFile;
  pinned: ResultRow;
  compare: ResultRow | null;
  onCompare: (key: string | null) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [tag, setTag] = useState<string | null>(null);
  const k = file.k;

  const others = file.rows.filter((r) => r !== pinned && r.questions.length > 0);
  // The listbox shows display labels; attribution rows share a label across models.
  const keyByDisplay = new Map(others.map((r) => [displayLabel(suite, r), rowKey(r)]));
  const byId = useMemo(
    () => new Map((compare?.questions ?? []).map((q) => [q.id, q])),
    [compare]
  );
  const tags = useMemo(() => {
    const all = new Set<string>();
    pinned.questions.forEach((q) => q.tags.forEach((x) => all.add(x)));
    return [...all].sort();
  }, [pinned]);

  const rows = pinned.questions
    .map((q) => ({ q, other: byId.get(q.id) ?? null }))
    .filter(({ q, other }) => {
      if (tag && !q.tags.includes(tag)) return false;
      if (filter === "misses") return q.first_relevant_rank === null && !q.tags.includes("unanswerable");
      if (filter === "changed") return other !== null && other.first_relevant_rank !== q.first_relevant_rank;
      return true;
    })
    .sort((a, b) => rankKey(a.q) - rankKey(b.q));

  const movement = compare
    ? summarise(pinned.questions, byId)
    : null;

  if (pinned.questions.length === 0) {
    return (
      <p className="px-4 py-3 text-[11px] text-subtle">
        This row was imported from an earlier measurement, so there is no per-question detail to
        show. Re-run the sweep in an environment with its backend installed to get it.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2">
        <span className="font-display text-[10px] tracking-[0.16em] text-subtle uppercase">
          Questions · {displayLabel(suite, pinned)}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-subtle">compare with</span>
          <Select
            value={compare ? displayLabel(suite, compare) : "—"}
            options={["—", ...others.map((r) => displayLabel(suite, r))]}
            onChange={(v) => onCompare(v === "—" ? null : (keyByDisplay.get(v) ?? null))}
            className="min-w-[14rem]"
          />
        </div>
        <Segmented options={FILTERS} value={filter} onChange={(v) => setFilter(v)} />
        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {tags.map((x) => (
              <button
                key={x}
                onClick={() => setTag(tag === x ? null : x)}
                className={[
                  "border px-1.5 py-0.5 font-mono text-[9px] transition-colors",
                  tag === x
                    ? "border-foreground/60 bg-foreground text-background"
                    : "border-line text-subtle hover:border-foreground/40 hover:text-foreground"
                ].join(" ")}
              >
                {x}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {movement ? (
        <p className="tabular border-b border-line px-4 py-2 font-mono text-[10px] text-subtle">
          against {displayLabel(suite, compare!)}: first relevant chunk moved up on{" "}
          <span className="text-foreground">{movement.up}</span>, down on{" "}
          <span className="text-foreground">{movement.down}</span>, unchanged on{" "}
          <span className="text-foreground">{movement.same}</span>
          {movement.recovered ? (
            <>
              {" "}· <span className="text-foreground">{movement.recovered}</span> recovered from a miss
            </>
          ) : null}
          {movement.lost ? (
            <>
              {" "}· <span className="text-foreground">{movement.lost}</span> became a miss
            </>
          ) : null}
        </p>
      ) : null}

      <div className="max-h-[26rem] overflow-y-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b border-line">
              <th className="px-4 pb-1.5 pt-2 font-display text-[9px] font-medium tracking-[0.16em] text-subtle uppercase">
                Question
              </th>
              <th className="pb-1.5 pr-3 pt-2 text-left font-display text-[9px] font-medium tracking-[0.16em] text-subtle uppercase">
                Tags
              </th>
              <th
                data-hint={`Rank of the first chunk covering a labelled answer span, within the top ${k}. “miss” means none did.`}
                className="hint hint-end pb-1.5 pr-3 pt-2 text-right font-display text-[9px] font-medium tracking-[0.16em] text-subtle uppercase"
              >
                {compare ? "pinned" : "rank"}
              </th>
              {compare ? (
                <th className="pb-1.5 pr-3 pt-2 text-right font-display text-[9px] font-medium tracking-[0.16em] text-subtle uppercase">
                  compared
                </th>
              ) : null}
              {suite === "attribution" ? (
                <th
                  data-hint="Answer-side checks: mentioned the required strings, cited a chunk covering the answer, bled in wrong-section content, refused."
                  className="hint hint-end pb-1.5 pr-4 pt-2 text-right font-display text-[9px] font-medium tracking-[0.16em] text-subtle uppercase"
                >
                  answer
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ q, other }) => (
              <tr key={q.id} className="border-b border-line/60 align-top">
                <td className="max-w-[28rem] px-4 py-1.5">
                  <div className="text-[11px] text-muted">{q.question ?? q.id}</div>
                  {q.missed.length > 0 && q.first_relevant_rank === null ? (
                    <div className="mt-0.5 truncate font-mono text-[9px] text-subtle" title={q.missed.join(" · ")}>
                      missed: {q.missed[0]}
                      {q.missed.length > 1 ? ` (+${q.missed.length - 1})` : ""}
                    </div>
                  ) : null}
                </td>
                <td className="py-1.5 pr-3">
                  <div className="flex flex-wrap gap-1">
                    {q.tags.map((x) => (
                      <span key={x} className="border border-line px-1 font-mono text-[8px] text-subtle">
                        {x}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="tabular py-1.5 pr-3 text-right font-mono text-[11px]">
                  <Rank q={q} />
                </td>
                {compare ? (
                  <td className="tabular py-1.5 pr-3 text-right font-mono text-[11px]">
                    {other ? <Rank q={other} moveFrom={q} /> : <span className="text-subtle">—</span>}
                  </td>
                ) : null}
                {suite === "attribution" ? (
                  <td className="py-1.5 pr-4 text-right font-mono text-[9px] text-subtle">
                    <AnswerFlags q={q} />
                  </td>
                ) : null}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-4 text-center font-mono text-[10px] text-subtle">
                  nothing matches this filter
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function rankKey(q: QuestionResult): number {
  if (q.tags.includes("unanswerable")) return 1000;
  return q.first_relevant_rank ?? 999;
}

function Rank({ q, moveFrom }: { q: QuestionResult; moveFrom?: QuestionResult }) {
  if (q.tags.includes("unanswerable")) {
    return <span className="text-subtle" title="Unanswerable: judged on the answer side only">n/a</span>;
  }
  if (q.first_relevant_rank === null) {
    return <span className="text-subtle">miss</span>;
  }
  const from = moveFrom?.first_relevant_rank;
  let move: string | null = null;
  if (moveFrom) {
    if (from === null || from === undefined) move = "recovered";
    else if (from !== q.first_relevant_rank) move = from > q.first_relevant_rank ? `↑${from - q.first_relevant_rank}` : `↓${q.first_relevant_rank - from}`;
  }
  return (
    <span>
      #{q.first_relevant_rank}
      {move ? <span className="ml-1 text-[9px] text-subtle">{move}</span> : null}
    </span>
  );
}

function AnswerFlags({ q }: { q: QuestionResult }) {
  const flags: string[] = [];
  if (q.refused === true) flags.push(q.tags.includes("unanswerable") ? "refused ✓" : "refused ✗");
  if (q.mentioned === true) flags.push("mentioned");
  if (q.mentioned === false) flags.push("missing mention");
  if (q.grounded === true) flags.push("grounded");
  if (q.grounded === false) flags.push("ungrounded");
  if (q.confused === true) flags.push("bled");
  return <span>{flags.join(" · ") || "—"}</span>;
}

function summarise(questions: QuestionResult[], other: Map<string, QuestionResult>) {
  let up = 0, down = 0, same = 0, recovered = 0, lost = 0;
  for (const q of questions) {
    if (q.tags.includes("unanswerable")) continue;
    const o = other.get(q.id);
    if (!o) continue;
    const a = q.first_relevant_rank;
    const b = o.first_relevant_rank;
    if (a === b) same += 1;
    else if (a === null) recovered += 1;
    else if (b === null) lost += 1;
    else if (b < a) up += 1;
    else down += 1;
  }
  // "up" and "down" describe the compared row against the pinned one.
  return { up: up + recovered, down: down + lost, same, recovered, lost };
}
