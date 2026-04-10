---
paths:
  - "**/*.plist"
  - "**/gateway/**"
  - "**/logs/**"
---
# Gateway Debugging

## Common failure: HTTP 401 "No cookie auth credentials found"
The gateway's auxiliary_client resolves providers differently from CLI.
- `provider: "lmstudio"` does NOT work in gateway — use `provider: "custom"`
- Gateway needs `OPENAI_BASE_URL` and `OPENAI_API_KEY` in ~/.hermes/.env
- The config.yaml `base_url` alone is insufficient for gateway provider resolution

## Common failure: exit code 78 from launchd
Means the binary or venv path in the plist doesn't exist. Verify:
```bash
ls -la /Users/maxwell/os-apps/hermes/hermes-agent/venv/bin/hermes
```

## Log locations
- stdout: ~/.hermes/logs/gateway.log
- stderr: ~/.hermes/logs/gateway.error.log
- Session data: ~/.hermes/sessions/

## Restart sequence after config changes
```bash
launchctl kickstart -k gui/$(id -u)/ai.hermes.gateway
sleep 5
tail -15 ~/.hermes/logs/gateway.log   # verify clean start
tail -5 ~/.hermes/logs/gateway.error.log  # check for new errors
```

## Discord slash command limit
Discord caps at 100 slash commands. If skills exceed this, some won't register.
Warning appears in logs but is non-fatal.
