# Workflow Engine Architecture — Phase 7

> **Module**: `workflow/`
> **Plan**: `~/.claude/plans/silly-snuggling-gadget.md`
> **Recon doc**: `.claude/rules/recon-phase-7.md`

## Overview

The workflow engine runs multi-step autonomous tasks with durable
checkpointing. Each step is checkpointed to SQLite so workflows survive
gateway restarts and `kill -9`. Two harness workflows prove the
primitives; the winner gets promoted to production in Phase 8c.

## System flow

```mermaid
flowchart TB
    subgraph triggers["Trigger Layer"]
        cron["cron/scheduler.py<br/>tick() every 60s"]
        watcher["workflow/file_watcher.py<br/>watchdog FSEvents"]
    end

    subgraph engine["Execution Engine"]
        run["workflow/engine.py<br/>run_workflow()"]
        resume["workflow/engine.py<br/>resume_workflow()"]
    end

    subgraph state["Durable State"]
        db[("hermes_state.py<br/>state.db (schema v8)")]
        runs["workflow_runs table"]
        cps["workflow_checkpoints table"]
    end

    subgraph observe["Observability"]
        bus["gateway/event_bus.py<br/>publish()"]
        sse["SSE endpoint<br/>/api/dashboard/events"]
        api["REST API<br/>/api/dashboard/workflows"]
        ui["/workflows route<br/>dashboard UI"]
    end

    cron -->|"job.workflow set"| run
    watcher -->|"debounced file event"| run
    run --> db
    run --> bus
    resume --> db
    resume --> bus
    db --> runs
    db --> cps
    bus --> sse
    api --> db
    sse --> ui
    api --> ui

    startup["Gateway startup"] -->|"scan running runs"| resume
```

## Step execution model

```mermaid
sequenceDiagram
    participant T as Trigger
    participant E as Engine
    participant DB as SQLite
    participant EB as EventBus
    participant S1 as Step 1
    participant S2 as Step 2
    participant S3 as Step 3

    T->>E: run_workflow(wf, trigger_meta)
    E->>DB: create_workflow_run(status=running)
    E->>EB: workflow.run.started

    E->>DB: create_checkpoint(step=0, status=running)
    E->>EB: workflow.step.started
    E->>S1: step.fn(context)
    S1-->>E: output dict
    E->>DB: update_checkpoint(status=completed)
    E->>EB: workflow.step.completed
    Note over E: context["step_1"] = output

    E->>DB: create_checkpoint(step=1, status=running)
    E->>EB: workflow.step.started
    E->>S2: step.fn(context)
    S2-->>E: output dict
    E->>DB: update_checkpoint(status=completed)
    E->>EB: workflow.step.completed

    E->>DB: create_checkpoint(step=2, status=running)
    E->>EB: workflow.step.started
    E->>S3: step.fn(context)
    S3-->>E: output dict
    E->>DB: update_checkpoint(status=completed)
    E->>EB: workflow.step.completed

    E->>DB: update_workflow_run(status=completed)
    E->>EB: workflow.run.completed
    E-->>T: WorkflowRunResult
```

## Crash recovery (resume)

```mermaid
flowchart LR
    subgraph before["State after crash"]
        r1["workflow_runs<br/>status=running"]
        c0["checkpoint 0<br/>status=completed"]
        c1["checkpoint 1<br/>status=running"]
        c2["checkpoint 2<br/>(not created)"]
    end

    subgraph after["After resume_workflow()"]
        r2["workflow_runs<br/>status=completed"]
        c0b["checkpoint 0<br/>SKIPPED"]
        c1b["checkpoint 1<br/>RE-RUN → completed"]
        c2b["checkpoint 2<br/>RUN → completed"]
    end

    before --> |"gateway restart<br/>resume_workflow(run_id)"| after
```

## Harness A: morning-repo-scan

```mermaid
flowchart LR
    cron["Cron tick<br/>every 2m (stress)<br/>or 0 9 * * 1-5 (prod)"]
    fetch["fetch_repos<br/>config.yaml or<br/>HERMES_SCAN_REPOS"]
    scan["scan_repos<br/>GitHub API GET<br/>(stale PRs, broken CI)"]
    summary["summarize<br/>Markdown → vault note<br/>+ event bus"]

    cron --> fetch --> scan --> summary
    summary -->|"~/brain/00_Inbox/<br/>repo-scan-DATE.md"| vault[("Vault")]
    summary -->|"workflow.run.completed"| bus["Event Bus"]
```

**Key constraint**: strictly READ-ONLY against GitHub. No mutations, no
merges, no comments. Hermes opens PRs, Maxwell reviews (premise P6).

## Harness B: watch-and-notify

```mermaid
flowchart LR
    watch["file_watcher.py<br/>watchdog FSEvents<br/>debounce 2s"]
    detect["detect_change<br/>validate path,<br/>extract metadata"]
    classify["classify_change<br/>rules-based:<br/>brain vs projects"]
    act["act_on_change<br/>low → event bus<br/>med/high → Discord"]

    watch --> detect --> classify --> act
    act -->|"workflow.file_change"| bus["Event Bus"]
    act -->|"medium/high priority"| discord["Discord notification"]
```

**Classification rules**:
| Path pattern | Event | Classification | Priority |
|---|---|---|---|
| `brain/00_Inbox/*.md` | created | `new_note` | medium |
| `brain/00_Inbox/*` | deleted | `note_deleted` | low |
| `brain/01_Projects/*.md` | created | `project_note` | medium |
| `Projects/**/*.py` | any | `code_change` | low |
| `Projects/**/*.ts(x)` | any | `code_change` | low |
| Everything else | any | `file_change` | low |

## Database schema (v8)

```sql
CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY,          -- "wf_morning-repo-scan_1712880000123"
    workflow_id TEXT NOT NULL,     -- "morning-repo-scan"
    workflow_name TEXT NOT NULL,   -- "Morning Repo Scan"
    trigger_type TEXT NOT NULL,    -- "cron" | "file_watch"
    trigger_meta TEXT,             -- JSON
    status TEXT NOT NULL,          -- pending|running|completed|failed|cancelled
    started_at REAL NOT NULL,
    ended_at REAL,
    error TEXT,
    result_summary TEXT
);

CREATE TABLE workflow_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id),
    step_name TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    status TEXT NOT NULL,          -- pending|running|completed|failed|skipped
    started_at REAL,
    ended_at REAL,
    output_summary TEXT,           -- truncated to 500 chars
    error TEXT,
    UNIQUE(run_id, step_index)
);
```

## Event types

| Event | Data fields |
|---|---|
| `workflow.run.started` | run_id, workflow_id, workflow_name, trigger_type |
| `workflow.run.completed` | run_id, workflow_id, status, duration_s, step_count |
| `workflow.run.failed` | run_id, workflow_id, status, step_count |
| `workflow.run.resumed` | run_id, workflow_id, completed_steps, total_steps |
| `workflow.step.started` | run_id, workflow_id, step_name, step_index |
| `workflow.step.completed` | run_id, workflow_id, step_name, step_index, duration_s |
| `workflow.step.failed` | run_id, workflow_id, step_name, step_index, error |
| `workflow.file_change` | path, event_type, classification, priority, description |
| `workflow.notification` | message, source, priority |

## Test coverage (75 tests)

| File | Tests | Covers |
|---|---|---|
| `test_engine.py` | 26 | Schema v8, CRUD, run/resume, context, events, timeout |
| `test_morning_repo_scan.py` | 13 | Config/env sources, GitHub API mock, read-only safety, vault note, E2E |
| `test_file_watcher.py` | 13 | Debounce, excludes, shutdown, no-watchdog fallback |
| `test_watch_and_notify.py` | 15 | Classification rules, priority routing, E2E |
| `test_durability.py` | 8 | Forced-failure drill, idempotency, gateway restart |

## Stress test

`scripts/phase7-stress-test.py` compresses the observation week to ~20 minutes:

1. Morning-repo-scan every 2 min (~10 runs)
2. File churner every 15s + watch-notify triggers (~80 runs)
3. Three kill -9 drills at minutes 5, 12, 18
4. Automated measurement collection → `.claude/rules/recon-phase-7.md`

```bash
./venv/bin/python scripts/phase7-stress-test.py --repo travelinman1013/hermes-agent
./venv/bin/python scripts/phase7-stress-test.py --duration 10 --skip-kills  # quick test
```
