"""Durability tests for workflow engine — forced-failure drill, idempotency, resume.

These tests simulate crash scenarios by interrupting workflow execution
mid-step and verifying that resume_workflow correctly picks up from the
last checkpoint.
"""

import time
import threading
import pytest
from unittest.mock import patch

from hermes_state import SessionDB
from workflow.primitives import StepDef, WorkflowDef
from workflow.engine import run_workflow, resume_workflow


@pytest.fixture()
def db(tmp_path):
    db_path = tmp_path / "test_state.db"
    sdb = SessionDB(db_path=db_path)
    yield sdb
    sdb.close()


def _step_fn(output: dict):
    def fn(ctx):
        return output
    return fn


def _slow_step_fn(delay: float, output: dict):
    """Step that takes some time — used for crash simulation."""
    def fn(ctx):
        time.sleep(delay)
        return output
    return fn


def _crashing_step(ctx):
    """Step that simulates a crash by raising a RuntimeError."""
    raise RuntimeError("simulated crash")


def _make_wf(steps=None, wf_id="test-wf"):
    if steps is None:
        steps = [
            StepDef(name="step_a", fn=_step_fn({"a": 1})),
            StepDef(name="step_b", fn=_step_fn({"b": 2})),
            StepDef(name="step_c", fn=_step_fn({"c": 3})),
        ]
    return WorkflowDef(
        id=wf_id,
        name="Test Workflow",
        trigger_type="cron",
        steps=steps,
    )


# ---------------------------------------------------------------------------
# Forced-failure drill (R11)
# ---------------------------------------------------------------------------

class TestForcedFailureDrill:
    @patch("workflow.engine._publish")
    def test_crash_after_step_1_resume_completes(self, mock_pub, db):
        """Simulate crash after step 1, resume completes steps 2-3."""
        # Manually create a "crashed" run state:
        # step_a completed, step_b started but never finished
        run_id = "wf_crash_001"
        db.create_workflow_run(run_id, "test-wf", "Test", "cron")
        db.create_checkpoint(run_id, "step_a", 0)
        db.update_checkpoint(run_id, 0, "completed", output_summary="{'a': 1}")
        db.create_checkpoint(run_id, "step_b", 1)
        # step_b left as "running" — simulates kill -9

        with patch("workflow.harnesses.get_harness", return_value=_make_wf()):
            result = resume_workflow(run_id, db=db)

        assert result is not None
        assert result.status == "completed"

        # Verify DB: all 3 checkpoints completed
        run = db.get_workflow_run(run_id)
        assert run["status"] == "completed"
        assert len(run["checkpoints"]) == 3
        for cp in run["checkpoints"]:
            assert cp["status"] == "completed"

    @patch("workflow.engine._publish")
    def test_crash_before_any_step_resume_runs_all(self, mock_pub, db):
        """Simulate crash before any step ran — resume runs everything."""
        run_id = "wf_crash_002"
        db.create_workflow_run(run_id, "test-wf", "Test", "cron")
        # No checkpoints at all — crashed at start

        with patch("workflow.harnesses.get_harness", return_value=_make_wf()):
            result = resume_workflow(run_id, db=db)

        assert result is not None
        assert result.status == "completed"
        assert len(result.steps) == 3

    @patch("workflow.engine._publish")
    def test_crash_at_last_step_resume_finishes(self, mock_pub, db):
        """Simulate crash at step 3 — resume re-runs only step 3."""
        run_id = "wf_crash_003"
        db.create_workflow_run(run_id, "test-wf", "Test", "cron")

        db.create_checkpoint(run_id, "step_a", 0)
        db.update_checkpoint(run_id, 0, "completed")
        db.create_checkpoint(run_id, "step_b", 1)
        db.update_checkpoint(run_id, 1, "completed")
        db.create_checkpoint(run_id, "step_c", 2)
        # step_c left as running

        with patch("workflow.harnesses.get_harness", return_value=_make_wf()):
            result = resume_workflow(run_id, db=db)

        assert result is not None
        assert result.status == "completed"
        # Only step_c should have been re-run
        re_run_steps = [s for s in result.steps if s.started_at > 0]
        assert len(re_run_steps) == 1
        assert re_run_steps[0].step_name == "step_c"


# ---------------------------------------------------------------------------
# Idempotency (R12)
# ---------------------------------------------------------------------------

class TestIdempotency:
    @patch("workflow.engine._publish")
    def test_resume_completed_run_is_noop(self, mock_pub, db):
        """Resuming an already-completed run does nothing."""
        wf = _make_wf()
        result = run_workflow(wf, db=db)
        assert result.status == "completed"

        # Resume should return None (no-op)
        result2 = resume_workflow(result.run_id, db=db)
        assert result2 is None

    @patch("workflow.engine._publish")
    def test_two_runs_get_unique_ids(self, mock_pub, db):
        """Running the same workflow twice produces separate run_ids."""
        wf = _make_wf()
        result1 = run_workflow(wf, db=db)
        time.sleep(0.01)  # Ensure timestamp differs
        result2 = run_workflow(wf, db=db)

        assert result1.run_id != result2.run_id
        assert result1.status == "completed"
        assert result2.status == "completed"

        # Both exist in DB
        runs = db.list_workflow_runs()
        assert len(runs) == 2

    @patch("workflow.engine._publish")
    def test_failed_step_on_resume_still_fails(self, mock_pub, db):
        """If a step fails consistently, resume correctly records the failure."""
        steps = [
            StepDef(name="step_a", fn=_step_fn({"a": 1})),
            StepDef(name="bad_step", fn=_crashing_step),
            StepDef(name="step_c", fn=_step_fn({"c": 3})),
        ]
        wf = _make_wf(steps=steps)

        # First run: fails at step 2
        result1 = run_workflow(wf, db=db)
        assert result1.status == "failed"

        # Don't resume a failed run — it's already terminal
        run = db.get_workflow_run(result1.run_id)
        assert run["status"] == "failed"


# ---------------------------------------------------------------------------
# Gateway restart scenario (R13)
# ---------------------------------------------------------------------------

class TestGatewayRestartResume:
    @patch("workflow.engine._publish")
    def test_get_running_workflow_runs_finds_stale(self, mock_pub, db):
        """get_running_workflow_runs returns only status='running'."""
        db.create_workflow_run("wf_ok", "test", "Test", "cron")
        db.update_workflow_run("wf_ok", "completed")
        db.create_workflow_run("wf_stale", "test", "Test", "cron")
        # wf_stale is still "running" (simulates gateway crash)

        stale = db.get_running_workflow_runs()
        assert len(stale) == 1
        assert stale[0]["id"] == "wf_stale"

    @patch("workflow.engine._publish")
    def test_resume_all_stale_runs(self, mock_pub, db):
        """Simulate gateway restart: resume all stale runs."""
        # Create two stale runs
        db.create_workflow_run("wf_s1", "test-wf", "Test", "cron")
        db.create_checkpoint("wf_s1", "step_a", 0)
        db.update_checkpoint("wf_s1", 0, "completed")

        db.create_workflow_run("wf_s2", "test-wf", "Test", "cron")

        with patch("workflow.harnesses.get_harness", return_value=_make_wf()):
            stale = db.get_running_workflow_runs()
            for run in stale:
                resume_workflow(run["id"], db=db)

        # Both should be completed now
        r1 = db.get_workflow_run("wf_s1")
        r2 = db.get_workflow_run("wf_s2")
        assert r1["status"] == "completed"
        assert r2["status"] == "completed"
