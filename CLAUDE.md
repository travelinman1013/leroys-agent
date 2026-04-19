# Hermes Agent — Maxwell's Instance

NousResearch Hermes Agent v0.8.0 fork. Prefer config/skills/env over source edits.

## Layout

- **Source**: `~/os-apps/hermes/` (venv: `venv/`, Python 3.11, managed by uv)
- **Config**: `~/.hermes/config.yaml` — restart gateway after every edit
- **Secrets**: `~/.hermes/.env` (chmod 600 — never log, commit, or expose)
- **Skills**: `~/.hermes/skills/<name>/SKILL.md` (YAML frontmatter required)
- **Logs**: `~/.hermes/logs/gateway.log`, `gateway.error.log`
- **Sandbox**: canonical at `scripts/sandbox/hermes.sb`, deployed to `~/.hermes/hermes.sb`
- **Dashboard**: `http://127.0.0.1:8642/dashboard/` (React 19 + TanStack Router + shadcn/ui)
- **Design system**: Read `DESIGN.md` before any dashboard visual change

## Git

- `origin` → `travelinman1013/hermes-agent` (private fork)
- `upstream` → `NousResearch/hermes-agent`
- Update: `git fetch upstream && git merge upstream/main && uv pip install -e ".[all]"`
- Never modify `web/` or `hermes_cli/web_server.py` — upstream dashboard files, zero diff policy

## Commands

```bash
hermes                    # CLI chat
hermes doctor             # Health check
hermes gateway run        # Foreground gateway (debug)
hermes model              # Switch model interactively
hermes cron list          # List scheduled jobs

make gateway-restart      # Restart gateway (after config changes)
make gateway-logs         # tail gateway log
make dashboard-build      # Rebuild frontend → api_server_static/
make dashboard-dev        # Vite dev server at :5173

make llama-start          # Quit LM Studio, start llama-server on :1234
make llama-stop           # Stop llama-server
make llama-restart        # Stop + start
make llama-health         # curl /health
make llama-metrics        # Prometheus /metrics (tok/s, KV cache, latency)
make llama-logs           # tail stderr log
```

## Local Inference: llama-server

Direct llama.cpp server — Homebrew build 8680, Metal, `--flash-attn on`.
Full config: `scripts/llama-server/com.llama-server.hermes.plist`

### Model Swap (local)

1. Edit plist — change `--model` and `--mmproj` paths
2. `make llama-restart`
3. Get model ID: `curl -s http://127.0.0.1:1234/v1/models | python3 -c "import json,sys; print(json.load(sys.stdin)['data'][0]['id'])"`
4. Update `~/.hermes/config.yaml` — `model.default` + `compression.summary_model`
5. `make gateway-restart`

### Provider Switching

Local: set `model.provider: custom` + `model.base_url: http://127.0.0.1:1234/v1` in config.yaml.
Cloud: set `model.provider: anthropic` + `model.default: claude-opus-4-6`.
`base_url` MUST be in config.yaml — `.env` `OPENAI_BASE_URL` alone is insufficient.
Always: `make gateway-restart` after switching.

### Available Models (`/Volumes/the-eagle/maxwell-ext/lmstudio/models/`)

| Model | Size | Notes |
|-------|------|-------|
| Gemma 4 26B-A4B Q8_0 | 25 GB | MoE, vision |
| Gemma 4 31B Q8_0 | ~31 GB | Dense, vision |
| Qwen 3.6 35B-A3B Q8_0 | 34 GB | MoE, thinking, vision |
| Qwen 3.5 9B Q8_0 | ~9 GB | Dense, vision |
| Qwen 3.5 35B-A3B Q8_0 | 34 GB | MoE, vision |

Each dir has `mmproj-*.gguf` for vision — update both `--model` and `--mmproj` in plist.
Requires external drive `the-eagle` mounted.

## Security Rules

- Never set `GATEWAY_ALLOW_ALL_USERS=true` or `approvals.mode: "off"`
- Never expose `.env` contents or `dashboard_token` in logs/chat/commits
- Never run `hermes --yolo` in gateway mode
- Never bind dashboard to `0.0.0.0` — loopback only (`127.0.0.1`)
- Keep `DISCORD_ALLOWED_USERS` to Maxwell's ID only
- Terminal CWD scoped to `~/Projects` — never `~` or `/`
- Sandbox edits: run `scripts/sandbox/validate-profile.sh` BEFORE deploying
- Sandbox TCP rules: use `(remote tcp ...)` NOT `(remote ip ...)` — ip form silently fails
- TCP listeners need BOTH `network-bind` AND `network-inbound`

## Skills

**When the user types `/skill-name`, ALWAYS invoke it with the Skill tool first.** Never self-implement a skill's workflow from memory or description alone — the skill file contains the exact process, tools, and constraints that must be loaded into context before acting. A direct `/skill-name` invocation is a blocking requirement: call `Skill("skill-name")` BEFORE generating any other response.

Specific skills:
- `/r-a-p` — research-and-plan: multi-phase process with validation agents. `Skill("r-a-p")`
- `/skill-trainer` — observe Leroys via Discord + dashboard API, generate hardened SKILL.md files. `Skill("skill-trainer")`

## Granting Leroys New Permissions

When Leroys needs access to a new localhost service (Docker container, local API, etc.):

1. **Seatbelt profile** (`scripts/sandbox/hermes.sb`): add `(remote tcp "localhost:PORT")` to the `network-outbound` allow block
2. **Deploy**: `cp scripts/sandbox/hermes.sb ~/.hermes/hermes.sb`
3. **Validate**: `scripts/sandbox/validate-profile.sh`
4. **Restart**: `make gateway-restart`
5. **Update skill**: ensure `~/.hermes/skills/docker-container-interaction/SKILL.md` lists the new port, API details, and config path
6. If the path jail blocks URLs in terminal commands, check `extract_tool_call_paths` in `tools/file_tools.py`
