import {
  BroomIcon,
  CaretDownIcon,
  DownloadSimpleIcon,
  StopIcon,
  TrashIcon
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import {
  formatElapsed,
  startImport,
  stopImport,
  useElapsedSeconds,
  useImportRun
} from "../../lib/importer";
import { useClearDocuments, useInvalidateCorpus, useSampleSets } from "../../lib/queries";

/**
 * The bundled demo corpora, with import/remove per set and a clear-index control.
 *
 * The import itself runs in the module-level importer store; this component only
 * starts, stops and renders it, so the progress readout survives the view swapping
 * from the empty state to the document list mid-import.
 */
/** Collapse survives view changes but not a reload: a preference, not an address. */
let lastCollapsed = false;

export function SampleSets({
  showClear = true,
  collapsible = true,
  className = "shrink-0 border-t border-line px-3 pt-2.5 pb-3"
}: {
  showClear?: boolean;
  collapsible?: boolean;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(collapsible && lastCollapsed);
  const toggle = () => {
    lastCollapsed = !collapsed;
    setCollapsed(lastCollapsed);
  };
  const { data: sets = [] } = useSampleSets();
  const invalidate = useInvalidateCorpus();
  const clearDocuments = useClearDocuments();
  const run = useImportRun();
  const importing = run !== null && run.finishedAt === null;
  const elapsed = useElapsedSeconds(run?.startedAt ?? 0, run === null ? 0 : run.finishedAt);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const noticeTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const flash = (message: string) => {
    setNotice(message);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  };

  const removeSet = async (setId: string) => {
    try {
      const report = await api.removeSampleSet(setId);
      flash(`Removed ${report.removed} document${report.removed === 1 ? "" : "s"}.`);
    } catch (error) {
      flash(String(error));
    } finally {
      void invalidate();
    }
  };

  const clearIndex = async () => {
    setConfirmClear(false);
    try {
      const report = await clearDocuments.mutateAsync();
      flash(`Cleared ${report.removed} document${report.removed === 1 ? "" : "s"}.`);
    } catch (error) {
      flash(String(error));
    }
  };

  if (sets.length === 0) return null;

  return (
    <div className={className}>
      {collapsible ? (
        // Same anatomy as the chat's telemetry panel: the whole header is the
        // toggle, with one caret that rotates. Pointing up while collapsed, because
        // this panel expands upward from the rail's bottom edge.
        <button
          onClick={toggle}
          aria-expanded={!collapsed}
          // A button's width fits its content, so the full-bleed span (rail border
          // to rail border, and up through the section's top padding) is explicit.
          className={`-mx-3 -mt-2.5 flex w-[calc(100%+1.5rem)] items-center justify-between gap-2 px-3 pt-2.5 pb-1.5 text-left transition-colors hover:bg-foreground/4 ${collapsed ? "" : "mb-1"}`}
        >
          <span className="menu-label">Sample data</span>
          <CaretDownIcon
            size={14}
            className={`shrink-0 text-subtle transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`}
          />
        </button>
      ) : (
        <p className="menu-label mb-1.5">Sample data</p>
      )}
      {collapsed ? null : (
        <>
          <ul className="space-y-1">
        {sets.map((set) => {
          const thisRun = run?.setId === set.id ? run : null;
          const fullyIndexed = set.indexed_count >= set.file_count;
          const settled = thisRun
            ? thisRun.files.filter((f) => f.status === "done" || f.status === "error").length
            : 0;
          const activeFile = thisRun?.files.find((f) => f.status === "indexing") ?? null;
          return (
            <li key={set.id} className="group">
              <div className="flex items-center gap-2 py-0.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body">{set.label}</span>
                  <span className="tabular block font-mono text-meta text-subtle">
                    {set.indexed_count}/{set.file_count} indexed
                  </span>
                </span>
                {thisRun && importing ? (
                  <button
                    onClick={() => stopImport()}
                    data-hint="Stop indexing this set. Files already indexed stay; the rest can be imported again later."
                    aria-label={`Stop importing ${set.label}`}
                    className="hint hint-right hint-end shrink-0 border border-line p-1 transition-colors hover:border-critical/70 hover:text-critical"
                  >
                    <StopIcon size={14} />
                  </button>
                ) : (
                  <>
                    {!fullyIndexed ? (
                      <button
                        onClick={() => void startImport(set.id, () => void invalidate())}
                        disabled={importing}
                        data-hint={`Index this set. ${set.description}`}
                        aria-label={`Import ${set.label}`}
                        className="hint hint-right hint-end shrink-0 border border-line p-1 transition-colors hover:border-foreground/50 disabled:opacity-40"
                      >
                        <DownloadSimpleIcon size={14} />
                      </button>
                    ) : null}
                    {set.indexed_count > 0 ? (
                      <button
                        onClick={() => void removeSet(set.id)}
                        disabled={importing}
                        data-hint="Remove this set's documents and their vectors from the index."
                        aria-label={`Remove ${set.label}`}
                        className="hint hint-right hint-end shrink-0 border border-line p-1 transition-colors hover:border-critical/70 hover:text-critical disabled:opacity-40"
                      >
                        <TrashIcon size={14} />
                      </button>
                    ) : null}
                  </>
                )}
              </div>
              {thisRun && importing ? (
                <div className="pb-1">
                  <div className="h-1 w-full bg-foreground/10">
                    <div
                      className="h-full bg-foreground transition-[width] duration-300"
                      style={{
                        width: `${thisRun.files.length ? Math.round((settled / thisRun.files.length) * 100) : 0}%`
                      }}
                    />
                  </div>
                  <p className="tabular mt-1 flex justify-between gap-2 font-mono text-meta text-subtle">
                    <span className="truncate">
                      {settled}/{thisRun.files.length || "…"}
                      {activeFile ? ` · ${activeFile.filename}` : ""}
                    </span>
                    <span className="shrink-0">{formatElapsed(elapsed)}</span>
                  </p>
                </div>
              ) : null}
              {thisRun && !importing && thisRun.summary ? (
                <p className="pb-1 font-mono text-meta text-subtle">
                  {thisRun.summary} ({formatElapsed(elapsed)})
                </p>
              ) : null}
              {thisRun?.warning ? (
                <p className="pb-1 font-mono text-meta text-slow">{thisRun.warning}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {showClear ? (
        confirmClear ? (
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void clearIndex()}
              className="border border-critical/70 px-2 py-1 font-mono text-meta text-critical transition-colors hover:bg-critical/10"
            >
              Remove everything
            </button>
            <button
              onClick={() => setConfirmClear(false)}
              className="border border-line px-2 py-1 font-mono text-meta transition-colors hover:border-foreground/50"
            >
              Keep
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmClear(true)}
            disabled={importing || clearDocuments.isPending}
            className="mt-2 flex w-full items-center justify-center gap-1.5 border border-line px-2 py-1 font-mono text-meta text-subtle transition-colors hover:border-critical/70 hover:text-critical disabled:opacity-40"
          >
            <BroomIcon size={14} />
            Clear index
          </button>
        )
      ) : null}

          {notice ? <p className="mt-2 font-mono text-meta text-subtle">{notice}</p> : null}
        </>
      )}
    </div>
  );
}
