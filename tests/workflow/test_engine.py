"""Tests for workflow engine — schema v8, CRUD, run_workflow, resume_workflow."""

import time
import pytest
from unittest.mock import patch, MagicMock

from hermes_state import SessionDB
from workflow.primitives import StepDef, WorkflowDef
from workflow.engine import run_workflow, resume_workflow, _truncate


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def db(tmp_path):
    """SessionDB with temp database — schema v8 tables available."""
    db_path = tmp_path / "test_state.db"
    session_db = SessionDB(db_path=db_path)
    yield session_db
    session_db.close()


def _step_fn(output: dict):
    """Factory for a step function that returns a fixed output."""
    def fn(ctx):
        return output
    return fn


def _failing_step(ctx):
    raise ValueError("step exploded")


def _slow_step(ctx):
    time.sleep(5)
    return {"done": True}


def _make_wf(steps=None, wf_id="test-wf"):
    """Build a simple WorkflowDef for testing."""
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
# Schema v8 migration
# ---------------------------------------------------------------------------

class TestSchemaV8:
    def test_workflow_tables_exist(self, db):
        """Schema v8 creates workflow_runs and workflow_checkpoints tables."""
        with db._lock:
            tables = db._conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
        table_names = [t["name"] for t in tables]
        assert "workflow_runs" in table_names
        assert "workflow_checkpoints" in table_names

    def test_schema_version_is_current(self, db):
        with db._lock:
            row = db._conn.execute("SELECT version FROM schema_version").fetchone()
        version = row["version"] if hasattr(row, "keys") else row[0]
        from hermes_state import SCHEMA_VERSION
        assert version == SCHEMA_VERSION


# ---------------------------------------------------------------------------
# Workflow CRUD
# ---------------------------------------------------------------------------

class TestWorkflowCRUD:
    def test_create_and_get_run(self, db):
        run_id = db.create_workflow_run(
            run_id="wf_test_001",
            workflow_id="morning-repo-scan",
            workflow_name="Morning Repo Scan",
            trigger_type="cron",
            trigger_meta={"cron_job_id": "abc123"},
        )
        assert run_id == "wf_test_001"

        run = db.get_workflow_run("wf_test_001")
        assert run is not None
        assert run["workflow_id"] == "morning-repo-scan"
        assert run["status"] == "running"
        assert run["trigger_meta"] == {"cron_job_id": "abc123"}
        assert run["checkpoints"] == []

    def test_get_nonexistent_run(self, db):
        assert db.get_workflow_run("nonexistent") is None

    def test_update_run_completed(self, db):
        db.create_workflow_run("wf_001", "test", "Test", "cron")
        db.update_workflow_run("wf_001", "completed", result_summary="all good")

        run = db.get_workflow_run("wf_001")
        assert run["status"] == "completed"
        assert run["ended_at"] is not None
        assert run["result_summary"] == "all good"

    def test_update_run_failed(self, db):
        db.create_workflow_run("wf_001", "test", "Test", "cron")
        db.update_workflow_run("wf_001", "failed", error="boom")

        run = db.get_workflow_run("wf_001")
        assert run["status"] == "failed"
        assert run["error"] == "boom"

    def test_create_and_update_checkpoint(self, db):
        db.create_workflow_run("wf_001", "test", "Test", "cron")
        db.create_checkpoint("wf_001", "step_a", 0)

        cps = db.get_checkpoints("wf_001")
        assert len(cps) == 1
        assert cps[0]["step_name"] == "step_a"
        assert cps[0]["status"] == "running"

        db.update_checkpoint("wf_001", 0, "completed", output_summary="done")
        cps = db.get_checkpoints("wf_001")
        assert cps[0]["status"] == "completed"
        assert cps[0]["output_summary"] == "done"

    def test_list_workflow_runs(self, db):
        db.create_workflow_run("wf_001", "test", "Test", "cron")
        db.create_workflow_run("wf_002", "test", "Test", "file_watch")
        db.update_workflow_run("wf_001", "completed")

        all_runs = db.list_workflow_runs()
        assert len(all_runs) == 2

        running = db.list_workflow_runs(status="running")
        assert len(running) == 1
        assert running[0]["id"] == "wf_002"

    def test_get_running_workflow_runs(self, db):
        db.create_workflow_run("wf_001", "test", "Test", "cron")
        db.create_workflow_run("wf_002", "test", "Test", "cron")
        db.update_workflow_run("wf_001", "completed")

        running = db.get_running_workflow_runs()
        assert len(running) == 1
        assert running[0]["id"] == "wf_002"

    def test_checkpoint_unique_constraint(self, db):
        db.create_workflow_run("wf_001", "test", "Test", "cron")
        db.create_checkpoint("wf_001", "step_a", 0)
        # INSERT OR REPLACE — should not fail
        db.create_checkpoint("wf_001", "step_a", 0)
        cps = db.get_checkpoints("wf_001")
        assert len(cps) == 1


# ---------------------------------------------------------------------------
# run_workflow
# ---------------------------------------------------------------------------

class TestRunWorkflow:
    @patch("workflow.engine._publish")
    def test_happy_path(self, mock_pub, db):
        wf = _make_wf()
        result = run_workflow(wf, db=db)

        assert result.status == "completed"
        assert len(result.steps) == 3
        assert all(s.status == "completed" for s in result.steps)
        assert result.error is None

        # Check DB state
        run = db.get_workflow_run(result.run_id)
        assert run["status"] == "completed"
        assert len(run["checkpoints"]) == 3
        assert all(c["status"] == "completed" for c in run["checkpoints"])

    @patch("workflow.engine._publish")
    def test_step_failure_aborts(self, mock_pub, db):
        steps = [
            StepDef(name="ok_step", fn=_step_fn({"ok": True})),
            StepDef(name="bad_step", fn=_failing_step),
            StepDef(name="never_step", fn=_step_fn({"nope": True})),
        ]
        wf = _make_wf(steps=steps)
        result = run_workflow(wf, db=db)

        assert result.status == "failed"
        assert len(result.steps) == 2
        assert result.steps[0].status == "completed"
        assert result.steps[1].status == "failed"
        assert "step exploded" in result.error

        # Verify never_step was not checkpointed
        cps = db.get_checkpoints(result.run_id)
        assert len(cps) == 2

    @patch("workflow.engine._publish")
    def test_skip_on_error(self, mock_pub, db):
        steps = [
            StepDef(name="ok_step", fn=_step_fn({"ok": True})),
            StepDef(name="bad_step", fn=_failing_step, skip_on_error=True),
            StepDef(name="still_runs", fn=_step_fn({"ran": True})),
        ]
        wf = _make_wf(steps=steps)
        result = run_workflow(wf, db=db)

        assert result.status == "completed"
        assert len(result.steps) == 3
        assert result.steps[1].status == "failed"
        assert result.steps[2].status == "completed"

    @patch("workflow.engine._publish")
    def test_step_timeout(self, mock_pub, db):
        steps = [
            StepDef(name="slow", fn=_slow_step, timeout_s=0.1),
        ]
        wf = _make_wf(steps=steps)
        result = run_workflow(wf, db=db)

        assert result.status == "failed"
        assert "timed out" in result.steps[0].error

    @patch("workflow.engine._publish")
    def test_context_accumulates(self, mock_pub, db):
        """Each step receives prior steps' outputs in context."""
        captured = {}

        def step_b_fn(ctx):
            captured.update(ctx)
            return {"b": 2}

        steps = [
            StepDef(name="step_a", fn=_step_fn({"a": 1})),
            StepDef(name="step_b", fn=step_b_fn),
        ]
        wf = _make_wf(steps=steps)
        run_workflow(wf, db=db)

        assert captured.get("step_a") == {"a": 1}

    @patch("workflow.engine._publish")
    def test_events_published(self, mock_pub, db):
        wf = _make_wf(steps=[StepDef(name="one", fn=_step_fn({"x": 1}))])
        run_workflow(wf, db=db)

        event_types = [call.args[0] for call in mock_pub.call_args_list]
        assert "workflow.run.started" in event_types
        assert "workflow.step.started" in event_types
        assert "workflow.step.completed" in event_types
        assert "workflow.run.completed" in event_types

    @patch("workflow.engine._publish")
    def test_no_db_still_runs(self, mock_pub):
        """Workflow runs even without a database (event-only mode)."""
        wf = _make_wf(steps=[StepDef(name="one", fn=_step_fn({"x": 1}))])
        result = run_workflow(wf, db=None)

        assert result.status == "completed"

    @patch("workflow.engine._publish")
    def test_trigger_meta_in_context(self, mock_pub, db):
        captured = {}

        def capture_fn(ctx):
            captured.update(ctx)
            return {}

        wf = _make_wf(steps=[StepDef(name="cap", fn=capture_fn)])
        run_workflow(wf, trigger_meta={"job_id": "j1"}, db=db)

        assert captured["trigger_meta"] == {"job_id": "j1"}


# ---------------------------------------------------------------------------
# resume_workflow
# ---------------------------------------------------------------------------

class TestResumeWorkflow:
    @patch("workflow.engine._publish")
    def test_resume_skips_completed_steps(self, mock_pub, db):
        # Simulate a partially completed run
        db.create_workflow_run("wf_resume_001", "test-wf", "Test", "cron")
        db.create_checkpoint("wf_resume_001", "step_a", 0)
        db.update_checkpoint("wf_resume_001", 0, "completed", output_summary="{'a': 1}")
        db.create_checkpoint("wf_resume_001", "step_b", 1)
        # step_b left as "running" (crash simulation)

        with patch("workflow.harnesses.get_harness") as mock_harness:
            mock_harness.return_value = _make_wf()
            result = resume_workflow("wf_resume_001", db=db)

        assert result is not None
        assert result.status == "completed"
        # step_a was skipped (already completed), step_b + step_c ran
        assert result.steps[0].status == "completed"  # step_a (from DB)
        assert result.steps[1].status == "completed"  # step_b (re-run)
        assert result.steps[2].status == "completed"  # step_c (new)

    @patch("workflow.engine._publish")
    def test_resume_completed_run_is_noop(self, mock_pub, db):
        db.create_workflow_run("wf_done", "test-wf", "Test", "cron")
        db.update_workflow_run("wf_done", "completed")

        result = resume_workflow("wf_done", db=db)
        assert result is None

    @patch("workflow.engine._publish")
    def test_resume_nonexistent_returns_none(self, mock_pub, db):
        result = resume_workflow("wf_nope", db=db)
        assert result is None

    @patch("workflow.engine._publish")
    def test_resume_unknown_workflow_fails(self, mock_pub, db):
        db.create_workflow_run("wf_bad", "unknown-wf", "Unknown", "cron")

        with patch("workflow.harnesses.get_harness", side_effect=KeyError("nope")):
            result = resume_workflow("wf_bad", db=db)

        assert result is None
        run = db.get_workflow_run("wf_bad")
        assert run["status"] == "failed"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class TestTruncate:
    def test_short_string(self):
        assert _truncate("hello", 500) == "hello"

    def test_long_string(self):
        result = _truncate("x" * 1000, 500)
        assert len(result) == 500
        assert result.endswith("...")

    def test_none(self):
        assert _truncate(None) == ""

    def test_empty(self):
        assert _truncate("") == ""
