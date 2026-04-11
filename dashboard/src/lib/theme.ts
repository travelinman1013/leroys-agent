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

/**
 * Static palette constants for places that can't consume CSS
 * variables (SVG fill/stroke props taken by non-CSS attributes,
 * <canvas> drawing code, inline style objects that some renderers
 * resolve at JS time). Use {@link useThemedPalette} to read the
 * palette for the active theme; the values match the DESIGN.md §4
 * Bone & Iron Oxide token set so the canvas / SVG surfaces
 * (BrainGraph, routes/index.tsx brain inset, etc.) flip with the
 * /config appearance toggle instead of staying in one instrument's
 * palette regardless of theme.
 *
 * Kept as a tiny subset of tokens — only the ones actually needed
 * by the canvas-style consumers. Do NOT expand this without
 * updating DESIGN.md; the single source of truth for color is the
 * CSS variable block in `src/index.css`, and these constants just
 * mirror the most load-bearing ones.
 */
export interface ThemedPalette {
  bg: string;
  bgAlt: string;
  ink: string;
  inkFaint: string;
  rule: string;
  ruleStrong: string;
  oxide: string;
}

const DARK_PALETTE: ThemedPalette = {
  bg: "#0E1110",
  bgAlt: "#131716",
  ink: "#E7E2D8",
  inkFaint: "#5E5A52",
  rule: "#2D3531",
  ruleStrong: "#3B4540",
  oxide: "#C96B2C",
};

const LIGHT_PALETTE: ThemedPalette = {
  bg: "#F2EFE6",
  bgAlt: "#EAE6D9",
  ink: "#161513",
  inkFaint: "#948D7C",
  // Light-mode rules in DESIGN.md §4 are alpha channels over ink.
  // Mirror them here as opaque equivalents at the same perceptual
  // weight so SVG stroke / canvas strokeStyle (which don't handle
  // rgba() as cleanly as full CSS) render at the correct density.
  rule: "rgba(22, 21, 19, 0.10)",
  ruleStrong: "rgba(22, 21, 19, 0.20)",
  oxide: "#B0561C",
};

/** Return the palette for a specific theme. Pure lookup. */
export function getPalette(theme: Theme): ThemedPalette {
  return theme === "light" ? LIGHT_PALETTE : DARK_PALETTE;
}

/**
 * React hook: the live palette for the currently active theme.
 * Rerenders the consumer when the theme changes.
 */
export function useThemedPalette(): ThemedPalette {
  const { theme } = useTheme();
  return getPalette(theme);
}
