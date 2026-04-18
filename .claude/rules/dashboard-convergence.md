---
paths:
  - "dashboard/**"
  - "gateway/platforms/dashboard_routes.py"
  - "gateway/platforms/api_server.py"
  - "web/**"
  - "hermes_cli/web_server.py"
---
# Dashboard Convergence Rules

Two dashboards coexist post upstream v0.9.0:
- `:8642/dashboard/` = **Operator's Desk** (ours, always-on, in-process)
- `:9119` = **Upstream dashboard** (opt-in via `hermes dashboard`)

## Hard Rules
- NEVER modify `web/` or `hermes_cli/web_server.py` — zero diff = zero merge conflicts
- Do NOT build in our dashboard: analytics, log viewers, config schema forms, skills browsers — upstream owns these
- Invest only in irreplaceable routes: session control, approvals, brain, workflows, live events, config, tools

## Upstream Merge Conflict Resolution

| File | Resolution |
|------|-----------|
| `hermes_state.py` | Accept upstream schema version, re-number our migrations above it |
| `gateway/run.py` | Keep both additions (event bus, workflow resume, control plane) |
| `gateway/platforms/api_server.py` | Preserve our CORS fix + dashboard registration block |
| `hermes_cli/config.py` | Accept upstream's new keys, keep ours (`code_execution`, `safe_roots`, `denied_paths`, `non_interactive_policy`) |
| `tools/approval.py` | Our `list_pending_approvals_for_dashboard` is additive |
