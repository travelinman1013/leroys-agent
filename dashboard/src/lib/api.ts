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
    apiFetch<{ skills: Array<{ name: string; path: string; preview?: string }> }>(
      "/api/dashboard/skills",
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
};

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
