/**
 * /config — schema-driven config editor with sidebar navigation.
 *
 * Left pane: config fields for the active category.
 * Right sidebar: category nav with field counts + search.
 * Save calls PUT /api/dashboard/config which routes through
 * apply_config_mutations. Security paths have their own specialized
 * endpoint. Backups section lists snapshots and supports rollback.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useApiMutation } from "@/lib/mutations";
import { useNotify } from "@/lib/notifications";
import { useConfirm } from "@/lib/confirm";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Field schema
// ---------------------------------------------------------------------------

type FieldType = "text" | "number" | "boolean" | "select" | "list";

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  hint?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  dangerous?: boolean;
}

interface CategoryDef {
  id: string;
  label: string;
  fields: FieldDef[];
}

// ---------------------------------------------------------------------------
// Schema — maps upstream dashboard categories
// ---------------------------------------------------------------------------

const CATEGORIES: CategoryDef[] = [
  {
    id: "general",
    label: "General",
    fields: [
      { key: "model", label: "Model", type: "text", hint: "default model (e.g. anthropic/claude-sonnet-4-6)", placeholder: "provider/model-name" },
      { key: "fallback_providers", label: "Fallback providers", type: "text", hint: "comma-separated provider names" },
      { key: "toolsets", label: "Toolsets", type: "text", hint: "comma-separated toolset names" },
      { key: "file_read_max_chars", label: "File read max chars", type: "number", min: 1000, max: 500000, step: 1000, hint: "max chars per read_file call" },
      { key: "timezone", label: "Timezone", type: "text", hint: "IANA format · e.g. America/Chicago · empty = server local", placeholder: "America/Chicago" },
      { key: "prefill_messages_file", label: "Prefill messages file", type: "text", hint: "JSON few-shot priming file path" },
    ],
  },
  {
    id: "agent",
    label: "Agent",
    fields: [
      { key: "agent.max_turns", label: "Max turns", type: "number", min: 1, max: 500, hint: "per-session turn limit" },
      { key: "agent.reasoning_effort", label: "Reasoning effort", type: "select", options: ["low", "medium", "high"], hint: "LLM reasoning depth" },
      { key: "agent.gateway_timeout", label: "Gateway timeout", type: "number", min: 0, max: 7200, step: 60, hint: "seconds · 0 = unlimited" },
      { key: "agent.restart_drain_timeout", label: "Drain timeout", type: "number", min: 0, max: 300, step: 10, hint: "seconds before interrupting on restart" },
      { key: "agent.service_tier", label: "Service tier", type: "text", hint: "API service tier" },
      { key: "agent.tool_use_enforcement", label: "Tool use enforcement", type: "text", hint: "auto / true / false" },
      { key: "agent.gateway_timeout_warning", label: "Timeout warning", type: "number", min: 0, max: 7200, step: 60, hint: "seconds before warning · 0 = off" },
      { key: "agent.gateway_notify_interval", label: "Notify interval", type: "number", min: 0, max: 3600, step: 60, hint: "seconds between status pings · 0 = off" },
      { key: "checkpoints.enabled", label: "Checkpoints enabled", type: "boolean" },
      { key: "checkpoints.max_snapshots", label: "Max snapshots", type: "number", min: 1, max: 200, hint: "per directory" },
      { key: "smart_model_routing.enabled", label: "Smart routing", type: "boolean", hint: "route simple queries to cheap model" },
      { key: "smart_model_routing.max_simple_chars", label: "Max simple chars", type: "number", min: 10, max: 500, hint: "char threshold for simple routing" },
      { key: "smart_model_routing.max_simple_words", label: "Max simple words", type: "number", min: 1, max: 100, hint: "word threshold for simple routing" },
      { key: "context.engine", label: "Context engine", type: "text", hint: "compressor (default) or plugin name" },
      { key: "network.force_ipv4", label: "Force IPv4", type: "boolean", hint: "skip IPv6 lookups" },
    ],
  },
  {
    id: "terminal",
    label: "Terminal",
    fields: [
      { key: "terminal.backend", label: "Backend", type: "select", options: ["local", "docker", "ssh", "modal", "singularity", "daytona"], hint: "execution environment" },
      { key: "terminal.cwd", label: "Working directory", type: "text", hint: "starting cwd for terminal commands" },
      { key: "terminal.timeout", label: "Command timeout", type: "number", min: 10, max: 3600, step: 10, hint: "seconds" },
      { key: "terminal.persistent_shell", label: "Persistent shell", type: "boolean", hint: "keep shell state across calls" },
      { key: "terminal.docker_image", label: "Docker image", type: "text", hint: "container image for docker backend" },
      { key: "terminal.container_cpu", label: "Container CPU", type: "number", min: 1, max: 16, hint: "CPU cores" },
      { key: "terminal.container_memory", label: "Container memory", type: "number", min: 256, max: 65536, step: 256, hint: "MB" },
      { key: "terminal.container_disk", label: "Container disk", type: "number", min: 1024, max: 204800, step: 1024, hint: "MB" },
      { key: "terminal.container_persistent", label: "Persistent container", type: "boolean", hint: "keep filesystem across sessions" },
      { key: "terminal.docker_mount_cwd_to_workspace", label: "Mount CWD", type: "boolean", hint: "mount host cwd into container", dangerous: true },
      { key: "terminal.modal_mode", label: "Modal mode", type: "select", options: ["auto", "sandbox", "function"], hint: "Modal.com execution mode" },
      { key: "terminal.env_passthrough", label: "Env passthrough", type: "text", hint: "comma-separated env var names" },
      { key: "terminal.docker_forward_env", label: "Docker forward env", type: "text", hint: "comma-separated env var names" },
      { key: "terminal.singularity_image", label: "Singularity image", type: "text" },
      { key: "terminal.modal_image", label: "Modal image", type: "text" },
      { key: "terminal.daytona_image", label: "Daytona image", type: "text" },
      { key: "terminal.docker_volumes", label: "Docker volumes", type: "text", hint: "comma-separated host:container paths" },
    ],
  },
  {
    id: "display",
    label: "Display",
    fields: [
      { key: "display.personality", label: "Personality", type: "text", hint: "kawaii, pirate, shakespeare, noir, etc." },
      { key: "display.compact", label: "Compact", type: "boolean" },
      { key: "display.streaming", label: "Streaming", type: "boolean" },
      { key: "display.show_reasoning", label: "Show reasoning", type: "boolean" },
      { key: "display.show_cost", label: "Show cost", type: "boolean", hint: "$ in status bar" },
      { key: "display.inline_diffs", label: "Inline diffs", type: "boolean" },
      { key: "display.bell_on_complete", label: "Bell on complete", type: "boolean" },
      { key: "display.resume_display", label: "Resume display", type: "select", options: ["full", "compact", "off"] },
      { key: "display.busy_input_mode", label: "Busy input mode", type: "select", options: ["interrupt", "queue", "reject"] },
      { key: "display.skin", label: "Skin", type: "select", options: ["default", "minimal", "fancy"] },
      { key: "display.interim_assistant_messages", label: "Interim messages", type: "boolean", hint: "mid-turn status messages" },
      { key: "display.tool_progress", label: "Tool progress", type: "text", hint: "all / off / errors" },
      { key: "display.tool_preview_length", label: "Tool preview length", type: "number", min: 0, max: 10000, hint: "chars · 0 = unlimited" },
      { key: "display.background_process_notifications", label: "BG notifications", type: "text", hint: "all / off / errors" },
      { key: "human_delay.mode", label: "Human delay", type: "select", options: ["off", "fixed", "random"], hint: "simulate typing delay" },
      { key: "human_delay.min_ms", label: "Delay min ms", type: "number", min: 0, max: 10000 },
      { key: "human_delay.max_ms", label: "Delay max ms", type: "number", min: 0, max: 10000 },
    ],
  },
  {
    id: "delegation",
    label: "Delegation",
    fields: [
      { key: "delegation.model", label: "Model", type: "text", hint: "subagent model · empty = inherit parent" },
      { key: "delegation.provider", label: "Provider", type: "text", hint: "subagent provider · empty = inherit" },
      { key: "delegation.base_url", label: "Base URL", type: "text" },
      { key: "delegation.max_iterations", label: "Max iterations", type: "number", min: 1, max: 500, hint: "per-subagent budget" },
      { key: "delegation.reasoning_effort", label: "Reasoning effort", type: "select", options: ["", "xhigh", "high", "medium", "low", "minimal", "none"], hint: "empty = inherit" },
      { key: "delegation.default_toolsets", label: "Default toolsets", type: "text", hint: "comma-separated" },
    ],
  },
  {
    id: "memory",
    label: "Memory",
    fields: [
      { key: "memory.memory_enabled", label: "Memory enabled", type: "boolean" },
      { key: "memory.user_profile_enabled", label: "User profile", type: "boolean" },
      { key: "memory.memory_char_limit", label: "Memory char limit", type: "number", min: 100, max: 10000, hint: "injected into system prompt" },
      { key: "memory.user_char_limit", label: "User char limit", type: "number", min: 100, max: 10000 },
      { key: "memory.provider", label: "Provider", type: "text", hint: "holographic, mem0, etc. · empty = built-in" },
    ],
  },
  {
    id: "compression",
    label: "Compression",
    fields: [
      { key: "compression.enabled", label: "Enabled", type: "boolean" },
      { key: "compression.threshold", label: "Threshold", type: "number", min: 0.1, max: 0.95, step: 0.05, hint: "ratio of context" },
      { key: "compression.target_ratio", label: "Target ratio", type: "number", min: 0.1, max: 0.9, step: 0.05, hint: "of window after compaction" },
      { key: "compression.protect_last_n", label: "Protect last N", type: "number", min: 0, max: 100, hint: "messages to keep uncompressed" },
    ],
  },
  {
    id: "security",
    label: "Security",
    fields: [
      { key: "approvals.mode", label: "Approval mode", type: "select", options: ["manual", "smart", "off"] },
      { key: "approvals.non_interactive_policy", label: "Non-interactive", type: "select", options: ["guarded", "allow"], hint: "guarded (recommended)" },
      { key: "approvals.timeout", label: "Approval timeout", type: "number", min: 10, max: 600, step: 10, hint: "seconds" },
      { key: "security.redact_secrets", label: "Redact secrets", type: "boolean", hint: "mask API keys in logs", dangerous: true },
      { key: "security.tirith_enabled", label: "Tirith scanner", type: "boolean" },
      { key: "security.tirith_timeout", label: "Tirith timeout", type: "number", min: 1, max: 30, hint: "seconds" },
      { key: "security.tirith_fail_open", label: "Tirith fail open", type: "boolean", hint: "allow on scanner error", dangerous: true },
      { key: "privacy.redact_pii", label: "Redact PII", type: "boolean", hint: "hash user IDs, strip phone numbers" },
      { key: "browser.allow_private_urls", label: "Allow private URLs", type: "boolean", hint: "localhost, 192.168.x.x, etc.", dangerous: true },
    ],
  },
  {
    id: "browser",
    label: "Browser",
    fields: [
      { key: "browser.inactivity_timeout", label: "Inactivity timeout", type: "number", min: 10, max: 600, step: 10, hint: "seconds" },
      { key: "browser.command_timeout", label: "Command timeout", type: "number", min: 5, max: 120, step: 5, hint: "seconds" },
      { key: "browser.record_sessions", label: "Record sessions", type: "boolean", hint: "save WebM videos" },
      { key: "browser.camofox.managed_persistence", label: "Camofox persistence", type: "boolean" },
    ],
  },
  {
    id: "voice",
    label: "Voice",
    fields: [
      { key: "voice.record_key", label: "Record key", type: "text", hint: "keyboard shortcut" },
      { key: "voice.max_recording_seconds", label: "Max recording", type: "number", min: 10, max: 600, hint: "seconds" },
      { key: "voice.auto_tts", label: "Auto TTS", type: "boolean", hint: "read responses aloud" },
      { key: "voice.silence_threshold", label: "Silence threshold", type: "number", min: 0, max: 1000, hint: "RMS level" },
      { key: "voice.silence_duration", label: "Silence duration", type: "number", min: 0.5, max: 10, step: 0.5, hint: "seconds before auto-stop" },
    ],
  },
  {
    id: "tts",
    label: "Text-to-Speech",
    fields: [
      { key: "tts.provider", label: "Provider", type: "select", options: ["edge", "elevenlabs", "openai", "minimax", "mistral", "neutts"], hint: "edge = free" },
      { key: "tts.edge.voice", label: "Edge voice", type: "text", hint: "e.g. en-US-AriaNeural" },
      { key: "tts.elevenlabs.voice_id", label: "ElevenLabs voice", type: "text" },
      { key: "tts.elevenlabs.model_id", label: "ElevenLabs model", type: "text" },
      { key: "tts.openai.model", label: "OpenAI model", type: "text" },
      { key: "tts.openai.voice", label: "OpenAI voice", type: "select", options: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] },
      { key: "tts.mistral.model", label: "Mistral model", type: "text" },
      { key: "tts.mistral.voice_id", label: "Mistral voice", type: "text" },
      { key: "tts.neutts.ref_audio", label: "NeuTTS ref audio", type: "text", hint: "path to reference audio" },
      { key: "tts.neutts.ref_text", label: "NeuTTS ref text", type: "text" },
      { key: "tts.neutts.model", label: "NeuTTS model", type: "text" },
      { key: "tts.neutts.device", label: "NeuTTS device", type: "select", options: ["cpu", "cuda", "mps"] },
    ],
  },
  {
    id: "stt",
    label: "Speech-to-Text",
    fields: [
      { key: "stt.enabled", label: "Enabled", type: "boolean" },
      { key: "stt.provider", label: "Provider", type: "select", options: ["local", "groq", "openai", "mistral"] },
      { key: "stt.local.model", label: "Local model", type: "select", options: ["tiny", "base", "small", "medium", "large-v3"] },
      { key: "stt.local.language", label: "Language", type: "text", hint: "en, es, fr, etc. · empty = auto" },
      { key: "stt.openai.model", label: "OpenAI model", type: "text" },
      { key: "stt.mistral.model", label: "Mistral model", type: "text" },
    ],
  },
  {
    id: "logging",
    label: "Logging",
    fields: [
      { key: "logging.level", label: "Level", type: "select", options: ["DEBUG", "INFO", "WARNING"] },
      { key: "logging.max_size_mb", label: "Max size", type: "number", min: 1, max: 100, hint: "MB per log file" },
      { key: "logging.backup_count", label: "Backup count", type: "number", min: 0, max: 20, hint: "rotated files to keep" },
    ],
  },
  {
    id: "discord",
    label: "Discord",
    fields: [
      { key: "discord.require_mention", label: "Require mention", type: "boolean", hint: "respond only to @mentions in channels" },
      { key: "discord.auto_thread", label: "Auto thread", type: "boolean", hint: "create threads on @mention" },
      { key: "discord.reactions", label: "Reactions", type: "boolean", hint: "add processing emoji reactions" },
      { key: "discord.free_response_channels", label: "Free response channels", type: "text", hint: "comma-separated channel IDs" },
      { key: "discord.allowed_channels", label: "Allowed channels", type: "text", hint: "whitelist · comma-separated IDs" },
    ],
  },
  {
    id: "auxiliary",
    label: "Auxiliary",
    fields: (() => {
      const services = [
        "vision", "web_extract", "compression", "session_search",
        "skills_hub", "approval", "mcp", "flush_memories",
      ];
      const fields: FieldDef[] = [];
      for (const svc of services) {
        fields.push(
          { key: `auxiliary.${svc}.provider`, label: `${svc} provider`, type: "text", hint: "auto / openrouter / nous / custom" },
          { key: `auxiliary.${svc}.model`, label: `${svc} model`, type: "text" },
          { key: `auxiliary.${svc}.base_url`, label: `${svc} base URL`, type: "text" },
          { key: `auxiliary.${svc}.timeout`, label: `${svc} timeout`, type: "number", min: 5, max: 600, hint: "seconds" },
        );
      }
      return fields;
    })(),
  },
  {
    id: "code_execution",
    label: "Code Execution",
    fields: [
      { key: "code_execution.timeout", label: "Timeout", type: "number", min: 10, max: 3600, step: 10, hint: "seconds" },
      { key: "code_execution.max_tool_calls", label: "Max tool calls", type: "number", min: 1, max: 200, hint: "per session" },
      { key: "code_execution.max_tool_output", label: "Max tool output", type: "number", min: 500, max: 20000, step: 100, hint: "tokens per call" },
    ],
  },
  {
    id: "cron",
    label: "Scheduling",
    fields: [
      { key: "cron.wrap_response", label: "Wrap response", type: "boolean", hint: "add header/footer to cron output" },
      { key: "cron.timezone", label: "Timezone", type: "text", hint: "IANA format · empty = server local", placeholder: "America/Chicago" },
    ],
  },
];

const TOTAL_FIELDS = CATEGORIES.reduce((n, c) => n + c.fields.length, 0);

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

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

  const confirm = useConfirm();

  const [restartHint, setRestartHint] = useState<string[]>([]);
  const [editing, setEditing] = useState<Record<string, unknown>>({});
  const [filter, setFilter] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("general");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cfg.data?.config) {
      const c = cfg.data.config as Record<string, any>;
      const state: Record<string, unknown> = {};
      for (const cat of CATEGORIES) {
        for (const f of cat.fields) {
          const val = getNestedValue(c, f.key);
          if (f.type === "list" && Array.isArray(val)) {
            state[f.key] = val.join(", ");
          } else if (val !== undefined && val !== null) {
            state[f.key] = val;
          }
        }
      }
      setEditing(state);
    }
  }, [cfg.data]);

  const save = useApiMutation({
    mutationFn: (mutations: Record<string, unknown>) =>
      api.putConfig(mutations),
    successMessage: "Config saved",
    onSuccess: (data) => {
      if (data.restart_required.length > 0) {
        setRestartHint((prev) => {
          const next = new Set(prev);
          for (const k of data.restart_required) next.add(k);
          return Array.from(next);
        });
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

  const restartGateway = useApiMutation({
    mutationFn: api.gatewayRestart,
    successMessage: "Gateway restarting…",
  });

  const update = (key: string, value: unknown) =>
    setEditing((p) => ({ ...p, [key]: value }));

  const filteredCategories = useMemo(() => {
    if (!filter.trim()) return CATEGORIES;
    const q = filter.toLowerCase();
    return CATEGORIES.map((cat) => ({
      ...cat,
      fields: cat.fields.filter(
        (f) =>
          f.label.toLowerCase().includes(q) ||
          f.key.toLowerCase().includes(q) ||
          (f.hint?.toLowerCase().includes(q) ?? false),
      ),
    })).filter((cat) => cat.fields.length > 0);
  }, [filter]);

  const backupCount = backups.data?.backups.length ?? 0;

  const saveCategory = (cat: CategoryDef) => {
    const mutations: Record<string, unknown> = {};
    for (const f of cat.fields) {
      const val = editing[f.key];
      if (val === undefined) continue;
      if (f.type === "list" && typeof val === "string") {
        mutations[f.key] = val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        mutations[f.key] = val;
      }
    }
    if (Object.keys(mutations).length > 0) {
      save.mutate(mutations);
    }
  };

  const activeCat = filteredCategories.find((c) => c.id === activeCategory);
  // Special pseudo-categories
  const isSpecial =
    activeCategory === "paths" ||
    activeCategory === "appearance" ||
    activeCategory === "backups";

  const handleRestart = async () => {
    const ok = await confirm({
      title: "Restart gateway?",
      description:
        "The gateway process will terminate and launchd will restart it. Active sessions will be interrupted.",
      confirmLabel: "RESTART",
    });
    if (ok) {
      restartGateway.mutate();
      setRestartHint([]);
    }
  };

  return (
    <div className="bg-bg">
      {/* ── strip ── */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">CONFIG</div>
        <div className="flex items-center justify-center gap-7">
          <Meter label="Fields" value={String(TOTAL_FIELDS)} />
          <Meter label="Categories" value={String(CATEGORIES.length)} />
          <Meter label="Backups" value={String(backupCount)} />
        </div>
        <div className="text-ink-faint">EDIT</div>
      </div>

      {/* ── main layout: content + sidebar ── */}
      <div className="flex min-h-0">
        {/* ── content pane ── */}
        <div ref={contentRef} className="flex-1 overflow-y-auto">
          {/* stamp */}
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

          {/* restart banner */}
          {restartHint.length > 0 && (
            <div className="mx-10 mb-6 flex items-center gap-4 border border-oxide-edge bg-oxide-wash px-4 py-3 font-mono text-[10px] uppercase tracking-marker text-oxide">
              <span className="flex-1">
                restart required: {restartHint.join(", ")}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRestart}
              >
                RESTART GATEWAY
              </Button>
            </div>
          )}

          {/* active section content */}
          <div className="px-10 pb-16">
            {activeCat && !isSpecial && (
              <Section
                id={activeCat.label.toUpperCase()}
                count={String(activeCat.fields.length)}
              >
                {activeCat.fields.map((f) => (
                  <DynamicField
                    key={f.key}
                    def={f}
                    value={editing[f.key]}
                    onChange={(v) => update(f.key, v)}
                  />
                ))}
                <SaveButton
                  onClick={() => saveCategory(activeCat)}
                  isPending={save.isPending}
                />
              </Section>
            )}

            {activeCategory === "paths" && (
              <SecurityPathsSection
                onRestartNeeded={() =>
                  setRestartHint((p) =>
                    p.includes("security.safe_roots")
                      ? p
                      : [...p, "security paths"],
                  )
                }
              />
            )}

            {activeCategory === "appearance" && <AppearanceSection />}

            {activeCategory === "backups" && (
              <Section id="BACKUPS" count={String(backupCount)}>
                <ul className="space-y-1.5">
                  {(backups.data?.backups ?? [])
                    .slice()
                    .reverse()
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
                  {backupCount === 0 && (
                    <li className="font-mono text-[10px] uppercase tracking-marker text-ink-faint">
                      no backups yet
                    </li>
                  )}
                </ul>
              </Section>
            )}
          </div>
        </div>

        {/* ── right sidebar ── */}
        <div
          className={cn(
            "shrink-0 border-l border-rule bg-bg-alt transition-[width] duration-180 ease-operator",
            sidebarOpen ? "w-[220px]" : "w-10",
          )}
        >
          <div className="sticky top-0">
            {/* collapse toggle */}
            <button
              type="button"
              onClick={() => setSidebarOpen((o) => !o)}
              className="flex h-8 w-full items-center justify-center font-mono text-[11px] text-ink-muted hover:text-ink"
              aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            >
              {sidebarOpen ? "›" : "‹"}
            </button>

            {!sidebarOpen ? null : (
            <div className="space-y-1 px-4 pb-4">
            {/* search */}
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search…"
              className="mb-3 h-8 text-[11px]"
            />

            {/* category list */}
            {filteredCategories.map((cat) => (
              <SidebarItem
                key={cat.id}
                label={cat.label}
                count={cat.fields.length}
                active={activeCategory === cat.id}
                onClick={() => {
                  setActiveCategory(cat.id);
                  contentRef.current?.scrollTo({ top: 0 });
                }}
              />
            ))}

            {/* divider */}
            <div className="my-2 h-px bg-rule" />

            {/* special sections */}
            <SidebarItem
              label="Path Jail"
              active={activeCategory === "paths"}
              onClick={() => {
                setActiveCategory("paths");
                contentRef.current?.scrollTo({ top: 0 });
              }}
            />
            <SidebarItem
              label="Appearance"
              active={activeCategory === "appearance"}
              onClick={() => {
                setActiveCategory("appearance");
                contentRef.current?.scrollTo({ top: 0 });
              }}
            />
            <SidebarItem
              label="Backups"
              count={backupCount}
              active={activeCategory === "backups"}
              onClick={() => {
                setActiveCategory("backups");
                contentRef.current?.scrollTo({ top: 0 });
              }}
            />

            {/* divider */}
            <div className="my-2 h-px bg-rule" />

            {/* restart button */}
            <button
              type="button"
              onClick={handleRestart}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1.5 font-mono text-[10px] uppercase tracking-marker transition-colors duration-120 ease-operator",
                restartHint.length > 0
                  ? "text-oxide hover:bg-oxide-wash"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              <span className="text-[12px]">↻</span>
              Restart Gateway
              {restartHint.length > 0 && (
                <span className="ml-auto inline-block size-1.5 rounded-full bg-oxide" />
              )}
            </button>
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar item
// ---------------------------------------------------------------------------

function SidebarItem({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between px-2 py-1.5 font-mono text-[11px] transition-colors duration-120 ease-operator",
        active
          ? "bg-oxide-wash text-oxide"
          : "text-ink-muted hover:bg-rule/30 hover:text-ink",
      )}
    >
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span className="tabular-nums text-ink-faint">{count}</span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dynamic field renderer
// ---------------------------------------------------------------------------

function DynamicField({
  def,
  value,
  onChange,
}: {
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const label = def.dangerous ? `${def.label} ⚠` : def.label;
  const hint = def.hint;

  switch (def.type) {
    case "boolean":
      return (
        <Field label={label} hint={hint}>
          <button
            type="button"
            onClick={() => onChange(!value)}
            className={cn(
              "h-8 border px-3 font-mono text-[10px] uppercase tracking-marker transition-colors duration-120 ease-operator",
              value
                ? "border-oxide-edge bg-oxide-wash text-oxide"
                : "border-rule text-ink-muted hover:border-oxide-edge",
            )}
          >
            {value ? "ON" : "OFF"}
          </button>
        </Field>
      );

    case "select":
      return (
        <Field label={label} hint={hint}>
          <Select
            value={String(value ?? def.options?.[0] ?? "")}
            onChange={(e) => onChange(e.target.value)}
            className="max-w-[200px]"
          >
            {(def.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o || "(empty)"}
              </option>
            ))}
          </Select>
        </Field>
      );

    case "number":
      return (
        <Field
          label={label}
          hint={
            def.min !== undefined && def.max !== undefined
              ? `${def.min} – ${def.max}${hint ? ` · ${hint}` : ""}`
              : hint
          }
        >
          <Input
            type="number"
            min={def.min}
            max={def.max}
            step={def.step}
            value={String(value ?? "")}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-9 max-w-[140px]"
          />
        </Field>
      );

    case "text":
    case "list":
    default:
      return (
        <Field label={label} hint={hint}>
          <Input
            type="text"
            placeholder={def.placeholder}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            className="h-9 max-w-[320px]"
          />
        </Field>
      );
  }
}

// ---------------------------------------------------------------------------
// Shared layout primitives
// ---------------------------------------------------------------------------

function Section({
  id,
  count,
  children,
}: {
  id: string;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="marker mb-4">
        <span className="marker-num">{count ?? "·"}</span>
        <span>{id}</span>
        <span className="marker-rule" />
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  invalid,
  children,
}: {
  label: string;
  hint?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="grid grid-cols-[160px_1fr] items-start gap-3 pt-1">
      <span
        className={cn(
          "pt-2 font-mono text-[10px] uppercase tracking-marker",
          invalid ? "text-danger" : "text-ink-muted",
        )}
      >
        {label}
      </span>
      <div>
        {children}
        {hint && (
          <p
            className={cn(
              "mt-1.5 font-mono text-[10px] tracking-marker",
              invalid ? "text-danger" : "text-ink-faint",
            )}
          >
            {hint}
          </p>
        )}
      </div>
    </label>
  );
}

function SaveButton({
  onClick,
  isPending,
  disabled,
}: {
  onClick: () => void;
  isPending?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex justify-end pt-2">
      <Button
        size="sm"
        variant="outline"
        onClick={onClick}
        disabled={isPending || disabled}
      >
        {isPending ? "SAVING…" : "SAVE"}
      </Button>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span>{label}</span>
      <span className="text-ink tabular-nums">{value}</span>
    </span>
  );
}

function getNestedValue(obj: Record<string, any>, dotkey: string): unknown {
  const parts = dotkey.split(".");
  let cursor: any = obj;
  for (const p of parts) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = cursor[p];
  }
  return cursor;
}

// ---------------------------------------------------------------------------
// Appearance — dark/light instrument toggle
// ---------------------------------------------------------------------------

function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <Section id="APPEARANCE · INSTRUMENT" count="·">
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
    </Section>
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

// ---------------------------------------------------------------------------
// Security — Path Jail section
// ---------------------------------------------------------------------------

function SecurityPathsSection({
  onRestartNeeded,
}: {
  onRestartNeeded: () => void;
}) {
  const paths = useQuery({
    queryKey: ["dashboard", "security", "paths"],
    queryFn: api.securityPaths,
  });

  const [newSafeRoot, setNewSafeRoot] = useState("");
  const [newDenied, setNewDenied] = useState("");

  const notify = useNotify();
  const confirm = useConfirm();

  const mutate = useApiMutation({
    mutationFn: api.securityPathMutate,
    successMessage: (data) =>
      `${data.action === "add" ? "Added" : "Removed"} ${data.path}`,
    onSuccess: () => {
      paths.refetch();
      onRestartNeeded();
    },
  });

  const handleAdd = (
    target: "safe_roots" | "denied_paths",
    path: string,
    clearFn: (v: string) => void,
  ) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    mutate.mutate({ action: "add", target, path: trimmed });
    clearFn("");
  };

  const handleRemove = async (
    target: "safe_roots" | "denied_paths",
    path: string,
  ) => {
    const isBlocked = (paths.data?.removal_blocklist ?? []).some(
      (b) => b === path,
    );
    if (isBlocked) {
      notify.error(`Cannot remove protected path: ${path}`);
      return;
    }
    const ok = await confirm({
      title: `Remove ${path}?`,
      description:
        target === "safe_roots"
          ? "Hermes will no longer be able to read/write files under this path."
          : "This path will no longer be blocked. Hermes will be able to access it.",
      confirmLabel: "REMOVE",
    });
    if (ok) mutate.mutate({ action: "remove", target, path });
  };

  const blocklist = new Set(paths.data?.removal_blocklist ?? []);

  return (
    <Section id="SECURITY · PATH JAIL" count="·">
      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          ALLOWED PATHS (safe_roots)
        </div>
        <p className="mb-3 font-mono text-[10px] tracking-marker text-ink-faint">
          Hermes can read and write files under these directories.
        </p>
        <ul className="space-y-1">
          {(paths.data?.safe_roots ?? []).map((p) => (
            <li
              key={p}
              className="flex items-center justify-between border-b border-rule/40 py-1 font-mono text-[11px] text-ink"
            >
              <span className="min-w-0 truncate">{p}</span>
              <button
                type="button"
                onClick={() => handleRemove("safe_roots", p)}
                className="shrink-0 pl-3 font-mono text-[10px] uppercase tracking-marker text-ink-faint hover:text-danger"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <Input
            placeholder="~/path/to/add"
            value={newSafeRoot}
            onChange={(e) => setNewSafeRoot(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                handleAdd("safe_roots", newSafeRoot, setNewSafeRoot);
            }}
            className="h-8 flex-1 font-mono text-[11px]"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              handleAdd("safe_roots", newSafeRoot, setNewSafeRoot)
            }
            disabled={!newSafeRoot.trim()}
          >
            ADD
          </Button>
        </div>
      </div>

      <div className="pt-4">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          BLOCKED PATHS (denied_paths)
        </div>
        <p className="mb-3 font-mono text-[10px] tracking-marker text-ink-faint">
          Always blocked, even if under an allowed root. Protected entries
          cannot be removed.
        </p>
        <ul className="space-y-1">
          {(paths.data?.denied_paths ?? []).map((p) => {
            const isProtected = blocklist.has(p);
            return (
              <li
                key={p}
                className="flex items-center justify-between border-b border-rule/40 py-1 font-mono text-[11px] text-ink"
              >
                <span className="min-w-0 truncate">
                  {p}
                  {isProtected && (
                    <span className="ml-2 text-[9px] uppercase tracking-marker text-ink-faint">
                      protected
                    </span>
                  )}
                </span>
                {!isProtected && (
                  <button
                    type="button"
                    onClick={() => handleRemove("denied_paths", p)}
                    className="shrink-0 pl-3 font-mono text-[10px] uppercase tracking-marker text-ink-faint hover:text-danger"
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-2 flex gap-2">
          <Input
            placeholder="~/path/to/block"
            value={newDenied}
            onChange={(e) => setNewDenied(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                handleAdd("denied_paths", newDenied, setNewDenied);
            }}
            className="h-8 flex-1 font-mono text-[11px]"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              handleAdd("denied_paths", newDenied, setNewDenied)
            }
            disabled={!newDenied.trim()}
          >
            ADD
          </Button>
        </div>
      </div>

      <p className="pt-3 font-mono text-[10px] uppercase tracking-marker text-ink-faint">
        changes require gateway restart · seatbelt profile is a separate
        kernel-level layer
      </p>
    </Section>
  );
}
