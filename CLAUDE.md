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

## Planned Phases (not yet implemented)

- **Phase 5b — Claude Code orchestration tile**: `claude_code_dispatch`
  tool + `/claude` dashboard route, spawning Claude Code as a sub-agent
  in isolated git worktrees via `claude-agent-sdk-python`. Plan already
  drafted in `~/.claude/plans/tranquil-dreaming-dragonfly.md` §R5.
- **Phase 8a — Session control plane**: session fleet API (spawn,
  attach, message, kill), failure policy engine, resource budgets.
  Phase 7 winner ported to durable state store.
- **Phase 8b — /console + /desk UI + approval parity**: pure frontend
  on top of Phase 8a. Browser approvals fire alongside Discord.
- **Phase 8c — First production workflow**: morning-repo-scan promoted
  from harness to production. 5 consecutive business days.
- **Phase 9a — Brave MCP + research digest + watch-and-notify production**.
- **Phase 9b — Playwright + CI fixer + E2E harness + backup drill**.

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
