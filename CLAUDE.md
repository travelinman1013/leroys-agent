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
- **Approvals**: Manual (every dangerous command requires user OK)
- **Max turns**: 30

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
```

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

## Skills Development

Custom skills go in `~/.hermes/skills/<skill-name>/SKILL.md`.
Use YAML frontmatter: name, description, version, metadata.hermes (tags, category, requires_toolsets).
Test via CLI (`hermes chat`) before deploying to gateway.

## GitHub Integration

GitHub MCP server configured in `~/.hermes/config.yaml` under `mcp_servers.github`.
PAT stored as `GITHUB_PERSONAL_ACCESS_TOKEN` in `~/.hermes/.env`.
Tools are lazy-loaded — connect on first use per session.
Verify: `hermes mcp list` should show github as enabled.

## Planned Phases (not yet implemented)

- Phase 4: Autonomous repo scanning pipeline
- Phase 5: Issue-to-PR automation
- Phase 6: Model fine-tuning with trajectory export
