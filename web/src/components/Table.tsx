import type { ReactNode } from "react";

/**
 * The one table header cell. Every data table in the app (retrieval, results,
 * questions, parse quality) had its own copy of the same small-caps header with
 * an optional hover hint; this is that header, once.
 */
export function Th({
  children,
  hint,
  align = "left",
  hintEnd = false,
  className = ""
}: {
  children: ReactNode;
  hint?: string;
  align?: "left" | "right";
  /** Anchor the hint to the cell's right edge so it opens leftward: for columns
   *  near a table's right side, where a left-anchored hint would be clipped. */
  hintEnd?: boolean;
  className?: string;
}) {
  return (
    <th
      data-hint={hint}
      className={[
        hint ? "hint" : "",
        hint && (align === "right" || hintEnd) ? "hint-end" : "",
        "menu-label pt-2 pb-2 pr-3 font-medium",
        align === "right" ? "text-right" : "text-left",
        className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </th>
  );
}
