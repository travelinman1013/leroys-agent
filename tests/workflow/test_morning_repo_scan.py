"""Tests for Harness A: morning-repo-scan workflow."""

import json
import os
import pytest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch, MagicMock

from hermes_state import SessionDB
from workflow.engine import run_workflow
import workflow.harnesses.morning_repo_scan as mrs_mod
from workflow.harnesses.morning_repo_scan import (
    WORKFLOW,
    fetch_repos,
    scan_repos,
    summarize,
    _STALE_PR_DAYS,
)

_CONFIG_PATCH = "hermes_cli.config.load_config"
_HTTPX_PATCH = "workflow.harnesses.morning_repo_scan.httpx.Client"
_HOME_PATCH = "pathlib.Path.home"
_SAFE_ROOTS_PATCH = "hermes_cli.config.get_safe_roots"
_DENIED_PATHS_PATCH = "hermes_cli.config.get_denied_paths"


@pytest.fixture()
def db(tmp_path):
    db_path = tmp_path / "test_state.db"
    sdb = SessionDB(db_path=db_path)
    yield sdb
    sdb.close()


# ---------------------------------------------------------------------------
# Step 1: fetch_repos
# ---------------------------------------------------------------------------

class TestFetchRepos:
    def test_from_config(self):
        mock_config = {
            "workflows": {
                "morning_repo_scan": {
                    "repos": ["owner/repo1", "owner/repo2"],
                }
            }
        }
        with patch(_CONFIG_PATCH, return_value=mock_config):
            result = fetch_repos({})
        assert result["repos"] == ["owner/repo1", "owner/repo2"]

    def test_from_env_var(self):
        with (
            patch(_CONFIG_PATCH, side_effect=ImportError),
            patch.dict(os.environ, {"HERMES_SCAN_REPOS": "a/b, c/d"}),
        ):
            result = fetch_repos({})
        assert result["repos"] == ["a/b", "c/d"]

    def test_no_repos_raises(self):
        with (
            patch(_CONFIG_PATCH, return_value={}),
            patch.dict(os.environ, {}, clear=True),
        ):
            # Remove the env var if it exists
            os.environ.pop("HERMES_SCAN_REPOS", None)
            with pytest.raises(ValueError, match="No repos configured"):
                fetch_repos({})


# ---------------------------------------------------------------------------
# Step 2: scan_repos
# ---------------------------------------------------------------------------

class TestScanRepos:
    def _mock_responses(self, client_mock, stale_prs=None, broken_runs=None, status_code=200):
        """Configure httpx.Client mock to return PR and CI data."""
        stale_prs = stale_prs or []
        broken_runs = broken_runs or []

        def mock_get(url, **kwargs):
            resp = MagicMock()
            resp.status_code = status_code
            resp.raise_for_status = MagicMock()

            if "/pulls" in url:
                resp.json.return_value = stale_prs
            elif "/actions/runs" in url:
                resp.json.return_value = {"workflow_runs": broken_runs}
            else:
                resp.json.return_value = {}
            return resp

        client_instance = MagicMock()
        client_instance.get = mock_get
        client_instance.__enter__ = lambda s: client_instance
        client_instance.__exit__ = lambda s, *a: None
        client_mock.return_value = client_instance
        return client_instance

    @patch(_HTTPX_PATCH)
    def test_detects_stale_prs(self, client_mock):
        old_date = (datetime.now(timezone.utc) - timedelta(days=14)).isoformat()
        self._mock_responses(client_mock, stale_prs=[
            {"number": 1, "title": "Old PR", "updated_at": old_date, "html_url": "https://github.com/o/r/pull/1"},
        ])

        ctx = {"fetch_repos": {"repos": ["owner/repo"]}}
        result = scan_repos(ctx)

        assert len(result["findings"]) == 1
        assert len(result["findings"][0]["stale_prs"]) == 1
        assert result["findings"][0]["stale_prs"][0]["number"] == 1

    @patch(_HTTPX_PATCH)
    def test_detects_broken_ci(self, client_mock):
        self._mock_responses(client_mock, broken_runs=[
            {"id": 100, "name": "CI", "conclusion": "failure", "created_at": "2026-04-10T00:00:00Z", "html_url": "https://github.com/o/r/actions/100"},
        ])

        ctx = {"fetch_repos": {"repos": ["owner/repo"]}}
        result = scan_repos(ctx)

        assert len(result["findings"][0]["broken_ci"]) == 1

    @patch(_HTTPX_PATCH)
    def test_handles_api_error(self, client_mock):
        import httpx as real_httpx

        def mock_get(url, **kwargs):
            resp = MagicMock()
            resp.status_code = 403
            resp.text = "Rate limited"
            resp.raise_for_status.side_effect = real_httpx.HTTPStatusError(
                "403", request=MagicMock(), response=resp
            )
            return resp

        client_instance = MagicMock()
        client_instance.get = mock_get
        client_instance.__enter__ = lambda s: client_instance
        client_instance.__exit__ = lambda s, *a: None
        client_mock.return_value = client_instance

        ctx = {"fetch_repos": {"repos": ["owner/repo"]}}
        result = scan_repos(ctx)

        assert result["findings"][0]["error"] is not None
        assert "403" in result["findings"][0]["error"]

    @patch(_HTTPX_PATCH)
    def test_no_repos_returns_empty(self, client_mock):
        result = scan_repos({"fetch_repos": {"repos": []}})
        assert result["findings"] == []

    @patch(_HTTPX_PATCH)
    def test_read_only_no_mutations(self, client_mock):
        """Verify only GET requests are made — no POST/PUT/PATCH/DELETE."""
        self._mock_responses(client_mock)

        ctx = {"fetch_repos": {"repos": ["owner/repo"]}}
        scan_repos(ctx)

        client_instance = client_mock.return_value
        # Only .get() should be called on the client
        assert not hasattr(client_instance, 'post') or not client_instance.post.called
        assert not hasattr(client_instance, 'put') or not client_instance.put.called
        assert not hasattr(client_instance, 'patch') or not client_instance.patch.called
        assert not hasattr(client_instance, 'delete') or not client_instance.delete.called


# ---------------------------------------------------------------------------
# Step 3: summarize
# ---------------------------------------------------------------------------

class TestSummarize:
    def test_formats_markdown(self):
        ctx = {
            "scan_repos": {
                "findings": [
                    {
                        "repo": "owner/repo",
                        "stale_prs": [{"number": 1, "title": "Old", "updated_at": "2026-03-01T00:00:00Z"}],
                        "broken_ci": [],
                        "error": None,
                    }
                ]
            }
        }
        result = summarize(ctx)
        assert "# Morning Repo Scan" in result["summary"]
        assert "owner/repo" in result["summary"]
        assert "#1" in result["summary"]

    def test_vault_note_written(self, tmp_path):
        ctx = {"scan_repos": {"findings": []}}
        vault_dir = tmp_path / "brain" / "00_Inbox"

        with patch(_HOME_PATCH, return_value=tmp_path):
            result = summarize(ctx)

        assert "vault" in result["delivered_to"]
        # Find the written file
        notes = list((tmp_path / "brain" / "00_Inbox").glob("repo-scan-*.md"))
        assert len(notes) == 1

    def test_vault_note_skipped_on_denied_path(self):
        ctx = {"scan_repos": {"findings": []}}
        with (
            patch(_SAFE_ROOTS_PATCH, return_value=["/allowed"]),
            patch(_DENIED_PATHS_PATCH, return_value=[]),
            patch("tools.file_tools.validate_path_operation", return_value=(False, "path not under safe roots")),
        ):
            result = summarize(ctx)
        # Should not crash, vault note just skipped
        assert "vault" not in result["delivered_to"]

    def test_vault_dir_from_config(self, tmp_path):
        """Configurable vault_dir overrides default ~/brain/00_Inbox."""
        ctx = {"scan_repos": {"findings": []}}
        custom_dir = tmp_path / "custom_vault"

        with (
            patch(_HOME_PATCH, return_value=tmp_path),
            patch(
                _CONFIG_PATCH,
                return_value={"workflows": {"morning_repo_scan": {"vault_dir": str(custom_dir)}}},
            ),
        ):
            result = summarize(ctx)

        assert "vault" in result["delivered_to"]
        notes = list(custom_dir.glob("repo-scan-*.md"))
        assert len(notes) == 1

    def test_all_clear_message(self):
        ctx = {
            "scan_repos": {
                "findings": [{"repo": "o/r", "stale_prs": [], "broken_ci": [], "error": None}]
            }
        }
        result = summarize(ctx)
        assert "All clear" in result["summary"]
        assert result["has_issues"] is False


# ---------------------------------------------------------------------------
# End-to-end via workflow engine
# ---------------------------------------------------------------------------

class TestEndToEnd:
    @patch("workflow.engine._publish")
    @patch(_HTTPX_PATCH)
    @patch(_CONFIG_PATCH)
    @patch(_HOME_PATCH)
    def test_full_pipeline(self, mock_home, mock_config, mock_client, mock_pub, db, tmp_path):
        mock_home.return_value = tmp_path
        mock_config.return_value = {
            "workflows": {"morning_repo_scan": {"repos": ["test/repo"]}}
        }

        # Mock httpx
        client_instance = MagicMock()

        def mock_get(url, **kwargs):
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            if "/pulls" in url:
                resp.json.return_value = []
            elif "/actions/runs" in url:
                resp.json.return_value = {"workflow_runs": []}
            return resp

        client_instance.get = mock_get
        client_instance.__enter__ = lambda s: client_instance
        client_instance.__exit__ = lambda s, *a: None
        mock_client.return_value = client_instance

        result = run_workflow(WORKFLOW, trigger_meta={"cron_job_id": "test"}, db=db)

        assert result.status == "completed"
        assert len(result.steps) == 3
        assert all(s.status == "completed" for s in result.steps)

        # Check DB
        run = db.get_workflow_run(result.run_id)
        assert run["status"] == "completed"
        assert len(run["checkpoints"]) == 3

        # Check vault note exists
        notes = list((tmp_path / "brain" / "00_Inbox").glob("repo-scan-*.md"))
        assert len(notes) == 1
