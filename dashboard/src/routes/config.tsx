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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /** Detailed tooltip shown on ⓘ hover. Explain what the setting does,
   *  and what happens at higher/lower values when applicable. */
  description?: string;
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
      { key: "model.default", label: "Model", type: "text", hint: "default model (e.g. claude-opus-4-6)", placeholder: "claude-opus-4-6", description: "The primary LLM used for all conversations. This is the model identifier as known to the provider. Changing this affects all new sessions immediately." },
      { key: "model.provider", label: "Model provider", type: "text", hint: "anthropic, openrouter, nous, custom, etc.", description: "Which provider serves the primary model. Built-in providers: openrouter, nous, anthropic, copilot, and more. Use 'custom' with a base_url for self-hosted or OpenAI-compatible endpoints." },
      { key: "fallback_providers", label: "Fallback providers", type: "list", hint: "comma-separated provider names", description: "Comma-separated list of providers to try if the primary fails. The agent tries each in order until one responds. Empty means no fallback — a primary failure ends the turn." },
      { key: "toolsets", label: "Toolsets", type: "list", hint: "comma-separated toolset names", description: "Which tool categories the agent can use. 'hermes-cli' is the default set. Adding toolsets grants more capabilities; removing them restricts what the agent can do." },
      { key: "file_read_max_chars", label: "File read max chars", type: "number", min: 1000, max: 500000, step: 1000, hint: "max chars per read_file call", description: "Maximum characters returned by a single read_file tool call. Higher values let the agent read larger files in one shot but consume more context. Lower values force chunked reads, which is safer for context budgets but slower." },
      { key: "timezone", label: "Timezone", type: "text", hint: "IANA format · e.g. America/Chicago · empty = server local", placeholder: "America/Chicago", description: "IANA timezone used for cron scheduling, timestamps, and time-aware responses. Empty means the server's local timezone is used." },
      { key: "prefill_messages_file", label: "Prefill messages file", type: "text", hint: "JSON few-shot priming file path", description: "Path to a JSON file containing [{role, content}] messages injected at the start of every API call. Used for few-shot priming. These messages are never saved to sessions or logs." },
    ],
  },
  {
    id: "agent",
    label: "Agent",
    fields: [
      { key: "agent.max_turns", label: "Max turns", type: "number", min: 1, max: 500, hint: "per-session turn limit", description: "Maximum number of conversation turns before the agent stops. Higher values allow longer autonomous runs but risk runaway loops. Lower values keep sessions short and predictable. Requires restart." },
      { key: "agent.reasoning_effort", label: "Reasoning effort", type: "select", options: ["low", "medium", "high"], hint: "LLM reasoning depth", description: "Controls how much thinking the model does before responding. 'high' produces more thorough but slower responses. 'low' is faster but may miss nuance. Affects token usage and latency." },
      { key: "agent.gateway_timeout", label: "Gateway timeout", type: "number", min: 0, max: 7200, step: 60, hint: "seconds · 0 = unlimited", description: "How long a gateway session can sit idle before being terminated. Only fires when the agent has been completely inactive — active tool calls don't count. 0 means no timeout. Higher values let agents think longer between actions." },
      { key: "agent.restart_drain_timeout", label: "Drain timeout", type: "number", min: 0, max: 300, step: 10, hint: "seconds before interrupting on restart", description: "On gateway restart, how long to wait for active agents to finish before force-interrupting them. Higher values are gentler but slow down restarts. 0 means interrupt immediately." },
      { key: "agent.service_tier", label: "Service tier", type: "text", hint: "API service tier", description: "API service tier passed to the LLM provider. Some providers use this for priority routing or billing. Leave empty for default tier." },
      { key: "agent.tool_use_enforcement", label: "Tool use enforcement", type: "text", hint: "auto / true / false", description: "Injects system prompt guidance telling the model to actually call tools instead of describing intended actions. 'auto' applies only to models known to need it (GPT, Codex). 'true' forces it for all models. 'false' disables it entirely." },
      { key: "agent.gateway_timeout_warning", label: "Timeout warning", type: "number", min: 0, max: 7200, step: 60, hint: "seconds before warning · 0 = off", description: "Sends a warning to the user at this idle threshold before the full gateway timeout fires. Gives the user a heads-up that the session is about to end. 0 disables the warning." },
      { key: "agent.gateway_notify_interval", label: "Notify interval", type: "number", min: 0, max: 3600, step: 60, hint: "seconds between status pings · 0 = off", description: "Sends periodic 'still working' status messages during long tasks so the user knows the agent hasn't died. Higher values mean less noise. 0 disables notifications entirely." },
      { key: "checkpoints.enabled", label: "Checkpoints enabled", type: "boolean", description: "When on, the agent takes a filesystem snapshot before destructive file operations (write, patch). You can use /rollback to undo. Turning this off saves disk space but removes the safety net." },
      { key: "checkpoints.max_snapshots", label: "Max snapshots", type: "number", min: 1, max: 200, hint: "per directory", description: "Maximum checkpoint snapshots kept per working directory. Older snapshots are pruned when the limit is reached. Higher values preserve more history but use more disk." },
      { key: "smart_model_routing.enabled", label: "Smart routing", type: "boolean", hint: "route simple queries to cheap model", description: "When on, simple queries (below the char/word thresholds) are routed to a cheaper/faster model instead of the primary. Saves cost on trivial exchanges like greetings or yes/no questions." },
      { key: "smart_model_routing.max_simple_chars", label: "Max simple chars", type: "number", min: 10, max: 500, hint: "char threshold for simple routing", description: "Messages shorter than this character count are considered 'simple' and routed to the cheap model. Higher values send more messages to the cheap model, saving cost but potentially reducing quality for medium-length queries." },
      { key: "smart_model_routing.max_simple_words", label: "Max simple words", type: "number", min: 1, max: 100, hint: "word threshold for simple routing", description: "Messages with fewer words than this are considered 'simple'. Works alongside the character threshold — both must be satisfied. Higher values broaden the cheap-model funnel." },
      { key: "context.engine", label: "Context engine", type: "text", hint: "compressor (default) or plugin name", description: "Controls how the context window is managed when approaching the model's token limit. 'compressor' is the built-in lossy summarization. Alternative engines can be installed as plugins. Requires restart." },
      { key: "network.force_ipv4", label: "Force IPv4", type: "boolean", hint: "skip IPv6 lookups", description: "Skip IPv6 DNS lookups entirely. Turn this on if your server has broken or unreachable IPv6 — without it, Python tries AAAA records first and hangs for the full TCP timeout before falling back to IPv4. Requires restart." },
    ],
  },
  {
    id: "terminal",
    label: "Terminal",
    fields: [
      { key: "terminal.backend", label: "Backend", type: "select", options: ["local", "docker", "ssh", "modal", "singularity", "daytona"], hint: "execution environment", description: "Where the agent's shell commands run. 'local' executes directly on this machine. 'docker' runs in an isolated container. 'ssh' connects to a remote host. Changing this requires a restart and may need additional config (images, credentials)." },
      { key: "terminal.cwd", label: "Working directory", type: "text", hint: "starting cwd for terminal commands", description: "The starting directory for all terminal commands. This is a starting point, not a jail — the agent can cd elsewhere unless the path jail (security.safe_roots) restricts it." },
      { key: "terminal.timeout", label: "Command timeout", type: "number", min: 10, max: 3600, step: 10, hint: "seconds", description: "How long a single shell command can run before being killed. Higher values allow long builds and downloads. Lower values catch runaway processes faster." },
      { key: "terminal.persistent_shell", label: "Persistent shell", type: "boolean", hint: "keep shell state across calls", description: "When on, a long-lived bash shell is kept across execute() calls so cwd, env vars, and shell variables survive between commands. When off, each command starts a fresh shell." },
      { key: "terminal.docker_image", label: "Docker image", type: "text", hint: "container image for docker backend", description: "The Docker image used when terminal.backend is 'docker'. Must have Python and Node.js for the agent's tools. Requires restart to take effect." },
      { key: "terminal.container_cpu", label: "Container CPU", type: "number", min: 1, max: 16, hint: "CPU cores", description: "CPU cores allocated to the container. More cores speed up parallel builds and multi-threaded tools. Requires restart." },
      { key: "terminal.container_memory", label: "Container memory", type: "number", min: 256, max: 65536, step: 256, hint: "MB", description: "Memory allocated to the container in MB. More memory prevents OOM kills during large builds or data processing. 5120 MB (5 GB) is the default. Requires restart." },
      { key: "terminal.container_disk", label: "Container disk", type: "number", min: 1024, max: 204800, step: 1024, hint: "MB", description: "Disk space allocated to the container in MB. More disk allows larger repos and build artifacts. 51200 MB (50 GB) is the default. Requires restart." },
      { key: "terminal.container_persistent", label: "Persistent container", type: "boolean", hint: "keep filesystem across sessions", description: "When on, the container filesystem persists across sessions — installed packages, cloned repos, and build artifacts survive. When off, each session starts from a clean image. Requires restart." },
      { key: "terminal.docker_mount_cwd_to_workspace", label: "Mount CWD", type: "boolean", hint: "mount host cwd into container", dangerous: true, description: "⚠ SECURITY: Mounts the host's current working directory into /workspace inside the container. This weakens sandbox isolation — the agent can read and modify host files directly. Off by default for good reason." },
      { key: "terminal.modal_mode", label: "Modal mode", type: "select", options: ["auto", "sandbox", "function"], hint: "Modal.com execution mode", description: "How commands run on Modal.com. 'auto' picks the best mode. 'sandbox' gives a full Linux VM. 'function' is faster but more restricted." },
      { key: "terminal.env_passthrough", label: "Env passthrough", type: "list", hint: "comma-separated env var names", description: "Environment variables from the host process to pass into sandboxed execution. Skill-declared variables are passed automatically; this list covers non-skill use cases." },
      { key: "terminal.docker_forward_env", label: "Docker forward env", type: "list", hint: "comma-separated env var names", description: "Environment variables from the host to forward into Docker containers. The values are read from the host process at container start." },
      { key: "terminal.singularity_image", label: "Singularity image", type: "text", description: "Container image for the Singularity/Apptainer backend. Same role as docker_image but for HPC environments." },
      { key: "terminal.modal_image", label: "Modal image", type: "text", description: "Container image for the Modal.com backend. Must be a Docker-compatible image." },
      { key: "terminal.daytona_image", label: "Daytona image", type: "text", description: "Container image for the Daytona backend." },
      { key: "terminal.docker_volumes", label: "Docker volumes", type: "list", hint: "comma-separated host:container paths", description: "Host directories to mount inside the Docker container, in standard Docker -v syntax (host_path:container_path). Use this to share data or project directories with the container." },
    ],
  },
  {
    id: "display",
    label: "Display",
    fields: [
      { key: "display.personality", label: "Personality", type: "text", hint: "kawaii, pirate, shakespeare, noir, etc.", description: "Cosmetic personality that affects the agent's tone and emoji usage. Built-in options include kawaii, pirate, shakespeare, noir, uwu, hype, and more. Custom personalities can be defined in the personalities config section." },
      { key: "display.compact", label: "Compact", type: "boolean", description: "When on, reduces output verbosity in the CLI — shorter tool previews, fewer decorations. Useful for small terminal windows." },
      { key: "display.streaming", label: "Streaming", type: "boolean", description: "Stream tokens to the terminal as they arrive instead of waiting for the full response. More responsive but can be noisy with tool calls." },
      { key: "display.show_reasoning", label: "Show reasoning", type: "boolean", description: "Display the model's chain-of-thought reasoning tokens in the output. Useful for debugging but very verbose." },
      { key: "display.show_cost", label: "Show cost", type: "boolean", hint: "$ in status bar", description: "Show estimated cost in the CLI status bar. Tracks input/output tokens and multiplies by the provider's pricing." },
      { key: "display.inline_diffs", label: "Inline diffs", type: "boolean", description: "Show inline diff previews for write actions (write_file, patch, skill_manage). When off, file writes happen silently without showing what changed." },
      { key: "display.bell_on_complete", label: "Bell on complete", type: "boolean", description: "Ring the terminal bell when a task finishes. Useful for long-running tasks when you've switched to another window." },
      { key: "display.resume_display", label: "Resume display", type: "select", options: ["full", "compact", "off"], description: "When resuming a session, how much history to show. 'full' replays the whole conversation. 'compact' shows a summary. 'off' starts with a blank screen." },
      { key: "display.busy_input_mode", label: "Busy input mode", type: "select", options: ["interrupt", "queue", "reject"], description: "What happens when you type while the agent is thinking. 'interrupt' stops the current generation. 'queue' buffers your input. 'reject' drops it." },
      { key: "display.skin", label: "Skin", type: "select", options: ["default", "minimal", "fancy"], description: "CLI appearance theme. Affects borders, colors, and decorative elements in the terminal output." },
      { key: "display.interim_assistant_messages", label: "Interim messages", type: "boolean", hint: "mid-turn status messages", description: "In gateway mode, show natural-language status updates mid-turn (e.g. 'Reading file…', 'Thinking…'). These appear as editable messages in Discord/Telegram. Turn off for cleaner chat." },
      { key: "display.tool_progress", label: "Tool progress", type: "text", hint: "all / off / errors", description: "Controls tool call visibility. 'all' shows every tool invocation. 'new' shows only the first call of each type. 'off' hides all tool progress. 'verbose' shows full tool arguments. Per-platform overrides available via display.platforms." },
      { key: "display.tool_preview_length", label: "Tool preview length", type: "number", min: 0, max: 10000, hint: "chars · 0 = unlimited", description: "Maximum characters shown for tool call previews (file paths, command strings). 0 means no limit — show everything. Lower values keep output compact." },
      { key: "display.background_process_notifications", label: "BG notifications", type: "text", hint: "all / off / errors", description: "Controls notifications for background processes. 'all' shows every event. 'errors' shows only failures. 'off' suppresses all background notifications." },
      { key: "human_delay.mode", label: "Human delay", type: "select", options: ["off", "fixed", "random"], hint: "simulate typing delay", description: "Adds artificial delay before responses to simulate human typing speed. 'natural' varies based on message length. 'custom' uses min_ms/max_ms bounds. Useful for messaging platforms where instant responses feel uncanny." },
      { key: "human_delay.min_ms", label: "Delay min ms", type: "number", min: 0, max: 10000, description: "Minimum response delay in milliseconds when human_delay is active. Higher values make the agent appear more thoughtful. Only applies when mode is 'custom' or 'natural'." },
      { key: "human_delay.max_ms", label: "Delay max ms", type: "number", min: 0, max: 10000, description: "Maximum response delay in milliseconds. The actual delay is randomized between min and max. Higher values add more variability." },
    ],
  },
  {
    id: "delegation",
    label: "Delegation",
    fields: [
      { key: "delegation.model", label: "Model", type: "text", hint: "subagent model · empty = inherit parent", description: "Override the model used by delegate_task subagents. Empty means subagents inherit the parent's model. Use a cheaper/faster model here to save cost on delegated subtasks. Precedence: base_url > provider > parent provider." },
      { key: "delegation.provider", label: "Provider", type: "text", hint: "subagent provider · empty = inherit", description: "Override the provider for subagents (e.g. 'openrouter', 'nous'). Empty means subagents use the same provider and credentials as the parent." },
      { key: "delegation.base_url", label: "Base URL", type: "text", description: "Direct OpenAI-compatible endpoint for subagents. Takes precedence over the provider setting. Use this to point subagents at a local model server." },
      { key: "delegation.max_iterations", label: "Max iterations", type: "number", min: 1, max: 500, hint: "per-subagent budget", description: "Turn limit for each subagent, independent of the parent's budget. Higher values let subagents work longer on complex subtasks. Lower values prevent runaway delegations." },
      { key: "delegation.reasoning_effort", label: "Reasoning effort", type: "select", options: ["", "xhigh", "high", "medium", "low", "minimal", "none"], hint: "empty = inherit", description: "Reasoning effort level for subagents. Empty means inherit the parent's level. Lower effort is cheaper and faster but may reduce quality on complex subtasks." },
      { key: "delegation.default_toolsets", label: "Default toolsets", type: "list", hint: "comma-separated", description: "Which tool categories subagents can use by default. Restricting this limits what delegated tasks can do (e.g. read-only subagents without terminal access)." },
    ],
  },
  {
    id: "memory",
    label: "Memory",
    fields: [
      { key: "memory.memory_enabled", label: "Memory enabled", type: "boolean", description: "Toggle the persistent memory system (MEMORY.md). When on, the agent learns and remembers facts across sessions. When off, every session starts with no memory context." },
      { key: "memory.user_profile_enabled", label: "User profile", type: "boolean", description: "Toggle user profile tracking (USER.md). When on, the agent builds a profile of the user's preferences and context. When off, the agent doesn't remember who you are across sessions." },
      { key: "memory.memory_char_limit", label: "Memory char limit", type: "number", min: 100, max: 10000, hint: "injected into system prompt", description: "Maximum characters from MEMORY.md injected into the system prompt. Higher values give the agent more context from past sessions but consume more of the context window (~800 tokens at default 2200 chars)." },
      { key: "memory.user_char_limit", label: "User char limit", type: "number", min: 100, max: 10000, description: "Maximum characters from USER.md injected into the system prompt. Same tradeoff as memory_char_limit — more context vs. more token usage (~500 tokens at default 1375 chars)." },
      { key: "memory.provider", label: "Provider", type: "text", hint: "holographic, mem0, etc. · empty = built-in", description: "External memory provider plugin. 'holographic' uses local SQLite FTS5 with trust scoring. 'mem0', 'hindsight', 'retaindb', 'byterover' are cloud options. Empty uses the built-in MEMORY.md/USER.md files only. Only one external provider can be active at a time." },
    ],
  },
  {
    id: "compression",
    label: "Compression",
    fields: [
      { key: "compression.enabled", label: "Enabled", type: "boolean", description: "Toggle context compression. When the conversation approaches the model's token limit, the agent summarizes older messages to free space. Disabling this means the session simply ends when the context fills up." },
      { key: "compression.threshold", label: "Threshold", type: "number", min: 0.1, max: 0.95, step: 0.05, hint: "ratio of context", description: "Compress when context usage exceeds this ratio of the model's limit. At 0.50, compression fires at 50% full. Higher values (0.75-0.85) give more working space before compression but risk hitting the hard limit during tool-heavy turns. Lower values compress more often, which is safer but loses more history. Requires restart." },
      { key: "compression.target_ratio", label: "Target ratio", type: "number", min: 0.1, max: 0.9, step: 0.05, hint: "of window after compaction", description: "After compression, how much of the threshold to preserve as the recent message tail. At 0.20, the newest 20% of messages are kept verbatim and the rest is summarized. Higher values preserve more recent context but compress less aggressively. Requires restart." },
      { key: "compression.protect_last_n", label: "Protect last N", type: "number", min: 0, max: 100, hint: "messages to keep uncompressed", description: "Minimum number of recent messages that are never summarized, regardless of the target_ratio. Acts as a safety floor — even if the ratio would summarize recent messages, this many are always kept verbatim." },
    ],
  },
  {
    id: "security",
    label: "Security",
    fields: [
      { key: "approvals.mode", label: "Approval mode", type: "select", options: ["manual", "smart", "off"], description: "'manual' prompts you for every dangerous command (CLI) or queues a pending request (messaging). 'smart' uses an auxiliary LLM to auto-approve low-risk commands and only prompts for high-risk ones — approved patterns persist for the session. 'off' skips all checks (equivalent to --yolo). Be very careful with 'off' in gateway mode." },
      { key: "approvals.non_interactive_policy", label: "Non-interactive", type: "select", options: ["guarded", "allow"], hint: "guarded (recommended)", description: "What happens when no human is available to approve (cron jobs, background sub-agents). 'guarded' falls through to the dangerous-pattern pipeline — with mode=smart this gives LLM-gated cron, with mode=manual this hard-denies flagged commands. 'allow' auto-approves everything (legacy behavior, not recommended for autonomous operation)." },
      { key: "approvals.timeout", label: "Approval timeout", type: "number", min: 10, max: 600, step: 10, hint: "seconds", description: "How long to wait for a human approval response before timing out. In messaging gateway mode, the approval request sits in the chat for this long. Longer timeouts give you more time to respond but block the agent longer." },
      { key: "security.redact_secrets", label: "Redact secrets", type: "boolean", hint: "mask API keys in logs", dangerous: true, description: "⚠ When on, API keys and secrets are masked in log output and dashboard responses. Turning this OFF exposes credentials in plaintext to anyone who can read logs or the dashboard. Keep this on unless you're debugging a specific auth issue." },
      { key: "security.tirith_enabled", label: "Tirith scanner", type: "boolean", description: "Enable Tirith pre-execution security scanning. Tirith analyzes commands before they run and blocks known-dangerous patterns. Disabling this removes a layer of defense against prompt injection attacks." },
      { key: "security.tirith_timeout", label: "Tirith timeout", type: "number", min: 1, max: 30, hint: "seconds", description: "How long to wait for Tirith to analyze a command. If the scan takes longer than this, behavior depends on tirith_fail_open. Higher values are safer (more time to detect threats) but slow down command execution." },
      { key: "security.tirith_fail_open", label: "Tirith fail open", type: "boolean", hint: "allow on scanner error", dangerous: true, description: "⚠ When on, commands are allowed if Tirith crashes or times out. When off, commands are blocked if Tirith fails. 'fail open' is the default for availability but means a Tirith outage disables the security scanner entirely." },
      { key: "privacy.redact_pii", label: "Redact PII", type: "boolean", hint: "hash user IDs, strip phone numbers", description: "Hash user IDs and strip phone numbers from the LLM context. Applies to WhatsApp, Signal, and Telegram. Discord and Slack are excluded because their mention systems require real user IDs." },
      { key: "browser.allow_private_urls", label: "Allow private URLs", type: "boolean", hint: "localhost, 192.168.x.x, etc.", dangerous: true, description: "⚠ SECURITY: Allow the browser tool to navigate to private/internal IP addresses (localhost, 192.168.x.x, 10.x.x.x, link-local). Off by default to prevent SSRF attacks where the agent could probe your internal network." },
    ],
  },
  {
    id: "browser",
    label: "Browser",
    fields: [
      { key: "browser.inactivity_timeout", label: "Inactivity timeout", type: "number", min: 10, max: 600, step: 10, hint: "seconds", description: "How long an idle browser session stays open before being automatically closed. Higher values keep the browser ready for follow-up commands but consume more memory. Lower values reclaim resources faster." },
      { key: "browser.command_timeout", label: "Command timeout", type: "number", min: 5, max: 120, step: 5, hint: "seconds", description: "Timeout for individual browser commands (navigate, screenshot, click, etc.). Pages that take longer than this to load or respond will fail. Increase for slow sites or heavy SPAs." },
      { key: "browser.record_sessions", label: "Record sessions", type: "boolean", hint: "save WebM videos", description: "Auto-record browser sessions as WebM video files saved to ~/.hermes/browser_recordings/. Useful for debugging and auditing what the agent did in the browser. Uses extra disk space." },
      { key: "browser.camofox.managed_persistence", label: "Camofox persistence", type: "boolean", description: "When on, sends a stable profile-scoped userId to Camofox so the server maps it to a persistent browser profile directory. Cookies, logins, and local storage persist across sessions. When off, each session gets a random ephemeral profile." },
    ],
  },
  {
    id: "voice",
    label: "Voice",
    fields: [
      { key: "voice.record_key", label: "Record key", type: "text", hint: "keyboard shortcut", description: "Push-to-talk keyboard shortcut for voice recording in CLI mode. Default is Ctrl+B. The key starts and stops recording." },
      { key: "voice.max_recording_seconds", label: "Max recording", type: "number", min: 10, max: 600, hint: "seconds", description: "Hard limit on recording duration. Recording stops automatically after this many seconds regardless of speech activity. Higher values allow longer voice messages." },
      { key: "voice.auto_tts", label: "Auto TTS", type: "boolean", hint: "read responses aloud", description: "Automatically speak responses aloud using the configured TTS provider when voice mode is active. When off, voice mode is input-only (speech-to-text) without spoken responses." },
      { key: "voice.silence_threshold", label: "Silence threshold", type: "number", min: 0, max: 1000, hint: "RMS level", description: "Audio RMS level (0-32767) below which is considered silence. Higher values make the detector more aggressive — it treats quieter sounds as silence. Lower values require near-total quiet. Increase if recording cuts off while you're speaking softly." },
      { key: "voice.silence_duration", label: "Silence duration", type: "number", min: 0.5, max: 10, step: 0.5, hint: "seconds before auto-stop", description: "How many seconds of continuous silence before recording auto-stops. Higher values tolerate longer pauses (good for thinking mid-sentence). Lower values end recording faster after you stop talking." },
    ],
  },
  {
    id: "tts",
    label: "Text-to-Speech",
    fields: [
      { key: "tts.provider", label: "Provider", type: "select", options: ["edge", "elevenlabs", "openai", "minimax", "mistral", "neutts"], hint: "edge = free", description: "Which TTS engine generates spoken audio. 'edge' is Microsoft's free service (~1s latency, 322 voices, 74 languages). 'elevenlabs' is premium quality. 'openai' uses GPT-4o voices. 'neutts' runs locally with no API key. Only the selected provider's sub-settings matter." },
      { key: "tts.edge.voice", label: "Edge voice", type: "text", hint: "e.g. en-US-AriaNeural", description: "Microsoft Edge TTS voice identifier. Popular options: AriaNeural, JennyNeural, AndrewNeural, BrianNeural, SoniaNeural. Supports 322 voices across 74 languages. Format: locale-VoiceName (e.g. en-US-AriaNeural)." },
      { key: "tts.elevenlabs.voice_id", label: "ElevenLabs voice", type: "text", description: "ElevenLabs voice ID. Find voice IDs in the ElevenLabs voice library. Default 'pNInz6obpgDQGcFmaJgB' is the Adam voice." },
      { key: "tts.elevenlabs.model_id", label: "ElevenLabs model", type: "text", description: "ElevenLabs model to use. 'eleven_multilingual_v2' supports many languages. Check ElevenLabs docs for available models and their capabilities." },
      { key: "tts.openai.model", label: "OpenAI model", type: "text", description: "OpenAI TTS model. 'gpt-4o-mini-tts' is the default. More expensive models may offer better quality." },
      { key: "tts.openai.voice", label: "OpenAI voice", type: "select", options: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"], description: "OpenAI voice character. Each has a distinct personality: alloy (neutral), echo (warm), fable (expressive), onyx (deep), nova (friendly), shimmer (clear)." },
      { key: "tts.mistral.model", label: "Mistral model", type: "text", description: "Mistral TTS model identifier. Default is 'voxtral-mini-tts-2603'." },
      { key: "tts.mistral.voice_id", label: "Mistral voice", type: "text", description: "Mistral voice UUID. Default is Paul (Neutral). Check Mistral's voice catalog for alternatives." },
      { key: "tts.neutts.ref_audio", label: "NeuTTS ref audio", type: "text", hint: "path to reference audio", description: "Path to a reference voice audio file for NeuTTS voice cloning. Empty uses the bundled default voice. The model will try to match the reference voice's characteristics." },
      { key: "tts.neutts.ref_text", label: "NeuTTS ref text", type: "text", description: "Path to the transcript of the reference audio. Helps NeuTTS align the voice clone. Empty uses the bundled default." },
      { key: "tts.neutts.model", label: "NeuTTS model", type: "text", description: "HuggingFace model repository for NeuTTS. Default is 'neuphonic/neutts-air-q4-gguf'. The model is downloaded on first use." },
      { key: "tts.neutts.device", label: "NeuTTS device", type: "select", options: ["cpu", "cuda", "mps"], description: "Hardware for NeuTTS inference. 'cpu' works everywhere but is slow. 'cuda' uses NVIDIA GPU. 'mps' uses Apple Silicon GPU. Requires restart." },
    ],
  },
  {
    id: "stt",
    label: "Speech-to-Text",
    fields: [
      { key: "stt.enabled", label: "Enabled", type: "boolean", description: "Toggle speech-to-text functionality. When off, voice recording is disabled entirely. The STT provider chain is local → groq → openai (falls back automatically if the primary fails)." },
      { key: "stt.provider", label: "Provider", type: "select", options: ["local", "groq", "openai", "mistral"], description: "'local' uses faster-whisper (free, offline, no API key). 'groq' is cloud-based and very fast. 'openai' uses the Whisper API (paid). 'mistral' uses Voxtral. Local is recommended for privacy; cloud providers are faster for large audio. Requires restart." },
      { key: "stt.local.model", label: "Local model", type: "select", options: ["tiny", "base", "small", "medium", "large-v3"], description: "Whisper model size for local STT. 'tiny' is fastest but least accurate. 'large-v3' is most accurate but uses significant RAM and is slower. 'base' is a good balance for English. 'medium' adds better multilingual support. Requires restart." },
      { key: "stt.local.language", label: "Language", type: "text", hint: "en, es, fr, etc. · empty = auto", description: "Force a specific language for speech recognition (ISO 639-1 code). Empty means auto-detect, which works well but is slightly slower. Setting the language explicitly improves accuracy and speed for that language." },
      { key: "stt.openai.model", label: "OpenAI model", type: "text", description: "OpenAI STT model. 'whisper-1' is the standard. 'gpt-4o-mini-transcribe' and 'gpt-4o-transcribe' are newer multimodal options with better accuracy." },
      { key: "stt.mistral.model", label: "Mistral model", type: "text", description: "Mistral STT model identifier. Default is 'voxtral-mini-latest'." },
    ],
  },
  {
    id: "logging",
    label: "Logging",
    fields: [
      { key: "logging.level", label: "Level", type: "select", options: ["DEBUG", "INFO", "WARNING"], description: "Minimum log level written to ~/.hermes/logs/agent.log. 'DEBUG' captures everything (very verbose, useful for diagnosing issues). 'INFO' captures normal operations. 'WARNING' only captures problems. errors.log always captures WARNING+ regardless of this setting." },
      { key: "logging.max_size_mb", label: "Max size", type: "number", min: 1, max: 100, hint: "MB per log file", description: "Maximum size per log file before rotation. When a log file exceeds this size, it's renamed to a backup and a fresh file starts. Higher values mean fewer rotations but larger files to search through." },
      { key: "logging.backup_count", label: "Backup count", type: "number", min: 0, max: 20, hint: "rotated files to keep", description: "Number of rotated log backups to keep. When the limit is reached, the oldest backup is deleted. Higher values preserve more history. 0 means no backups — old logs are discarded on rotation." },
    ],
  },
  {
    id: "discord",
    label: "Discord",
    fields: [
      { key: "discord.require_mention", label: "Require mention", type: "boolean", hint: "respond only to @mentions in channels", description: "When on, the bot only responds in server channels when @mentioned. DMs always work. When off, the bot responds to every message in every channel it can see — only disable this in private servers." },
      { key: "discord.auto_thread", label: "Auto thread", type: "boolean", hint: "create threads on @mention", description: "Automatically create a new thread when someone @mentions the bot in a channel. Keeps conversations organized and prevents channel spam. The thread title is derived from the first message." },
      { key: "discord.reactions", label: "Reactions", type: "boolean", hint: "add processing emoji reactions", description: "Add emoji reactions during message processing: 👀 when reading, ✅ on success, ❌ on error. Gives visual feedback that the bot is working on a response." },
      { key: "discord.free_response_channels", label: "Free response channels", type: "text", hint: "comma-separated channel IDs", description: "Channel IDs where the bot responds to all messages without requiring an @mention. Useful for dedicated bot channels. Comma-separated. Overrides require_mention for these specific channels." },
      { key: "discord.allowed_channels", label: "Allowed channels", type: "text", hint: "whitelist · comma-separated IDs", description: "When set, the bot ONLY responds in these channel IDs (whitelist). All other channels are ignored. Empty means the bot can respond in any channel (subject to require_mention). Use this to restrict the bot to specific channels." },
    ],
  },
  {
    id: "auxiliary",
    label: "Auxiliary",
    fields: (() => {
      const svcDesc: Record<string, string> = {
        vision: "Image analysis — used when the agent needs to understand screenshots, diagrams, or photos",
        web_extract: "Web page summarization — used when the agent reads a URL and needs to extract content",
        compression: "Context compression — the LLM that summarizes old messages when the context window fills up",
        session_search: "Session search — used when the agent searches across past conversation history",
        skills_hub: "Skills hub — used for skill discovery and matching when the agent looks for relevant skills",
        approval: "Approval classifier — the auxiliary LLM that auto-classifies command risk in 'smart' approval mode",
        mcp: "MCP tool dispatch — used when the agent needs help interpreting MCP tool results",
        flush_memories: "Memory flush — the LLM that curates and compresses memories for long-term storage",
      };
      const services = [
        "vision", "web_extract", "compression", "session_search",
        "skills_hub", "approval", "mcp", "flush_memories",
      ];
      const fields: FieldDef[] = [];
      for (const svc of services) {
        const desc = svcDesc[svc] ?? svc;
        fields.push(
          { key: `auxiliary.${svc}.provider`, label: `${svc} provider`, type: "text", hint: "auto / openrouter / nous / custom", description: `Provider for ${svc} tasks. ${desc}. 'auto' picks the best available provider automatically. Set to a specific provider name to pin it. All auxiliary tasks fall back to openrouter:google/gemini-3-flash-preview if the configured provider is unavailable.` },
          { key: `auxiliary.${svc}.model`, label: `${svc} model`, type: "text", description: `Model for ${svc} tasks. Empty uses the provider's default auxiliary model. Use a fast/cheap model for cost savings, or a more capable model for better quality. ${svc === "approval" ? "Fast models recommended (gemini-flash, haiku) since approval classification is simple." : ""}` },
          { key: `auxiliary.${svc}.base_url`, label: `${svc} base URL`, type: "text", description: `Direct OpenAI-compatible endpoint for ${svc} tasks. Takes precedence over the provider setting. Use this to point at a local model server for this specific task.` },
          { key: `auxiliary.${svc}.timeout`, label: `${svc} timeout`, type: "number", min: 5, max: 600, hint: "seconds", description: `LLM API call timeout for ${svc} tasks. ${svc === "web_extract" ? "Default is 360s (6 min) — web pages can be large and summarization is slow on local models." : svc === "vision" ? "Default is 120s — vision payloads are large and need generous timeout." : svc === "compression" ? "Default is 120s — compression summarizes large contexts." : "Default is 30s."} Increase if you're using a slow local model.` },
        );
      }
      return fields;
    })(),
  },
  {
    id: "code_execution",
    label: "Code Execution",
    fields: [
      { key: "code_execution.timeout", label: "Timeout", type: "number", min: 10, max: 3600, step: 10, hint: "seconds", description: "Maximum execution time for a single tool call (shell command, code execution). Commands exceeding this are killed. Higher values allow long builds and data processing. Lower values catch runaway commands faster." },
      { key: "code_execution.max_tool_calls", label: "Max tool calls", type: "number", min: 1, max: 200, hint: "per session", description: "Maximum number of tool calls allowed per session. Acts as a safety cap on autonomous work — prevents the agent from making unlimited tool calls. Budget pressure warnings appear at 70% and 90% of this limit. Requires restart." },
      { key: "code_execution.max_tool_output", label: "Max tool output", type: "number", min: 500, max: 20000, step: 100, hint: "tokens per call", description: "Truncates individual tool results to this many tokens. Forces the LLM into chunked reads via offset/limit instead of one greedy read that fills the context. Higher values give more context per call but risk compression storms. 4000 is the recommended default. Requires restart." },
    ],
  },
  {
    id: "cron",
    label: "Scheduling",
    fields: [
      { key: "cron.wrap_response", label: "Wrap response", type: "boolean", hint: "add header/footer to cron output", description: "When on, cron job outputs are wrapped with a header (task name) and footer ('The agent cannot see this message'). When off, the raw agent response is delivered as-is — cleaner output but no context about which job produced it." },
      { key: "cron.timezone", label: "Timezone", type: "text", hint: "IANA format · empty = server local", placeholder: "America/Chicago", description: "IANA timezone for cron schedule evaluation (e.g. 'America/Chicago', 'Europe/London'). Empty means the server's local timezone. Affects when scheduled jobs fire — a '0 6 * * *' job fires at 6 AM in this timezone." },
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const notify = useNotify();

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

  const handleExport = useCallback(() => {
    if (!cfg.data?.config) return;
    const blob = new Blob(
      [JSON.stringify(cfg.data.config, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hermes-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [cfg.data]);

  const handleImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      // Reset the input so the same file can be re-selected
      e.target.value = "";
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          notify.error("Invalid config: expected a JSON object");
          return;
        }
        if (!window.confirm("Import this config? Current config will be backed up first.")) return;
        // Flatten the config into dot-notation mutations
        const mutations: Record<string, unknown> = {};
        const flatten = (obj: Record<string, unknown>, prefix = "") => {
          for (const [k, v] of Object.entries(obj)) {
            const key = prefix ? `${prefix}.${k}` : k;
            if (v !== null && typeof v === "object" && !Array.isArray(v)) {
              flatten(v as Record<string, unknown>, key);
            } else {
              mutations[key] = v;
            }
          }
        };
        flatten(parsed);
        await api.putConfig(mutations);
        notify.success("Config imported");
        cfg.refetch();
        backups.refetch();
      } catch (err) {
        notify.error(`Import failed: ${(err as Error).message}`);
      }
    },
    [cfg, backups, notify],
  );

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
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleExport}
            disabled={!cfg.data?.config}
            className="font-mono text-[10px] uppercase tracking-marker text-ink-muted transition-colors duration-120 ease-operator hover:text-oxide disabled:opacity-40"
          >
            EXPORT
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="font-mono text-[10px] uppercase tracking-marker text-ink-muted transition-colors duration-120 ease-operator hover:text-oxide"
          >
            IMPORT
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
        </div>
      </div>

      {/* ── main layout: content + sidebar ── */}
      <div className="flex min-h-0">
        {/* ── content pane ── */}
        <div ref={contentRef} className="flex-1 overflow-y-auto">
          {/* stamp */}
          <div className="px-10 pb-6 pt-9">
            <h1 className="page-stamp">
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
  const description = def.description;

  switch (def.type) {
    case "boolean":
      return (
        <Field label={label} hint={hint} description={description}>
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
        <Field label={label} hint={hint} description={description}>
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
          description={description}
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
        <Field label={label} hint={hint} description={description}>
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
  description,
  invalid,
  children,
}: {
  label: string;
  hint?: string;
  description?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="grid grid-cols-[160px_1fr] items-start gap-3 pt-1">
      <span
        className={cn(
          "flex items-center gap-1.5 pt-2 font-mono text-[10px] uppercase tracking-marker",
          invalid ? "text-danger" : "text-ink-muted",
        )}
      >
        {label}
        {description && <InfoTip text={description} />}
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

function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="relative inline-flex cursor-help"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span className="inline-flex size-3.5 items-center justify-center rounded-full border border-rule text-[8px] leading-none text-ink-faint transition-colors hover:border-oxide hover:text-oxide">
        ?
      </span>
      {open && (
        <span className="absolute bottom-full left-0 z-50 mb-2 w-72 border border-rule bg-bg-alt px-3 py-2 font-mono text-[10px] normal-case leading-relaxed tracking-normal text-ink shadow-sm">
          {text}
        </span>
      )}
    </span>
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
          ? "Leroys will no longer be able to read/write files under this path."
          : "This path will no longer be blocked. Leroys will be able to access it.",
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
          Leroys can read and write files under these directories.
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
