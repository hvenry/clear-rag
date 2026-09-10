/**
 * The one look for the header's right-hand controls: runtime, model, health,
 * theme. Borderless; the hover zone is the same fixed-height box on each, and
 * it answers hover with a fill rather than a border, so four controls read as
 * one strip instead of four boxes.
 */
export function headerControl(open = false): string {
  return [
    "flex h-8 cursor-default items-center gap-2 px-2.5 font-mono text-meta transition-colors",
    open ? "bg-foreground/10 text-foreground" : "text-subtle hover:bg-foreground/8 hover:text-foreground"
  ].join(" ");
}
