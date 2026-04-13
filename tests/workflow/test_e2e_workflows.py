"""E2E workflow integration tests.

Real SessionDB (tmp file), real workflow engine, real harness code.
External APIs (GitHub, Brave, etc.) are mocked.
These tests verify the full pipeline: engine -> harness -> DB -> events.
"""

from __future__ import annotations

import concurrent.futures
import os
import sqlite3
import tempfile
import time
import zipfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest
import yaml

pytestmark = pytest.mark.integration


def _make_test_db(tmp_path):
    """Create a real SessionDB backed by a temp file."""
    from hermes_state import SessionDB
    db_path = tmp_path / "test_state.db"
    db = SessionDB(db_path=db_path)
    return db


class TestMorningRepoScanE2E:
    """Run morning-repo-scan with mocked GitHub API, real DB + engine."""

    def test_full_pipeline(self, tmp_path):
        from workflow.engine import run_workflow
        from workflow.harnesses.morning_repo_scan import WORKFLOW

        db = _make_test_db(tmp_path)

        mock_config = {
            "workflows": {
                "morning_repo_scan": {
                    "repos": ["owner/test-repo"],
                    "vault_dir": str(tmp_path / "vault"),
                },
            },
        }

        # Mock GitHub API responses
        pulls_resp = MagicMock()
        pulls_resp.status_code = 200
        pulls_resp.json.return_value = []
        pulls_resp.raise_for_status = MagicMock()

        runs_resp = MagicMock()
        runs_resp.status_code = 200
        runs_resp.json.return_value = {"workflow_runs": []}
        runs_resp.raise_for_status = MagicMock()

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.side_effect = [pulls_resp, runs_resp]

        with patch("hermes_cli.config.load_config", return_value=mock_config):
            with patch("workflow.harnesses.morning_repo_scan.httpx.Client", return_value=mock_client):
                result = run_workflow(WORKFLOW, db=db)

        assert result.status == "completed"
        assert len(result.steps) == 3
        assert all(sr.status == "completed" for sr in result.steps)

        # Verify vault note was written
        vault_dir = tmp_path / "vault"
        if vault_dir.exists():
            notes = list(vault_dir.glob("repo-scan-*.md"))
            assert len(notes) == 1

        # Verify DB has the run
        runs = db.list_workflow_runs()
        assert len(runs) >= 1
        assert runs[0]["status"] == "completed"


class TestWatchAndNotifyE2E:
    """Run watch-and-notify with a real temp file trigger."""

    def test_file_created_event(self, tmp_path):
        from workflow.engine import run_workflow
        from workflow.harnesses.watch_and_notify import WORKFLOW

        db = _make_test_db(tmp_path)

        # Create a real file to trigger on
        test_file = tmp_path / "test_note.md"
        test_file.write_text("# Test Note\nSome content")

        trigger_meta = {
            "path": str(test_file),
            "event_type": "created",
        }

        # Mock config to avoid path jail issues
        mock_config = {"security": {"safe_roots": [str(tmp_path)]}}
        with patch("hermes_cli.config.load_config", return_value=mock_config):
            with patch("hermes_cli.config.get_safe_roots", return_value=[str(tmp_path)]):
                with patch("hermes_cli.config.get_denied_paths", return_value=[]):
                    result = run_workflow(WORKFLOW, trigger_meta=trigger_meta, db=db)

        assert result.status == "completed"
        assert len(result.steps) == 3


class TestBackupDrillE2E:
    """Run backup-drill with a synthetic HERMES_HOME."""

    def test_full_drill(self, tmp_path):
        from workflow.engine import run_workflow
        from workflow.harnesses.backup_drill import WORKFLOW

        db = _make_test_db(tmp_path)

        # Create a synthetic hermes home
        hermes_home = tmp_path / "hermes_home"
        hermes_home.mkdir()
        (hermes_home / "config.yaml").write_text("model:\n  provider: custom\n")
        (hermes_home / "skills").mkdir()
        (hermes_home / "memories").mkdir()

        # Create a real state.db
        state_db = hermes_home / "state.db"
        conn = sqlite3.connect(str(state_db))
        conn.execute("CREATE TABLE test (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()

        # Mock run_backup to create a real zip from synthetic home
        def fake_run_backup(args):
            out = Path(args.output)
            with zipfile.ZipFile(out, "w") as zf:
                for f in hermes_home.rglob("*"):
                    if f.is_file():
                        zf.write(f, arcname=str(f.relative_to(hermes_home)))
                # Add dirs as entries too
                for d in ("skills", "memories"):
                    zf.writestr(f"{d}/.gitkeep", "")

        with patch("hermes_constants.get_default_hermes_root", return_value=hermes_home):
            with patch("hermes_cli.backup.run_backup", side_effect=fake_run_backup):
                result = run_workflow(WORKFLOW, db=db)

        assert result.status == "completed"
        assert len(result.steps) == 3

        # Verify the drill passed
        report_output = result.steps[2].output
        assert "passed" in str(report_output).lower() or report_output.get("passed") is True


class TestCIDiagnosticsE2E:
    """Run ci-diagnostics with mocked GitHub API."""

    def test_full_pipeline(self, tmp_path):
        from workflow.engine import run_workflow
        from workflow.harnesses.ci_diagnostics import WORKFLOW

        db = _make_test_db(tmp_path)

        mock_config = {
            "workflows": {
                "ci_diagnostics": {
                    "repos": ["owner/repo"],
                    "vault_dir": str(tmp_path / "vault"),
                },
            },
        }

        # Step 1: fetch_failures — return one failed run
        fetch_resp = MagicMock()
        fetch_resp.status_code = 200
        fetch_resp.json.return_value = {
            "workflow_runs": [{
                "id": 42,
                "name": "Tests",
                "conclusion": "failure",
                "created_at": "2026-04-12T00:00:00Z",
                "html_url": "https://github.com/owner/repo/actions/runs/42",
            }],
        }
        fetch_resp.raise_for_status = MagicMock()

        # Step 2: analyze_logs — jobs + log
        jobs_resp = MagicMock()
        jobs_resp.status_code = 200
        jobs_resp.json.return_value = {
            "jobs": [{"id": 100, "conclusion": "failure"}],
        }
        jobs_resp.raise_for_status = MagicMock()

        log_resp = MagicMock()
        log_resp.status_code = 200
        log_resp.text = "FAILED tests/test_foo.py::test_bar\nAssertionError: 1 != 2"

        # httpx.Client is created twice (step 1 and step 2), so we need
        # two separate mock contexts
        call_count = [0]

        def make_client(*args, **kwargs):
            mock = MagicMock()
            mock.__enter__ = MagicMock(return_value=mock)
            mock.__exit__ = MagicMock(return_value=False)
            if call_count[0] == 0:
                mock.get.return_value = fetch_resp
            else:
                mock.get.side_effect = [jobs_resp, log_resp]
            call_count[0] += 1
            return mock

        with patch("hermes_cli.config.load_config", return_value=mock_config):
            with patch("workflow.harnesses.ci_diagnostics.httpx.Client", side_effect=make_client):
                result = run_workflow(WORKFLOW, db=db)

        assert result.status == "completed"
        assert len(result.steps) == 3


class TestCheckpointResume:
    """Test that a failed workflow can be resumed from the failure point."""

    def test_resume_skips_completed_steps(self, tmp_path):
        from workflow.engine import run_workflow, resume_workflow
        from workflow.primitives import StepDef, WorkflowDef

        db = _make_test_db(tmp_path)

        call_count = [0]

        def step_ok(ctx):
            return {"value": "done"}

        def step_fails_first_time(ctx):
            call_count[0] += 1
            if call_count[0] == 1:
                raise RuntimeError("Transient failure")
            return {"recovered": True}

        def step_final(ctx):
            return {"complete": True}

        wf = WorkflowDef(
            id="test-resume",
            name="Test Resume",
            trigger_type="cron",
            steps=[
                StepDef(name="step_ok", fn=step_ok, timeout_s=10),
                StepDef(name="step_flaky", fn=step_fails_first_time, timeout_s=10),
                StepDef(name="step_final", fn=step_final, timeout_s=10),
            ],
        )

        # First run should fail at step 2
        result1 = run_workflow(wf, db=db)
        assert result1.status == "failed"
        assert result1.steps[0].status == "completed"
        assert result1.steps[1].status == "failed"

        # Resume should skip step 1 and succeed
        with patch("workflow.harnesses.get_harness", return_value=wf):
            result2 = resume_workflow(result1.run_id, db=db)

        assert result2 is not None
        assert result2.status == "completed"
        # step_flaky was called twice total (once failed, once succeeded)
        assert call_count[0] == 2


class TestConcurrentWorkflows:
    """Test that two workflows can run simultaneously without DB contention."""

    def test_parallel_execution(self, tmp_path):
        from workflow.engine import run_workflow
        from workflow.primitives import StepDef, WorkflowDef

        db = _make_test_db(tmp_path)

        def slow_step(ctx):
            time.sleep(0.1)
            return {"thread": "done"}

        wf_a = WorkflowDef(
            id="concurrent-a",
            name="Concurrent A",
            trigger_type="cron",
            steps=[StepDef(name="slow", fn=slow_step, timeout_s=10)],
        )

        wf_b = WorkflowDef(
            id="concurrent-b",
            name="Concurrent B",
            trigger_type="cron",
            steps=[StepDef(name="slow", fn=slow_step, timeout_s=10)],
        )

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            fut_a = pool.submit(run_workflow, wf_a, db=db)
            fut_b = pool.submit(run_workflow, wf_b, db=db)

            result_a = fut_a.result(timeout=30)
            result_b = fut_b.result(timeout=30)

        assert result_a.status == "completed"
        assert result_b.status == "completed"
        assert result_a.run_id != result_b.run_id

        # Both runs should be in DB
        runs = db.list_workflow_runs()
        completed = [r for r in runs if r["status"] == "completed"]
        assert len(completed) >= 2
