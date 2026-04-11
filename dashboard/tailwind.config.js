/** @type {import('tailwindcss').Config} */
// Operator's Desk — see DESIGN.md at the repo root.
// Tailwind colors bind directly to CSS variables (var(--token)) — no HSL
// wrapping — so the dark/light token sets in dashboard/src/index.css
// resolve to the same hex everywhere. shadcn primitives still use the
// `border-border`, `bg-background`, etc. utility names; their semantic
// names are remapped to the Bone & Iron Oxide tokens.
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        // Operator's Desk semantic tokens
        bg: "var(--bg)",
        "bg-alt": "var(--bg-alt)",
        surface: "var(--surface)",
        "surface-2": "var(--surface-2)",
        "surface-3": "var(--surface-3)",
        rule: "var(--rule)",
        "rule-strong": "var(--rule-strong)",
        ink: "var(--ink)",
        "ink-2": "var(--ink-2)",
        "ink-muted": "var(--ink-muted)",
        "ink-faint": "var(--ink-faint)",
        inverse: "var(--inverse)",
        oxide: {
          DEFAULT: "var(--oxide)",
          hover: "var(--oxide-hover)",
          deep: "var(--oxide-deep)",
          wash: "var(--oxide-wash)",
          edge: "var(--oxide-edge)",
        },
        steel: {
          DEFAULT: "var(--steel)",
          wash: "var(--steel-wash)",
        },
        success: "var(--success)",
        warning: "var(--warning)",
        danger: "var(--danger)",

        // shadcn-compat aliases — bound to the same tokens so existing
        // utility classes (border-border, bg-background, …) keep working.
        border: "var(--rule)",
        input: "var(--rule-strong)",
        ring: "var(--oxide)",
        background: "var(--bg)",
        foreground: "var(--ink)",
        primary: {
          DEFAULT: "var(--oxide)",
          foreground: "var(--inverse)",
        },
        secondary: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--ink)",
        },
        destructive: {
          DEFAULT: "var(--danger)",
          foreground: "var(--ink)",
        },
        muted: {
          DEFAULT: "var(--surface-2)",
          foreground: "var(--ink-muted)",
        },
        accent: {
          DEFAULT: "var(--oxide-wash)",
          foreground: "var(--oxide)",
        },
        popover: {
          DEFAULT: "var(--surface)",
          foreground: "var(--ink)",
        },
        card: {
          DEFAULT: "var(--surface)",
          foreground: "var(--ink)",
        },
      },
      borderRadius: {
        // 0 for structural; 2px for inputs/buttons/badges. Never above 4px.
        none: "0px",
        sm: "2px",
        DEFAULT: "2px",
        md: "2px",
        lg: "4px",
        xl: "4px",
        "2xl": "4px",
        full: "9999px",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "oxide-pulse": {
          "0%, 100%": { opacity: "1", boxShadow: "0 0 0 0 var(--oxide-edge)" },
          "50%": { opacity: "0.55", boxShadow: "0 0 0 4px transparent" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 180ms cubic-bezier(0.16, 0.84, 0.24, 1)",
        "accordion-up": "accordion-up 180ms cubic-bezier(0.16, 0.84, 0.24, 1)",
        "oxide-pulse": "oxide-pulse 2.4s cubic-bezier(0.16, 0.84, 0.24, 1) infinite",
      },
      fontFamily: {
        sans: [
          "Söhne",
          "Switzer Variable",
          "Switzer",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        display: [
          "Söhne Breit",
          "Switzer Variable",
          "Switzer",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "MD IO",
          "Söhne Mono",
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
        stamp: ["Instrument Serif", "Tiempos Headline", "Georgia", "serif"],
      },
      letterSpacing: {
        // patch-bay tracking for UPPERCASE labels
        marker: "0.18em",
        label: "0.14em",
        wide: "0.16em",
        // tight tracking for display
        display: "-0.02em",
        big: "-0.04em",
      },
      transitionTimingFunction: {
        operator: "cubic-bezier(0.16, 0.84, 0.24, 1)",
      },
      transitionDuration: {
        120: "120ms",
        180: "180ms",
        240: "240ms",
        320: "320ms",
        600: "600ms",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
