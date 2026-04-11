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
  (`/`, `/sessions`, `/sessions/$id`, `/cron`, `/tools`, `/skills`,
  `/mcp`, `/health`). Live Console is a Dozzle-style event stream
  with regex filter, pause/resume, auto-scroll. ApprovalCard mirrors
  the LangGraph Agent Inbox shape (Once / Session / Always / Deny).
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

## Planned Phases (not yet implemented)

- **Phase 5b — Claude Code orchestration tile**: `claude_code_dispatch`
  tool + `/claude` dashboard route, spawning Claude Code as a sub-agent
  in isolated git worktrees via `claude-agent-sdk-python`. Plan already
  drafted in `~/.claude/plans/tranquil-dreaming-dragonfly.md` §R5.
- **Phase 6 — Autonomous repo scanning pipeline**: Hermes scans
  configured repos on a schedule, triages findings, opens issues.
- **Phase 7 — Issue-to-PR automation**: cron-fired pipeline that
  picks a triaged issue, drafts a fix, runs tests in a worktree,
  opens a PR for review.
- **Phase 8 — Model fine-tuning with trajectory export**: serialize
  gateway sessions into a training corpus.
