import type { Citation } from "../lib/types";

/** Renders an answer with `[n]` markers turned into clickable chips. */
export function AnswerText({
  text,
  citations,
  onCite
}: {
  text: string;
  citations: Citation[];
  onCite: (citation: Citation) => void;
}) {
  const byMarker = new Map(citations.map((c) => [c.marker, c]));
  const parts = text.split(/(\[\d{1,2}\])/g);

  return (
    <p className="text-[14px] leading-[1.75] whitespace-pre-wrap">
      {parts.map((part, i) => {
        const match = /^\[(\d{1,2})\]$/.exec(part);
        const citation = match ? byMarker.get(Number(match[1])) : undefined;

        // A marker with no matching citation was invented by the model and validated
        // away server-side; it is rendered as plain text rather than a false source.
        if (!citation) return <span key={i}>{part}</span>;

        return (
          <button
            key={i}
            onClick={() => onCite(citation)}
            title={`${citation.filename}${citation.page ? ` · p.${citation.page}` : ""}`}
            className="mx-0.5 inline-flex h-[17px] min-w-[17px] items-center justify-center border border-line px-1 align-baseline font-mono text-[10px] transition-colors hover:border-foreground/60 hover:bg-foreground hover:text-background"
          >
            {citation.marker}
          </button>
        );
      })}
    </p>
  );
}

export function CitationList({
  citations,
  onCite
}: {
  citations: Citation[];
  onCite: (citation: Citation) => void;
}) {
  if (citations.length === 0) return null;

  return (
    <ul className="mt-4 space-y-1.5 border-t border-line pt-3">
      {citations.map((citation) => (
        <li key={citation.chunk_id}>
          <button
            onClick={() => onCite(citation)}
            className="group flex w-full items-start gap-2.5 text-left"
          >
            <span className="mt-px inline-flex h-[17px] min-w-[17px] shrink-0 items-center justify-center border border-line font-mono text-[10px]">
              {citation.marker}
            </span>
            <span className="min-w-0 flex-1">
              <span className="font-mono text-[10px] text-subtle">
                {citation.filename}
                {citation.page ? ` · p.${citation.page}` : ""} · chars {citation.span[0]}–
                {citation.span[1]}
              </span>
              <span className="block truncate text-[11px] text-muted transition-opacity group-hover:opacity-100">
                {citation.quote}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
