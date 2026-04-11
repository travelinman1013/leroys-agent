/**
 * /config — F5 safe config editor.
 *
 * Each card surfaces a few allowlisted keys with the appropriate
 * input. Save calls PUT /api/dashboard/config which routes through
 * apply_config_mutations (W0). Backups tab lists snapshots and
 * supports rollback. Gateway restart returns the launchctl command
 * for the user to copy/paste.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApiMutation } from "@/lib/mutations";
import { useNotify } from "@/lib/notifications";
import { useConfirm } from "@/lib/confirm";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/config")({
  component: ConfigPage,
});

function ConfigPage() {
  const cfg = useQuery({
    queryKey: ["dashboard", "config"],
    queryFn: api.config,
  });
  const backups = useQuery({
    queryKey: ["dashboard", "config", "backups"],
    queryFn: api.configBackups,
  });

  const notify = useNotify();
  const confirm = useConfirm();

  const [restartHint, setRestartHint] = useState<string[]>([]);
  const [editing, setEditing] = useState<Record<string, unknown>>({});

  // Pull the live values into local edit state on first load
  useEffect(() => {
    if (cfg.data?.config) {
      const c = cfg.data.config as Record<string, any>;
      setEditing({
        "approvals.mode": c?.approvals?.mode ?? "manual",
        "approvals.non_interactive_policy":
          c?.approvals?.non_interactive_policy ?? "guarded",
        "compression.threshold": c?.compression?.threshold ?? 0.75,
        "compression.target_ratio": c?.compression?.target_ratio ?? 0.3,
        "code_execution.max_tool_output":
          c?.code_execution?.max_tool_output ?? 4000,
      });
    }
  }, [cfg.data]);

  const save = useApiMutation({
    mutationFn: (mutations: Record<string, unknown>) => api.putConfig(mutations),
    successMessage: "Config saved",
    onSuccess: (data) => {
      if (data.restart_required.length > 0) {
        setRestartHint(data.restart_required);
      }
      cfg.refetch();
      backups.refetch();
    },
  });

  const rollback = useApiMutation({
    mutationFn: (filename: string) => api.rollbackConfig(filename),
    successMessage: "Restored",
    onSuccess: () => {
      cfg.refetch();
      backups.refetch();
    },
  });

  const restartCmd = useApiMutation({
    mutationFn: api.gatewayRestartCommand,
    onSuccess: async (data) => {
      try {
        await navigator.clipboard.writeText(data.command);
        notify.success("Restart command copied to clipboard");
      } catch {
        notify.info(data.command);
      }
    },
  });

  const update = (key: string, value: unknown) =>
    setEditing((p) => ({ ...p, [key]: value }));

  return (
    <div className="bg-bg">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">CONFIG</div>
        <div className="flex items-center justify-center gap-7">
          <span className="flex items-baseline gap-2">
            <span>Backups</span>
            <span className="text-ink tabular-nums">
              {backups.data?.backups.length ?? 0}
            </span>
          </span>
        </div>
        <div className="text-ink-faint">EDIT</div>
      </div>

      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp text-[56px]">
          config <em>panel</em>
        </h1>
        <p className="mt-3 max-w-prose font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          mutations are allowlisted. backups are dated. comment loss is
          a known limitation of pyyaml — restore the pristine snapshot
          if you need the original byte-for-byte.
        </p>
      </div>

      {restartHint.length > 0 && (
        <div className="mx-10 mb-6 border border-oxide-edge bg-oxide-wash px-4 py-3 font-mono text-[11px] uppercase tracking-marker text-oxide">
          RESTART REQUIRED FOR: {restartHint.join(", ")}
          <div className="mt-2 normal-case text-ink-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => restartCmd.mutate()}
            >
              COPY RESTART COMMAND
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-10 px-10 pb-16 lg:grid-cols-2">
        <ConfigCard title="Approvals">
          <Field label="Mode">
            <select
              value={String(editing["approvals.mode"] ?? "manual")}
              onChange={(e) => update("approvals.mode", e.target.value)}
              className="h-8 border border-rule bg-bg px-2 font-mono text-[11px] uppercase text-ink"
            >
              <option value="manual">manual</option>
              <option value="smart">smart</option>
              <option value="off">off</option>
            </select>
          </Field>
          <Field label="Non-interactive">
            <select
              value={String(editing["approvals.non_interactive_policy"] ?? "guarded")}
              onChange={(e) =>
                update("approvals.non_interactive_policy", e.target.value)
              }
              className="h-8 border border-rule bg-bg px-2 font-mono text-[11px] uppercase text-ink"
            >
              <option value="guarded">guarded</option>
              <option value="allow">allow</option>
            </select>
          </Field>
          <SaveButton
            onClick={() =>
              save.mutate({
                "approvals.mode": editing["approvals.mode"],
                "approvals.non_interactive_policy":
                  editing["approvals.non_interactive_policy"],
              })
            }
            isPending={save.isPending}
          />
        </ConfigCard>

        <ConfigCard title="Compression">
          <Field label="Threshold (0–1)">
            <Input
              type="number"
              step={0.05}
              min={0.1}
              max={0.95}
              value={String(editing["compression.threshold"] ?? "")}
              onChange={(e) =>
                update("compression.threshold", Number(e.target.value))
              }
              className="h-8 max-w-[120px]"
            />
          </Field>
          <Field label="Target ratio">
            <Input
              type="number"
              step={0.05}
              min={0.1}
              max={0.9}
              value={String(editing["compression.target_ratio"] ?? "")}
              onChange={(e) =>
                update("compression.target_ratio", Number(e.target.value))
              }
              className="h-8 max-w-[120px]"
            />
          </Field>
          <SaveButton
            onClick={() =>
              save.mutate({
                "compression.threshold": editing["compression.threshold"],
                "compression.target_ratio": editing["compression.target_ratio"],
              })
            }
            isPending={save.isPending}
          />
        </ConfigCard>

        <ConfigCard title="Code execution">
          <Field label="Max tool output (tokens)">
            <Input
              type="number"
              step={100}
              min={500}
              max={20000}
              value={String(editing["code_execution.max_tool_output"] ?? "")}
              onChange={(e) =>
                update(
                  "code_execution.max_tool_output",
                  Number(e.target.value),
                )
              }
              className="h-8 max-w-[120px]"
            />
          </Field>
          <SaveButton
            onClick={() =>
              save.mutate({
                "code_execution.max_tool_output":
                  editing["code_execution.max_tool_output"],
              })
            }
            isPending={save.isPending}
          />
        </ConfigCard>

        <AppearanceCard />

        <ConfigCard title="Backups">
          <ul className="space-y-1.5">
            {(backups.data?.backups ?? [])
              .slice()
              .reverse()
              .slice(0, 12)
              .map((b) => (
                <li
                  key={b.filename}
                  className="flex items-center justify-between border-b border-rule/60 py-1 font-mono text-[11px] tabular-nums text-ink"
                >
                  <span>{b.filename}</span>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Restore ${b.filename}?`,
                        description:
                          "Current config will be backed up first.",
                        confirmLabel: "RESTORE",
                      });
                      if (ok) rollback.mutate(b.filename);
                    }}
                    className="font-mono text-[10px] uppercase tracking-marker text-ink-muted hover:text-oxide"
                  >
                    RESTORE
                  </button>
                </li>
              ))}
            {(backups.data?.backups ?? []).length === 0 && (
              <li className="font-mono text-[10px] uppercase tracking-marker text-ink-faint">
                no backups yet
              </li>
            )}
          </ul>
        </ConfigCard>
      </div>
    </div>
  );
}

function ConfigCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-rule bg-card p-6">
      <div className="marker mb-4">
        <span className="marker-num">·</span>
        <span>{title}</span>
        <span className="marker-rule" />
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[140px_1fr] items-center gap-3">
      <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function SaveButton({
  onClick,
  isPending,
}: {
  onClick: () => void;
  isPending?: boolean;
}) {
  return (
    <div className="flex justify-end pt-2">
      <Button
        size="sm"
        variant="outline"
        onClick={onClick}
        disabled={isPending}
      >
        {isPending ? "SAVING…" : "SAVE"}
      </Button>
    </div>
  );
}

/*
  AppearanceCard — houses the dark/light toggle that previously lived
  in StatusHeader. DESIGN.md §9 anti-slop pledge explicitly forbids a
  dark-mode toggle in header chrome: "toggle lives in settings, not
  chrome." The Operator's Desk light + dark modes ship as "separate
  instruments, not an accessibility preference" (DESIGN.md §4), so
  the card reads "APPEARANCE · INSTRUMENT" and the controls are a
  pair of segmented buttons (DARK / LIGHT) rather than a toggle
  switch — the switch framing implies an on/off state where one
  direction is the "default" and the other is the "accessibility"
  mode. Segmented buttons signal "pick the instrument you want."

  Changes apply instantly (no save button). Persists to localStorage
  via `useTheme`, and the `bootstrapTheme()` call in main.tsx
  applies the stored value before React paints to avoid a
  dark→light flash on reload.
*/
function AppearanceCard() {
  const { theme, setTheme } = useTheme();

  return (
    <ConfigCard title="Appearance · Instrument">
      <Field label="Theme">
        <div className="flex gap-2">
          <ThemePill
            theme="dark"
            active={theme === "dark"}
            onClick={() => setTheme("dark")}
            label="Dark"
          />
          <ThemePill
            theme="light"
            active={theme === "light"}
            onClick={() => setTheme("light")}
            label="Light"
          />
        </div>
      </Field>
      <p className="font-mono text-[10px] uppercase tracking-marker text-ink-faint">
        applies instantly · persisted per browser
      </p>
    </ConfigCard>
  );
}

function ThemePill({
  theme,
  active,
  onClick,
  label,
}: {
  theme: Theme;
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${label} instrument`}
      className={cn(
        "h-8 border px-3 font-mono text-[10px] uppercase tracking-marker transition-colors duration-120 ease-operator",
        active
          ? "border-oxide-edge bg-oxide-wash text-oxide"
          : "border-rule text-ink-2 hover:border-oxide-edge hover:text-ink",
      )}
    >
      {theme === "dark" ? "◐" : "◑"} {label}
    </button>
  );
}
