/**
 * A pipeline error with its remedy: the same two-line shape everywhere an error
 * event can land (a chat turn, a Lab run), so failure always reads the same way.
 */
export function ErrorNotice({ message, remedy }: { message: string; remedy?: string | null }) {
  return (
    <div className="border border-critical/50 px-3 py-2">
      <p className="text-body text-muted">{message}</p>
      {remedy ? <p className="mt-1 font-mono text-meta text-subtle">→ {remedy}</p> : null}
    </div>
  );
}
