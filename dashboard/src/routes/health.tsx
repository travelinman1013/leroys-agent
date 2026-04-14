/**
 * /health — instrument panel (DESIGN.md §6: a few real gauges, not 12 KPI tiles).
 * Comfortable density. Doctor checks read like a service-manual page.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, type DashboardState } from "@/lib/api";
import { compactRelTimeFromUnix, compactNumber, formatUptime } from "@/lib/utils";

export const Route = createFileRoute("/health")({
  component: HealthPage,
});

function HealthPage() {
  const doctor = useQuery({
    queryKey: ["dashboard", "doctor"],
    queryFn: api.doctor,
    refetchInterval: 10_000,
  });
  const config = useQuery({
    queryKey: ["dashboard", "config"],
    queryFn: api.config,
  });
  const compression = useQuery({
    queryKey: ["dashboard", "metrics", "compression", "24h"],
    queryFn: () => api.metricsCompression("24h"),
    refetchInterval: 60_000,
  });
  const gwInfo = useQuery({
    queryKey: ["dashboard", "gateway", "info"],
    queryFn: api.gatewayInfo,
    refetchInterval: 30_000,
  });
  const state = useQuery({
    queryKey: ["dashboard", "state"],
    queryFn: api.state,
    refetchInterval: 30_000,
  });
  const tokens7d = useQuery({
    queryKey: ["dashboard", "metrics", "tokens", "7d"],
    queryFn: () => api.metricsTokens("7d"),
    refetchInterval: 60_000,
  });
  const errors24h = useQuery({
    queryKey: ["dashboard", "metrics", "errors", "24h"],
    queryFn: () => api.metricsErrors("24h"),
    refetchInterval: 60_000,
  });
  const latency24h = useQuery({
    queryKey: ["dashboard", "metrics", "latency", "24h"],
    queryFn: () => api.metricsLatency("24h"),
    refetchInterval: 60_000,
  });

  const checks = doctor.data?.checks ?? [];
  const okCount = checks.filter((c) => c.ok).length;
  const total = checks.length;

  // F10: Extract platform connectivity from doctor checks
  const platforms = useMemo(() => {
    const platformChecks: { name: string; ok: boolean }[] = [];
    for (const c of checks) {
      const lower = c.name.toLowerCase();
      if (
        lower.includes("discord") ||
        lower.includes("telegram") ||
        lower.includes("api_server") ||
        lower.includes("webhook")
      ) {
        platformChecks.push({ name: c.name, ok: c.ok });
      }
    }
    return platformChecks;
  }, [checks]);

  return (
    <div className="bg-bg">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">HEALTH</div>
        <div className="flex items-center justify-center gap-7">
          <span className="flex items-baseline gap-2">
            <span>Checks</span>
            <span className={okCount === total ? "text-success tabular-nums" : "text-warning tabular-nums"}>
              {okCount}/{total}
            </span>
          </span>
        </div>
        <div className="text-ink-faint">REFRESH 10s</div>
      </div>

      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp">
          system <em>health</em>
        </h1>
      </div>

      <div className="grid grid-cols-1 gap-10 px-10 pb-16 lg:grid-cols-[1fr_1fr]">
        {/* Doctor */}
        <section>
          <div className="marker mb-6">
            <span className="marker-num">01</span>
            <span>DOCTOR</span>
            <span className="marker-rule" />
          </div>
          {doctor.isLoading && (
            <p className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
              running checks<span className="loading-cursor ml-2" />
            </p>
          )}
          <ul className="border-t border-rule">
            {checks.map((c) => (
              <li
                key={c.name}
                className="flex items-baseline justify-between gap-4 border-b border-rule px-1 py-3"
              >
                <div className="flex items-baseline gap-3">
                  <span
                    className={`inline-block size-1.5 rounded-full ${c.ok ? "bg-success" : "bg-danger"}`}
                  />
                  <span className="font-mono text-[12px] uppercase tracking-marker text-ink">
                    {c.name}
                  </span>
                </div>
                <span
                  className={
                    c.ok
                      ? "font-mono text-[11px] tabular-nums text-success"
                      : "font-mono text-[11px] tabular-nums text-danger"
                  }
                >
                  {c.ok ? "OK" : c.detail || "FAIL"}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* F10: Gateway info + platform connectivity */}
        <section>
          <div className="marker mb-6">
            <span className="marker-num">02</span>
            <span>GATEWAY</span>
            <span className="marker-rule" />
          </div>
          <GatewayPanel gwInfo={gwInfo.data} state={state.data} platforms={platforms} isLoading={gwInfo.isLoading} />
        </section>

        {/* F11: Metrics gauges */}
        <section>
          <div className="marker mb-6">
            <span className="marker-num">03</span>
            <span>METRICS</span>
            <span className="marker-rule" />
          </div>
          <MetricsPanel
            tokens7d={tokens7d.data}
            errors24h={errors24h.data}
            latency24h={latency24h.data}
            isLoading={tokens7d.isLoading}
          />
        </section>

        {/*
          Runtime config.

          The `min-w-0` on the <section> is load-bearing: CSS grid
          defaults grid items to `min-width: auto`, which resolves
          to the content's intrinsic min-content width. With a
          non-wrapping <pre> inside (JSON with deep nesting → long
          lines), that intrinsic width is the full length of the
          widest line — ~2027px measured. Without `min-w-0`, the
          grid column would size to that width and push `main` into
          horizontal scroll, dragging sections 03+ off-screen.

          With `min-w-0`, the grid column honors the flex 1fr and
          the <pre>'s own `overflow-auto` handles horizontal scroll
          for long JSON lines — which is exactly where the scroll
          should happen (inside the config block, not the whole
          page). Matches the fix in ~/.claude/plans/ashen-tempering-ibis.md
          §2 Commit 4.
        */}
        <section className="min-w-0">
          <div className="marker mb-6">
            <span className="marker-num">04</span>
            <span>RUNTIME CONFIG</span>
            <span className="marker-rule" />
          </div>
          <pre className="max-h-[640px] w-full max-w-full overflow-auto border border-rule bg-bg-alt p-4 font-mono text-[11px] leading-relaxed tabular-nums text-ink-2">
            {config.data
              ? JSON.stringify(config.data.config, null, 2)
              : config.isLoading
                ? "loading…"
                : ""}
          </pre>
        </section>

        <section className="min-w-0 lg:col-span-2">
          <div className="marker mb-6">
            <span className="marker-num">05</span>
            <span>COMPRESSION · 24H</span>
            <span className="marker-rule" />
          </div>
          {compression.isLoading && (
            <p className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
              loading<span className="loading-cursor ml-2" />
            </p>
          )}
          {compression.data && compression.data.events.length === 0 && (
            <p className="font-mono text-[11px] uppercase tracking-marker text-ink-faint">
              no compression events in the last 24h
            </p>
          )}
          {compression.data && compression.data.events.length > 0 && (
            <table className="w-full table-auto border-collapse font-mono text-[12px] tabular-nums text-ink [&_td]:break-words">
              <thead>
                <tr>
                  <th className="border-b border-rule px-3 py-3 text-left text-[10px] font-medium uppercase tracking-marker text-ink-muted">
                    TIME
                  </th>
                  <th className="border-b border-rule px-3 py-3 text-left text-[10px] font-medium uppercase tracking-marker text-ink-muted">
                    SESSION
                  </th>
                  <th className="border-b border-rule px-3 py-3 text-right text-[10px] font-medium uppercase tracking-marker text-ink-muted">
                    BEFORE
                  </th>
                  <th className="border-b border-rule px-3 py-3 text-center text-[10px] font-medium uppercase tracking-marker text-ink-muted">
                    →
                  </th>
                  <th className="border-b border-rule px-3 py-3 text-right text-[10px] font-medium uppercase tracking-marker text-ink-muted">
                    AFTER
                  </th>
                  <th className="border-b border-rule px-3 py-3 text-right text-[10px] font-medium uppercase tracking-marker text-ink-muted">
                    RATIO
                  </th>
                </tr>
              </thead>
              <tbody>
                {compression.data.events.map((evt, i) => {
                  const ratio =
                    evt.tokens_before && evt.tokens_after
                      ? ((evt.tokens_after / evt.tokens_before) * 100).toFixed(0)
                      : "—";
                  return (
                    <tr key={i} className="border-b border-rule align-top">
                      <td className="px-3 py-2.5 text-ink-faint">
                        {compactRelTimeFromUnix(evt.ts)}
                      </td>
                      <td className="px-3 py-2.5 text-ink-faint">
                        {evt.session_id ? String(evt.session_id).slice(0, 8) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right text-ink">
                        {compactNumber(evt.tokens_before)}
                      </td>
                      <td className="px-3 py-2.5 text-center text-ink-faint">
                        →
                      </td>
                      <td className="px-3 py-2.5 text-right text-ink">
                        {compactNumber(evt.tokens_after)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-oxide">
                        {ratio === "—" ? ratio : `${ratio}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// F10: Gateway status + platform connectivity
// ---------------------------------------------------------------------------

function GatewayPanel({
  gwInfo,
  state,
  platforms,
  isLoading,
}: {
  gwInfo?: { pid: number; uptime_seconds: number; host: string; port: number; max_rss?: number };
  state?: DashboardState;
  platforms: { name: string; ok: boolean }[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
        loading<span className="loading-cursor ml-2" />
      </p>
    );
  }

  const gw = state?.gateway;

  return (
    <div className="border-t border-rule">
      <GwRow label="PID" value={gwInfo?.pid != null ? String(gwInfo.pid) : "—"} />
      <GwRow label="UPTIME" value={gwInfo?.uptime_seconds != null ? formatUptime(gwInfo.uptime_seconds) : "—"} />
      <GwRow label="HOST" value={gwInfo ? `${gwInfo.host}:${gwInfo.port}` : "—"} />
      <GwRow label="SANDBOX" value={gw?.sandboxed ? "ON" : "OFF"} ok={gw?.sandboxed ?? false} />
      <GwRow label="MODEL" value={state?.model || "—"} />
      {gwInfo?.max_rss != null && (
        <GwRow label="RSS" value={`${(gwInfo.max_rss / 1024 / 1024).toFixed(0)} MB`} />
      )}
      <GwRow label="SSE SUBS" value={String(state?.event_bus?.subscribers ?? 0)} />

      {platforms.length > 0 && (
        <div className="border-b border-rule px-1 py-3">
          <div className="mb-2 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            PLATFORMS
          </div>
          <div className="flex flex-wrap gap-4">
            {platforms.map((p) => (
              <span key={p.name} className="flex items-center gap-2">
                <span
                  className={`inline-block size-1.5 rounded-full ${p.ok ? "bg-success" : "bg-danger"}`}
                />
                <span className="font-mono text-[12px] uppercase tracking-marker text-ink">
                  {p.name}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GwRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule px-1 py-3">
      <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        {label}
      </span>
      <span
        className={
          ok === true
            ? "font-mono text-[11px] tabular-nums text-success"
            : ok === false
              ? "font-mono text-[11px] tabular-nums text-warning"
              : "font-mono text-[11px] tabular-nums text-ink"
        }
      >
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// F11: Metrics gauges — token sparkline, error rate, top-3 latency
// ---------------------------------------------------------------------------

function MetricsPanel({
  tokens7d,
  errors24h,
  latency24h,
  isLoading,
}: {
  tokens7d?: {
    buckets: Array<{ ts: number; input: number; output: number }>;
    total: { input: number; output: number };
  };
  errors24h?: {
    per_tool: Record<string, { total: number; errors: number; error_rate: number }>;
  };
  latency24h?: {
    groups: Record<
      string,
      { count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }
    >;
  };
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
        loading<span className="loading-cursor ml-2" />
      </p>
    );
  }

  // Token sparkline data
  const buckets = tokens7d?.buckets ?? [];
  const totalIn = tokens7d?.total?.input ?? 0;
  const totalOut = tokens7d?.total?.output ?? 0;

  // Error rate
  const toolErrors = errors24h?.per_tool ?? {};
  const totalCalls = Object.values(toolErrors).reduce((s, t) => s + t.total, 0);
  const totalErrs = Object.values(toolErrors).reduce((s, t) => s + t.errors, 0);
  const errorRate = totalCalls > 0 ? ((totalErrs / totalCalls) * 100).toFixed(1) : "0.0";

  // Top 3 latency tools by call count
  const latencyGroups = latency24h?.groups ?? {};
  const top3 = Object.entries(latencyGroups)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 3);

  return (
    <div className="border-t border-rule">
      {/* Token sparkline (7d) */}
      <div className="border-b border-rule px-1 py-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            TOKENS 7D
          </span>
          <span className="font-mono text-[11px] tabular-nums text-ink">
            {compactK(totalIn)} in / {compactK(totalOut)} out
          </span>
        </div>
        <TokenSparkline buckets={buckets} />
      </div>

      {/* Error rate (24h) */}
      <div className="flex items-baseline justify-between border-b border-rule px-1 py-3">
        <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          ERROR RATE 24H
        </span>
        <span
          className={`font-mono text-[11px] tabular-nums ${
            totalErrs > 0 ? "text-danger" : "text-success"
          }`}
        >
          {errorRate}% ({totalErrs}/{totalCalls})
        </span>
      </div>

      {/* Top 3 tool latency */}
      <div className="border-b border-rule px-1 py-3">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          TOP TOOL LATENCY 24H (P50 / P95)
        </div>
        {top3.length === 0 && (
          <span className="font-mono text-[11px] text-ink-faint">no data</span>
        )}
        {top3.map(([tool, stats]) => (
          <div
            key={tool}
            className="flex items-baseline justify-between gap-4 py-1"
          >
            <span className="font-mono text-[12px] text-ink">{tool}</span>
            <span className="font-mono text-[11px] tabular-nums text-ink-2">
              {stats.p50 != null ? `${Math.round(stats.p50)}ms` : "—"} /{" "}
              {stats.p95 != null ? `${Math.round(stats.p95)}ms` : "—"}
              <span className="ml-2 text-ink-faint">({stats.count})</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function compactK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Inline SVG sparkline for token usage buckets. */
function TokenSparkline({
  buckets,
}: {
  buckets: Array<{ ts: number; input: number; output: number }>;
}) {
  if (buckets.length === 0) {
    return (
      <span className="font-mono text-[11px] text-ink-faint">no data</span>
    );
  }

  const w = 320;
  const h = 32;
  const values = buckets.map((b) => b.input + b.output);
  const max = Math.max(...values, 1);
  const step = w / Math.max(values.length - 1, 1);

  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-8 w-full"
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--oxide)"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
