import { PushPinIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, useState } from "react";

import { Chip } from "../../components/Chip";
import { Th } from "../../components/Table";

import {
  displayLabel,
  fmt,
  modelShort,
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
 * table is meant to be read ("was that change worth it?") made into a gesture instead
 * of a mental subtraction.
 *
 * The best value in a column is set in ink, everything else in muted. Movement against
 * the pinned row is a signed number under each value: green up, red down, printed with
 * its sign so the colour never carries the meaning alone.
 */

export interface Column {
  key: string;
  label: string;
  hint: string;
  read: (agg: Record<string, Aggregate>) => number | null;
}

const METRIC_HINTS: Record<string, string> = {
  recall: "Share of labelled answer spans covered by the top-k chunks. The denominator is spans, not chunks, so it stays fixed when chunk size changes.",
  mrr: "Mean reciprocal rank of the first relevant chunk; 1.0 means first place every time.",
  ndcg: "Discounted cumulative gain with binary relevance, normalised: rewards relevant chunks near the top, not merely inside the window.",
  mention_accuracy: "Share of answerable questions whose answer contains every required string.",
  grounding_rate: "Share of answers with at least one citation whose chunk actually covers the labelled answer span.",
  citation_precision: "Mean share of an answer's citations that cover a labelled span; the rest cite the wrong chunk.",
  refusal_accuracy: "Share of unanswerable questions the model correctly declined.",
  false_refusal_rate: "Share of answerable questions the model refused anyway: over-refusal."
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
  const varying = varyingSettings(file);

  return (
    // Capped height with its own scroll: a long sweep must not push the question
    // panel off the page. The header stays put; a pinned row stays findable.
    <div className="scroll-chain max-h-[26rem] overflow-x-auto overflow-y-auto">
      <table className="w-full min-w-[48rem] border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="border-b border-line">
            <Th
              hint="The settings this sweep varies, one chip each. Click a row to pin it: chips that differ from the pinned row are set in ink, and every number shows how far it moved."
              className="pl-4"
            >
              Configuration
            </Th>
            {columns.map((col, i) => (
              <Th key={col.key} hint={col.hint} align="right" hintEnd={i >= columns.length - 2}>
                {col.label}
              </Th>
            ))}
            <th className="w-9 pr-4" aria-label="Pinned" />
          </tr>
        </thead>
        <tbody>
          {file.rows.map((r) => {
            const isPinned = baseline !== null && rowKey(baseline) === rowKey(r);
            const imported = r.provenance.source === "imported";
            const chips = chipsFor(r, varying, baseline && !isPinned ? baseline : null);
            return (
              <tr
                key={rowKey(r)}
                onClick={() => onPin(isPinned ? null : rowKey(r))}
                aria-pressed={isPinned}
                aria-label={displayLabel(suite, r)}
                title={displayLabel(suite, r)}
                className={[
                  "group cursor-pointer border-b border-line/60 align-top transition-colors",
                  isPinned ? "bg-pin/10" : "hover:bg-foreground/4"
                ].join(" ")}
              >
                <td className="w-[32rem] max-w-[32rem] py-1.5 pr-3 pl-4">
                  <ChipLine chips={chips} pinned={isPinned} imported={imported ? r.provenance : null} />
                </td>
                {columns.map((col, i) => (
                  <MetricCell
                    key={col.key}
                    value={col.read(r.at_k)}
                    baseline={baseline && !isPinned ? col.read(baseline.at_k) : null}
                    best={best[i]}
                  />
                ))}
                {/* A fixed trailing slot: solid on the pinned row, faint on hover, so
                    pinning never reflows the row. */}
                <td className="py-1.5 pr-4 text-right align-top" aria-hidden>
                  <PushPinIcon
                    size={14}
                    weight="fill"
                    className={`inline-block transition-opacity ${isPinned ? "text-pin opacity-100" : "opacity-0 group-hover:opacity-35"}`}
                  />
                </td>
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
      <td className="py-1.5 pr-3 text-right align-top">
        <span className="hint hint-end text-ui text-subtle" data-hint="Not measured for this row.">
          —
        </span>
      </td>
    );
  }
  const isBest = Math.abs(value - best) < 5e-4;
  const delta = baseline === null ? null : value - baseline;
  const moved = delta !== null && Math.abs(delta) >= 5e-4;

  return (
    <td className="tabular py-1.5 pr-3 text-right font-mono">
      <span className={`text-ui ${isBest ? "font-medium text-foreground" : "text-muted"}`}>
        {fmt(value)}
      </span>
      {/* A reserved line under every value, the same height as the label row's chip
          line, so pinning adds a delta without moving a single number. */}
      <div className="mt-1 h-4 text-label leading-4 text-subtle">
        {delta !== null ? (
          <span
            title={`against the pinned row`}
            className={moved ? (delta > 0 ? "text-gain" : "text-loss") : "opacity-60"}
          >
            {signed(moved ? delta : 0)}
          </span>
        ) : null}
      </div>
    </td>
  );
}

interface Chip {
  key: string;
  value: string;
  /** Differs from the pinned row (only meaningful while a row is pinned). */
  differs: boolean;
}

/**
 * The settings a sweep actually varies: every configuration key with more than one
 * distinct value across the rows, plus the embedder or chat model when they vary.
 * Fixed settings are noise in a table whose point is the differences.
 */
function varyingSettings(file: ResultsFile): { keys: string[]; embedder: boolean; chat: boolean } {
  const keys = new Set<string>();
  const first = file.rows[0]?.config ?? {};
  for (const r of file.rows) {
    for (const key of Object.keys(r.config)) {
      if (JSON.stringify(r.config[key]) !== JSON.stringify(first[key])) keys.add(key);
    }
  }
  const distinct = (pick: (r: ResultRow) => string | null | undefined) =>
    new Set(file.rows.map((r) => modelShort(pick(r)))).size > 1;
  return {
    keys: Object.keys(first).filter((k) => keys.has(k)),
    embedder: distinct((r) => r.provenance.embed_model),
    chat: file.rows.some((r) => r.generated) && distinct((r) => r.provenance.chat_model)
  };
}

function chipsFor(
  r: ResultRow,
  varying: ReturnType<typeof varyingSettings>,
  baseline: ResultRow | null
): Chip[] {
  const chips: Chip[] = varying.keys.map((key) => ({
    key,
    value: String(r.config[key]),
    differs: baseline !== null && JSON.stringify(baseline.config[key]) !== JSON.stringify(r.config[key])
  }));
  if (varying.embedder) {
    chips.push({
      key: "embedder",
      value: modelShort(r.provenance.embed_model),
      differs: baseline !== null && modelShort(baseline.provenance.embed_model) !== modelShort(r.provenance.embed_model)
    });
  }
  if (varying.chat) {
    chips.push({
      key: "chat",
      value: modelShort(r.provenance.chat_model),
      differs: baseline !== null && modelShort(baseline.provenance.chat_model) !== modelShort(r.provenance.chat_model)
    });
  }
  return chips;
}

/**
 * Three reserved lines of setting chips, the same height on every row. Chips wrap
 * whole; any that do not fit wrap onto a hidden fourth line and a "+N" badge counts
 * them. On the pinned row every chip is in the pin colour; on other rows, chips that
 * differ from the pinned row are in the diff colour and the rest stay muted.
 */
function ChipLine({
  chips,
  pinned,
  imported
}: {
  chips: Chip[];
  pinned: boolean;
  imported: ResultRow["provenance"] | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const items = [...el.children] as HTMLElement[];
      // Line pitch is 16px + 4px gap; anything past the third line is hidden.
      setHidden(items.filter((item) => item.offsetTop > 44).length);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [chips]);

  return (
    <div className="relative">
      <div ref={ref} className={`flex h-14 flex-wrap content-start gap-1 overflow-hidden ${hidden ? "pr-7" : ""}`}>
        {chips.map((c) => (
          <Chip key={c.key} tone={pinned ? "pin" : c.differs ? "diff" : "muted"}>
            <span className="opacity-70">{c.key}</span> {c.value}
          </Chip>
        ))}
        {imported ? (
          <Chip
            dashed
            hint={`Imported from an earlier measurement (${imported.measured_at}) rather than re-run here${imported.note ? `: ${imported.note}` : ""}. No per-question detail.`}
          >
            imported
          </Chip>
        ) : null}
      </div>
      {hidden > 0 ? (
        <span className="tabular absolute right-0 bottom-0 font-mono text-label leading-4 text-subtle">
          +{hidden}
        </span>
      ) : null}
    </div>
  );
}

/** A signed three-decimal delta: "+0.032", "−0.065", "0.000". */
function signed(delta: number): string {
  if (delta === 0) return "0.000";
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(3)}`;
}

/** The row a key refers to, or null. */
export function findRow(file: ResultsFile, key: string | null): ResultRow | null {
  return key === null ? null : (file.rows.find((r) => rowKey(r) === key) ?? null);
}
