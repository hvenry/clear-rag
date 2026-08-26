/**
 * Categorical colour assignment, mirroring the slot tokens in global.css.
 *
 * Slots are assigned in fixed order and never cycled: the ninth entity does not
 * invent a hue, it folds to neutral ink. Identity is always carried by a visible
 * label beside the mark — the colour reinforces, it never stands alone (three of
 * the light-mode slots sit under 3:1 contrast by design, with exactly that
 * mitigation).
 */

export const CATEGORICAL_SLOTS = 8;

/** CSS colour for categorical slot `index` (0-based), or neutral ink past slot 8. */
export function catColor(index: number): string {
  if (index < 0 || index >= CATEGORICAL_SLOTS) return "rgb(var(--foreground) / 0.5)";
  // The raw --viz-cat tokens, not the @theme-level --color-cat aliases: Tailwind
  // tree-shakes theme variables it cannot see used, and a dynamically-built
  // `var(--color-cat-${n})` is invisible to its source scanner.
  return `rgb(var(--viz-cat-${index + 1}))`;
}

/**
 * Stable slot assignment for a list of entity ids. Order follows the list given
 * (callers pass a stably-sorted list, e.g. documents by filename), so a colour
 * follows its entity across renders instead of following its rank.
 */
export function assignSlots(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, i) => [id, i]));
}
