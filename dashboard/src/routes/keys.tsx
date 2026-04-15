/**
 * /keys — env var inventory, read-only (DESIGN.md scan-route density).
 * Categorized accordion with reveal-on-click masking.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useState, useMemo, useCallback, useEffect } from "react";

export const Route = createFileRoute("/keys")({
  component: KeysPage,
});

type EnvVar = {
  is_set: boolean;
  redacted_value: string | null;
  description: string;
  url: string | null;
  category: string;
  tools: string[];
};

type CategoryDef = {
  key: string;
  label: string;
};

const CATEGORIES: CategoryDef[] = [
  { key: "provider", label: "LLM PROVIDERS" },
  { key: "tool", label: "TOOL API KEYS" },
  { key: "messaging", label: "MESSAGING PLATFORMS" },
  { key: "setting", label: "AGENT SETTINGS" },
];

function KeysPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "env"],
    queryFn: api.env,
  });

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(CATEGORIES.map((c) => c.key)),
  );
  const [notSetExpanded, setNotSetExpanded] = useState<Set<string>>(new Set());
  const [revealedKeys, setRevealedKeys] = useState<
    Record<string, { value: string; timer: number }>
  >({});

  const reveal = useMutation({
    mutationFn: (key: string) => api.envReveal(key),
    onSuccess: (resp) => {
      const timer = window.setTimeout(() => {
        setRevealedKeys((prev) => {
          const next = { ...prev };
          delete next[resp.key];
          return next;
        });
      }, 5000);
      setRevealedKeys((prev) => ({
        ...prev,
        [resp.key]: { value: resp.value, timer },
      }));
    },
  });

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      Object.values(revealedKeys).forEach((r) => clearTimeout(r.timer));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const vars = data?.vars ?? {};

  const grouped = useMemo(() => {
    const groups: Record<string, { key: string; meta: EnvVar }[]> = {};
    for (const cat of CATEGORIES) {
      groups[cat.key] = [];
    }
    for (const [key, meta] of Object.entries(vars)) {
      const cat = meta.category;
      if (groups[cat]) {
        groups[cat].push({ key, meta });
      }
    }
    return groups;
  }, [vars]);

  const toggleExpand = useCallback((cat: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const toggleNotSet = useCallback((cat: string) => {
    setNotSetExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const totalVars = Object.keys(vars).length;
  const totalSet = Object.values(vars).filter((v) => v.is_set).length;

  return (
    <div className="bg-bg">
      {/* Meters strip */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">KEYS</div>
        <div className="flex items-center justify-center gap-7">
          <span className="flex items-baseline gap-2">
            <span>Total</span>
            <span className="text-ink tabular-nums">{totalVars}</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span>Configured</span>
            <span className="text-ink tabular-nums">{totalSet}</span>
          </span>
        </div>
        <div className="text-ink-faint">~/.HERMES/.ENV</div>
      </div>

      {/* Page stamp */}
      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp">
          keys & <em>secrets</em>
        </h1>
        <p className="mt-3 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          API keys and secrets from ~/.hermes/.env — read-only view
        </p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-marker text-ink-faint">
          Set values via CLI or edit ~/.hermes/.env directly.
        </p>
      </div>

      {/* Category accordion */}
      <div className="px-10 pb-16">
        {isLoading && (
          <p className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
            loading environment<span className="loading-cursor ml-2" />
          </p>
        )}

        {!isLoading && totalVars === 0 && (
          <p className="py-8 text-center font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            no env vars registered
          </p>
        )}

        <div className="border-t border-rule">
          {CATEGORIES.map((cat) => {
            const items = grouped[cat.key] ?? [];
            const setItems = items.filter((i) => i.meta.is_set);
            const unsetItems = items.filter((i) => !i.meta.is_set);
            const isExpanded = expanded.has(cat.key);

            return (
              <div key={cat.key} className="border-b border-rule">
                {/* Category header */}
                <button
                  onClick={() => toggleExpand(cat.key)}
                  className="group flex w-full items-center gap-4 px-1 py-4 text-left transition-colors duration-120 ease-operator hover:bg-oxide-wash"
                >
                  <span
                    className="inline-block font-mono text-[14px] text-ink-muted transition-transform duration-180 ease-operator"
                    style={{
                      transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                    }}
                  >
                    ›
                  </span>
                  <span className="font-mono text-[13px] uppercase tracking-marker text-ink">
                    {cat.label}
                  </span>
                  <span className="ml-auto border border-oxide/30 bg-oxide-wash px-2 py-0.5 font-mono text-[9px] uppercase tracking-marker text-oxide">
                    {setItems.length} of {items.length} configured
                  </span>
                </button>

                {/* Collapsed preview */}
                {!isExpanded && (
                  <div className="pb-3 pl-8 text-[12px] text-ink-2">
                    {setItems.map((i) => i.key).join(", ") || "none configured"}
                  </div>
                )}

                {/* Expanded rows */}
                {isExpanded && (
                  <div className="pb-2 pl-8">
                    {/* Configured vars */}
                    {setItems.map((item) => (
                      <EnvVarRow
                        key={item.key}
                        envKey={item.key}
                        meta={item.meta}
                        revealed={revealedKeys[item.key]?.value ?? null}
                        onReveal={() => reveal.mutate(item.key)}
                        revealing={
                          reveal.isPending &&
                          reveal.variables === item.key
                        }
                      />
                    ))}

                    {/* Not configured — collapsible sub-section */}
                    {unsetItems.length > 0 && (
                      <div className="mt-1">
                        <button
                          onClick={() => toggleNotSet(cat.key)}
                          className="flex items-center gap-2 py-2 font-mono text-[10px] uppercase tracking-marker text-ink-faint transition-colors duration-120 ease-operator hover:text-ink-muted"
                        >
                          <span
                            className="inline-block transition-transform duration-180 ease-operator"
                            style={{
                              transform: notSetExpanded.has(cat.key)
                                ? "rotate(90deg)"
                                : "rotate(0deg)",
                            }}
                          >
                            ›
                          </span>
                          <span>
                            {unsetItems.length} not configured
                          </span>
                        </button>
                        {notSetExpanded.has(cat.key) &&
                          unsetItems.map((item) => (
                            <EnvVarRow
                              key={item.key}
                              envKey={item.key}
                              meta={item.meta}
                              revealed={null}
                              onReveal={() => {}}
                              revealing={false}
                            />
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-var row
// ---------------------------------------------------------------------------

function EnvVarRow({
  envKey,
  meta,
  revealed,
  onReveal,
  revealing,
}: {
  envKey: string;
  meta: EnvVar;
  revealed: string | null;
  onReveal: () => void;
  revealing: boolean;
}) {
  return (
    <div className="flex items-start gap-4 border-t border-rule/50 px-1 py-3 transition-colors duration-120 ease-operator hover:bg-oxide-wash">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[11px] uppercase text-ink">
            {envKey}
          </span>
          {meta.is_set ? (
            <span className="border border-oxide/40 bg-oxide-wash px-1.5 py-0 font-mono text-[9px] uppercase tracking-marker text-oxide">
              SET
            </span>
          ) : (
            <span className="border border-rule px-1.5 py-0 font-mono text-[9px] uppercase tracking-marker text-ink-faint">
              NOT SET
            </span>
          )}
          {meta.url && (
            <a
              href={meta.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[9px] uppercase tracking-marker text-ink-faint underline decoration-rule underline-offset-2 transition-colors duration-120 ease-operator hover:text-oxide"
            >
              get key
            </a>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-ink-muted">
          {meta.description}
        </p>
        {meta.is_set && (
          <div className="mt-1.5 flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={revealed ?? meta.redacted_value ?? ""}
              className="w-64 border border-rule bg-bg px-2 py-1 font-mono text-[11px] text-ink-2 focus:outline-none"
            />
            {revealed === null && (
              <button
                onClick={onReveal}
                disabled={revealing}
                className="border border-rule px-2 py-1 font-mono text-[9px] uppercase tracking-marker text-ink-muted transition-colors duration-120 ease-operator hover:border-oxide hover:text-oxide disabled:opacity-50"
              >
                reveal
              </button>
            )}
            {revealed !== null && (
              <span className="font-mono text-[9px] uppercase tracking-marker text-ink-faint">
                hiding in 5s
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
