import {
  CheckSquareIcon,
  GearSixIcon,
  PlusIcon,
  SquareIcon,
  TrashIcon,
  XIcon
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { IconButton } from "../../components/IconButton";
import { SidePanel } from "../../components/SidePanel";
import { UploadButton } from "../library/UploadButton";
import { api } from "../../lib/api";
import {
  useCreateSession,
  useDeleteSession,
  useDocuments,
  useSessions,
  useUpdateSession
} from "../../lib/queries";
import type { DocumentSummary, SessionSummary } from "../../lib/types";

/**
 * The chat's session rail: every conversation, its document scope, and the
 * controls to start, re-scope or delete one. Always visible on desktop; a
 * drawer on phones. Scope is stored as document ids (null = whole corpus),
 * so it survives re-indexing and grows with the corpus when unscoped.
 */
export function SessionRail({
  activeId,
  open,
  onClose,
  onUpload
}: {
  activeId?: string;
  open: boolean;
  onClose: () => void;
  onUpload: (files: File[]) => Promise<void>;
}) {
  const navigate = useNavigate();
  const { data: sessions = [] } = useSessions();
  const { data: documents = [] } = useDocuments();
  const createSession = useCreateSession();
  const updateSession = useUpdateSession();
  const deleteSession = useDeleteSession();
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; session: SessionSummary } | null
  >(null);

  const scopeLabel = (session: SessionSummary) =>
    session.doc_ids === null
      ? "all documents"
      : `${session.doc_ids.length} document${session.doc_ids.length === 1 ? "" : "s"}`;

  const removeSession = async (id: string) => {
    await deleteSession.mutateAsync(id);
    if (activeId === id) {
      const remaining = sessions.filter((s) => s.id !== id);
      // Deleting the last session: the next list auto-creates a fresh default.
      const target = remaining[0] ?? (await api.sessions())[0];
      if (target) navigate(`/chat/${target.id}`, { replace: true });
    }
  };

  return (
    <>
      <SidePanel title="Chats" open={open} onClose={onClose} widthClass="lg:w-56">
        <div className="px-3 pt-3 pb-2">
          <button
            onClick={() => setDialog({ mode: "create" })}
            className="flex w-full items-center justify-center gap-1.5 border border-line px-2 py-1.5 font-display text-meta tracking-[0.14em] uppercase transition-colors hover:border-foreground/50"
          >
            <PlusIcon size={14} />
            New chat
          </button>
        </div>

        <ul className="pb-3">
          {sessions.map((session) => (
            <li key={session.id}>
              <div
                className={[
                  "group flex items-center gap-1.5 border-l-2 px-3 py-2 transition-colors",
                  activeId === session.id
                    ? "border-l-foreground bg-foreground/6"
                    : "border-l-transparent hover:bg-foreground/4"
                ].join(" ")}
              >
                <button
                  onClick={() => {
                    navigate(`/chat/${session.id}`);
                    onClose();
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-body">{session.title}</span>
                  <span className="tabular block font-mono text-meta text-subtle">
                    {scopeLabel(session)}
                  </span>
                </button>
                <button
                  onClick={() => setDialog({ mode: "edit", session })}
                  aria-label={`Settings for ${session.title}`}
                  className="shrink-0 border border-line p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:border-foreground/50 focus-visible:opacity-100"
                >
                  <GearSixIcon size={14} />
                </button>
                <button
                  onClick={() => void removeSession(session.id)}
                  aria-label={`Delete ${session.title}`}
                  className="shrink-0 border border-line p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:border-critical/70 hover:text-critical focus-visible:opacity-100"
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </SidePanel>

      {dialog ? (
        <SessionDialog
          mode={dialog.mode}
          session={dialog.mode === "edit" ? dialog.session : null}
          documents={documents}
          onUpload={onUpload}
          onClose={() => setDialog(null)}
          onSubmit={async (title, docIds) => {
            if (dialog.mode === "create") {
              const created = await createSession.mutateAsync({
                title: title || undefined,
                doc_ids: docIds
              });
              setDialog(null);
              onClose();
              navigate(`/chat/${created.id}`);
            } else {
              await updateSession.mutateAsync({
                id: dialog.session.id,
                ...(title ? { title } : {}),
                ...(docIds === null ? { all_documents: true } : { doc_ids: docIds })
              });
              setDialog(null);
            }
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Create/edit a session: name it, scope it to documents. All boxes checked is
 * stored as "whole corpus" (null), so an unscoped chat keeps seeing documents
 * added later rather than freezing the list it was created with.
 */
function SessionDialog({
  mode,
  session,
  documents,
  onUpload,
  onClose,
  onSubmit
}: {
  mode: "create" | "edit";
  session: SessionSummary | null;
  documents: DocumentSummary[];
  onUpload: (files: File[]) => Promise<void>;
  onClose: () => void;
  onSubmit: (title: string, docIds: string[] | null) => Promise<void>;
}) {
  const [title, setTitle] = useState(session?.title ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        session?.doc_ids === null || session === null
          ? documents.map((d) => d.id)
          : session.doc_ids
      )
  );
  const [saving, setSaving] = useState(false);

  // A document indexed while this dialog is open (its upload button, or a file
  // dropped on the window) was uploaded to be talked to, so check it automatically.
  const seenDocs = useRef(new Set(documents.map((d) => d.id)));
  useEffect(() => {
    const fresh = documents.filter((d) => !seenDocs.current.has(d.id));
    if (fresh.length === 0) return;
    fresh.forEach((d) => seenDocs.current.add(d.id));
    setSelected((prev) => new Set([...prev, ...fresh.map((d) => d.id)]));
  }, [documents]);

  const allSelected = documents.length > 0 && selected.size === documents.length;
  const nothingSelected = documents.length > 0 && selected.size === 0;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    setSaving(true);
    try {
      await onSubmit(title.trim(), allSelected || documents.length === 0 ? null : [...selected]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md border border-line bg-background shadow-[0_8px_28px_rgb(0_0_0/0.4)]"
      >
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <span className="font-display text-meta tracking-[0.18em] text-subtle uppercase">
            {mode === "create" ? "New chat" : "Chat settings"}
          </span>
          <IconButton label="Close" onClick={onClose}>
            <XIcon size={14} />
          </IconButton>
        </div>

        <div className="space-y-3 px-4 py-3">
          <div>
            <label className="mb-1 block text-ui text-muted">Name</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Named after your first question if left blank"
              className="w-full border border-line bg-transparent px-2 py-1.5 font-mono text-ui outline-none transition-colors focus:border-foreground/45"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="text-ui text-muted">Documents this chat searches</label>
              {documents.length > 0 ? (
                <button
                  onClick={() =>
                    setSelected(allSelected ? new Set() : new Set(documents.map((d) => d.id)))
                  }
                  className="font-mono text-meta text-subtle transition-colors hover:text-foreground"
                >
                  {allSelected ? "none" : "all"}
                </button>
              ) : null}
            </div>
            {documents.length === 0 ? (
              <p className="text-ui leading-relaxed text-subtle">
                Nothing is indexed yet, so this chat will search every document you add.
              </p>
            ) : (
              <ul className="max-h-60 overflow-y-auto border border-line">
                {documents.map((doc) => {
                  const checked = selected.has(doc.id);
                  return (
                    <li key={doc.id}>
                      <button
                        onClick={() => toggle(doc.id)}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-foreground/4"
                      >
                        {checked ? (
                          <CheckSquareIcon size={16} className="shrink-0" />
                        ) : (
                          <SquareIcon size={16} className="shrink-0 text-subtle" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-body">
                          {doc.filename}
                        </span>
                        <span className="tabular shrink-0 font-mono text-meta text-subtle">
                          {doc.n_chunks} chunks
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {nothingSelected ? (
              <p className="mt-1 font-mono text-meta text-critical">
                Select at least one document.
              </p>
            ) : allSelected ? (
              <p className="mt-1 font-mono text-meta text-subtle">
                All documents, including ones added later.
              </p>
            ) : null}
            <div className="mt-2">
              <UploadButton onUpload={onUpload} compact />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">
          <button
            onClick={onClose}
            className="border border-line px-2.5 py-1 font-mono text-meta transition-colors hover:border-foreground/50"
          >
            cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={saving || nothingSelected}
            className="border border-foreground/60 bg-foreground px-2.5 py-1 font-mono text-meta text-background transition-colors hover:bg-foreground/85 disabled:opacity-40"
          >
            {saving ? "saving…" : mode === "create" ? "create" : "save"}
          </button>
        </div>
      </div>
    </div>
  );
}
