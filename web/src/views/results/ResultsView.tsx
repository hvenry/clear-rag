import { ChartBarIcon, TerminalIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { MeterRow } from "../../components/charts";
import { Panel, SectionLabel } from "../../components/Panel";
import { Segmented } from "../../components/Segmented";
import {
  PARSE_QUALITY,
  RESULTS,
  SUITE_INFO,
  SUITES,
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
            <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-subtle">
              Every table here is read from <Code text="evals/results/" />, which{" "}
              <Code text="clear-rag ablate --save-results" /> writes. The README renders
              the same files. Pin a row to read the others against it.
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

  const setPinned = (key: string | null) => {
    setPinnedBySuite((s) => ({ ...s, [suite]: key }));
    if (key === null || key === compareBySuite[suite]) {
      setCompareBySuite((s) => ({ ...s, [suite]: null }));
    }
  };

  return (
    <>
      <p className="mt-4 max-w-3xl text-[12px] leading-relaxed text-muted">{SUITE_INFO[suite].what}</p>

      <Panel ticks className="mt-4">
        <SectionLabel
          right={
            <span
              data-hint="What measured these rows. Rows imported from an earlier run carry their own date and models; hover the “imported” chip."
              className="hint hint-end"
            >
              {provenanceSummary(file)}
            </span>
          }
        >
          {SUITE_INFO[suite].title}
        </SectionLabel>
        <div className="border-t border-line px-4 py-2">
          <ResultsTable
            suite={suite}
            file={file}
            columns={columns}
            pinned={pinned ? rowKey(pinned) : null}
            onPin={setPinned}
          />
        </div>
        {file.rows.length === 0 ? (
          <p className="px-4 py-6 text-center font-mono text-[10px] text-subtle">
            no rows yet — run {SUITE_INFO[suite].command}
          </p>
        ) : null}
      </Panel>

      {pinned ? (
        <Panel className="mt-4">
          <QuestionPanel
            suite={suite}
            file={file}
            pinned={pinned}
            compare={compare && compare !== pinned ? compare : null}
            onCompare={(key) => setCompareBySuite((s) => ({ ...s, [suite]: key }))}
          />
        </Panel>
      ) : (
        <p className="mt-3 px-1 text-[11px] text-subtle">
          Click a configuration to pin it, then compare it with another to see which questions moved.
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
      <p className="mt-4 max-w-3xl text-[12px] leading-relaxed text-muted">
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
                <th className="pb-2 pr-3 font-display text-[9px] font-medium tracking-[0.16em] text-subtle uppercase">file</th>
                {backends.map((b) => (
                  <th key={b} colSpan={2} className="pb-2 pr-3 text-right font-display text-[9px] font-medium tracking-[0.16em] text-subtle uppercase">
                    {b} · recovery / order
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f} className="border-b border-line/60">
                  <td className="py-1.5 pr-3 font-mono text-[10px] text-muted">{f}</td>
                  {backends.map((b) => {
                    const r = byKey.get(`${f}|${b}`);
                    return [
                      <td key={`${b}-w`} className="tabular py-1.5 pr-1 text-right font-mono text-[10px] text-muted">
                        {r ? fmt(r.word_recovery) : "—"}
                        {r?.provenance.source === "imported" ? <span className="text-subtle"> †</span> : null}
                      </td>,
                      <td key={`${b}-o`} className="tabular py-1.5 pr-3 text-right font-mono text-[10px] text-subtle">
                        {r ? fmt(r.order_similarity) : "—"}
                      </td>
                    ];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {PARSE_QUALITY.rows.some((r) => r.provenance.source === "imported") ? (
            <p className="mt-2 font-mono text-[9px] text-subtle">† imported from an earlier measurement; that backend is not installed here.</p>
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
    <div className="mt-4 flex flex-wrap items-start gap-x-6 gap-y-1 border-t border-line pt-3 font-mono text-[10px] text-subtle">
      <span className="flex items-center gap-1.5">
        <TerminalIcon size={11} />
        {command}
      </span>
      {chat.length ? <span>chat: {chat.join(", ")}</span> : null}
      {embed.length ? <span>embeddings: {embed.join(", ")}</span> : null}
      {reranker.length ? <span>reranker: {reranker.join(", ")}</span> : null}
      <span className="flex items-center gap-1.5">
        <ChartBarIcon size={11} />
        the README tables are rendered from the same files by scripts/render_results.py
      </span>
    </div>
  );
}

function Code({ text }: { text: string }) {
  return (
    <code className="border border-line bg-foreground/5 px-1 py-px font-mono text-[0.9em]">{text}</code>
  );
}
