/**
 * Home / Inbox — the asymmetric stamp + ONE BIG NUMBER + event rail.
 *
 * Operator's Desk DESIGN.md §6, mockup §04. Comfortable density. The
 * one-big-number per viewport is the count of pending approvals (or
 * "ALL CLEAR"). Right rail carries Brain inset, next cron, health.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { EventStream } from "@/components/EventStream";
import { ApprovalCard } from "@/components/ApprovalCard";
import { compactNumber, formatUptime } from "@/lib/utils";
import { useThemedPalette } from "@/lib/theme";

export const Route = createFileRoute("/")({
  component: HomeInbox,
});

const WEEKDAY = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const MONTH = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

function HomeInbox() {
  const state = useQuery({
    queryKey: ["dashboard", "state"],
    queryFn: api.state,
    refetchInterval: 5_000,
  });
  const approvals = useQuery({
    queryKey: ["dashboard", "approvals"],
    queryFn: api.approvals,
    refetchInterval: 3_000,
  });
  const cron = useQuery({
    queryKey: ["dashboard", "cron"],
    queryFn: api.cronJobs,
    refetchInterval: 10_000,
  });
  const doctor = useQuery({
    queryKey: ["dashboard", "doctor"],
    queryFn: api.doctor,
    refetchInterval: 15_000,
  });

  const pending = approvals.data?.pending ?? [];
  const now = new Date();
  const day = WEEKDAY[now.getDay()];
  const dateLine = `${MONTH[now.getMonth()]} ${String(now.getDate()).padStart(2, "0")} · ${now.getFullYear()}`;
  const timeLine = now
    .toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
    .replace(":", ":");

  return (
    <div className="grid h-full grid-cols-[1fr_360px]">
      {/* ─── LEFT: stamp + one number + event rail ─────────── */}
      <section className="flex min-h-0 flex-col border-r border-rule">
        {/* page-stamp + meta */}
        <div className="flex items-baseline gap-7 border-b border-rule px-10 pb-6 pt-9">
          <h1 className="page-stamp text-[56px]">
            hermes,
            <br />
            <em>{day}</em>
          </h1>
          <div className="font-mono text-[10px] uppercase leading-relaxed tracking-marker text-ink-muted">
            <span className="block text-ink">{timeLine} CT</span>
            {dateLine}
            <br />
            LM STUDIO ·{" "}
            {state.error ? (
              <span className="text-danger">DOWN</span>
            ) : (
              <span className="text-success">OK</span>
            )}
            <br />
            {state.data?.gateway?.uptime_seconds !== undefined && (
              <>UP {formatUptime(state.data.gateway.uptime_seconds)}</>
            )}
          </div>
        </div>

        {/* ── ONE BIG NUMBER ── */}
        <div className="border-b border-rule px-10 pb-8 pt-9">
          <div className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            ───── PENDING APPROVALS ─────────────────
          </div>
          <div className="mt-3">
            {pending.length === 0 ? (
              <span className="font-display text-[96px] font-bold leading-none tracking-big text-ink">
                ALL CLEAR
              </span>
            ) : (
              <span className="one-number-big">{pending.length}</span>
            )}
          </div>
          {pending.length > 0 && (
            <div className="mt-3 font-mono text-[11px] uppercase tracking-marker text-ink-muted">
              OF{" "}
              {pending
                .slice(0, 3)
                .map((a) => (
                  <span key={a.session_key} className="text-ink">
                    {a.pattern_key.toUpperCase()}
                  </span>
                ))
                .reduce<React.ReactNode[]>((acc, cur, i) => {
                  if (i > 0) acc.push(<span key={`sep${i}`}> · </span>);
                  acc.push(cur);
                  return acc;
                }, [])}
            </div>
          )}
          <CostStrip />
        </div>

        {/* approval queue (collapses to nothing when no pending) */}
        {pending.length > 0 && (
          <div className="space-y-3 border-b border-rule px-10 pb-7 pt-6">
            <div className="marker">
              <span className="marker-num">02</span>
              <span>APPROVAL QUEUE</span>
              <span className="marker-rule" />
            </div>
            {pending.map((a, idx) => (
              <ApprovalCard key={`${a.session_key}-${idx}`} approval={a} />
            ))}
          </div>
        )}

        {/* ── live event rail ── */}
        <div className="flex min-h-0 flex-1 flex-col px-10 pt-6">
          <div className="marker mb-3">
            <span className="marker-num">03</span>
            <span>LIVE EVENTS</span>
            <span className="marker-rule" />
            <span className="text-ink-faint tabular-nums">
              {timeLine}
            </span>
          </div>
          <div className="-mx-10 flex-1 border-t border-rule">
            <EventStream compact />
          </div>
        </div>
      </section>

      {/* ─── RIGHT RAIL ────────────────────────────────────── */}
      <aside className="flex flex-col gap-0 overflow-y-auto bg-bg-alt">
        <RailPanel
          title="Brain"
          right={
            state.data?.event_bus
              ? `${state.data.event_bus.recent_buffer} buf`
              : undefined
          }
        >
          <Link
            to="/brain"
            className="block aspect-[1.6/1] w-full border border-rule bg-bg-alt transition-colors duration-120 ease-operator hover:border-oxide-edge"
          >
            <BrainInsetSvg />
          </Link>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-marker text-ink-faint">
            click to open star chart
          </p>
        </RailPanel>

        <RailPanel
          title="Cron · Next"
          right={
            cron.data?.jobs ? `${cron.data.jobs.length} jobs` : undefined
          }
        >
          {(cron.data?.jobs ?? []).slice(0, 4).map((j) => (
            <PanelRow
              key={String((j as Record<string, unknown>).id ?? Math.random())}
              left={String(
                (j as Record<string, unknown>).name ??
                  (j as Record<string, unknown>).id ??
                  "—",
              )}
              right={String(
                (j as Record<string, unknown>).schedule ??
                  (j as Record<string, unknown>).next_run ??
                  "—",
              )}
            />
          ))}
          {(cron.data?.jobs ?? []).length === 0 && (
            <PanelEmpty>no jobs scheduled</PanelEmpty>
          )}
        </RailPanel>

        <RailPanel
          title="Health"
          right={
            doctor.data?.checks
              ? `${doctor.data.checks.filter((c) => c.ok).length}/${doctor.data.checks.length}`
              : undefined
          }
        >
          {(doctor.data?.checks ?? []).slice(0, 6).map((c) => (
            <PanelRow
              key={c.name}
              left={
                <span className="flex items-baseline gap-2">
                  <span
                    className={`inline-block size-1.5 rounded-full ${c.ok ? "bg-success" : "bg-danger"}`}
                  />
                  {c.name}
                </span>
              }
              right={c.ok ? "OK" : c.detail ?? "fail"}
            />
          ))}
          {(doctor.data?.checks ?? []).length === 0 && (
            <PanelEmpty>doctor pending</PanelEmpty>
          )}
        </RailPanel>

        <RailPanel
          title="Sessions · Active"
          right={
            state.data?.active_sessions
              ? compactNumber(state.data.active_sessions.length)
              : undefined
          }
        >
          {(state.data?.active_sessions ?? [])
            .slice(0, 5)
            .map((s, idx) => {
              const r = s as Record<string, unknown>;
              return (
                <PanelRow
                  key={`${String(r.id ?? idx)}`}
                  left={String(r.id ?? "—").slice(0, 14)}
                  right={String(r.source ?? "—")}
                />
              );
            })}
          {(state.data?.active_sessions ?? []).length === 0 && (
            <PanelEmpty>no active sessions</PanelEmpty>
          )}
        </RailPanel>
      </aside>
    </div>
  );
}

function CostStrip() {
  const { data } = useQuery({
    queryKey: ["dashboard", "cost", "summary"],
    queryFn: () => api.costSummary(),
    refetchInterval: 30_000,
  });
  if (!data) return null;
  const color = data.above_threshold ? "text-oxide" : "text-ink-muted";
  return (
    <div className={`mt-2 font-mono text-[12px] tabular-nums ${color}`}>
      ${data.today_usd.toFixed(2)} today · ${data.week_usd.toFixed(2)} this week
    </div>
  );
}

function RailPanel({
  title,
  right,
  children,
}: {
  title: string;
  right?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-rule px-6 py-5">
      <div className="mb-3 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-marker">
        <span className="text-ink">{title}</span>
        {right && (
          <span className="text-ink-faint tabular-nums">{right}</span>
        )}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function PanelRow({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-4 py-1 font-mono text-[12px] tabular-nums text-ink-2">
      <span className="truncate">{left}</span>
      <span className="text-ink">{right}</span>
    </div>
  );
}

function PanelEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-marker text-ink-faint">
      {children}
    </p>
  );
}

/** Tiny static brain inset for the right rail — matches preview §04 right rail.
 *
 * Uses `useThemedPalette()` so the stroke / fill values follow the active
 * theme. Previously the colors were hardcoded dark-mode hexes, so the inset
 * stayed dark even after the /config Appearance toggle flipped the rest of
 * the app to the bone-colored light instrument. P8 light-mode audit finding. */
function BrainInsetSvg() {
  const p = useThemedPalette();
  return (
    <svg viewBox="0 0 560 350" preserveAspectRatio="xMidYMid slice">
      <defs>
        <pattern id="g1" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0H0V40" fill="none" stroke={p.rule} strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect width="560" height="350" fill="url(#g1)" opacity="0.5" />
      <g stroke={p.ink} strokeOpacity="0.18" strokeWidth="0.6">
        <line x1="80" y1="60" x2="180" y2="120" />
        <line x1="180" y1="120" x2="280" y2="80" />
        <line x1="180" y1="120" x2="240" y2="220" />
        <line x1="280" y1="80" x2="400" y2="140" />
        <line x1="280" y1="80" x2="340" y2="200" />
        <line x1="240" y1="220" x2="340" y2="200" />
        <line x1="340" y1="200" x2="450" y2="260" />
        <line x1="450" y1="260" x2="500" y2="180" />
        <line x1="180" y1="120" x2="120" y2="240" />
        <line x1="120" y1="240" x2="240" y2="220" />
        <line x1="500" y1="180" x2="400" y2="140" />
        <line x1="80" y1="60" x2="60" y2="180" />
      </g>
      <g fill={p.oxide} stroke={p.oxide}>
        <g>
          <circle cx="280" cy="80" r="2.5" />
          <line x1="272" y1="80" x2="288" y2="80" strokeWidth="0.6" />
          <line x1="280" y1="72" x2="280" y2="88" strokeWidth="0.6" />
        </g>
        <g>
          <circle cx="180" cy="120" r="2" />
        </g>
        <g>
          <circle cx="240" cy="220" r="2" />
          <line x1="234" y1="220" x2="246" y2="220" strokeWidth="0.5" />
          <line x1="240" y1="214" x2="240" y2="226" strokeWidth="0.5" />
        </g>
        <g>
          <circle cx="400" cy="140" r="1.6" />
        </g>
        <g>
          <circle cx="340" cy="200" r="2" />
        </g>
        <g>
          <circle cx="450" cy="260" r="1.6" />
        </g>
        <g>
          <circle cx="500" cy="180" r="1.6" />
        </g>
        <g>
          <circle cx="120" cy="240" r="1.6" />
        </g>
        <g>
          <circle cx="60" cy="180" r="1.4" />
        </g>
        <g>
          <circle cx="80" cy="60" r="1.6" />
        </g>
      </g>
      <g fill={p.ink} fillOpacity="0.78" fontFamily="ui-monospace,JetBrains Mono" fontSize="8">
        <text x="290" y="76">HERMES</text>
        <text x="190" y="116">ARCH</text>
        <text x="250" y="216">RECON</text>
        <text x="350" y="196">SANDBOX</text>
      </g>
      <text x="14" y="20" fill={p.inkFaint} fontFamily="ui-monospace,JetBrains Mono" fontSize="8">
        RA 12h ─ Dec +47°
      </text>
    </svg>
  );
}
