/**
 * Theme controller — Operator's Desk dark/light toggle.
 *
 * Two modes ship as separate instruments. Dark is the default. The
 * preference is persisted to localStorage. We do NOT honour
 * `prefers-color-scheme` — this is a deliberate switch (DESIGN.md §4 + §11).
 */

import { useEffect, useState, useCallback } from "react";

export type Theme = "dark" | "light";
const STORAGE_KEY = "hermes-theme";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light") return v;
  } catch {
    /* localStorage may be denied */
  }
  return "dark";
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  // shadcn primitives still flip on a `dark` class — keep them in sync.
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Bootstrap theme on page load — call once at app entry, before React mounts. */
export function bootstrapTheme() {
  applyTheme(readStoredTheme());
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return { theme, setTheme, toggle };
}
