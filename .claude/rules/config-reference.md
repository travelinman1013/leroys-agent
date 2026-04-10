---
paths:
  - "**/.hermes/**"
  - "**/config.yaml"
  - "**/.env"
---
# Config Reference

## Provider gotchas
- Use `provider: "custom"` for any local LLM (LM Studio, Ollama, vLLM)
- Aliases "lmstudio", "ollama" work in CLI but NOT in gateway auxiliary_client
- Always set both `OPENAI_BASE_URL` and `OPENAI_API_KEY` in .env for gateway
- Model ID must exactly match what the LLM server reports via `/v1/models`

## Config precedence (highest wins)
1. CLI flags (`--model`, `--toolsets`)
2. `~/.hermes/config.yaml`
3. `~/.hermes/.env`
4. Built-in defaults

## Compression model
The `compression.summary_model` and `summary_provider` must point to a model
that accepts the full context length. When using local LLM, set:
```yaml
compression:
  summary_model: "google/gemma-4-26b-a4b"
  summary_provider: "main"
```

## Discord env vars
```
DISCORD_BOT_TOKEN=<token>
DISCORD_ALLOWED_USERS=<user-id>
DISCORD_REQUIRE_MENTION=true
DISCORD_AUTO_THREAD=true
```
These go in ~/.hermes/.env, NOT in config.yaml.
