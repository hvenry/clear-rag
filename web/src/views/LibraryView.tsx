import { useEffect, useState } from "react";

import { ChunkInspector } from "../components/ChunkInspector";
import { EmbeddingMap } from "../components/EmbeddingMap";
import { Panel } from "../components/Panel";
import { api } from "../lib/api";
import type { DocumentSummary } from "../lib/types";

/**
 * The library, with the chunk visualiser as its main panel.
 *
 * This used to live in a sidebar gated behind the `xl` breakpoint, which meant that on
 * anything but a very wide window the feature existed but could not be reached. It is a
 * destination now.
 */
export function LibraryView({
  documents,
  onChanged,
  onUpload,
  initialDocId
}: {
  documents: DocumentSummary[];
  onChanged: () => void;
  onUpload: (files: File[]) => Promise<void>;
  initialDocId?: string | null;
}) {
  const [active, setActive] = useState<string | null>(initialDocId ?? null);
  const [mode, setMode] = useState<"documents" | "map">("documents");

  useEffect(() => {
    if (initialDocId) {
      setActive(initialDocId);
      setMode("documents");
    }
  }, [initialDocId]);

  useEffect(() => {
    // Only clear a selection that no longer exists — never auto-select. Auto-selecting
    // hid the list on mobile, and closing the document re-selected it instantly,
    // making the list unreachable on a phone.
    if (active && !documents.some((d) => d.id === active)) {
      setActive(null);
    }
  }, [documents, active]);

  if (documents.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6 sm:py-16">
        <h2 className="font-display text-[15px] tracking-[0.14em] uppercase">Library</h2>
        <div className="rule-dashed my-5" />
        <p className="text-[13px] leading-relaxed text-muted">
          Nothing indexed yet. Add a PDF, DOCX, Markdown, CSV or text file and it will
          appear here, split into the chunks retrieval actually searches over.
        </p>
        <div className="mt-4">
          <UploadButton onUpload={onUpload} />
        </div>
      </div>
    );
  }

  // On phones this is master-detail navigation: the list is a full-width page, opening
  // a document replaces it (the inspector's close button is the way back), and the map
  // takes the whole viewport. A 240px rail beside a 390px screen served neither pane.
  const detailShown = mode === "map" || active !== null;

  return (
    <div className="flex h-full min-h-0">
      <aside
        className={`${detailShown ? "hidden lg:block" : "block"} w-full shrink-0 overflow-y-auto border-r border-line lg:w-60`}
      >
        <div className="px-4 pt-4 pb-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex">
            {(["documents", "map"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                data-hint={
                  m === "documents"
                    ? "Read each document with its chunk boundaries drawn over the text."
                    : "See every chunk as a point in embedding space, and where a question lands among them."
                }
                className={[
                  "hint -ml-px border px-2.5 py-1 font-display text-[10px] tracking-[0.14em] uppercase transition-colors first:ml-0",
                  mode === m
                    ? "z-10 border-foreground/50 bg-foreground text-background"
                    : "border-line text-subtle hover:border-foreground/40 hover:text-foreground"
                ].join(" ")}
              >
                {m === "documents" ? "Documents" : "Vector map"}
              </button>
            ))}
            </div>
            <UploadButton onUpload={onUpload} compact />
          </div>
        </div>
        <ul className="pb-3">
          {documents.map((doc) => (
            <li key={doc.id}>
              <div
                className={[
                  "group flex items-center gap-2 border-l-2 px-4 py-2 transition-colors",
                  active === doc.id
                    ? "border-l-foreground bg-foreground/6"
                    : "border-l-transparent hover:bg-foreground/4"
                ].join(" ")}
              >
                <button onClick={() => setActive(doc.id)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-[12px]">{doc.filename}</div>
                  <div className="tabular font-mono text-[10px] text-subtle">
                    {doc.n_chunks} chunks · {doc.chars.toLocaleString()} chars
                  </div>
                </button>
                <button
                  onClick={async () => {
                    await api.deleteDocument(doc.id);
                    if (active === doc.id) setActive(null);
                    onChanged();
                  }}
                  data-hint="Remove this document and its vectors from the index."
                  className="hint hint-right hint-end shrink-0 border border-line px-1.5 py-0.5 font-mono text-[10px] opacity-0 transition-opacity group-hover:opacity-100 hover:border-critical/70 hover:text-critical"
                >
                  del
                </button>
              </div>
            </li>
          ))}
        </ul>
      </aside>

      <div className={`${detailShown ? "block" : "hidden lg:block"} min-w-0 flex-1 overflow-hidden`}>
        {mode === "map" ? (
          <EmbeddingMap
            onClose={() => setMode("documents")}
            onOpenDoc={(docId) => {
              setActive(docId);
              setMode("documents");
            }}
          />
        ) : active ? (
          <ChunkInspector docId={active} onClose={() => setActive(null)} />
        ) : (
          <div className="p-6">
            <Panel ticks className="px-5 py-4">
              <p className="text-[12px] text-muted">Select a document to inspect its chunks.</p>
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}


/**
 * A real file input. Drag-and-drop was the only way to add documents, which excludes
 * every phone; this is the same upload path behind a picker the OS provides.
 */
function UploadButton({
  onUpload,
  compact = false
}: {
  onUpload: (files: File[]) => Promise<void>;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <label
      className={[
        "inline-flex cursor-pointer items-center border border-line font-display tracking-[0.14em] uppercase transition-colors hover:border-foreground/50",
        compact ? "px-2 py-1 text-[10px]" : "px-3 py-1.5 text-[11px]",
        busy ? "pointer-events-none opacity-40" : ""
      ].join(" ")}
    >
      {busy ? "Indexing…" : "+ Add"}
      <input
        type="file"
        multiple
        accept=".pdf,.docx,.md,.markdown,.txt,.csv"
        className="hidden"
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (!files.length) return;
          setBusy(true);
          try {
            await onUpload(files);
          } finally {
            setBusy(false);
          }
        }}
      />
    </label>
  );
}
