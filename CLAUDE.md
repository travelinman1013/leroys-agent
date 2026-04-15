# Hermes Agent — Maxwell's Instance

## What This Is

NousResearch Hermes Agent v0.8.0 — autonomous AI agent running locally.
Forked from NousResearch/hermes-agent. Upstream source is tracked via `upstream` remote.
Prefer config, skills, and env vars over modifying source files directly.

## Runtime Layout

- **Source + venv**: `~/os-apps/hermes/` (this repo — fork of NousResearch/hermes-agent)
- **Config**: `~/.hermes/config.yaml`
- **Secrets**: `~/.hermes/.env` (chmod 600 — never log, never commit)
- **Skills**: `~/.hermes/skills/`
- **Sessions/logs**: `~/.hermes/sessions/`, `~/.hermes/logs/`
- **Memories**: `~/.hermes/memories/`
- **Events** (Phase 5 R1): `~/.hermes/events.ndjson` (rotating 50 MB)
- **Dashboard token** (Phase 5 R2): `~/.hermes/dashboard_token` (chmod 600, separate from `.env`)
- **Sandbox profile**: `~/.hermes/hermes.sb` (deployed copy — canonical at `scripts/sandbox/hermes.sb`)
- **Venv**: `venv/` (Python 3.11, managed by uv)

## Git Remotes

- `origin` → `travelinman1013/hermes-agent` (private fork)
- `upstream` → `NousResearch/hermes-agent` (upstream source)

Pull upstream updates: `git fetch upstream && git merge upstream/main`

## Services

| Service | Plist | Status command |
|---------|-------|---------------|
| Gateway | `~/Library/LaunchAgents/ai.hermes.gateway.plist` | `launchctl list \| grep hermes` |

Restart: `launchctl kickstart -k gui/$(id -u)/ai.hermes.gateway`
Logs: `tail -f ~/.hermes/logs/gateway.log`
Errors: `tail -f ~/.hermes/logs/gateway.error.log`

## Current Configuration

- **LLM**: Gemma 4 26B via LM Studio at `localhost:1234`
- **Provider**: `custom` with `OPENAI_BASE_URL` / `OPENAI_API_KEY` in .env
- **Discord**: Bot "Hermes Agent#8334" on Chomptown server
- **Terminal**: Local backend, CWD restricted to `~/Projects`
- **Approvals**: Manual (every dangerous command requires user OK), `non_interactive_policy: guarded`
- **Max turns**: 30
- **Sandbox**: `sandbox-exec -f ~/.hermes/hermes.sb` via `scripts/sandbox/hermes-gateway-sandboxed` wrapper (Phase 4 R4)
- **Dashboard** (Phase 5): `http://127.0.0.1:8642/dashboard/` — enabled via `API_SERVER_ENABLED=true` in `.env`
- **Memory provider**: `holographic` — local SQLite FTS5 fact store with trust scoring and HRR-based compositional retrieval. DB at `~/.hermes/memory_store.db`. Additive to built-in MEMORY.md/USER.md. Deployed 2026-04-12.
- **Memory guidance**: 2-tier SAVE/SKIP framework across 5 guidance locations (system prompt, tool schema, background review, compression flush, gateway flush). SAVE: user corrections, preferences, conventions, operational learnings, decision reasoning. SKIP: config facts, volatile state, raw file contents, task progress. See `agent/prompt_builder.py:MEMORY_GUIDANCE`.

## Commands

```bash
hermes                    # CLI chat
hermes doctor             # Health check
hermes gateway run        # Foreground gateway (for debugging)
hermes tools              # Enable/disable toolsets
hermes skills list        # List installed skills
hermes model              # Switch model interactively
hermes cron list          # List scheduled jobs

# Update upstream
git fetch upstream && git merge upstream/main && uv pip install -e ".[all]"

# Restart gateway after config changes
launchctl kickstart -k gui/$(id -u)/ai.hermes.gateway
# or:
make gateway-restart

# Phase 5 dashboard workflows (Makefile targets)
make dashboard-build      # npm install + build + copy to api_server_static/
make dashboard-dev        # Vite dev server at :5173 (proxies to :8642)
make gateway-logs         # tail -f ~/.hermes/logs/gateway.log

# Optional observability (R4 — only if you want Phoenix traces)
pip install -e ".[observability]"
export HERMES_OTLP_ENDPOINT=http://localhost:4317
make phoenix-up           # Docker sidecar at :6006 (UI) + :4317 (OTLP gRPC)
make phoenix-down
```

## Dashboard (Phase 5)

Modern orchestration & monitoring UI served at `http://127.0.0.1:8642/dashboard/`.
Built with React 19 + TanStack Router + shadcn/ui + Tailwind, shipped as a
static bundle served directly by the gateway's aiohttp server. Zero new
processes, zero new ports beyond 8642, zero additional sandbox surface —
the dashboard runs in the SAME sandboxed process as the gateway.

Key pieces:
- **Event bus** (`gateway/event_bus.py`) — in-process asyncio pubsub that
  fans typed events (turn, tool, approval, compaction, cron, session)
  from the agent loop to SSE subscribers. Thread-safe `publish()`,
  drop-oldest backpressure, fail-silent. Tees every event to
  `~/.hermes/events.ndjson` (rotating 50 MB).
- **Dashboard routes** (`gateway/platforms/dashboard_routes.py`) —
  `/api/dashboard/*` JSON endpoints + SSE multiplexer at
  `/api/dashboard/events`. Auth via bearer token from
  `~/.hermes/dashboard_token` (separate from `.env` so Seatbelt deny
  rule on `.env` keeps holding). Handshake route bootstraps the token
  on first localhost request.
- **Frontend** (`dashboard/`) — TanStack Router file-based routes
  (`/`, `/desk`, `/brain`, `/sessions`, `/sessions/$id`, `/approvals`,
  `/cron`, `/tools`, `/skills`, `/mcp`, `/health`, `/config`,
  `/workflows`). Live Console is a Dozzle-style event stream
  with regex filter, pause/resume, auto-scroll. ApprovalCard mirrors
  the LangGraph Agent Inbox shape (Once / Session / Always / Deny).
  `/desk` is the session control plane: spawn, kill, live fleet view.
- **Makefile** — `make dashboard-build`, `make gateway-restart`,
  `make phoenix-up/down/logs`, `make gateway-logs`.

To enable:
1. `echo 'API_SERVER_ENABLED=true' >> ~/.hermes/.env`
2. `make dashboard-build` (one-time or after frontend edits)
3. `make gateway-restart`
4. Open `http://127.0.0.1:8642/dashboard/` — handshake mints the token
   automatically on first load.

## Config Changes

Always restart the gateway after editing `~/.hermes/config.yaml` or `~/.hermes/.env`.
Use `hermes doctor` to validate after changes.

When changing the LLM model:
1. Verify model is loaded in LM Studio: `curl -s http://localhost:1234/v1/models`
2. Update `model.default` in config.yaml to match the exact model ID from LM Studio
3. Restart gateway

## Security Rules

- Never set `GATEWAY_ALLOW_ALL_USERS=true`
- Never set `approvals.mode: "off"` without explicit user request
- Never expose `~/.hermes/.env` contents in logs, chat, or commits
- Never run `hermes --yolo` in gateway/production mode
- Keep `DISCORD_ALLOWED_USERS` set to Maxwell's ID only
- Terminal CWD must not be set to `~` or `/` — keep it scoped to `~/Projects`
- Do not add cloud API keys unless Maxwell explicitly provides them
- Never bind the dashboard API server to anything other than `127.0.0.1` / `localhost` — no `0.0.0.0`, no LAN IP. The bearer-token auth model assumes loopback-only.
- Never disable the dashboard bearer token or expose `~/.hermes/dashboard_token` — treat it like `.env`.
- Sandbox profile edits: always run `scripts/sandbox/validate-profile.sh` BEFORE deploying to `~/.hermes/hermes.sb`. Use `(local tcp ...)` / `(remote tcp ...)` for TCP rules, NOT `(local ip ...)` / `(remote ip ...)` — the `ip` form parses but silently fails to match. TCP listeners also need BOTH `network-bind` AND `network-inbound` — missing the latter EPERMs at `listen()`.

## Skills Development

Custom skills go in `~/.hermes/skills/<skill-name>/SKILL.md`.
Use YAML frontmatter: name, description, version, metadata.hermes (tags, category, requires_toolsets).
Test via CLI (`hermes chat`) before deploying to gateway.

## GitHub Integration

GitHub MCP server configured in `~/.hermes/config.yaml` under `mcp_servers.github`.
PAT stored as `GITHUB_PERSONAL_ACCESS_TOKEN` in `~/.hermes/.env`.
Tools are lazy-loaded — connect on first use per session.
Verify: `hermes mcp list` should show github as enabled.

## Shipped Phases

- **Phase 4: Sandboxing** (deployed 2026-04-10) — app-level approval gate (R1),
  non-interactive policy (R2), inline path jail (R3), Seatbelt MACF profile
  under `sandbox-exec` via launchd wrapper (R4), per-tool-output cap (R5).
  Details: `.claude/rules/recon-findings.md`, `architecture.md`.
- **Phase 5: Orchestration & Monitoring Dashboard** (deployed 2026-04-10) —
  in-process event bus (R1), REST + SSE dashboard backend (R2), React 19 +
  TanStack Router + shadcn/ui frontend (R3), optional OpenLLMetry + Phoenix
  sidecar (R4). Details: `architecture.md` §9, plan at
  `~/.claude/plans/tranquil-dreaming-dragonfly.md`.

- **Phase 6: Brain Route v2 + MCP Wave 1** (deployed 2026-04-11) —
  unified brain content API with 6 backend modules (brain_sources,
  brain_tree, brain_search, brain_write, brain_backlinks, brain_cache)
  and 6 new endpoints (R1), three-pane reader UI with Prose typography,
  tree walker, search, timeline, editor with approval-gated writes (R2),
  Obsidian MCP eval (@bitbonsai/mcpvault selected) + Filesystem MCP
  config (R3/R4), control-plane audit for Phase 7/8a (R5). Vitest
  adopted for frontend tests. Details: plan at
  `~/.claude/plans/bone-leafing-heron.md`, eval at
  `.claude/rules/phase-6-obsidian-mcp-eval.md`, audit at
  `.claude/rules/phase-6-control-plane-audit.md`.

- **Phase 7: Workflow Primitives Recon** (deployed 2026-04-12) —
  two harness workflows proving 3 primitives each (trigger, durable
  state, dashboard inspectability). Harness A: morning-repo-scan
  (cron-triggered, GitHub API scan for stale PRs/broken CI, vault
  note + Discord delivery). Harness B: watch-and-notify (watchdog
  FSEvents file watcher, rules-based classification, event bus +
  Discord notification). Shared engine: workflow/engine.py with
  run_workflow() + resume_workflow() for crash recovery, schema v8
  (workflow_runs + workflow_checkpoints tables), gateway restart
  resume, dashboard /workflows route with step accordion. 75 tests.
  Plan at `~/.claude/plans/silly-snuggling-gadget.md`.

- **Phase 8a: Session Control Plane** (deployed 2026-04-12) —
  session spawn/kill/status from dashboard REST endpoints, live inject
  via agent interrupt, schema v9 (session_key + workflow_run_id columns),
  runner bridge for dashboard-to-gateway communication. Watchdog-based
  timeout (not asyncio.wait_for), concurrent session cap (5), SENTINEL-
  aware kill. 12 new tests (111 total). Plan at
  `~/.claude/plans/synthetic-forging-seahorse.md`.

- **Phase 8b: Desk UI + Approval Parity** (deployed 2026-04-12) —
  `/desk` dashboard route: fleet view with running/recent session split,
  spawn dialog (message + optional title + timeout picker, Cmd+Enter
  submit), kill button with confirm on running sessions, live status
  badges (running pulse / idle / ended), ONE BIG NUMBER (running
  session count in 72px oxide), SSE-driven auto-refresh, browser
  Notification API for `approval.requested` events (opt-in toggle in
  strip header). Sidebar renumbered: Desk is #02. API client extended
  with `spawnSession` + `killSession` + `SessionListRow.status` fields.
  Follows Operator's Desk design system (DESIGN.md).

- **Phase 8c: First Production Workflow** (deployed 2026-04-12) —
  morning-repo-scan promoted from Phase 7 harness to production cron
  job. Scans 6 repos (hermes-agent, claude-skills, jazzapedia,
  jazzapedia-v2, cnario, electric-abacus) for stale PRs and broken CI.
  Runs weekdays at 6 AM CT, delivers vault note to
  `~/brain/00_Inbox/repo-scan-YYYY-MM-DD.md` + Discord DM. Vault
  output directory now configurable via
  `workflows.morning_repo_scan.vault_dir` in config.yaml. Cron job
  ID `e0c86681487d`. 5 business day observation period begins
  2026-04-13.

- **Phase 9a: Search Activation + Research Digest** (deployed 2026-04-12) —
  Tavily search backend activation (config-only, `tools/web_tools.py:282-361`
  already implemented), Brave Search MCP server config
  (`@brave/brave-search-mcp-server`), research-digest workflow harness
  (`workflow/harnesses/research_digest.py`) fetching HN + arXiv + GitHub
  trending into vault notes with `defusedxml` XXE protection for arXiv XML,
  file watcher production hardening (config-driven debounce/excludes, path
  jail in `_should_ignore`, observer liveness check with auto-restart),
  path safety defense-in-depth in watch-and-notify `detect_change`. 28 new
  tests (104 workflow total). Plan at
  `~/.claude/plans/humming-growing-gray.md`.

## Planned Phases (not yet implemented)

- **Phase 9b — Playwright + CI fixer + E2E harness + backup drill + `hermes doctor` search check**.
- **Phase 11 — Dashboard convergence + differentiator investment**:
  Cost controls (per-session budget caps with agent-local enforcement,
  cost alert strip on Home), browser notifications for approvals and
  budget events, cron job creation form (collapsible, with inline
  schedule validation), tool-call collapse/truncate in session
  transcripts. Plan at `~/.claude/plans/cheerful-doodling-sparkle.md`.
- **Phase 12 — Claude Code orchestration tile**: `claude_code_dispatch`
  tool + `/claude` dashboard route, spawning Claude Code as a sub-agent
  in isolated git worktrees via `claude-agent-sdk-python`. Key use case:
  start a long CC task through Hermes, walk away, get Discord
  notifications when done or when CC needs input, reply via Discord.

## Dashboard Convergence (post v0.9.0)

Upstream shipped a built-in dashboard in v0.9.0 (FastAPI at `:9119`,
`hermes dashboard` command). Our custom dashboard (`:8642/dashboard/`)
remains the primary operational control plane.

**Two dashboards, separate file spaces:**
- `:8642/dashboard/` = **Operator's Desk** (always-on, in-process with
  gateway). Owns: session control plane, approvals, brain, workflows,
  live events, safe config, tool invocation, memory editor.
- `:9119` = **Upstream dashboard** (opt-in via `hermes dashboard`).
  Use for: analytics charts, log viewer, config schema forms, skills
  browser, OAuth provider management, env var management.

**Never-touch rule:** Do not modify files in `web/` or
`hermes_cli/web_server.py`. Zero diff on these files = zero merge
conflicts on dashboard code. All upstream dashboard evolution flows
through cleanly.

**Do not build in our dashboard:** Analytics pages, log viewers, config
schema-driven forms, skills category browsers — upstream owns these.
Invest in our irreplaceable routes instead.

### Upstream Merge Protocol

When `git merge upstream/main` creates conflicts:

| File | Resolution |
|------|-----------|
| `hermes_state.py` | Accept upstream schema version, re-number our migrations above it |
| `gateway/run.py` | Keep both additions (event bus, workflow resume, control plane), merge around upstream changes |
| `gateway/platforms/api_server.py` | Preserve our CORS fix + dashboard registration block |
| `hermes_cli/config.py` | Accept upstream's new keys, keep ours (`code_execution`, `safe_roots`, `denied_paths`, `non_interactive_policy`) |
| `tools/approval.py` | Our `list_pending_approvals_for_dashboard` is additive |

## Design System

The dashboard (`dashboard/`) follows the **Operator's Desk** design
system, defined in `DESIGN.md` at the repo root. Always read
`DESIGN.md` before making any visual, typography, color, layout, or
component change to the dashboard. It defines:

- The full Bone & Iron Oxide palette (dark + light, both ship as
  separate instruments — not as accessibility options)
- The production type stack (Söhne / Söhne Breit / MD IO / Instrument
  Serif) and the free fallback stack (Switzer / JetBrains Mono /
  Instrument Serif)
- Density rules (comfortable on read-routes, dense on scan-routes)
- Motion tokens (custom easing, 120/180/240/320/600ms)
- Route-by-route layout philosophy
- The migration delta from the current shadcn-default state
- An anti-slop pledge listing patterns the dashboard refuses to ship
  (purple gradients, glassmorphism, rainbow event categories,
  rounded-2xl + shadow cards, chat-bubble transcripts, Inter, Geist,
  Berkeley Mono, etc.)

Do not deviate from `DESIGN.md` without explicit user approval. The
visual reference preview file is `~/.hermes/operator-desk-preview.html`
— keep it in sync if `DESIGN.md` changes.
