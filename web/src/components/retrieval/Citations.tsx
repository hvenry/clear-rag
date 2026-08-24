import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { Citation } from "../../lib/types";

/**
 * Renders an answer as Markdown (GFM: tables, lists, emphasis) with `[n]` markers
 * turned into clickable citation chips.
 *
 * The chip mechanism: validated markers are rewritten to `[n](#cite-n)` links
 * *before* parsing, so they survive wherever Markdown puts them — a table cell, a
 * list item, bold text — and the link renderer turns them into chips. A marker
 * with no matching citation was invented by the model and validated away
 * server-side; it stays literal text rather than becoming a false source.
 */
export function AnswerText({
  text,
  citations,
  onCite
}: {
  text: string;
  citations: Citation[];
  onCite: (citation: Citation) => void;
}) {
  const byMarker = useMemo(() => new Map(citations.map((c) => [c.marker, c])), [citations]);

  const source = useMemo(
    () =>
      text.replace(/\[(\d{1,2})\]/g, (whole, n) =>
        byMarker.has(Number(n)) ? `[${n}](#cite-${n})` : whole
      ),
    [text, byMarker]
  );

  const components: Components = {
    a: ({ href, children }) => {
      const match = href ? /^#cite-(\d{1,2})$/.exec(href) : null;
      const citation = match ? byMarker.get(Number(match[1])) : undefined;
      if (citation) {
        return (
          <button
            onClick={() => onCite(citation)}
            title={`${citation.filename}${citation.page ? ` · p.${citation.page}` : ""}`}
            className="mx-0.5 inline-flex h-[17px] min-w-[17px] items-center justify-center border border-line px-1 align-baseline font-mono text-[10px] transition-colors hover:border-foreground/60 hover:bg-foreground hover:text-background"
          >
            {citation.marker}
          </button>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-line underline-offset-2 hover:decoration-foreground"
        >
          {children}
        </a>
      );
    },
    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
    strong: ({ children }) => <strong className="font-medium text-foreground">{children}</strong>,
    code: ({ children }) => (
      <code className="border border-line bg-foreground/5 px-1 py-px font-mono text-[0.85em]">
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="my-2 overflow-x-auto border border-line bg-foreground/4 p-2.5 font-mono text-[12px] leading-relaxed [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="menu-label border border-line px-2 py-1 text-left">{children}</th>
    ),
    td: ({ children }) => <td className="border border-line px-2 py-1 align-top">{children}</td>,
    h1: ({ children }) => (
      <h3 className="mt-3 mb-1.5 font-display text-[15px] tracking-wide">{children}</h3>
    ),
    h2: ({ children }) => (
      <h3 className="mt-3 mb-1.5 font-display text-[14px] tracking-wide">{children}</h3>
    ),
    h3: ({ children }) => (
      <h3 className="mt-3 mb-1.5 font-display text-[13px] tracking-wide">{children}</h3>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-line pl-3 text-muted">{children}</blockquote>
    ),
    hr: () => <div className="rule-dashed my-3" />
  };

  return (
    <div className="text-[14px] leading-[1.75]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
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
