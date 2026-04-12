# Phase 7 — Workflow Primitives Recon

> **Branch**: `enhance/hermes-phase7-workflow-recon`
> **Plan**: `~/.claude/plans/silly-snuggling-gadget.md`
> **Deployed**: 2026-04-12
> **Status**: Observation week pending

## Harnesses Implemented

### Harness A: morning-repo-scan (cron-triggered)
- **Trigger**: cron job with `workflow: morning-repo-scan` field
- **Steps**: fetch_repos → scan_repos (GitHub API GET-only) → summarize (vault note + event bus)
- **Files**: `workflow/harnesses/morning_repo_scan.py`, `cron/scheduler.py` (workflow hook)

### Harness B: watch-and-notify (event-driven)
- **Trigger**: watchdog FSEvents file watcher on ~/brain + ~/Projects
- **Steps**: detect_change → classify_change → act_on_change (event bus + Discord)
- **Files**: `workflow/file_watcher.py`, `workflow/harnesses/watch_and_notify.py`, `gateway/run.py`

## Primitives Proved

| Primitive | Harness A | Harness B |
|-----------|-----------|-----------|
| Trigger mechanism | Cron scheduler (reused) | watchdog FSEvents (new) |
| Durable state | workflow_runs + workflow_checkpoints (schema v8) | Same |
| Dashboard inspectability | /api/dashboard/workflows + /workflows route | Same + workflow.file_change events |

## Architecture

- **workflow/engine.py**: `run_workflow()` + `resume_workflow()` — synchronous step executor with durable checkpointing
- **workflow/primitives.py**: StepDef, WorkflowDef, StepResult, WorkflowRunResult dataclasses
- **hermes_state.py**: schema v8 migration, 8 new CRUD methods
- **gateway/run.py**: file watcher thread + workflow resume on startup

## Test Coverage

- 75 tests total across 5 test files
- `tests/workflow/test_engine.py`: 26 tests (schema, CRUD, engine, resume, helpers)
- `tests/workflow/test_morning_repo_scan.py`: 13 tests (steps, E2E)
- `tests/workflow/test_file_watcher.py`: 13 tests (debounce, excludes, shutdown)
- `tests/workflow/test_watch_and_notify.py`: 15 tests (classification, routing, E2E)
- `tests/workflow/test_durability.py`: 8 tests (forced-failure, idempotency, restart)

## 6R5 Open Questions — Resolved

| # | Question | Resolution |
|---|----------|-----------|
| 1 | Agent interrupt | EXISTS at run_agent.py:2504 — not needed for Phase 7 workflows |
| 2 | Session-to-agent binding | Not needed — workflows run to completion |
| 3 | Workflow state granularity | Step-level only (500 char output summaries) |
| 4 | WAL contention | Same state.db, ~3 writes per run — no contention observed |
| 5 | SSE scalability | 1024 queue fine — ~10-20 events per workflow run |
| 6 | run_job() reusability | Workflow hook in run_job(), not a refactor |
| 7 | workflow_id in events | data.run_id + data.workflow_id top-level |
| 8 | Approval ownership | Deferred — both harnesses are read-only |
| 9 | Credential isolation | Deferred — same trust level |

## Observation Week Measurements (FILL AFTER WEEK)

| Criterion | Pass/Fail | Notes |
|-----------|-----------|-------|
| Restart/resume durability | | |
| Idempotency/dedupe | | |
| External-event correlation | | |
| Failure recovery semantics | | |
| Dashboard inspectability | | |
| LOC | | |
| Test count | 75 | |
| Compaction pressure | | |

## Winner Recommendation (FILL AFTER WEEK)

<!-- After observation week: commit to winner, delete loser, document rationale -->
