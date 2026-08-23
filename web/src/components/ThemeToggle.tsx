import { useEffect, useState } from "react";

type Theme = "dark" | "light";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("clear-rag-theme") as Theme) ?? "dark";
    } catch {
      // Private windows and blocked site data both throw here; the default is fine.
      return "dark";
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("clear-rag-theme", theme);
    } catch {
      // Persisting the preference is a convenience, never a requirement.
    }
  }, [theme]);

  return (
    <button
      onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      className="border border-line px-2 py-1 font-mono text-[10px] transition-colors hover:border-foreground/50"
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {theme === "dark" ? "light" : "dark"}
    </button>
  );
}
