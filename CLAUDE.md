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

Direct llama.cpp server — bypasses LM Studio Electron overhead. Homebrew build 8680, Metal.
Flags: `--flash-attn on`, `--parallel 1`, `--batch-size 2048`, `--ubatch-size 512`, `--metrics`, `--mmproj`.
Full config: `scripts/llama-server/com.llama-server.hermes.plist`

**Benchmark** (2026-04-17, Gemma 4 26B-A4B Q8_0, M3 Ultra 192GB):
Gen: 80.5 tok/s (+8.8% vs LM Studio) | Prompt eval: 1,497 tok/s (+134%) | Built-in prompt caching

### Model Swap (local)

```bash
# 1. Edit plist — change --model and --mmproj paths
vi scripts/llama-server/com.llama-server.hermes.plist
# 2. Restart llama-server
make llama-restart
# 3. Get model ID
curl -s http://127.0.0.1:1234/v1/models | python3 -c "import json,sys; print(json.load(sys.stdin)['data'][0]['id'])"
# 4. Update config.yaml — model.default + compression.summary_model
vi ~/.hermes/config.yaml
# 5. Restart gateway
make gateway-restart
```

### Provider Switching

Local (llama-server):
```yaml
model:
  default: <model-id>          # from /v1/models
  provider: custom
  base_url: http://127.0.0.1:1234/v1
```
`base_url` MUST be in config.yaml model section — `.env` `OPENAI_BASE_URL` alone is insufficient.

Cloud (Anthropic):
```yaml
model:
  default: claude-opus-4-6
  provider: anthropic
```
Always: `make gateway-restart` after switching.

### Available Models (`/Volumes/the-eagle/maxwell-ext/lmstudio/models/`)

| Model | Path | Size | Notes |
|-------|------|------|-------|
| Gemma 4 26B-A4B Q8_0 | `lmstudio-community/gemma-4-26B-A4B-it-GGUF/` | 25 GB | MoE, vision |
| Gemma 4 31B Q8_0 | `lmstudio-community/gemma-4-31B-it-GGUF/` | ~31 GB | Dense, vision |
| Qwen 3.6 35B-A3B Q8_0 | `unsloth/Qwen3.6-35B-A3B-GGUF/` | 34 GB | MoE, thinking, vision |
| Qwen 3.5 9B Q8_0 | `lmstudio-community/Qwen3.5-9B-GGUF/` | ~9 GB | Dense, vision |
| Qwen 3.5 35B-A3B Q8_0 | `lmstudio-community/Qwen3.5-35B-A3B-GGUF/` | 34 GB | MoE, vision |

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
