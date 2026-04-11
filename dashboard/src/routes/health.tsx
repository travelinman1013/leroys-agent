/**
 * /health — instrument panel (DESIGN.md §6: a few real gauges, not 12 KPI tiles).
 * Comfortable density. Doctor checks read like a service-manual page.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

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

  const checks = doctor.data?.checks ?? [];
  const okCount = checks.filter((c) => c.ok).length;
  const total = checks.length;

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
        <h1 className="page-stamp text-[56px]">
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
            <span className="marker-num">02</span>
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
      </div>
    </div>
  );
}
