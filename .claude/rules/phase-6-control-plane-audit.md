# Phase 6 R5 — Control-Plane Audit

## Purpose
Input document for Phase 7 workflow primitives recon and Phase 8a session
control plane. Maps what already ships in the repo so we reuse instead of rebuild.

## 1. Dashboard routes (`gateway/platforms/dashboard_routes.py`)

### Session endpoints currently shipped

| Method | Path | Handler | File:Line | Returns |
|--------|------|---------|-----------|---------|
| GET | `/api/dashboard/sessions` | `handle_sessions` | :426 | `{sessions: [...], limit, offset}` — paginated list via `SessionDB.list_sessions_rich` |
| GET | `/api/dashboard/sessions/search` | `handle_session_search` | :773 | `{sessions: [...], limit, offset}` — filtered by q, source, from/to unix ts |
| GET | `/api/dashboard/sessions/{id}` | `handle_session_detail` | :467 | `{session: {...}, messages: [...]}` — full transcript with redaction |
| GET | `/api/dashboard/sessions/{id}/events` | `handle_session_events` | :512 | `{events: [...]}` — events.ndjson filtered by session_id |
| GET | `/api/dashboard/sessions/{id}/export` | `handle_export_session` | :837 | JSON or Markdown download (Content-Disposition attachment) |
| DELETE | `/api/dashboard/sessions/{id}` | `handle_delete_session` | :813 | `{deleted: true, id}` — publishes `session.deleted` event |
| POST | `/api/dashboard/sessions/{id}/fork` | `handle_fork_session` | :880 | `{id: new_id, parent_id}` — deep-copies metadata + messages up to `up_to_turn` |
| POST | `/api/dashboard/sessions/{id}/inject` | `handle_inject_message` | :922 | `{id, message_id}` — appends user/system message, reopens ended sessions |
| POST | `/api/dashboard/sessions/{id}/reopen` | `handle_reopen_session` | :962 | `{id, reopened: true}` — clears ended_at/end_reason |
| POST | `/api/dashboard/sessions/bulk` | `handle_session_bulk` | :987 | `{results: [{id, ok, error?}], action}` — delete or export N sessions |

### Approval endpoints currently shipped

| Method | Path | Handler | File:Line | Returns |
|--------|------|---------|-----------|---------|
| GET | `/api/dashboard/approvals` | `handle_list_approvals` | :536 | `{pending: [...]}` — in-memory pending approvals snapshot |
| POST | `/api/dashboard/approvals/{session_key}` | `handle_resolve_approval` | :551 | `{resolved: n, choice}` — once/session/always/deny with LangGraph translation |
| GET | `/api/dashboard/approvals/history` | `handle_approvals_history` | :1570 | `{rows: [...], limit, offset}` — paginated from `approval_history` table |
| GET | `/api/dashboard/approvals/stats` | `handle_approvals_stats` | :1596 | `{stats: {...}, window, since}` — per-pattern aggregates from SQLite |
| POST | `/api/dashboard/approvals/bulk` | `handle_approvals_bulk` | :1610 | `{results: [...], choice}` — bulk resolve N pending approvals |

### SSE endpoints and event types

**SSE endpoint:** `GET /api/dashboard/events` (file:1825) — subscribes to `EventBus.subscribe()`, replays up to 500 recent events on connect, streams `text/event-stream` with `data: {json}\n\n` framing. Keepalive via `: connected\n\n` comment on connect.

**Event taxonomy flowing through SSE** (documented in `event_bus.py:27-48`):

- `session.started`, `session.ended` — session lifecycle
- `session.deleted`, `session.exported`, `session.forked`, `session.reopened`, `session.injected` — dashboard-originated session mutations (emitted by dashboard_routes handlers)
- `turn.started`, `turn.ended` — agent turn boundaries
- `tool.invoked`, `tool.completed` — tool dispatch lifecycle
- `llm.call` — LLM API call telemetry (tokens, latency, model)
- `approval.requested`, `approval.resolved` — approval gate flow
- `compaction` — context compression events
- `cron.fired` — cron tick lifecycle (started/completed/dry-run phases)
- `memory.added`, `memory.replaced`, `memory.removed` — brain-viz memory events
- `skill.installed`, `skill.removed`, `skill.reloaded` — skill lifecycle
- `mcp.connected`, `mcp.disconnected` — MCP server lifecycle

**Additional REST endpoints for event access:**
- `GET /api/dashboard/events/search` (file:1435) — filtered NDJSON query with type wildcards, free-text, session, time window
- `GET /api/dashboard/events/export` (file:1504) — streaming NDJSON download (50k cap)
- `GET /api/dashboard/recent` (file:749) — recent events from in-memory ring buffer

### What's missing for Phase 8a

- **POST `/api/dashboard/sessions` (spawn)** — not shipped. No route creates a new agent session from the dashboard. The existing `create_session` in SessionDB is only called by the agent runtime, not exposed as an HTTP endpoint.
- **POST `/api/dashboard/sessions/{id}/attach` (attach to live session)** — not shipped. No mechanism for the dashboard to observe or inject into a running agent loop in real-time beyond appending messages via `/inject`.
- **POST `/api/dashboard/sessions/{id}/message` (send message to running agent)** — not shipped. `/inject` appends to the DB but does NOT wake a running agent. There is no message-passing channel from dashboard to a live agent loop.
- **POST `/api/dashboard/sessions/{id}/kill` (terminate running session)** — not shipped. No route interrupts a running agent. The `handle_gateway_restart_command` (file:1147) returns a launchctl string for manual restart but does not kill individual sessions.
- **Extended row shape**: The `SessionListRow` type (api.ts:45-58) has `id, source, model, title, started_at, ended_at, message_count, input_tokens, output_tokens, estimated_cost_usd, preview, last_active`. Missing fields for Phase 8a: `origin` (platform+chat_id that spawned the session), `waiting_on` (what the session is blocked on — approval, tool, LLM), `workflow_id` (link to parent workflow run), `status` (running/paused/ended/failed).

## 2. Session frontend (`dashboard/src/routes/sessions.tsx`)

### Components and their shapes

- **`SessionsList`** (file:35) — top-level route component registered at `/sessions`. Renders either the list view or `<Outlet />` for the child `/sessions/$id` detail route (exclusive swap, not side-by-side).
- **`SessionFilters`** — imported from `@/components/SessionFilters`, controlled via `SessionFilterState` shape: `{q: string, source: string, fromDays: number}`. Drives `api.searchSessions()` when any filter is active, else `api.sessions()`.
- **`BulkActionsBar`** — imported from `@/components/BulkActionsBar`, props: `{selectedCount, onDelete, onExport, onClear}`.
- **`Th`** (file:362) — local table header helper with Operator's Desk styling (hairline borders, mono 10px uppercase tracking-marker).
- **Table columns**: checkbox, ID (8-char prefix), TITLE (wrapping), SRC, MODEL, MSGS, TOK, COST, LAST (relative time), ACTIONS (export link + delete button with glyphs).
- **Row shape consumed**: `{id, title, preview, source, model, message_count, input_tokens, output_tokens, estimated_cost_usd, last_active, started_at}`.

### Filters and bulk actions already shipped

**Filters:**
- Text search (`q`) — substring match against session title
- Source filter (`source`) — exact match dropdown
- Time range (`fromDays`) — 0 (all), 1, 7, 30 day windows

**Bulk actions:**
- Select all / individual checkboxes with `Set<string>` state
- Bulk delete — confirm dialog, calls `api.bulkSessions({ids, action: "delete"})`, reports ok/fail counts
- Bulk export — opens `api.exportSessionUrl(id, "json")` in new tab for each selected session

**Polling:** 15-second refetch interval.

### What /desk needs that /sessions doesn't have

- **Live status column** — sessions.tsx shows `last_active` (relative time of last message) but no live running/paused/waiting indicator. `/desk` needs a real-time status derived from SSE events.
- **Origin column** — no display of where the session was triggered from (discord, telegram, cron, cli). The `source` column exists but is just a string label; `/desk` needs platform + chat_id for click-to-jump.
- **Workflow grouping** — no concept of sessions belonging to a workflow. `/desk` needs `workflow_id` filtering and a hierarchical view (workflow > sessions).
- **Spawn action** — no "New Session" button. `/desk` needs a spawn dialog that creates a session with a selected model and prompt.
- **Kill action** — no way to stop a running session from the UI.
- **Attach/observe** — no live transcript streaming for a running session. The detail view (`/sessions/$id`) shows the DB snapshot, not a live feed.

## 3. Approvals frontend (`dashboard/src/routes/approvals.tsx`)

### ApprovalCard component contract

**File:** `dashboard/src/components/ApprovalCard.tsx`

**Props:** `{ approval: PendingApproval }` where `PendingApproval` = `{session_key: string, command: string, pattern_key: string, description: string, queued_at: number | null}`.

**Visual:** Hairline border card with oxide left rule (3px), mono lab label (`APPROVAL REQUIRED`), italic stamp headline, session key prefix (24 chars), relative queue time, command in `<pre>` block.

**Mutation:** Calls `api.resolveApproval(session_key, choice)` on button click, invalidates `["dashboard", "state"]` and `["dashboard", "approvals"]` query keys.

### Current action set (once/session/always/deny)

Four buttons in the LangGraph Agent Inbox shape:
- **Approve once** (`variant="default"`) — approve this specific command
- **Session** (`variant="secondary"`) — approve this pattern for the rest of the session
- **Always** (`variant="secondary"`) — approve this pattern permanently
- **Deny** (`variant="destructive"`) — block the command

The backend (file:576-577) also translates LangGraph schema: `accept` -> `once`, `ignore` -> `deny`. `edit` and `response` are rejected (dashboard doesn't support side-channel).

### Cross-surface parity considerations

- **Discord surface** uses `/approve` slash command with the same four choices (once/session/always/deny) routed through `resolve_gateway_approval`.
- **Bulk resolve** is dashboard-only (file:1610) — Discord has no bulk approve equivalent.
- **History + stats sidebar** is dashboard-only — no equivalent visibility in Discord.
- **Phase 8a consideration:** If workflows spawn sub-sessions that need approval, the approval card needs a `workflow_id` field so the operator can see which workflow is blocked. The `PendingApproval` shape currently has no workflow context — it only knows `session_key`.
- **Notification gap:** The dashboard polls at 3s intervals (file:29) and the SSE stream delivers `approval.requested` events, but there is no push notification (browser Notification API or sound) when a new approval arrives. Autonomous workflows that block on approval with no operator watching will stall silently.

## 4. Observability (`agent/otel.py` + `gateway/metrics.py`)

### Span coverage today

**File:** `agent/otel.py`

- **Tracer name:** `hermes.agent` version `0.8.0` (file:109)
- **Init:** `Traceloop.init(app_name="hermes-agent")` via OpenLLMetry SDK (file:94-98). Initialized once per process via `init_if_configured()`.
- **Span:** `start_tool_span(tool_name, session_id, tool_call_id)` (file:126) — creates `gen_ai.tool.invoke {tool_name}` spans following OpenTelemetry GenAI semantic conventions.
- **Attributes per span:**
  - `gen_ai.system` = `"hermes"`
  - `gen_ai.tool.name` = tool name
  - `gen_ai.tool.call.id` = tool call id
  - `hermes.session.id` = session id
- **LLM call spans:** Traceloop auto-instruments OpenAI client calls (no manual spans needed for LLM calls).
- **Not instrumented:** Compression events, cron ticks, approval gates, session lifecycle. These emit EventBus events but not OTel spans.

### Metric coverage today

**File:** `gateway/metrics.py` — `MetricsReader` class (file:82)

This is NOT a Prometheus/OTel metrics exporter. It is a read-side aggregator that walks `events.ndjson` and computes dashboard metrics on demand. Metric types:

| Metric | Method | Event type consumed | Output shape |
|--------|--------|-------------------|--------------|
| Token usage buckets | `tokens(window)` | `llm.call` | `{buckets: [{ts, input, output}], total: {input, output}}` |
| Latency percentiles | `latency(window, group_by)` | `tool.completed` | `{groups: {tool: {count, p50, p95, p99, max}}}` |
| Compression timeline | `compression(window)` | `compaction` (phase=completed) | `{events: [{ts, session_id, tokens_before, tokens_after, ...}]}` |
| Tool error rate | `errors(window)` | `tool.completed` (ok field) | `{per_tool: {tool: {total, errors, error_rate}}}` |
| Live context | `context()` | `llm.call` (tail-read) | `{latest: {ts, model, input/output/total_tokens, latency_ms}}` |

Windows supported: 1h, 24h, 7d, 30d. 30-second TTL cache keyed by `(metric_kind, window)`.

### What Phase 8a adds

- **Workflow-scoped spans:** `gen_ai.workflow.execute {workflow_name}` parent spans that group session spans.
- **Workflow metrics:** Workflow success/failure rate, avg duration, avg sessions per workflow, checkpoint count.
- **Session status span attributes:** `hermes.session.status` (running/paused/waiting/ended), `hermes.workflow.id`.
- **Approval wait time as a metric:** Currently only in `approval_history` SQLite table; not aggregated by MetricsReader. Phase 8a should add an `approval_wait` metric builder.
- **OTel export of EventBus events:** The event bus documents "later: otel exporter" as a consumer (event_bus.py:8) but this is not implemented. Phase 8a could bridge EventBus events to OTel spans for correlation.

## 5. Credentials (`tools/credential_files.py`)

### Current primitive shape

**Purpose:** Session-scoped registry of credential files for mounting into remote terminal backends (Docker, Modal, SSH). NOT a secrets vault — it maps host-side file paths to container mount points.

**Core API:**
- `register_credential_file(relative_path, container_base)` (file:55) — registers a single file relative to `HERMES_HOME`. Validates: rejects absolute paths, rejects path traversal via `realpath`, resolves symlinks. Returns True if file exists and was registered.
- `register_credential_files(entries, container_base)` (file:107) — bulk registration from skill frontmatter. Each entry is either a string or a dict with `path` key. Returns list of missing files.
- `get_credential_file_mounts()` (file:177) — returns `[{host_path, container_path}]` combining skill-registered and config-based files (`terminal.credential_files` in config.yaml).
- `get_skills_directory_mount()` (file:203) — mounts local + external skills directories. Sanitizes symlinks by creating temp copies.
- `get_cache_directory_mounts()` (file:354) — mounts cache/documents, cache/images, cache/audio, cache/screenshots.

**Security:** All paths must resolve inside `HERMES_HOME`. Symlinks in skills dirs are detected and replaced with sanitized copies. ContextVar isolation prevents cross-session bleed in the gateway.

### How Brave API key + GitHub webhook secret plug in (Phase 9a)

The `credential_files.py` module is designed for **file-based credentials** mounted into containers. For Phase 9a:

- **Brave API key** — typically a single env var (`BRAVE_API_KEY`). Does NOT need credential_files.py unless it is stored in a file at `~/.hermes/brave_api_key`. More likely path: add to `~/.hermes/.env` and rely on the existing `.env` loader (which is already pre-loaded by the sandbox wrapper before Seatbelt blocks `.env` reads).
- **GitHub webhook secret** — used for HMAC validation of incoming webhook payloads. Same pattern: store in `.env` as `GITHUB_WEBHOOK_SECRET`. The credential_files.py module would only be needed if the webhook handler runs in a Docker/Modal sandbox that needs the secret file-mounted.
- **Extension point:** If Phase 9a adds a webhook receiver that needs to validate payloads, the secret should go in `.env` (already supported) rather than extending credential_files.py. The file registry is for remote-backend credential passthrough, not local secret storage.

## 6. Scheduler (`cron/scheduler.py`)

### Trigger types supported today (cron, one-shot)

**Cron expressions:** Standard 5-field cron syntax parsed by `cron/jobs.py:parse_schedule`. The scheduler's `tick()` function (file:868) runs every 60 seconds from a gateway background thread, checks `get_due_jobs()`, and executes each due job.

**Intervals:** Duration strings like `30m`, `2h`, `1d` — parsed into a `next_run_at` timestamp that advances by the interval after each run.

**One-shot:** Absolute timestamps (`2026-02-03T14:00:00`) — fires once at the specified time with `repeat=1` auto-set (cron/jobs.py:408). After firing, the job is disabled.

**Scheduling model:** File-based lock at `~/.hermes/cron/.tick.lock` prevents concurrent ticks. Jobs are stored as JSON files in `~/.hermes/cron/jobs/`. `advance_next_run()` is called BEFORE execution so a crash mid-run does not re-fire the job on restart (recurring only; one-shots can retry).

### Trigger types missing for Phase 7 (file_change, webhook)

- **`file_change` trigger** — not implemented. No filesystem watcher (watchdog/inotify/FSEvents) exists anywhere in the codebase. Would need a new long-running watcher task alongside the 60s cron ticker.
- **`webhook` trigger** — not implemented as a trigger type, despite `"webhook"` appearing in `_KNOWN_DELIVERY_PLATFORMS` (file:48). That is a *delivery* target, not a trigger. No HTTP endpoint exists to receive external webhook payloads and spawn a job run. Would need: (a) a new route on the gateway, (b) HMAC signature validation, (c) a way to map incoming payloads to job specs.
- **`event` trigger** — not implemented. No mechanism to trigger a cron job in response to an EventBus event (e.g., "run this job whenever `approval.denied` fires"). Would be a natural extension: subscribe to EventBus with a filter pattern and call `run_job()`.
- **`github_event` trigger** — not implemented. GitHub webhook events (push, PR opened, issue created) cannot currently trigger jobs. This is the Phase 7 workflow primitive for issue-to-PR automation.

### Prompt injection delivery semantics — already load-bearing

The cron scheduler's delivery path is a **prompt injection pipeline** by design. Key semantics:

1. **Prompt construction** (`_build_job_prompt`, file:431): The job's `prompt` field is wrapped with a system-level `[SYSTEM: ...]` prefix instructing the agent about delivery, `[SILENT]` suppression, and cron context. Skill content is prepended if configured.
2. **Script injection** (file:437-460): If a `script` field is set, the script runs BEFORE the agent and its stdout is injected into the prompt as `## Script Output\n...\n`.
3. **Agent execution** (`run_job`, file:521): Creates a fresh `AIAgent` with `disabled_toolsets=["cronjob", "messaging", "clarify"]` and `skip_memory=True` (to prevent cron system prompts from corrupting user memory). The agent runs the injected prompt as a normal conversation.
4. **Delivery** (`_deliver_result`, file:200): The agent's `final_response` is delivered to the resolved target platform. `[SILENT]` responses suppress delivery but output is still saved.
5. **Redaction** (file:419): Script output is run through `redact_sensitive_text` before injection into the prompt.

**Phase 7 implication:** Any workflow that reuses the cron scheduler for recurring steps inherits this prompt-injection model. The `[SYSTEM: ...]` framing, `[SILENT]` suppression, and skill-prepending are already battle-tested across cron runs.

## 7. Event bus (`gateway/event_bus.py`)

### Event taxonomy shipped

Event types currently emitted (documented at file:30-43, extended by dashboard_routes handlers):

| Category | Event types |
|----------|-------------|
| Session lifecycle | `session.started`, `session.ended`, `session.deleted`, `session.exported`, `session.forked`, `session.reopened`, `session.injected` |
| Agent turns | `turn.started`, `turn.ended` |
| Tool dispatch | `tool.invoked`, `tool.completed` |
| LLM calls | `llm.call` |
| Approvals | `approval.requested`, `approval.resolved` |
| Compression | `compaction` |
| Cron | `cron.fired` (phases: started, completed, dry-run) |
| Brain/memory | `memory.added`, `memory.replaced`, `memory.removed` |
| Skills | `skill.installed`, `skill.removed`, `skill.reloaded` |
| MCP | `mcp.connected`, `mcp.disconnected` |

**No runtime whitelist** — `publish()` accepts any string type. New event types require no bus changes.

### SSE delivery + rotation

**SSE delivery** (via `subscribe()`, file:300):
- Per-subscriber bounded `asyncio.Queue` (maxsize 1024) with drop-oldest backpressure
- Thread-safe `put_threadsafe()` via `loop.call_soon_threadsafe`
- Replay on connect: subscriber receives up to N recent events from in-memory ring buffer (500-event deque) before switching to live mode
- Subscriber cleanup on disconnect (finally block removes subscriber from list)

**NDJSON tee** (via `_write_ndjson`, file:391):
- Every event appended to `~/.hermes/events.ndjson`
- Rotation at 50 MB, 3 backups (`.1`, `.2`, `.3`)
- Async flush task runs every 0.5s, draining up to 50 events per tick
- File I/O guarded by `threading.Lock`, append-mode for atomic line writes

**In-memory ring buffer** (`_recent`, file:184): 500-event deque for `recent_events()` introspection and SSE replay.

### Workflow event types to add (state_changed, checkpoint_written, waiting_on_approval, resumed)

| Event type | Purpose | Data shape |
|------------|---------|------------|
| `workflow.started` | Workflow run begins | `{workflow_id, workflow_name, trigger_type, trigger_data}` |
| `workflow.state_changed` | Step transition | `{workflow_id, from_step, to_step, status}` |
| `workflow.checkpoint_written` | Durable state persisted | `{workflow_id, checkpoint_id, step, byte_size}` |
| `workflow.waiting_on_approval` | Workflow blocked on human input | `{workflow_id, session_id, approval_key}` |
| `workflow.resumed` | Workflow unblocked | `{workflow_id, resumed_by, approval_choice}` |
| `workflow.completed` | Workflow finished | `{workflow_id, status: "success"|"failed"|"cancelled", duration_s}` |
| `workflow.step_error` | Step failed (may retry) | `{workflow_id, step, error, retry_count}` |

No bus code changes needed — just new `publish()` callsites in workflow orchestration code.

## 8. State store (`hermes_state.py` SessionStore)

### Sessions + messages schema

**Schema version:** 7 (auto-migrates from earlier versions)

**`sessions` table** (file:43-71):
- `id TEXT PRIMARY KEY` — UUID or composite (e.g. `cron_{job_id}_{timestamp}`)
- `source TEXT NOT NULL` — origin platform: `cli`, `discord`, `telegram`, `cron`, `dashboard`, `api`, etc.
- `user_id TEXT` — platform-specific user identifier
- `model TEXT` — LLM model name
- `model_config TEXT` — JSON blob of model parameters
- `system_prompt TEXT` — full assembled system prompt snapshot
- `parent_session_id TEXT` — FK to parent (compression continuations, forks, sub-agents)
- `started_at REAL NOT NULL`, `ended_at REAL`, `end_reason TEXT`
- `message_count INTEGER`, `tool_call_count INTEGER`
- Token accounting: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`
- Cost tracking: `billing_provider`, `billing_base_url`, `billing_mode`, `estimated_cost_usd`, `actual_cost_usd`, `cost_status`, `cost_source`, `pricing_version`
- `title TEXT` — unique (WHERE NOT NULL), sanitized, max 100 chars

**`messages` table** (file:73-87):
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `session_id TEXT NOT NULL REFERENCES sessions(id)`
- `role TEXT NOT NULL` — user, assistant, system, tool
- `content TEXT`, `tool_call_id TEXT`, `tool_calls TEXT` (JSON), `tool_name TEXT`
- `timestamp REAL NOT NULL`, `token_count INTEGER`, `finish_reason TEXT`
- `reasoning TEXT`, `reasoning_details TEXT` (JSON), `codex_reasoning_items TEXT` (JSON)

**`approval_history` table** (file:89-101):
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `session_id TEXT`, `command TEXT NOT NULL`, `pattern_key TEXT`, `description TEXT`
- `choice TEXT NOT NULL`, `resolver TEXT NOT NULL`
- `requested_at REAL`, `resolved_at REAL NOT NULL`, `wait_ms INTEGER`, `reason TEXT`

**FTS5 virtual table** `messages_fts` (file:112-131) — full-text index on `messages.content` with auto-sync triggers.

**Indexes:** `idx_sessions_source`, `idx_sessions_parent`, `idx_sessions_started` (DESC), `idx_messages_session`, `idx_approval_history_session`, `idx_approval_history_resolved_at` (DESC), `idx_approval_history_pattern`, `idx_sessions_title_unique`.

### Extension points for Phase 8a workflow_runs + workflow_checkpoints

**Option A: New tables in the same `state.db`**

The `SessionDB._init_schema()` method (file:271) already handles multi-version migrations (v1 through v7). Adding v8 with new tables is straightforward:

```sql
-- v8: workflow primitives
CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    trigger_type TEXT NOT NULL,  -- cron, webhook, file_change, manual
    trigger_data TEXT,           -- JSON
    status TEXT NOT NULL,        -- pending, running, paused, completed, failed, cancelled
    started_at REAL NOT NULL,
    ended_at REAL,
    error TEXT,
    config TEXT                  -- JSON workflow definition
);

CREATE TABLE IF NOT EXISTS workflow_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
    step_name TEXT NOT NULL,
    state TEXT NOT NULL,         -- JSON serialized step state
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_sessions (
    workflow_id TEXT NOT NULL REFERENCES workflow_runs(id),
    session_id TEXT NOT NULL REFERENCES sessions(id),
    step_name TEXT,
    PRIMARY KEY (workflow_id, session_id)
);
```

**Option B: Separate `workflow_state.db`** — avoids write contention with the high-frequency session/message writes. The `SessionDB` pattern (WAL mode, jitter retry) already handles contention well, but workflows add a new write-heavy surface (frequent checkpoint updates during multi-step runs).

**Existing extension points:**
- `sessions.parent_session_id` — already models session hierarchies (compression continuations, sub-agents, forks). Workflow sessions would add another parent relationship type.
- `sessions.source` — can be set to `"workflow"` or `"workflow:{name}"` for filtering.
- `_execute_write()` retry pattern (file:183-233) — reusable for workflow state writes.
- `fork_session()` (file:1289) — could be used to branch workflow sessions at decision points.
- `reopen_session()` (file:451) — could resume paused workflow sessions.

## 9. Reusability map — what to build vs reuse in Phase 7/8a

| Phase 7/8a need | Reuse | Extend | Build new |
|---|---|---|---|
| Cron trigger | `cron/scheduler.py` tick + `cron/jobs.py` parse — as-is | — | — |
| One-shot trigger | `cron/jobs.py` duration/timestamp parsing — as-is | — | — |
| File-watch trigger | — | — | Watchdog/FSEvents wrapper + new trigger type in jobs schema |
| Webhook trigger | — | Gateway aiohttp app (add route) | Webhook receiver route + HMAC validation + job dispatch |
| GitHub event trigger | — | Webhook trigger (above) + GitHub MCP server (already configured) | Payload-to-job mapping |
| Approval gate | `tools/approval.py` resolve_gateway_approval — as-is | — | — |
| Approval notification | ApprovalCard + SSE `approval.requested` event — as-is | Add browser Notification API push | — |
| Durable state | — | `hermes_state.py` SessionDB (add v8 migration) | `workflow_runs` + `workflow_checkpoints` tables |
| Session spawn from dashboard | SessionDB.create_session — as-is | Add POST `/api/dashboard/sessions` route | Agent spawn orchestration (run_agent in background thread) |
| Session kill from dashboard | — | — | Agent interrupt mechanism + POST `/api/dashboard/sessions/{id}/kill` route |
| Event correlation | `gateway/event_bus.py` publish — as-is | Add `workflow_id` field to event schema | — |
| Dashboard inspectability | `/api/dashboard/sessions/*` routes — as-is | Add `/api/dashboard/workflows` route | Workflow list/detail frontend components |
| Prompt construction | `cron/scheduler.py` `_build_job_prompt` — as-is | Parameterize for workflow step context | — |
| Agent execution | `cron/scheduler.py` `run_job` (creates AIAgent) — as-is | Extract into reusable `run_step()` | — |
| Delivery to platform | `cron/scheduler.py` `_deliver_result` — as-is | — | — |
| OTel spans for workflows | `agent/otel.py` `start_tool_span` — as-is | Add `start_workflow_span` | — |
| Metrics for workflows | `gateway/metrics.py` MetricsReader — as-is | Add `workflow.*` event handlers | — |
| Credential passthrough | `tools/credential_files.py` — as-is (for remote backends) | — | — |

## 10. Open questions surfaced by the audit

- **Agent interrupt mechanism:** There is no way to interrupt a running `AIAgent.run_conversation()` from outside the thread. The cron scheduler uses an inactivity timeout with `agent.interrupt()` (file:762-763), but this requires the agent to have an `interrupt` method. Is this method implemented, and does it cleanly terminate mid-tool-call?

- **Session-to-agent binding:** The dashboard can inject messages into the DB (`/inject`), but there is no channel to deliver those messages to a live agent loop. Phase 8a needs a message bus or shared queue between the dashboard route handler and the running agent thread. What is the threading model — is each agent a thread, a process, or an asyncio task?

- **Workflow state granularity:** Should workflow checkpoints store the full LLM conversation state (messages array) or just the workflow-level state (step name, decision, outputs)? The former enables replay; the latter is smaller. `fork_session()` already preserves full message history, suggesting the repo leans toward full-state checkpoints.

- **WAL contention under workflows:** The `SessionDB` handles write contention with 15 retries and 20-150ms jitter (file:151-153). Workflows add frequent checkpoint writes alongside normal session/message writes. At what point does contention require a separate `workflow_state.db`? The existing `_CHECKPOINT_EVERY_N_WRITES = 50` passive WAL checkpoint (file:155) may need tuning.

- **SSE scalability for workflow monitoring:** The EventBus uses a fixed 1024-event per-subscriber queue (file:76). A multi-step workflow emitting events at high frequency (tool calls, checkpoints, approvals) could fill this queue and trigger drops. Should workflow-heavy dashboards use a dedicated SSE endpoint with a larger buffer?

- **Cron `run_job()` reusability:** The function (file:521) creates a fresh `AIAgent` with hardcoded `disabled_toolsets=["cronjob", "messaging", "clarify"]` and `skip_memory=True`. Workflow steps may need different toolset configurations per step. Should `run_job()` be refactored into a generic `run_step(config)` that accepts toolset/memory/provider overrides?

- **Event bus `workflow_id` threading:** Events currently carry an optional `session_id`. Adding `workflow_id` to the event schema is cheap (no bus changes needed), but should it be a top-level field alongside `session_id`, or nested inside `data`? Top-level enables efficient SSE filtering without JSON-parsing `data`.

- **Approval ownership in workflows:** When a workflow step triggers an approval, the approval's `session_key` identifies the session, not the workflow. If two workflow instances run the same step concurrently, an operator resolving one approval could accidentally affect the other. Should the approval system gain a `workflow_id` discriminator?

- **Credential isolation between workflow steps:** If a workflow runs steps with different trust levels (e.g., "scan untrusted repo" then "open PR on trusted repo"), should credential_files.py support per-step credential scoping? The current ContextVar isolation is per-session, not per-step.

- **MetricsReader performance at scale:** The reader walks the entire NDJSON rotation on every cache miss (30s TTL). With workflow events adding volume, the 50 MB rotation window may contain significantly more events. Should the reader maintain a cursor/offset to avoid re-scanning?
