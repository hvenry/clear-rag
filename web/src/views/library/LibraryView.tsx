import {
  FileCsvIcon,
  FileDocIcon,
  FileMdIcon,
  FilePdfIcon,
  FileTextIcon,
  ScanIcon,
  SidebarSimpleIcon,
  TrashIcon,
  type Icon
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";

import type { AppOutletContext } from "../../app/session";
import { EmptyState } from "../../components/EmptyState";
import { IconButton } from "../../components/IconButton";
import { Loader } from "../../components/Loader";
import { Segmented } from "../../components/Segmented";
import {
  formatElapsed,
  useElapsedSeconds,
  useImportRun,
  type ImportFileState
} from "../../lib/importer";
import { assignSlots, catColor } from "../../lib/palette";
import { useDeleteDocument, useDocuments } from "../../lib/queries";
import { ChunkInspector } from "./ChunkInspector";
import { EmbeddingMap } from "./EmbeddingMap";
import { SampleSets } from "./SampleSets";
import { UploadButton } from "./UploadButton";

/**
 * The library, with the chunk visualiser as its main panel.
 *
 * Navigation is the URL: `/library` is the list, `/library/:docId` a document,
 * `/library/map` the embedding map. A citation click lands here carrying its
 * highlight span in location.state, because the span is ephemeral reading position, not
 * part of the document's address.
 */
export function LibraryView() {
  const { docId } = useParams<{ docId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { upload } = useOutletContext<AppOutletContext>();
  const { data: documents = [], isLoading } = useDocuments();
  const deleteDocument = useDeleteDocument();
  const [railCollapsed, setRailCollapsed] = useState(false);

  // Files of an in-flight sample import that are not documents yet: rendered as
  // placeholder rows so the whole set is visible from the first second, instead of
  // rows popping in one by one as each file finishes embedding.
  const importRun = useImportRun();
  const pendingFiles =
    importRun && importRun.finishedAt === null
      ? importRun.files.filter((f) => !documents.some((d) => d.filename === f.filename))
      : [];

  const mode: "documents" | "map" = location.pathname === "/library/map" ? "map" : "documents";
  const active = docId ?? null;
  const highlightSpan = (location.state as { span?: [number, number] } | null)?.span ?? null;

  useEffect(() => {
    // A URL naming a document that no longer exists falls back to the list;
    // never auto-select a replacement.
    if (active && !isLoading && !documents.some((d) => d.id === active)) {
      navigate("/library", { replace: true });
    }
  }, [documents, active, isLoading, navigate]);

  // Same filename ordering the vector map uses, so a document keeps one colour
  // across the list, the map and its legend.
  const slots = useMemo(
    () =>
      assignSlots(
        [...documents].sort((a, b) => a.filename.localeCompare(b.filename)).map((d) => d.id)
      ),
    [documents]
  );

  if (!isLoading && documents.length === 0 && pendingFiles.length === 0) {
    return (
      <div className="mx-auto w-full max-w-4xl px-3 py-4 sm:px-5 sm:py-6">
        <EmptyState lead="Nothing indexed yet. Add a PDF, DOCX, Markdown, CSV or text file and it will appear here, split into the chunks retrieval actually searches over, or start from a bundled sample set.">
          <UploadButton onUpload={upload} />
          <SampleSets
            showClear={false}
            collapsible={false}
            className="mt-4 w-full max-w-xs border border-line px-3 pt-2.5 pb-3 text-left"
          />
        </EmptyState>
      </div>
    );
  }

  // On phones this is master-detail navigation: the list is a full-width page, opening
  // a document replaces it (the inspector's close button is the way back), and the map
  // takes the whole viewport. A 240px rail beside a 390px screen served neither pane.
  const detailShown = mode === "map" || active !== null;

  return (
    <div className="flex h-full min-h-0">
      {/* Collapsed: a slim strip holding the expand control, desktop only; on a
          phone the list is a full page and collapsing it would strand the user. */}
      {railCollapsed ? (
        <aside className="hidden shrink-0 flex-col items-center gap-3 border-r border-line px-1.5 pt-2 lg:flex">
          <IconButton label="Expand library" onClick={() => setRailCollapsed(false)}>
            <SidebarSimpleIcon size={16} />
          </IconButton>
          <span
            className="menu-label"
            style={{ writingMode: "vertical-rl" }}
          >
            Library
          </span>
        </aside>
      ) : null}

      {/* Rail anatomy: header and controls pinned at the top, sample data docked at
          the bottom, and only the document list between them scrolls. */}
      <aside
        className={[
          detailShown ? "hidden" : "flex",
          railCollapsed ? "lg:hidden" : "lg:flex",
          "w-full shrink-0 flex-col border-r border-line lg:w-64"
        ].join(" ")}
      >
        <div className="hidden shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2 lg:flex">
          <span className="font-display text-meta tracking-[0.18em] text-subtle uppercase">
            Library
          </span>
          <IconButton label="Collapse library" onClick={() => setRailCollapsed(true)}>
            <SidebarSimpleIcon size={14} />
          </IconButton>
        </div>
        {/* Stacked rows instead of one crowded line: the mode switch gets the full
            rail width, and upload gets its own row, so nothing wraps. */}
        <div className="shrink-0 space-y-2 px-3 pt-3 pb-2">
          <Segmented
            variant="display"
            grow
            value={mode}
            onChange={(m) => navigate(m === "map" ? "/library/map" : "/library")}
            options={[
              { value: "documents", label: "Documents", icon: FileTextIcon },
              { value: "map", label: "Vector map", icon: ScanIcon }
            ]}
          />
          <UploadButton onUpload={upload} compact />
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto pb-3">
          {documents.map((doc) => {
            const TypeIcon = fileIcon(doc.filename);
            return (
              <li key={doc.id}>
                <div
                  className={[
                    "group flex items-center gap-2 border-l-2 px-3 py-2 transition-colors",
                    active === doc.id
                      ? "border-l-foreground bg-foreground/6"
                      : "border-l-transparent hover:bg-foreground/4"
                  ].join(" ")}
                >
                  <button
                    onClick={() => navigate(`/library/${doc.id}`)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <TypeIcon size={18} className="shrink-0 text-subtle" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="h-1.5 w-1.5 shrink-0"
                          style={{ background: catColor(slots.get(doc.id) ?? -1) }}
                          aria-hidden
                        />
                        <span className="truncate text-body">{doc.filename}</span>
                      </span>
                      <span className="tabular block font-mono text-meta text-subtle">
                        {doc.n_chunks} chunks · {doc.chars.toLocaleString()} chars
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={async () => {
                      await deleteDocument.mutateAsync(doc.id);
                      if (active === doc.id) navigate("/library");
                    }}
                    data-hint="Remove this document and its vectors from the index."
                    aria-label={`Delete ${doc.filename}`}
                    className="hint hint-right hint-end shrink-0 border border-line p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:border-critical/70 hover:text-critical focus-visible:opacity-100"
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              </li>
            );
          })}
          {pendingFiles.map((file) => (
            <PendingRow
              key={file.filename}
              file={file}
              startedAt={importRun!.fileStartedAt}
            />
          ))}
        </ul>

        <SampleSets />
      </aside>

      <div className={`${detailShown ? "block" : "hidden lg:block"} min-w-0 flex-1 overflow-hidden`}>
        {mode === "map" ? (
          <EmbeddingMap
            onClose={() => navigate("/library")}
            onOpenDoc={(id) => navigate(`/library/${id}`)}
          />
        ) : active ? (
          <ChunkInspector
            docId={active}
            highlight={highlightSpan ? { span: highlightSpan } : null}
            onClose={() => navigate("/library")}
          />
        ) : (
          <div className="mx-auto w-full max-w-4xl px-3 py-4 sm:px-5 sm:py-6">
            <EmptyState lead="Select a document to inspect its chunks: boundaries, structure and overlap are drawn over the source text." />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A document that is about to exist: one file of an in-flight sample import.
 * Same row anatomy as a real document, dimmed, with its own status line; the
 * active file gets a loader and a ticking per-file timer.
 */
function PendingRow({ file, startedAt }: { file: ImportFileState; startedAt: number }) {
  const TypeIcon = fileIcon(file.filename);
  const indexing = file.status === "indexing";
  const seconds = useElapsedSeconds(startedAt, indexing ? null : 0);
  return (
    <li className="border-l-2 border-l-transparent px-3 py-2 opacity-60">
      <span className="flex items-center gap-2">
        <TypeIcon size={18} className="shrink-0 text-subtle" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body">{file.filename}</span>
          <span className="tabular mt-0.5 block font-mono text-meta text-subtle">
            {indexing ? (
              <span className="flex items-center gap-2">
                <Loader />
                embedding · {formatElapsed(seconds)}
              </span>
            ) : file.status === "error" ? (
              <span className="text-critical">failed</span>
            ) : file.status === "done" ? (
              "indexed"
            ) : (
              "queued"
            )}
          </span>
        </span>
      </span>
    </li>
  );
}

function fileIcon(filename: string): Icon {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf":
      return FilePdfIcon;
    case "docx":
    case "doc":
      return FileDocIcon;
    case "md":
    case "markdown":
      return FileMdIcon;
    case "csv":
      return FileCsvIcon;
    default:
      return FileTextIcon;
  }
}
