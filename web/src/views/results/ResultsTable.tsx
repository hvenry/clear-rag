import { diffConfigs } from "../../lib/knobs";
import {
  diffModels,
  displayLabel,
  fmt,
  rowKey,
  type Aggregate,
  type MetricName,
  type ResultRow,
  type ResultsFile,
  type Suite
} from "../../lib/results";

/**
 * The ablation table as a ladder you can pin. Click a row and every other row is read
 * against it: the settings that differ, and how far each metric moved. That is how the
 * table is meant to be read — "was that change worth it?" — made into a gesture instead
 * of a mental subtraction.
 *
 * Bars are drawn on an absolute 0–1 scale, not the column's own range, so a bar's length
 * means the same thing in every column and a full bar is a perfect score. Colour is not
 * used: the best value in a column is set in ink, everything else in muted, and movement
 * is an arrow beside a number.
 */

export interface Column {
  key: string;
  label: string;
  hint: string;
  read: (agg: Record<string, Aggregate>) => number | null;
}

const METRIC_HINTS: Record<string, string> = {
  recall: "Share of labelled answer spans covered by the top-k chunks. The denominator is spans, not chunks, so it stays fixed when chunk size changes.",
  mrr: "Mean reciprocal rank of the first relevant chunk — 1.0 means first place every time.",
  ndcg: "Discounted cumulative gain with binary relevance, normalised: rewards relevant chunks near the top, not merely inside the window.",
  mention_accuracy: "Share of answerable questions whose answer contains every required string.",
  grounding_rate: "Share of answers with at least one citation whose chunk actually covers the labelled answer span.",
  citation_precision: "Mean share of an answer's citations that cover a labelled span — the rest cite the wrong chunk.",
  refusal_accuracy: "Share of unanswerable questions the model correctly declined.",
  false_refusal_rate: "Share of answerable questions the model refused anyway — over-refusal."
};

export function columnsFor(file: ResultsFile): Column[] {
  const k = String(file.k);
  const at = (kk: string, name: MetricName) => (agg: Record<string, Aggregate>) =>
    agg[kk] ? agg[kk][name] : null;

  if (file.suite === "attribution") {
    return [
      { key: "recall", label: `recall@${k}`, hint: METRIC_HINTS.recall, read: at(k, "recall") },
      { key: "mention", label: "required mentions", hint: METRIC_HINTS.mention_accuracy, read: at(k, "mention_accuracy") },
      { key: "grounding", label: "grounding", hint: METRIC_HINTS.grounding_rate, read: at(k, "grounding_rate") },
      { key: "citation", label: "citation precision", hint: METRIC_HINTS.citation_precision, read: at(k, "citation_precision") },
      { key: "refusal", label: "refusals", hint: METRIC_HINTS.refusal_accuracy, read: at(k, "refusal_accuracy") },
      { key: "false_refusal", label: "false refusals", hint: METRIC_HINTS.false_refusal_rate, read: at(k, "false_refusal_rate") }
    ];
  }

  const tags = new Set<string>();
  file.rows.forEach((r) => Object.keys(r.at_k[k]?.by_tag ?? {}).forEach((tag) => tags.add(tag)));
  const wanted = file.suite === "sec"
    ? ["table", "structure", "cross-company"]
    : ["lexical", "semantic", "distractor", "paraphrase"];
  const tagColumns: Column[] = wanted
    .filter((tag) => tags.has(tag))
    .map((tag) => ({
      key: `tag:${tag}`,
      label: tag,
      hint: `recall@${k} restricted to questions tagged “${tag}”.`,
      read: (agg) => agg[k]?.by_tag[tag] ?? null
    }));

  return [
    { key: "recall1", label: "recall@1", hint: METRIC_HINTS.recall, read: at("1", "recall") },
    { key: "recall", label: `recall@${k}`, hint: METRIC_HINTS.recall, read: at(k, "recall") },
    { key: "mrr", label: "MRR", hint: METRIC_HINTS.mrr, read: at(k, "mrr") },
    { key: "ndcg", label: `nDCG@${k}`, hint: METRIC_HINTS.ndcg, read: at(k, "ndcg") },
    ...tagColumns
  ];
}

export function ResultsTable({
  suite,
  file,
  columns,
  pinned,
  onPin
}: {
  suite: Suite;
  file: ResultsFile;
  columns: Column[];
  /** The pinned row's key (see `rowKey`), or null. */
  pinned: string | null;
  onPin: (key: string | null) => void;
}) {
  const baseline = file.rows.find((r) => rowKey(r) === pinned) ?? null;
  const best = columns.map((col) =>
    Math.max(...file.rows.map((r) => col.read(r.at_k) ?? -Infinity))
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[48rem] border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="border-b border-line">
            <Th hint="One configuration of the pipeline. Click a row to pin it: every other row is then read against it — which settings differ, and how far each number moved.">
              Configuration
            </Th>
            {columns.map((col, i) => (
              <Th key={col.key} hint={col.hint} align="right" hintEnd={i >= columns.length - 2}>
                {col.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {file.rows.map((r) => {
            const isPinned = baseline !== null && rowKey(baseline) === rowKey(r);
            const changes = baseline && !isPinned ? diffConfigs(baseline.config, r.config) : [];
            const models = baseline && !isPinned ? diffModels(baseline, r) : [];
            const imported = r.provenance.source === "imported";
            return (
              <tr
                key={rowKey(r)}
                onClick={() => onPin(isPinned ? null : rowKey(r))}
                className={[
                  "cursor-pointer border-b border-line/60 align-top transition-colors",
                  isPinned ? "bg-foreground/8" : "hover:bg-foreground/4"
                ].join(" ")}
              >
                <td className="max-w-[20rem] py-2 pr-3">
                  <div className="flex items-center gap-1.5">
                    {isPinned ? (
                      <span className="font-display text-[8px] tracking-[0.16em] text-subtle uppercase">
                        pinned
                      </span>
                    ) : null}
                    <span className={`text-[11.5px] ${isPinned ? "text-foreground" : "text-muted"}`}>
                      {displayLabel(suite, r)}
                    </span>
                    {imported ? (
                      <span
                        data-hint={`Imported from an earlier measurement (${r.provenance.measured_at}) rather than re-run here${r.provenance.note ? `: ${r.provenance.note}` : ""}. No per-question detail.`}
                        className="hint border border-line px-1 font-mono text-[8px] text-subtle"
                      >
                        imported
                      </span>
                    ) : null}
                  </div>
                  {changes.length > 0 || models.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {changes.map((c) => (
                        <span
                          key={c.key}
                          data-hint={`Differs from the pinned row: ${c.key} was ${String(c.from)}, here it is ${String(c.to)}.`}
                          className="hint tabular border border-line px-1 font-mono text-[9px] text-subtle"
                        >
                          {c.key} {String(c.from)} → {String(c.to)}
                        </span>
                      ))}
                      {models.map((c) => (
                        <span
                          key={`model:${c.key}`}
                          data-hint={`Measured with a different ${c.key === "embedder" ? "embedding" : "chat"} model than the pinned row: ${c.from} there, ${c.to} here. A model is the identity of an index or an answer, not a knob, so it lives in the row's provenance rather than its configuration.`}
                          className="hint tabular border border-line px-1 font-mono text-[9px] text-subtle"
                        >
                          {c.key} {c.from} → {c.to}
                        </span>
                      ))}
                    </div>
                  ) : baseline && !isPinned ? (
                    <div className="mt-1 font-mono text-[9px] text-subtle">no settings differ</div>
                  ) : null}
                </td>
                {columns.map((col, i) => (
                  <MetricCell
                    key={col.key}
                    value={col.read(r.at_k)}
                    baseline={baseline && !isPinned ? col.read(baseline.at_k) : null}
                    best={best[i]}
                  />
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MetricCell({
  value,
  baseline,
  best
}: {
  value: number | null;
  baseline: number | null;
  best: number;
}) {
  if (value === null) {
    return (
      <td className="py-2 pr-3 text-right">
        <span className="hint hint-end text-[10px] text-subtle" data-hint="Not measured for this row.">
          —
        </span>
      </td>
    );
  }
  const isBest = Math.abs(value - best) < 5e-4;
  const delta = baseline === null ? null : value - baseline;
  const moved = delta !== null && Math.abs(delta) >= 5e-4;

  return (
    <td className="tabular py-2 pr-3 text-right font-mono">
      <span className={`text-[11px] ${isBest ? "font-medium text-foreground" : "text-muted"}`}>
        {fmt(value)}
      </span>
      <div className="h-[13px] text-[9px] text-subtle">
        {moved ? (
          <span title={`${delta! > 0 ? "up" : "down"} ${Math.abs(delta!).toFixed(3)} against the pinned row`}>
            {delta! > 0 ? "↑" : "↓"}
            {Math.abs(delta!).toFixed(3)}
          </span>
        ) : delta !== null ? (
          <span title="Identical to the pinned row">=</span>
        ) : null}
      </div>
      {/* Absolute scale: a full bar is 1.000 in every column. */}
      <div className="mt-0.5 ml-auto h-[3px] w-14 bg-foreground/8">
        <div
          className={`h-full ${isBest ? "bg-foreground/70" : "bg-foreground/35"}`}
          style={{ width: `${Math.max(2, 100 * Math.min(1, value))}%` }}
        />
      </div>
    </td>
  );
}

function Th({
  children,
  hint,
  align = "left",
  hintEnd = false
}: {
  children: React.ReactNode;
  hint: string;
  align?: "left" | "right";
  hintEnd?: boolean;
}) {
  return (
    <th
      data-hint={hint}
      className={`hint ${align === "right" || hintEnd ? "hint-end" : ""} pb-2 font-display text-[9px] font-medium tracking-[0.16em] text-subtle uppercase ${
        align === "right" ? "pr-3 text-right" : "pr-3 text-left"
      }`}
    >
      {children}
    </th>
  );
}

/** The row a key refers to, or null. */
export function findRow(file: ResultsFile, key: string | null): ResultRow | null {
  return key === null ? null : (file.rows.find((r) => rowKey(r) === key) ?? null);
}
