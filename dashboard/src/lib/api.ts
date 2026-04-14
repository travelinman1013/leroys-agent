/**
 * Hermes Dashboard API client.
 *
 * - Bootstraps the bearer token via /api/dashboard/handshake on first call
 * - Caches the token in sessionStorage (nuked on tab close — lower exposure
 *   than localStorage)
 * - Every subsequent fetch/SSE adds `Authorization: Bearer <token>`
 * - SSE uses the native EventSource with a bearer query param workaround
 *   (EventSource cannot set headers, so we pass the token as a query arg
 *   and the server's auth check also accepts `?token=...`). For now we rely
 *   on the fact that the dashboard runs on the same origin and the token
 *   was already obtained via handshake over HTTP where headers work.
 */

export type HermesEvent = {
  type: string;
  ts: string;
  session_id: string | null;
  data: Record<string, unknown>;
};

export type DashboardState = {
  gateway: {
    started_at: number;
    uptime_seconds: number;
    host: string;
    port: number;
    sandboxed: boolean;
  };
  model: string | null;
  active_sessions: Array<Record<string, unknown>>;
  pending_approvals: PendingApproval[];
  cron_jobs: Array<Record<string, unknown>>;
  event_bus: { subscribers: number; recent_buffer: number };
};

export type WorkflowRun = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  trigger_type: string;
  trigger_meta: Record<string, unknown> | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  error: string | null;
  result_summary: string | null;
  step_count?: number;
  checkpoints?: WorkflowCheckpoint[];
};

export type WorkflowCheckpoint = {
  id: number;
  run_id: string;
  step_name: string;
  step_index: number;
  status: string;
  started_at: number | null;
  ended_at: number | null;
  output_summary: string | null;
  error: string | null;
};

export type WorkflowCatalogEntry = {
  id: string;
  name: string;
  trigger_type: string;
  trigger_meta: Record<string, unknown>;
  steps: { index: number; name: string; timeout_s: number; skip_on_error: boolean }[];
  step_count: number;
};

export type PendingApproval = {
  session_key: string;
  command: string;
  pattern_key: string;
  description: string;
  queued_at: number | null;
};

export type SessionListRow = {
  id: string;
  source: string;
  model: string | null;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  message_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  preview: string;
  last_active: number;
  // Phase 8a status enrichment
  status?: "running" | "idle" | "ended";
  running_since?: number;
  session_key?: string;
};

export type SpawnSessionResponse = {
  session_id: string;
  session_key: string | null;
  status: "spawning";
};

const TOKEN_KEY = "hermes.dashboard.token";

export function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* sessionStorage unavailable (private mode, etc.) — silently accept */
  }
}

export function clearStoredToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function doHandshake(): Promise<string> {
  const resp = await fetch("/api/dashboard/handshake", {
    method: "GET",
    credentials: "same-origin",
  });
  if (!resp.ok) {
    throw new Error(`Handshake failed: ${resp.status} ${resp.statusText}`);
  }
  const data = await resp.json();
  if (typeof data.token !== "string" || !data.token) {
    throw new Error("Handshake returned invalid token");
  }
  storeToken(data.token);
  return data.token;
}

export async function ensureToken(): Promise<string> {
  const cached = getStoredToken();
  if (cached) return cached;
  return doHandshake();
}

/**
 * Authenticated fetch helper. Bootstraps the token on first call and retries
 * once with a fresh token on 401 (token rotation).
 */
export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let token = await ensureToken();
  let resp = await fetch(path, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      "Content-Type":
        init.body && !(init.body instanceof FormData)
          ? "application/json"
          : (init.headers as Record<string, string>)?.["Content-Type"] ?? "application/json",
    },
    credentials: "same-origin",
  });

  if (resp.status === 401) {
    clearStoredToken();
    token = await doHandshake();
    resp = await fetch(path, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      credentials: "same-origin",
    });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}: ${text || path}`);
  }

  if (resp.headers.get("Content-Type")?.includes("application/json")) {
    return (await resp.json()) as T;
  }
  return (await resp.text()) as unknown as T;
}

// --------------------------------------------------------------------------
// Typed endpoint shortcuts
// --------------------------------------------------------------------------

export const api = {
  handshake: () =>
    apiFetch<{
      token: string;
      version: string;
      started_at: number;
      host: string;
      port: number;
    }>("/api/dashboard/handshake"),

  state: () => apiFetch<DashboardState>("/api/dashboard/state"),

  sessions: (opts: { limit?: number; offset?: number; source?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    if (opts.source) params.set("source", opts.source);
    const qs = params.toString();
    return apiFetch<{
      sessions: SessionListRow[];
      limit: number;
      offset: number;
    }>(`/api/dashboard/sessions${qs ? `?${qs}` : ""}`);
  },

  sessionDetail: (id: string) =>
    apiFetch<{
      session: Record<string, unknown>;
      messages: Array<Record<string, unknown>>;
    }>(`/api/dashboard/sessions/${encodeURIComponent(id)}`),

  sessionEvents: (id: string, limit = 200) =>
    apiFetch<{ events: HermesEvent[] }>(
      `/api/dashboard/sessions/${encodeURIComponent(id)}/events?limit=${limit}`,
    ),

  recentEvents: (limit = 100) =>
    apiFetch<{ events: HermesEvent[] }>(`/api/dashboard/recent?limit=${limit}`),

  approvals: () =>
    apiFetch<{ pending: PendingApproval[] }>("/api/dashboard/approvals"),

  resolveApproval: (
    sessionKey: string,
    choice: "accept" | "ignore" | "once" | "session" | "always" | "deny",
    resolveAll = false,
  ) =>
    apiFetch<{ resolved: number; choice: string }>(
      `/api/dashboard/approvals/${encodeURIComponent(sessionKey)}`,
      {
        method: "POST",
        body: JSON.stringify({ choice, resolve_all: resolveAll }),
      },
    ),

  tools: () =>
    apiFetch<{
      tools: Array<{ name: string; toolset: string | null }>;
      toolsets: Record<string, unknown>;
    }>("/api/dashboard/tools"),

  skills: () =>
    apiFetch<{
      categories: Array<{
        name: string;
        description: string | null;
        skills: Array<{
          name: string;
          description: string;
          tags: string[];
          enabled: boolean;
        }>;
        skill_count: number;
        enabled_count: number;
      }>;
      total_skills: number;
      total_enabled: number;
    }>("/api/dashboard/skills"),

  skillToggle: (name: string, enabled: boolean) =>
    apiFetch<{ name: string; enabled: boolean }>(
      `/api/dashboard/skills/${encodeURIComponent(name)}/toggle`,
      { method: "POST", body: JSON.stringify({ enabled }) },
    ),

  mcp: () =>
    apiFetch<{
      servers: Array<{
        name: string;
        command: string | null;
        enabled: boolean;
        env_keys: string[];
      }>;
    }>("/api/dashboard/mcp"),

  doctor: () =>
    apiFetch<{
      checks: Array<{ name: string; ok: boolean; detail: string | null }>;
    }>("/api/dashboard/doctor"),

  config: () =>
    apiFetch<{ config: Record<string, unknown> }>("/api/dashboard/config"),

  cronJobs: () => apiFetch<{ jobs: Array<Record<string, unknown>> }>("/api/jobs"),

  createJob: (body: {
    name: string;
    schedule: string;
    prompt: string;
    deliver?: string;
    skills?: string[];
    repeat?: number;
    workflow?: string;
  }) =>
    apiFetch<{ job: Record<string, unknown> }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteJob: (id: string) =>
    apiFetch<{ deleted: boolean }>(`/api/jobs/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  pauseJob: (id: string) =>
    apiFetch<{ job: Record<string, unknown> }>(
      `/api/jobs/${encodeURIComponent(id)}/pause`,
      { method: "POST" },
    ),

  resumeJob: (id: string) =>
    apiFetch<{ job: Record<string, unknown> }>(
      `/api/jobs/${encodeURIComponent(id)}/resume`,
      { method: "POST" },
    ),

  runJob: (id: string) =>
    apiFetch<{ ok: boolean }>(
      `/api/jobs/${encodeURIComponent(id)}/run`,
      { method: "POST" },
    ),

  // Brain visualization (Wave-2 R3 of stateful-noodling-reddy plan)
  brainGraph: () => apiFetch<BrainGraph>("/api/dashboard/brain/graph"),

  brainNode: (type: BrainNodeType, id: string) =>
    apiFetch<{ node: BrainNode }>(
      `/api/dashboard/brain/node/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    ),

  // F1 — Session Control Plane (Dashboard v2)
  searchSessions: (opts: {
    q?: string;
    source?: string;
    from?: number;
    to?: number;
    limit?: number;
    offset?: number;
  } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", opts.q);
    if (opts.source) params.set("source", opts.source);
    if (opts.from !== undefined) params.set("from", String(opts.from));
    if (opts.to !== undefined) params.set("to", String(opts.to));
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return apiFetch<{ sessions: SessionListRow[]; limit: number; offset: number }>(
      `/api/dashboard/sessions/search${qs ? `?${qs}` : ""}`,
    );
  },

  deleteSession: (id: string) =>
    apiFetch<{ deleted: boolean; id: string }>(
      `/api/dashboard/sessions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  exportSessionUrl: (id: string, format: "json" | "md" = "json") =>
    `/api/dashboard/sessions/${encodeURIComponent(id)}/export?format=${format}`,

  /** Fetch session export with auth and trigger browser download. */
  async downloadSession(id: string, format: "json" | "md" = "json") {
    const token = await ensureToken();
    const resp = await fetch(
      `/api/dashboard/sessions/${encodeURIComponent(id)}/export?format=${format}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${id.slice(0, 8)}.${format === "md" ? "md" : "json"}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  forkSession: (id: string, body: { up_to_turn?: number; title?: string }) =>
    apiFetch<{ id: string; parent_id: string }>(
      `/api/dashboard/sessions/${encodeURIComponent(id)}/fork`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  injectMessage: (id: string, body: { content: string; role?: "user" | "system" }) =>
    apiFetch<{ id: string; message_id: number }>(
      `/api/dashboard/sessions/${encodeURIComponent(id)}/inject`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  reopenSession: (id: string) =>
    apiFetch<{ id: string; reopened: boolean }>(
      `/api/dashboard/sessions/${encodeURIComponent(id)}/reopen`,
      { method: "POST" },
    ),

  bulkSessions: (body: { ids: string[]; action: "delete" | "export" }) =>
    apiFetch<{
      results: Array<{ id: string; ok: boolean; error?: string; message_count?: number }>;
      action: string;
    }>("/api/dashboard/sessions/bulk", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // F2 — Brain/Memory Editor
  addMemory: (body: { store: "MEMORY.md" | "USER.md"; content: string }) =>
    apiFetch<{ ok: boolean }>("/api/dashboard/brain/memory", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  replaceMemory: (
    hash: string,
    store: "MEMORY.md" | "USER.md",
    content: string,
  ) =>
    apiFetch<{ ok: boolean }>(
      `/api/dashboard/brain/memory/${encodeURIComponent(hash)}?store=${encodeURIComponent(store)}`,
      { method: "PUT", body: JSON.stringify({ content }) },
    ),

  deleteMemory: (hash: string, store: "MEMORY.md" | "USER.md") =>
    apiFetch<{ ok: boolean }>(
      `/api/dashboard/brain/memory/${encodeURIComponent(hash)}?store=${encodeURIComponent(store)}`,
      { method: "DELETE" },
    ),

  exportMemory: (store: "MEMORY.md" | "USER.md" | "both" = "both") =>
    apiFetch<Record<string, { raw: string; entries: string[] }>>(
      `/api/dashboard/brain/export?store=${encodeURIComponent(store)}`,
    ),

  importMemory: (body: {
    store: "MEMORY.md" | "USER.md";
    raw_content: string;
    mode?: "replace" | "append";
  }) =>
    apiFetch<{ ok: boolean }>("/api/dashboard/brain/import", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Phase 6 — Brain content API
  brainSources: () =>
    apiFetch<BrainSource[]>("/api/dashboard/brain/sources"),

  brainTree: (source: string, path?: string) => {
    const params = new URLSearchParams({ source });
    if (path) params.set("path", path);
    return apiFetch<BrainTreeNode>(
      `/api/dashboard/brain/tree?${params}`,
    );
  },

  brainDoc: (source: string, path: string) =>
    apiFetch<BrainDoc>(
      `/api/dashboard/brain/doc?${new URLSearchParams({ source, path })}`,
    ),

  brainSearch: (q: string, source: string = "*", limit: number = 50) =>
    apiFetch<{ results: BrainSearchHit[]; partial?: boolean }>(
      `/api/dashboard/brain/search?${new URLSearchParams({ q, source, limit: String(limit) })}`,
    ),

  brainTimeline: (since?: string, limit: number = 100) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (since) params.set("since", since);
    return apiFetch<BrainTimelineEntry[]>(
      `/api/dashboard/brain/timeline?${params}`,
    );
  },

  brainDocWrite: (body: {
    source: string;
    path: string;
    content: string;
    expected_hash?: string;
  }) =>
    apiFetch<BrainDocWriteResult>("/api/dashboard/brain/doc", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // F3 — Live Console v2 + Approval Command Center
  searchEvents: (opts: {
    types?: string[];
    q?: string;
    session?: string;
    from?: number;
    to?: number;
    limit?: number;
  } = {}) => {
    const params = new URLSearchParams();
    if (opts.types?.length) params.set("types", opts.types.join(","));
    if (opts.q) params.set("q", opts.q);
    if (opts.session) params.set("session", opts.session);
    if (opts.from !== undefined) params.set("from", String(opts.from));
    if (opts.to !== undefined) params.set("to", String(opts.to));
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return apiFetch<{ events: HermesEvent[]; count: number }>(
      `/api/dashboard/events/search${qs ? `?${qs}` : ""}`,
    );
  },

  exportEventsUrl: (opts: { types?: string[]; from?: number; to?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.types?.length) params.set("types", opts.types.join(","));
    if (opts.from !== undefined) params.set("from", String(opts.from));
    if (opts.to !== undefined) params.set("to", String(opts.to));
    const qs = params.toString();
    return `/api/dashboard/events/export${qs ? `?${qs}` : ""}`;
  },

  approvalsHistory: (opts: {
    limit?: number;
    offset?: number;
    pattern?: string;
    session?: string;
    choice?: string;
    since?: number;
  } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    if (opts.pattern) params.set("pattern", opts.pattern);
    if (opts.session) params.set("session", opts.session);
    if (opts.choice) params.set("choice", opts.choice);
    if (opts.since !== undefined) params.set("since", String(opts.since));
    const qs = params.toString();
    return apiFetch<{
      rows: ApprovalHistoryRow[];
      limit: number;
      offset: number;
    }>(`/api/dashboard/approvals/history${qs ? `?${qs}` : ""}`);
  },

  approvalsStats: (window: "1h" | "24h" | "7d" | "30d" = "7d") =>
    apiFetch<{
      stats: Record<string, ApprovalStatEntry>;
      window: string;
      since: number;
    }>(`/api/dashboard/approvals/stats?window=${window}`),

  bulkResolveApprovals: (
    sessionKeys: string[],
    choice: "once" | "session" | "always" | "deny" | "accept" | "ignore",
  ) =>
    apiFetch<{
      results: Array<{ session_key: string; ok: boolean; resolved?: number; error?: string }>;
      choice: string;
    }>("/api/dashboard/approvals/bulk", {
      method: "POST",
      body: JSON.stringify({ session_keys: sessionKeys, choice }),
    }),

  // F4 — Interactive Ops
  parseCronSchedule: (expr: string) =>
    apiFetch<{ parsed: Record<string, unknown> }>(
      `/api/dashboard/jobs/parse-schedule?expr=${encodeURIComponent(expr)}`,
    ),

  cronDryRun: (body: {
    prompt: string;
    schedule: string;
    deliver?: string;
    skill?: string;
  }) =>
    apiFetch<{ spec: Record<string, unknown>; persisted: boolean }>(
      "/api/dashboard/jobs/dry-run",
      { method: "POST", body: JSON.stringify(body) },
    ),

  toggleTool: (name: string, platform: string, enabled: boolean) =>
    apiFetch<{ applied: string[]; restart_required: string[] }>(
      `/api/dashboard/tools/${encodeURIComponent(name)}/toggle`,
      { method: "POST", body: JSON.stringify({ platform, enabled }) },
    ),

  toolSchema: (name: string) =>
    apiFetch<{ name: string; spec: Record<string, unknown> }>(
      `/api/dashboard/tools/${encodeURIComponent(name)}/schema`,
    ),

  invokeTool: (name: string, args: Record<string, unknown>, sessionId?: string) =>
    apiFetch<{
      result?: string;
      tool?: string;
      needs_approval?: boolean;
      pattern_key?: string;
      description?: string;
      command?: string;
    }>(
      `/api/dashboard/tools/${encodeURIComponent(name)}/invoke`,
      {
        method: "POST",
        body: JSON.stringify({ args, session_id: sessionId }),
      },
    ),

  reloadSkill: (name: string) =>
    apiFetch<{ reloaded: boolean; name: string }>(
      `/api/dashboard/skills/${encodeURIComponent(name)}/reload`,
      { method: "POST" },
    ),

  skillFull: (name: string) =>
    apiFetch<{ name: string; content: string }>(
      `/api/dashboard/skills/${encodeURIComponent(name)}/full`,
    ),

  toggleMcp: (name: string, enabled: boolean) =>
    apiFetch<{ applied: string[]; restart_required: string[] }>(
      `/api/dashboard/mcp/${encodeURIComponent(name)}/toggle`,
      { method: "POST", body: JSON.stringify({ enabled }) },
    ),

  mcpHealth: (name: string) =>
    apiFetch<{
      name: string;
      configured: boolean;
      enabled: boolean;
      command: string | null;
    }>(`/api/dashboard/mcp/${encodeURIComponent(name)}/health`),

  // F5 — Telemetry + Safe Config Editor
  metricsTokens: (window: "1h" | "24h" | "7d" | "30d" = "24h") =>
    apiFetch<{
      buckets: Array<{ ts: number; input: number; output: number }>;
      total: { input: number; output: number };
      bucket_seconds: number;
    }>(`/api/dashboard/metrics/tokens?window=${window}`),

  metricsLatency: (
    window: "1h" | "24h" | "7d" | "30d" = "24h",
    groupBy: "tool" | "session" = "tool",
  ) =>
    apiFetch<{
      groups: Record<
        string,
        { count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }
      >;
      group_by: string;
    }>(`/api/dashboard/metrics/latency?window=${window}&group_by=${groupBy}`),

  metricsCompression: (window: "1h" | "24h" | "7d" | "30d" = "24h") =>
    apiFetch<{
      events: Array<{
        ts: number | null;
        session_id: string | null;
        tokens_before: number | null;
        tokens_after: number | null;
        n_messages_before: number | null;
        n_messages_after: number | null;
      }>;
      count: number;
    }>(`/api/dashboard/metrics/compression?window=${window}`),

  metricsErrors: (window: "1h" | "24h" | "7d" | "30d" = "24h") =>
    apiFetch<{
      per_tool: Record<string, { total: number; errors: number; error_rate: number }>;
    }>(`/api/dashboard/metrics/errors?window=${window}`),

  metricsContext: () =>
    apiFetch<{
      latest: {
        ts: string;
        session_id: string | null;
        model: string | null;
        input_tokens: number | null;
        output_tokens: number | null;
        total_tokens: number | null;
        latency_ms: number | null;
      } | null;
    }>("/api/dashboard/metrics/context"),

  putConfig: (mutations: Record<string, unknown>) =>
    apiFetch<{ applied: string[]; restart_required: string[]; backup: string | null }>(
      "/api/dashboard/config",
      { method: "PUT", body: JSON.stringify({ mutations }) },
    ),

  configBackups: () =>
    apiFetch<{
      backups: Array<{ filename: string; path: string; ts: number; size: number }>;
    }>("/api/dashboard/config/backups"),

  rollbackConfig: (filename: string) =>
    apiFetch<{ restored: string; backup: string | null }>(
      "/api/dashboard/config/rollback",
      { method: "POST", body: JSON.stringify({ to: filename }) },
    ),

  gatewayInfo: () =>
    apiFetch<{
      pid: number;
      uptime_seconds: number;
      host: string;
      port: number;
      max_rss?: number;
    }>("/api/dashboard/gateway/info"),

  gatewayRestartCommand: () =>
    apiFetch<{ command: string; note: string }>("/api/dashboard/gateway/restart-command"),

  gatewayRestart: () =>
    apiFetch<{ restarting: boolean }>("/api/dashboard/gateway/restart", {
      method: "POST",
    }),

  // Security — path jail
  securityPaths: () =>
    apiFetch<{
      safe_roots: string[];
      denied_paths: string[];
      removal_blocklist: string[];
    }>("/api/dashboard/security/paths"),

  securityPathMutate: (body: {
    action: "add" | "remove";
    target: "safe_roots" | "denied_paths";
    path: string;
  }) =>
    apiFetch<{
      ok: boolean;
      action: string;
      target: string;
      path: string;
      restart_required: boolean;
    }>("/api/dashboard/security/paths", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Phase 8a: Session control plane
  spawnSession: (body: { message: string; title?: string; timeout_seconds?: number; budget_usd?: number }) =>
    apiFetch<SpawnSessionResponse>("/api/dashboard/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  costSummary: () =>
    apiFetch<{ today_usd: number; week_usd: number; threshold_usd: number; above_threshold: boolean }>(
      "/api/dashboard/cost/summary",
    ),

  killSession: (id: string, reason?: string) =>
    apiFetch<{ session_id: string; killed: boolean; was_running: boolean }>(
      `/api/dashboard/sessions/${encodeURIComponent(id)}/kill`,
      { method: "POST", body: JSON.stringify({ reason: reason ?? "dashboard_kill" }) },
    ),

  // Phase 7: Workflow inspectability
  workflowRuns: (opts: { limit?: number; offset?: number; status?: string; workflow_id?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.offset) params.set("offset", String(opts.offset));
    if (opts.status) params.set("status", opts.status);
    if (opts.workflow_id) params.set("workflow_id", opts.workflow_id);
    const qs = params.toString();
    return apiFetch<{ runs: WorkflowRun[]; limit: number; offset: number }>(
      `/api/dashboard/workflows${qs ? `?${qs}` : ""}`,
    );
  },

  workflowRunDetail: (id: string) =>
    apiFetch<{ run: WorkflowRun }>(`/api/dashboard/workflows/${encodeURIComponent(id)}`),

  workflowCatalog: () =>
    apiFetch<{ catalog: WorkflowCatalogEntry[] }>("/api/dashboard/workflows/catalog"),
};

// --------------------------------------------------------------------------
// F3 types
// --------------------------------------------------------------------------

export interface ApprovalHistoryRow {
  id: number;
  session_id: string | null;
  command: string;
  pattern_key: string | null;
  description: string | null;
  choice: string;
  resolver: string;
  requested_at: number | null;
  resolved_at: number;
  wait_ms: number | null;
  reason: string | null;
}

export interface ApprovalStatEntry {
  count: number;
  approved: number;
  denied: number;
  deny_rate: number;
  avg_wait_ms: number;
}

// --------------------------------------------------------------------------
// Brain visualization types
// --------------------------------------------------------------------------

export type BrainNodeType =
  | "memory"
  | "session"
  | "skill"
  | "tool"
  | "mcp"
  | "cron";

export type BrainNode = {
  id: string;
  type: BrainNodeType;
  label: string;
  weight: number;
  metadata: Record<string, unknown>;
};

export type BrainEdge = {
  source: string;
  target: string;
  kind: string;
  weight: number;
};

export type BrainStats = {
  memory: number;
  session: number;
  skill: number;
  tool: number;
  mcp: number;
  cron: number;
  edges: number;
};

export type BrainGraph = {
  nodes: BrainNode[];
  edges: BrainEdge[];
  stats: BrainStats;
  generated_at: number;
};

// --------------------------------------------------------------------------
// Phase 6 — Brain content API types
// --------------------------------------------------------------------------

export type BrainSource = {
  id: string;
  label: string;
  count: number;
  root_path: string;
};

export type BrainTreeNode = {
  name: string;
  type: "dir" | "file" | "binary";
  path: string;
  children?: BrainTreeNode[];
  count?: number;
  last_modified?: number;
  size?: number;
  permission?: string;
};

export type BrainDoc = {
  body: string;
  frontmatter: Record<string, unknown>;
  backlinks: string[];
  path: string;
  size: number;
  last_modified: number;
  content_hash: string;
};

export type BrainSearchHit = {
  source: string;
  path: string;
  title: string;
  snippet: string;
  score: number;
  last_modified: number;
};

export type BrainTimelineEntry = {
  source: string;
  path: string;
  title: string;
  op: string;
  ts: number;
};

export type BrainDocWriteResult = {
  path: string;
  source: string;
  content_hash: string;
  size: number;
  written: boolean;
};

// --------------------------------------------------------------------------
// SSE event stream
// --------------------------------------------------------------------------

/**
 * Subscribe to /api/dashboard/events via the Fetch API (not EventSource,
 * because EventSource cannot set Authorization headers). Returns a cleanup
 * function that aborts the stream.
 */
export function subscribeEvents(
  onEvent: (event: HermesEvent) => void,
  opts: { replay?: number; onError?: (err: Error) => void } = {},
): () => void {
  const abort = new AbortController();
  let cancelled = false;

  const start = async () => {
    try {
      const token = await ensureToken();
      const replay = opts.replay ?? 50;
      const resp = await fetch(`/api/dashboard/events?replay=${replay}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
        },
        signal: abort.signal,
        credentials: "same-origin",
      });

      if (!resp.ok || !resp.body) {
        throw new Error(`SSE connection failed: ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Parse SSE frames (blank-line delimited)
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          // Each frame may have multiple lines — we only care about "data:"
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (payload) {
                try {
                  const event = JSON.parse(payload) as HermesEvent;
                  onEvent(event);
                } catch (err) {
                  /* malformed JSON line — ignore */
                }
              }
            }
          }
        }
      }
    } catch (err) {
      if (cancelled) return;
      if (opts.onError && err instanceof Error) opts.onError(err);
      // Auto-reconnect after a short delay
      if (!cancelled) {
        setTimeout(() => {
          if (!cancelled) void start();
        }, 2000);
      }
    }
  };

  void start();

  return () => {
    cancelled = true;
    abort.abort();
  };
}
