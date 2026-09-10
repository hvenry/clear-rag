import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { headerControl } from "./headerControl";

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

  // The icon shows what you would switch TO (sun in the dark, moon in the light),
  // matching how every OS quick-settings tile reads.
  const next: Theme = theme === "dark" ? "light" : "dark";
  const NextIcon = next === "light" ? SunIcon : MoonIcon;

  return (
    <button
      aria-label={`Switch to ${next} theme`}
      onClick={() => setTheme(next)}
      className={`${headerControl()} cursor-pointer`}
    >
      <NextIcon size={16} />
    </button>
  );
}
