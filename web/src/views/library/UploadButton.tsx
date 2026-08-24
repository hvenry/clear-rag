import { PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";

/**
 * A real file input. Drag-and-drop was the only way to add documents, which excludes
 * every phone; this is the same upload path behind a picker the OS provides.
 */
export function UploadButton({
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
        "inline-flex cursor-pointer items-center justify-center gap-1.5 border border-line font-display tracking-[0.14em] uppercase transition-colors hover:border-foreground/50",
        compact ? "w-full px-2 py-1.5 text-[10px]" : "px-3 py-1.5 text-[11px]",
        busy ? "pointer-events-none opacity-40" : ""
      ].join(" ")}
    >
      <PlusIcon size={12} />
      {busy ? "Indexing…" : "Add documents"}
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
