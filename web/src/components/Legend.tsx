import { SOURCE_HINT, SOURCE_LABEL } from "../lib/stages";

/**
 * Identity is never carried by colour alone — every swatch ships its label.
 *
 * That is also what discharges the two outstanding warnings from the palette
 * validation (dark red/aqua CVD separation, light aqua contrast): both are legal
 * only with secondary encoding, and the label is it.
 */
export function SourceLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {(["keyword", "vector", "both"] as const).map((source) => (
        <span
          key={source}
          data-hint={SOURCE_HINT[source]}
          className="hint flex items-center gap-1.5 text-[10px] text-subtle"
        >
          {source === "both" ? (
            <span className="inline-flex gap-px">
              <span className="h-1.5 w-1.5 bg-keyword" />
              <span className="h-1.5 w-1.5 bg-vector" />
            </span>
          ) : (
            <span
              className={`h-1.5 w-1.5 ${source === "keyword" ? "bg-keyword" : "bg-vector"}`}
            />
          )}
          {SOURCE_LABEL[source]}
        </span>
      ))}
    </div>
  );
}
