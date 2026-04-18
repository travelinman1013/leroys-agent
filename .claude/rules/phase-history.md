---
paths:
  - "gateway/**"
  - "agent/**"
  - "workflow/**"
  - "dashboard/**"
  - "tools/**"
  - "scripts/sandbox/**"
---
# Shipped Phase History

Reference for what shipped and when. Consult when working on code that
touches these subsystems to understand design decisions.

## Phase 4: Sandboxing (2026-04-10)
App-level approval gate (R1), non-interactive policy (R2), inline path jail (R3),
Seatbelt MACF profile under `sandbox-exec` via launchd wrapper (R4), per-tool-output
cap (R5). Details: `.claude/rules/recon-findings.md`, `architecture.md`.

## Phase 5: Dashboard (2026-04-10)
In-process event bus (R1), REST + SSE dashboard backend (R2), React 19 + TanStack
Router + shadcn/ui frontend (R3), optional OpenLLMetry + Phoenix sidecar (R4).

## Phase 6: Brain Route v2 + MCP Wave 1 (2026-04-11)
Unified brain content API with 6 backend modules + 6 endpoints (R1), three-pane
reader UI (R2), Obsidian MCP (@bitbonsai/mcpvault) + Filesystem MCP (R3/R4),
control-plane audit (R5). Vitest adopted for frontend tests.

## Phase 7: Workflow Primitives (2026-04-12)
Two harness workflows: morning-repo-scan (cron) + watch-and-notify (FSEvents).
Shared engine: `workflow/engine.py` with `run_workflow()` + `resume_workflow()`.
Schema v8 (workflow_runs + workflow_checkpoints). 75 tests.

## Phase 8a: Session Control Plane (2026-04-12)
Session spawn/kill/status from dashboard, live inject, schema v9, runner bridge.
Watchdog timeout, concurrent session cap (5), SENTINEL-aware kill. 111 total tests.

## Phase 8b: Desk UI + Approval Parity (2026-04-12)
`/desk` route: fleet view, spawn dialog, kill button, live badges, SSE auto-refresh,
browser Notification API for approvals. Follows DESIGN.md.

## Phase 8c: First Production Workflow (2026-04-12)
morning-repo-scan cron job scanning 6 repos for stale PRs/broken CI. Weekdays 6 AM CT.
Delivers vault note + Discord DM.

## Phase 9a: Search + Research Digest (2026-04-12)
Tavily search activation, Brave Search MCP, research-digest workflow harness
(HN + arXiv + GitHub trending), file watcher hardening. 104 workflow tests.

## Planned Phases
- **9b**: Playwright + CI fixer + E2E harness + backup drill
- **11**: Dashboard convergence + cost controls + browser notifications
- **12**: Claude Code orchestration tile (`claude_code_dispatch` tool)
