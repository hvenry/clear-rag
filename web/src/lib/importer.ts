/**
 * The sample-set import, as a module-level store outside the component tree.
 *
 * An import outlives any one component: it usually starts from the library's empty
 * state, and the moment the first file is indexed that view unmounts in favour of the
 * document list. State owned by the unmounting component loses the progress bar while
 * the stream keeps running — so the run lives here, and any view subscribes.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

import { api } from "./api";

export type ImportFileStatus = "pending" | "indexing" | "done" | "error";

export interface ImportFileState {
  filename: string;
  status: ImportFileStatus;
}

export interface ImportRun {
  setId: string;
  files: ImportFileState[];
  startedAt: number;
  /** When the current file began embedding — the per-file timer's origin. */
  fileStartedAt: number;
  finishedAt: number | null;
  summary: string | null;
  /** A non-fatal degradation (e.g. parser fallback) — shown alongside the summary. */
  warning: string | null;
}

let run: ImportRun | null = null;
let controller: AbortController | null = null;
let clearTimer: number | undefined;
const listeners = new Set<() => void>();

function emit(next: ImportRun | null) {
  run = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The active (or just-finished, for a few seconds) import run, if any. */
export function useImportRun(): ImportRun | null {
  return useSyncExternalStore(subscribe, () => run);
}

/** Abort the stream. The file currently embedding is the last one written. */
export function stopImport(): void {
  controller?.abort();
}

export async function startImport(setId: string, onCorpusChange: () => void): Promise<void> {
  if (run && run.finishedAt === null) return;
  window.clearTimeout(clearTimer);
  controller = new AbortController();
  const startedAt = Date.now();
  emit({
    setId,
    files: [],
    startedAt,
    fileStartedAt: startedAt,
    finishedAt: null,
    summary: null,
    warning: null
  });

  const patch = (fn: (previous: ImportRun) => ImportRun) => {
    if (run) emit(fn(run));
  };

  try {
    for await (const event of api.importSampleSet(setId, controller.signal)) {
      switch (event.type) {
        case "start":
          patch((previous) => ({
            ...previous,
            files: event.filenames.map((filename) => ({
              filename,
              status: "pending" as const
            }))
          }));
          break;
        case "file":
          patch((previous) => ({
            ...previous,
            fileStartedAt: Date.now(),
            files: previous.files.map((file, index) => ({
              ...file,
              status:
                index === event.index
                  ? "indexing"
                  : index < event.index && file.status !== "error"
                    ? "done"
                    : file.status
            }))
          }));
          // Refresh listings after every file, so documents appear as they land
          // instead of all at once when the set finishes.
          onCorpusChange();
          break;
        case "warning":
          patch((previous) => ({
            ...previous,
            warning: previous.warning ?? event.message
          }));
          break;
        case "error":
          patch((previous) => ({
            ...previous,
            summary: event.message,
            files: previous.files.map((file) =>
              file.status === "indexing" ? { ...file, status: "error" as const } : file
            )
          }));
          break;
        case "done":
          patch((previous) => ({
            ...previous,
            summary: event.indexed
              ? `Indexed ${event.indexed} document${event.indexed > 1 ? "s" : ""}.`
              : "Already indexed.",
            files: previous.files.map((file) =>
              file.status === "error" ? file : { ...file, status: "done" as const }
            )
          }));
          break;
      }
    }
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    patch((previous) => ({
      ...previous,
      summary: aborted ? "Stopped — remaining files were not indexed." : String(error)
    }));
  } finally {
    controller = null;
    patch((previous) => ({ ...previous, finishedAt: Date.now() }));
    onCorpusChange();
    // Keep the summary readable for a moment, then let the run leave the screen.
    clearTimer = window.setTimeout(() => emit(null), 6000);
  }
}

/** Seconds since `from`, ticking once a second — frozen once `until` is set. */
export function useElapsedSeconds(from: number, until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until !== null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return Math.max(0, Math.round(((until ?? now) - from) / 1000));
}

export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
