import { useEffect, useState } from "react";

import { ChunkInspector } from "../components/ChunkInspector";
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
  initialDocId
}: {
  documents: DocumentSummary[];
  onChanged: () => void;
  initialDocId?: string | null;
}) {
  const [active, setActive] = useState<string | null>(initialDocId ?? null);

  useEffect(() => {
    if (initialDocId) setActive(initialDocId);
  }, [initialDocId]);

  useEffect(() => {
    if (documents.length && !documents.some((d) => d.id === active)) {
      setActive(documents[0].id);
    }
  }, [documents, active]);

  if (documents.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h2 className="font-display text-[15px] tracking-[0.14em] uppercase">Library</h2>
        <div className="rule-dashed my-5" />
        <p className="text-[13px] leading-relaxed text-muted">
          Nothing indexed yet. Drop a PDF, DOCX, Markdown, CSV or text file anywhere on
          this window and it will appear here, split into the chunks retrieval actually
          searches over.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-60 shrink-0 overflow-y-auto border-r border-line">
        <div className="px-4 pt-4 pb-2">
          <h2 className="font-display text-[11px] tracking-[0.18em] text-subtle uppercase">
            Documents
          </h2>
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

      <div className="min-w-0 flex-1 overflow-hidden">
        {active ? (
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
