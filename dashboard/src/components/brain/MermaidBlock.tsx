/**
 * MermaidBlock — renders ```mermaid fenced code blocks as SVG diagrams.
 *
 * Lazy-loads mermaid (~2MB) on first render. Shows oxide block cursor ▋
 * during load. Falls back to raw code on parse error.
 *
 * Themed to Operator's Desk palette (DESIGN.md §4).
 * Max height 600px with scroll for tall diagrams.
 */

import { useEffect, useId, useState } from "react";

interface Props {
  code: string;
}

let mermaidReady: Promise<typeof import("mermaid")> | null = null;

function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        theme: "base",
        themeVariables: {
          primaryColor: "#C96B2C",
          primaryTextColor: "#E7E2D8",
          primaryBorderColor: "#2D3531",
          lineColor: "#8D877B",
          secondaryColor: "#171C1A",
          tertiaryColor: "#1D2321",
          noteBkgColor: "#171C1A",
          noteTextColor: "#B6B0A3",
          fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
          fontSize: "13px",
        },
      });
      return mod;
    });
  }
  return mermaidReady;
}

export function MermaidBlock({ code }: Props) {
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${reactId.replace(/:/g, "")}`;

    // Clean up HTML entities that vault markdown uses inside mermaid
    // node labels. Mermaid syntax doesn't understand <br/>, &amp;, etc.
    const cleaned = code
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");

    loadMermaid()
      .then((mod) => {
        if (cancelled) return;
        return mod.default.render(id, cleaned);
      })
      .then((result) => {
        if (cancelled || !result) return;
        setSvg(result.svg);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || "Mermaid parse error");
      });

    return () => {
      cancelled = true;
    };
  }, [code, reactId]);

  // Loading state: oxide block cursor per DESIGN.md §7
  if (!svg && !error) {
    return (
      <div className="my-4 flex items-center gap-2 p-4">
        <span className="loading-cursor font-mono text-oxide">▋</span>
        <span className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
          rendering diagram
        </span>
      </div>
    );
  }

  // Error: show raw code with badge
  if (error) {
    return (
      <div className="my-4">
        <span className="mb-1 inline-block font-mono text-[9px] uppercase tracking-marker text-danger">
          PARSE ERROR
        </span>
        <pre className="overflow-x-auto bg-surface p-4 font-mono text-[13px] leading-snug text-ink-2">
          {code}
        </pre>
      </div>
    );
  }

  // Success: render SVG with max-height scroll
  return (
    <div
      className="my-4 max-h-[600px] overflow-y-auto bg-surface p-4"
      role="img"
      aria-label={code.split("\n")[0] || "Mermaid diagram"}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg! }}
    />
  );
}
