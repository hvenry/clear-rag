import type { ComponentProps, ReactNode } from "react";

/**
 * The bordered square icon button: close, collapse/expand, theme. One border
 * and hover treatment for every icon-only control, so they read as one family.
 */
export function IconButton({
  label,
  children,
  className = "",
  ...rest
}: {
  label: string;
  children: ReactNode;
  className?: string;
} & Omit<ComponentProps<"button">, "aria-label" | "className" | "children">) {
  return (
    <button
      aria-label={label}
      className={`border border-line p-1.5 text-subtle transition-colors hover:border-foreground/50 hover:text-foreground ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
