import type { ReactNode } from "react";

/**
 * The one empty-page format. Every view's resting state (Chat before a question,
 * the Lab before a run, the Library before a selection) uses this same lead
 * size, measure and vertical position, so switching views never jiggles the
 * opening line. Callers wrap it in the same container metrics as Chat's content
 * column (`mx-auto max-w-4xl px-3 py-4 sm:px-5 sm:py-6`) or compensate to match.
 */
export function EmptyState({ lead, children }: { lead: string; children?: ReactNode }) {
  return (
    <div className="reveal py-14">
      <p className="max-w-lg text-lead leading-relaxed text-muted">{lead}</p>
      {children ? (
        <>
          <div className="rule-dashed my-6 max-w-lg" />
          {children}
        </>
      ) : null}
    </div>
  );
}
