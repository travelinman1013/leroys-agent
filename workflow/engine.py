"""Workflow execution engine — runs WorkflowDef step-by-step with durable checkpointing.

Designed to be called from background threads (cron ticker, file watcher).
Each step is checkpointed to SQLite so workflows survive gateway restart.
Events are published to the event bus for dashboard SSE visibility.
"""

from __future__ import annotations

import logging
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from typing import Any, Dict, List, Optional

from workflow.primitives import StepResult, WorkflowDef, WorkflowRunResult

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Event bus helper (fail-silent, same pattern as cron/scheduler.py)
# ---------------------------------------------------------------------------

def _publish(event_type: str, **data: Any) -> None:
    try:
        from gateway.event_bus import publish
        publish(event_type, data=data)
    except Exception:
        pass  # Event bus unavailable (CLI mode, tests) — never block the engine.


# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------

def _get_db():
    """Return a SessionDB instance or None if unavailable."""
    try:
        from hermes_state import SessionDB
        return SessionDB()
    except Exception:
        logger.debug("SessionDB unavailable — workflow will run without persistence")
        return None


def _truncate(text: str, max_len: int = 500) -> str:
    if not text or len(text) <= max_len:
        return text or ""
    return text[:max_len - 3] + "..."


# ---------------------------------------------------------------------------
# Core execution
# ---------------------------------------------------------------------------

def run_workflow(
    wf: WorkflowDef,
    trigger_meta: Optional[Dict[str, Any]] = None,
    db=None,
) -> WorkflowRunResult:
    """Execute a workflow definition synchronously, checkpointing each step.

    Args:
        wf: The workflow definition to run.
        trigger_meta: Optional trigger context (cron job id, file path, etc.)
        db: Optional SessionDB instance. If None, attempts to create one.

    Returns:
        WorkflowRunResult with per-step results.
    """
    run_id = f"wf_{wf.id}_{int(time.time() * 1000)}"
    started_at = time.time()
    db = db or _get_db()

    # Create the run record
    if db:
        try:
            db.create_workflow_run(
                run_id=run_id,
                workflow_id=wf.id,
                workflow_name=wf.name,
                trigger_type=wf.trigger_type,
                trigger_meta=trigger_meta,
            )
        except Exception as exc:
            logger.warning("Failed to create workflow run record: %s", exc)

    _publish(
        "workflow.run.started",
        run_id=run_id,
        workflow_id=wf.id,
        workflow_name=wf.name,
        trigger_type=wf.trigger_type,
    )

    context: Dict[str, Any] = {"trigger_meta": trigger_meta or {}}
    step_results: List[StepResult] = []
    final_status = "completed"
    final_error: Optional[str] = None

    for idx, step in enumerate(wf.steps):
        step_started = time.time()

        if db:
            try:
                db.create_checkpoint(run_id, step.name, idx)
            except Exception:
                pass

        _publish(
            "workflow.step.started",
            run_id=run_id,
            workflow_id=wf.id,
            step_name=step.name,
            step_index=idx,
        )

        try:
            output = _run_step_with_timeout(step, context)
            step_ended = time.time()

            # Accumulate output into context for subsequent steps
            context[step.name] = output

            sr = StepResult(
                step_name=step.name,
                step_index=idx,
                status="completed",
                output=output,
                started_at=step_started,
                ended_at=step_ended,
            )
            step_results.append(sr)

            if db:
                try:
                    db.update_checkpoint(
                        run_id, idx, "completed",
                        output_summary=_truncate(str(output)),
                    )
                except Exception:
                    pass

            _publish(
                "workflow.step.completed",
                run_id=run_id,
                workflow_id=wf.id,
                step_name=step.name,
                step_index=idx,
                duration_s=round(step_ended - step_started, 2),
            )

        except Exception as exc:
            step_ended = time.time()
            error_msg = f"{type(exc).__name__}: {exc}"

            sr = StepResult(
                step_name=step.name,
                step_index=idx,
                status="failed",
                error=error_msg,
                started_at=step_started,
                ended_at=step_ended,
            )
            step_results.append(sr)

            if db:
                try:
                    db.update_checkpoint(run_id, idx, "failed", error=error_msg)
                except Exception:
                    pass

            _publish(
                "workflow.step.failed",
                run_id=run_id,
                workflow_id=wf.id,
                step_name=step.name,
                step_index=idx,
                error=error_msg,
            )

            if step.skip_on_error:
                logger.warning(
                    "Workflow %s step %s failed (skip_on_error=True): %s",
                    run_id, step.name, error_msg,
                )
                continue

            # Abort remaining steps
            final_status = "failed"
            final_error = f"Step '{step.name}' failed: {error_msg}"
            logger.error("Workflow %s aborted at step %s: %s", run_id, step.name, error_msg)
            break

    ended_at = time.time()

    if db:
        try:
            summary = "; ".join(
                f"{sr.step_name}={sr.status}" for sr in step_results
            )
            db.update_workflow_run(
                run_id, final_status,
                error=final_error,
                result_summary=_truncate(summary),
            )
        except Exception:
            pass

    _publish(
        f"workflow.run.{final_status}",
        run_id=run_id,
        workflow_id=wf.id,
        status=final_status,
        duration_s=round(ended_at - started_at, 2),
        step_count=len(step_results),
    )

    return WorkflowRunResult(
        run_id=run_id,
        workflow_id=wf.id,
        status=final_status,
        steps=step_results,
        started_at=started_at,
        ended_at=ended_at,
        error=final_error,
    )


def _run_step_with_timeout(step, context: Dict[str, Any]) -> Dict[str, Any]:
    """Run a step function with a timeout. Raises on timeout or step error."""
    if step.timeout_s <= 0:
        return step.fn(context)

    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(step.fn, context)
        try:
            return future.result(timeout=step.timeout_s)
        except FuturesTimeout:
            future.cancel()
            raise TimeoutError(
                f"Step '{step.name}' timed out after {step.timeout_s}s"
            )


# ---------------------------------------------------------------------------
# Resume — the durability primitive
# ---------------------------------------------------------------------------

def resume_workflow(
    run_id: str,
    db=None,
) -> Optional[WorkflowRunResult]:
    """Resume a workflow run from its last completed checkpoint.

    Reads the workflow_runs + workflow_checkpoints from the DB, identifies
    the first non-completed step, and re-runs from there.

    Returns None if the run doesn't exist or is already completed.
    """
    db = db or _get_db()
    if not db:
        logger.warning("Cannot resume workflow %s — no DB available", run_id)
        return None

    run = db.get_workflow_run(run_id)
    if not run:
        logger.warning("Workflow run %s not found in DB", run_id)
        return None

    if run["status"] in ("completed", "cancelled"):
        logger.info("Workflow run %s already %s — skipping resume", run_id, run["status"])
        return None

    # Look up the workflow definition
    try:
        from workflow.harnesses import get_harness
        wf = get_harness(run["workflow_id"])
    except KeyError:
        logger.error("Cannot resume %s — unknown workflow %s", run_id, run["workflow_id"])
        db.update_workflow_run(run_id, "failed", error=f"Unknown workflow: {run['workflow_id']}")
        return None

    checkpoints = run.get("checkpoints", [])
    completed_indices = {
        cp["step_index"] for cp in checkpoints if cp["status"] == "completed"
    }

    # Rebuild context from completed checkpoints
    context: Dict[str, Any] = {
        "trigger_meta": run.get("trigger_meta") or {},
    }
    for cp in checkpoints:
        if cp["status"] == "completed" and cp.get("output_summary"):
            context[cp["step_name"]] = {"_resumed": True, "summary": cp["output_summary"]}

    _publish(
        "workflow.run.resumed",
        run_id=run_id,
        workflow_id=run["workflow_id"],
        completed_steps=len(completed_indices),
        total_steps=len(wf.steps),
    )

    step_results: List[StepResult] = []
    final_status = "completed"
    final_error: Optional[str] = None

    for idx, step in enumerate(wf.steps):
        if idx in completed_indices:
            step_results.append(StepResult(
                step_name=step.name,
                step_index=idx,
                status="completed",
                output=context.get(step.name, {}),
                started_at=0.0,
                ended_at=0.0,
            ))
            continue

        # Run this step
        step_started = time.time()
        try:
            db.create_checkpoint(run_id, step.name, idx)
        except Exception:
            pass

        _publish(
            "workflow.step.started",
            run_id=run_id,
            workflow_id=run["workflow_id"],
            step_name=step.name,
            step_index=idx,
        )

        try:
            output = _run_step_with_timeout(step, context)
            step_ended = time.time()
            context[step.name] = output

            sr = StepResult(
                step_name=step.name,
                step_index=idx,
                status="completed",
                output=output,
                started_at=step_started,
                ended_at=step_ended,
            )
            step_results.append(sr)

            try:
                db.update_checkpoint(
                    run_id, idx, "completed",
                    output_summary=_truncate(str(output)),
                )
            except Exception:
                pass

            _publish(
                "workflow.step.completed",
                run_id=run_id,
                workflow_id=run["workflow_id"],
                step_name=step.name,
                step_index=idx,
                duration_s=round(step_ended - step_started, 2),
            )

        except Exception as exc:
            step_ended = time.time()
            error_msg = f"{type(exc).__name__}: {exc}"

            sr = StepResult(
                step_name=step.name,
                step_index=idx,
                status="failed",
                error=error_msg,
                started_at=step_started,
                ended_at=step_ended,
            )
            step_results.append(sr)

            try:
                db.update_checkpoint(run_id, idx, "failed", error=error_msg)
            except Exception:
                pass

            _publish(
                "workflow.step.failed",
                run_id=run_id,
                workflow_id=run["workflow_id"],
                step_name=step.name,
                step_index=idx,
                error=error_msg,
            )

            if step.skip_on_error:
                continue

            final_status = "failed"
            final_error = f"Step '{step.name}' failed: {error_msg}"
            break

    ended_at = time.time()

    try:
        summary = "; ".join(f"{sr.step_name}={sr.status}" for sr in step_results)
        db.update_workflow_run(
            run_id, final_status,
            error=final_error,
            result_summary=_truncate(summary),
        )
    except Exception:
        pass

    _publish(
        f"workflow.run.{final_status}",
        run_id=run_id,
        workflow_id=run["workflow_id"],
        status=final_status,
        step_count=len(step_results),
    )

    return WorkflowRunResult(
        run_id=run_id,
        workflow_id=run["workflow_id"],
        status=final_status,
        steps=step_results,
        started_at=run.get("started_at", 0.0),
        ended_at=ended_at,
        error=final_error,
    )
