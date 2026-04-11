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

## Dashboard not picking up new routes / sidebar showing old layout
After editing `gateway/platforms/dashboard_routes.py` OR `dashboard/src/`:

1. **Backend changes** need a gateway restart — the dashboard_routes module
   is imported once at boot. `make gateway-restart` (kicks launchd).
2. **Frontend changes** need a bundle rebuild — `make dashboard-build`
   runs `vite build && tsc -b --noEmit && node scripts/install.mjs` which
   copies `dashboard/dist/` → `gateway/platforms/api_server_static/`.
3. **Browser cache** is the most common reason "I rebuilt and the sidebar
   still looks old" — Chromium reuses cached `index.html` even after a
   rebuild. Hard refresh with **⌘⇧R**, or open devtools Network tab and
   tick "Disable cache", or open in incognito.

Verify the served bundle matches the build:
```bash
curl -s http://127.0.0.1:8642/dashboard/ | grep -o 'index-[A-Za-z0-9]*\.js'
```
The hash should match the `dist/assets/index-*.js` line in the most
recent `make dashboard-build` output.

## Dashboard v2 control routes (PR #4 / cobalt-steering-heron)

The dashboard now has 10 sidebar entries. New ones:

- `/approvals` (04) — F3 approval command center with bulk-resolve + history
- `/config` (10) — F5 safe config editor with allowlisted mutations + dated backups

The security-critical route is `POST /api/dashboard/tools/{name}/invoke`.
Test gate: `pytest tests/gateway/test_tool_invoke_security.py -n 0` must
pass 8/8 before any change to that handler ships. The 4 plan assertions:
dangerous → 202, force=True stripped, nested smuggle blocked, path jail
applies to /etc/passwd via read_file.

Config writes go through `hermes_cli.config.apply_config_mutations` which
enforces the `CONFIG_MUTATION_ALLOWLIST` frozen set. Any non-allowlist
key returns 403. Backups land in `~/.hermes/config_backups/` with a
microsecond-precision timestamp + a one-time pristine snapshot.

Approval audit trail is in `state.db::approval_history` (schema v7,
auto-migrates from v6). Fire-and-forget — failed writes never block
`resolve_gateway_approval`.

## Test isolation: hermes_state.DEFAULT_DB_PATH is import-time-cached

Any test that exercises a dashboard route which calls `SessionDB()` (no
explicit path) MUST monkeypatch `DEFAULT_DB_PATH` AND `HERMES_HOME`:

```python
import hermes_state
monkeypatch.setenv("HERMES_HOME", str(tmp_path))
monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
```

Without it, parallel xdist workers contend on the real `~/.hermes/state.db`
and tests flake. Pattern is in every dashboard v2 route test fixture.

## Mermaid in architecture.md

Mermaid 11.x reserves `@` after `|` as a link-id specifier. Quote any
edge label containing `@` or parens:

```
Maxwell -->|"@mentions, slash commands"| Discord       # OK
hermes -->|"localhost:1234<br/>(remote ip)"| LMS       # OK
Maxwell -->|@mentions| Discord                          # PARSE ERROR
hermes -->|localhost (remote ip)| LMS                  # PARSE ERROR
```

Validate before pushing:
```bash
mkdir -p /tmp/mc && python3 -c "
import re; src = open('architecture.md').read()
for i, b in enumerate(re.findall(r'\`\`\`mermaid\n(.*?)\n\`\`\`', src, re.DOTALL), 1):
    open(f'/tmp/mc/b{i}.mmd', 'w').write(b)
"
for f in /tmp/mc/*.mmd; do
  npx --yes @mermaid-js/mermaid-cli@11 -i $f -o ${f%.mmd}.svg 2>&1 | tail -3
done
```
