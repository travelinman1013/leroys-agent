"""Tests for the ci-diagnostics workflow harness."""

import os
from unittest.mock import patch, MagicMock

import pytest


class TestCategorizeLog:
    """Tests for the _categorize_log helper."""

    def test_test_failure(self):
        from workflow.harnesses.ci_diagnostics import _categorize_log
        assert _categorize_log("FAILED tests/test_foo.py::test_bar") == "test_failure"
        assert _categorize_log("AssertionError: expected 1 got 2") == "test_failure"
        assert _categorize_log("pytest: 3 failed, 2 passed") == "test_failure"

    def test_dependency_issue(self):
        from workflow.harnesses.ci_diagnostics import _categorize_log
        assert _categorize_log("ModuleNotFoundError: No module named 'foo'") == "dependency_issue"
        assert _categorize_log("ImportError: cannot import name 'bar'") == "dependency_issue"

    def test_infra_timeout(self):
        from workflow.harnesses.ci_diagnostics import _categorize_log
        assert _categorize_log("Error: Process completed with exit code 124 (timeout)") == "infra_timeout"
        assert _categorize_log("deadline exceeded after 300s") == "infra_timeout"

    def test_build_failure(self):
        from workflow.harnesses.ci_diagnostics import _categorize_log
        assert _categorize_log("error: something went wrong\nfatal: cannot continue") == "build_failure"
        assert _categorize_log("SyntaxError: unexpected token") == "build_failure"

    def test_unknown(self):
        from workflow.harnesses.ci_diagnostics import _categorize_log
        assert _categorize_log("Everything looks fine here") == "unknown"
        assert _categorize_log("") == "unknown"


class TestExtractErrorSummary:
    """Tests for the _extract_error_summary helper."""

    def test_finds_error_lines(self):
        from workflow.harnesses.ci_diagnostics import _extract_error_summary
        log = "line 1\nline 2\nERROR: something broke\nline 4\nline 5"
        summary = _extract_error_summary(log)
        assert "ERROR" in summary
        assert "something broke" in summary

    def test_fallback_to_tail(self):
        from workflow.harnesses.ci_diagnostics import _extract_error_summary
        log = "just some normal output\n" * 10
        summary = _extract_error_summary(log, max_chars=200)
        assert len(summary) <= 200

    def test_empty_log(self):
        from workflow.harnesses.ci_diagnostics import _extract_error_summary
        summary = _extract_error_summary("")
        assert summary == ""


class TestFetchFailures:
    """Tests for the fetch_failures step."""

    def test_fetches_from_config(self):
        from workflow.harnesses.ci_diagnostics import fetch_failures

        mock_config = {
            "workflows": {
                "ci_diagnostics": {
                    "repos": ["owner/repo1"],
                },
            },
        }

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "workflow_runs": [
                {
                    "id": 123,
                    "name": "Tests",
                    "conclusion": "failure",
                    "created_at": "2026-04-12T00:00:00Z",
                    "html_url": "https://github.com/owner/repo1/actions/runs/123",
                },
            ],
        }
        mock_response.raise_for_status = MagicMock()

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.return_value = mock_response

        with patch("workflow.harnesses.ci_diagnostics.load_config", return_value=mock_config, create=True):
            with patch("hermes_cli.config.load_config", return_value=mock_config):
                with patch("workflow.harnesses.ci_diagnostics.httpx.Client", return_value=mock_client):
                    result = fetch_failures({})

        assert result["repos"] == ["owner/repo1"]
        assert len(result["failed_runs"]) == 1
        assert result["failed_runs"][0]["run_id"] == 123

    def test_no_repos_raises(self):
        from workflow.harnesses.ci_diagnostics import fetch_failures

        with patch("hermes_cli.config.load_config", return_value={}):
            with patch.dict(os.environ, {}, clear=True):
                with pytest.raises(ValueError, match="No repos configured"):
                    fetch_failures({})


class TestAnalyzeLogs:
    """Tests for the analyze_logs step."""

    def test_categorizes_failures(self):
        from workflow.harnesses.ci_diagnostics import analyze_logs

        ctx = {
            "fetch_failures": {
                "failed_runs": [
                    {"repo": "owner/repo", "run_id": 1, "name": "Tests",
                     "created_at": "2026-04-12", "url": "http://example.com"},
                ],
            },
        }

        # Mock GitHub API to return a failed job with test failure logs
        mock_jobs_resp = MagicMock()
        mock_jobs_resp.status_code = 200
        mock_jobs_resp.json.return_value = {
            "jobs": [{"id": 10, "conclusion": "failure"}],
        }
        mock_jobs_resp.raise_for_status = MagicMock()

        mock_log_resp = MagicMock()
        mock_log_resp.status_code = 200
        mock_log_resp.text = "FAILED tests/test_foo.py::test_bar - AssertionError"

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)
        mock_client.get.side_effect = [mock_jobs_resp, mock_log_resp]

        with patch("workflow.harnesses.ci_diagnostics.httpx.Client", return_value=mock_client):
            result = analyze_logs(ctx)

        assert len(result["diagnostics"]) == 1
        assert result["diagnostics"][0]["category"] == "test_failure"

    def test_empty_runs(self):
        from workflow.harnesses.ci_diagnostics import analyze_logs
        result = analyze_logs({"fetch_failures": {"failed_runs": []}})
        assert result["diagnostics"] == []


class TestSummarize:
    """Tests for the summarize step."""

    def test_formats_report(self, tmp_path):
        from workflow.harnesses.ci_diagnostics import summarize

        ctx = {
            "analyze_logs": {
                "diagnostics": [
                    {
                        "repo": "owner/repo",
                        "run_id": 1,
                        "name": "Tests",
                        "created_at": "2026-04-12T00:00:00Z",
                        "url": "https://example.com",
                        "category": "test_failure",
                        "error_summary": "FAILED test_foo",
                    },
                    {
                        "repo": "owner/repo2",
                        "run_id": 2,
                        "name": "Build",
                        "created_at": "2026-04-12T00:00:00Z",
                        "url": "https://example.com",
                        "category": "build_failure",
                        "error_summary": "error: compile failed",
                    },
                ],
            },
        }

        # Mock vault write to use tmp_path
        with patch("workflow.harnesses.ci_diagnostics.Path.home", return_value=tmp_path):
            with patch("hermes_cli.config.load_config", return_value={}):
                result = summarize(ctx)

        assert result["total_failures"] == 2
        assert "test_failure" in result["categories"]
        assert "build_failure" in result["categories"]
        assert "CI Diagnostics" in result["summary"]


class TestWorkflowDefinition:
    def test_workflow_registered(self):
        from workflow.harnesses import get_harness
        wf = get_harness("ci-diagnostics")
        assert wf.id == "ci-diagnostics"
        assert len(wf.steps) == 3

    def test_step_names(self):
        from workflow.harnesses import get_harness
        wf = get_harness("ci-diagnostics")
        names = [s.name for s in wf.steps]
        assert names == ["fetch_failures", "analyze_logs", "summarize"]
