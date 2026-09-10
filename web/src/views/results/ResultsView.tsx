import { CheckIcon, CopyIcon, InfoIcon, PushPinIcon, TerminalIcon } from "@phosphor-icons/react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { MeterRow } from "../../components/charts";
import { Panel, SectionLabel } from "../../components/Panel";
import { Segmented } from "../../components/Segmented";
import { Th } from "../../components/Table";
import {
  PARSE_QUALITY,
  RESULTS,
  SUITE_INFO,
  SUITES,
  displayLabel,
  fmt,
  modelShort,
  provenanceSummary,
  rowKey,
  type Suite
} from "../../lib/results";
import { QuestionPanel } from "./QuestionPanel";
import { ResultsTable, columnsFor, findRow } from "./ResultsTable";

/**
 * The Results view: the ablation tables the README shows, from the same committed
 * files, made explorable. The README says "reranking lifts recall@1 0.734 → 0.927";
 * here you pin the fused row, read the arrow on the reranked one, and open the
 * questions that moved. Every number on this page has a provenance line, because a
 * benchmark that cannot say what measured it is a claim, not a result.
 */

const SUITE_OPTIONS = SUITES.map((s) => ({
  value: s,
  label: SUITE_INFO[s].title,
  hint: SUITE_INFO[s].what
}));

type Tab = Suite | "parse-quality";

export function ResultsView() {
  const { suite: param } = useParams<{ suite?: string }>();
  const navigate = useNavigate();
  const tab: Tab = isTab(param) ? param : "retrieval";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-3 py-4 sm:px-5 sm:py-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-[18px] tracking-wide">Results</h1>
            <p className="mt-1 max-w-2xl text-body leading-relaxed text-subtle">
              Every table here is read from <Code text="evals/results/" />, which{" "}
              <Code text="clear-rag ablate --save-results" /> writes.
            </p>
          </div>
          <Segmented
            options={[...SUITE_OPTIONS, { value: "parse-quality", label: "Parse quality", hint: "Parser backends differentially scored against HTML-derived ground truth: word recovery and reading order." }]}
            value={tab}
            onChange={(v) => navigate(`/results/${v}`)}
            variant="display"
          />
        </div>

        {tab === "parse-quality" ? <ParseQualitySection /> : <SuiteSection suite={tab} />}
      </div>
    </div>
  );
}

function isTab(value: string | undefined): value is Tab {
  return value === "parse-quality" || (SUITES as string[]).includes(value ?? "");
}

function SuiteSection({ suite }: { suite: Suite }) {
  const file = RESULTS[suite];
  const columns = useMemo(() => columnsFor(file), [file]);
  const [pinnedBySuite, setPinnedBySuite] = useState<Record<string, string | null>>({});
  const [compareBySuite, setCompareBySuite] = useState<Record<string, string | null>>({});
  const pinned = findRow(file, pinnedBySuite[suite] ?? null);
  const compare = findRow(file, compareBySuite[suite] ?? null);
  const [tableCollapsed, setTableCollapsed] = useState(false);
  const [questionsCollapsed, setQuestionsCollapsed] = useState(false);

  // Pinning unfolds the questions panel if it was collapsed, but never scrolls:
  // the reader is mid-table, and the page moving under a click reads as a glitch.
  useEffect(() => {
    if (pinned) setQuestionsCollapsed(false);
  }, [pinned]);

  const setPinned = (key: string | null) => {
    setPinnedBySuite((s) => ({ ...s, [suite]: key }));
    if (key === null || key === compareBySuite[suite]) {
      setCompareBySuite((s) => ({ ...s, [suite]: null }));
    }
  };

  return (
    <>
      <p className="mt-4 max-w-3xl text-body leading-relaxed text-muted">{SUITE_INFO[suite].what}</p>

      <Panel ticks className="mt-4">
        <SectionLabel
          collapsed={tableCollapsed}
          onToggle={() => setTableCollapsed((v) => !v)}
          right={
            <span
              data-hint={`${provenanceSummary(file)}. Rows imported from an earlier run carry their own date and models; hover the “imported” chip.`}
              className="hint hint-end hint-block flex h-6 w-6 items-center justify-center text-subtle transition-colors hover:text-foreground"
              aria-label="What measured these rows"
            >
              <InfoIcon size={16} />
            </span>
          }
        >
          {SUITE_INFO[suite].title}
        </SectionLabel>
        {!tableCollapsed ? (
          <div className="border-t border-line">
            <ResultsTable
              suite={suite}
              file={file}
              columns={columns}
              pinned={pinned ? rowKey(pinned) : null}
              onPin={setPinned}
            />
          </div>
        ) : null}
        {file.rows.length === 0 ? (
          <p className="px-4 py-6 text-center font-mono text-meta text-subtle">
            no rows yet; run {SUITE_INFO[suite].command}
          </p>
        ) : null}
      </Panel>

      {pinned ? (
        <div>
          <Panel className="mt-4">
            <SectionLabel
              collapsed={questionsCollapsed}
              onToggle={() => setQuestionsCollapsed((v) => !v)}
              right={`${pinned.questions.length} questions`}
            >
              Questions · {displayLabel(suite, pinned)}
            </SectionLabel>
            {!questionsCollapsed ? (
              <div className="border-t border-line">
                <QuestionPanel
                  suite={suite}
                  file={file}
                  pinned={pinned}
                  compare={compare && compare !== pinned ? compare : null}
                  onCompare={(key) => setCompareBySuite((s) => ({ ...s, [suite]: key }))}
                />
              </div>
            ) : null}
          </Panel>
        </div>
      ) : (
        <p className="mt-3 px-1 text-ui text-subtle">
          Click a configuration to <PinWord lower /> it, then compare it with another to see which questions moved.
        </p>
      )}

      <Reproduce command={SUITE_INFO[suite].command} rows={file.rows.map((r) => r.provenance)} />
    </>
  );
}

function ParseQualitySection() {
  const backends = Object.keys(PARSE_QUALITY.means);
  const files = [...new Set(PARSE_QUALITY.rows.map((r) => r.file))];
  const byKey = new Map(PARSE_QUALITY.rows.map((r) => [`${r.file}|${r.backend}`, r]));

  return (
    <>
      <p className="mt-4 max-w-3xl text-body leading-relaxed text-muted">
        The parse stage's differential test. Each backend's text is scored against tag-stripped
        HTML of the same filing: what share of the words came back, and in how close to the right
        order. Born-digital renders are flat extraction's best case, so these numbers measure
        structure fidelity more than extraction difficulty.
      </p>

      <Panel ticks className="mt-4">
        <SectionLabel right={<span>{files.length} files · {backends.length} backends</span>}>
          Per-backend means
        </SectionLabel>
        <div className="grid grid-cols-1 gap-x-8 border-t border-line px-4 py-3 md:grid-cols-2">
          <div>
            <div className="menu-label mb-1">word recovery</div>
            {backends.map((b) => (
              <MeterRow
                key={b}
                label={b}
                value={fmt(PARSE_QUALITY.means[b].word_recovery)}
                fraction={PARSE_QUALITY.means[b].word_recovery}
                labelWidth="6rem"
                swatch={false}
              />
            ))}
          </div>
          <div>
            <div className="menu-label mb-1">reading order</div>
            {backends.map((b) => (
              <MeterRow
                key={b}
                label={b}
                value={fmt(PARSE_QUALITY.means[b].order_similarity)}
                fraction={PARSE_QUALITY.means[b].order_similarity}
                labelWidth="6rem"
                swatch={false}
              />
            ))}
          </div>
        </div>
      </Panel>

      <Panel className="mt-4">
        <div className="overflow-x-auto px-4 py-2">
          <table className="w-full min-w-[40rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                <Th>file</Th>
                {backends.map((b) => (
                  <th key={b} colSpan={2} className="menu-label pt-2 pb-2 pr-3 text-right font-medium">
                    {b} · recovery / order
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f} className="border-b border-line/60">
                  <td className="py-1.5 pr-3 font-mono text-meta text-muted">{f}</td>
                  {backends.map((b) => {
                    const r = byKey.get(`${f}|${b}`);
                    return [
                      <td key={`${b}-w`} className="tabular py-1.5 pr-1 text-right font-mono text-meta text-muted">
                        {r ? fmt(r.word_recovery) : "—"}
                        {r?.provenance.source === "imported" ? <span className="text-subtle"> †</span> : null}
                      </td>,
                      <td key={`${b}-o`} className="tabular py-1.5 pr-3 text-right font-mono text-meta text-subtle">
                        {r ? fmt(r.order_similarity) : "—"}
                      </td>
                    ];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {PARSE_QUALITY.rows.some((r) => r.provenance.source === "imported") ? (
            <p className="mt-2 font-mono text-label text-subtle">† imported from an earlier measurement; that backend is not installed here.</p>
          ) : null}
        </div>
      </Panel>

      <Reproduce command="clear-rag parse-quality --save-results" rows={PARSE_QUALITY.rows.map((r) => r.provenance)} />
    </>
  );
}

function Reproduce({ command, rows }: { command: string; rows: { measured_at: string; source: string; chat_model?: string | null; embed_model?: string | null; reranker?: string | null }[] }) {
  const measured = rows.filter((p) => p.source === "measured");
  const chat = [...new Set(measured.map((p) => modelShort(p.chat_model)).filter((x) => x !== "?"))];
  const embed = [...new Set(measured.map((p) => modelShort(p.embed_model)).filter((x) => x !== "?"))];
  const reranker = [...new Set(measured.map((p) => p.reranker).filter(Boolean))];
  return (
    <Panel className="mt-4">
      <SectionLabel>Reproduce</SectionLabel>
      <div className="grid gap-x-8 gap-y-3 border-t border-line px-4 py-3 md:grid-cols-[auto_1fr]">
        <div className="menu-label md:pt-1">command</div>
        <CommandBox command={command} />

        <div className="menu-label md:pt-0.5">models</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-ui">
          {[
            ["chat", chat],
            ["embeddings", embed],
            ["reranker", reranker]
          ]
            .filter(([, values]) => values.length)
            .map(([label, values]) => (
              <Fragment key={String(label)}>
                <dt className="text-subtle">{label}</dt>
                <dd className="text-muted">{(values as string[]).join(", ")}</dd>
              </Fragment>
            ))}
        </dl>

        <div className="menu-label md:pt-0.5">readme</div>
        <p className="text-ui leading-relaxed text-muted">
          The README tables are rendered from the same files by{" "}
          <Code text="scripts/render_results.py" />, so this page and the README cannot
          disagree.
        </p>
      </div>
    </Panel>
  );
}

/** A command in a code box with a copy button; the button confirms for a moment. */
function CommandBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  return (
    <div className="flex w-fit max-w-full items-center gap-2 self-start justify-self-start border border-line bg-foreground/5 pl-2 font-mono text-ui">
      <TerminalIcon size={14} className="shrink-0 text-subtle" />
      <code className="py-1">{command}</code>
      <button
        type="button"
        onClick={() => navigator.clipboard.writeText(command).then(() => setCopied(true))}
        aria-label={copied ? "Copied" : "Copy command"}
        className="flex h-7 items-center gap-1 border-l border-line px-2 text-subtle transition-colors hover:bg-foreground/8 hover:text-foreground"
      >
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        <span className="font-display text-label tracking-[0.14em] uppercase">
          {copied ? "copied" : "copy"}
        </span>
      </button>
    </div>
  );
}

/** The word "pin" in the pin colour with its glyph, the legend for the table. */
function PinWord({ lower = false }: { lower?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1 font-medium text-pin">
      <PushPinIcon size={14} weight="fill" className="relative top-[2px]" />
      {lower ? "pin" : "Pin"}
    </span>
  );
}

function Code({ text }: { text: string }) {
  return (
    <code className="border border-line bg-foreground/5 px-1 py-px font-mono text-[0.9em]">{text}</code>
  );
}
