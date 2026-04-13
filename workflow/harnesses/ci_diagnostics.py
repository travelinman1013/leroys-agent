"""Harness: ci-diagnostics — fetch and classify CI failures.

Steps:
  1. fetch_failures  — GitHub Actions API, get failed runs for configured repos
  2. analyze_logs    — fetch job logs, regex categorize failures
  3. summarize       — format diagnostic report, write vault note

This is a Phase 9b harness. It is strictly READ-ONLY against GitHub.
It diagnoses and reports, it does NOT auto-fix.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

import httpx

from workflow.primitives import StepDef, WorkflowDef

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Failure categories
# ---------------------------------------------------------------------------

_CATEGORY_PATTERNS = [
    ("test_failure", [
        re.compile(r"FAILED|AssertionError|AssertError|pytest|unittest.*FAIL", re.IGNORECASE),
    ]),
    ("dependency_issue", [
        re.compile(r"ModuleNotFoundError|ImportError|pip install|No matching distribution", re.IGNORECASE),
    ]),
    ("infra_timeout", [
        re.compile(r"timeout|deadline exceeded|timed out|SIGKILL.*timeout", re.IGNORECASE),
    ]),
    ("build_failure", [
        re.compile(r"^error:|fatal:|compilation failed|SyntaxError|build failed", re.IGNORECASE | re.MULTILINE),
    ]),
]


def _categorize_log(log_text: str) -> str:
    """Classify a CI log into a failure category."""
    for category, patterns in _CATEGORY_PATTERNS:
        for pattern in patterns:
            if pattern.search(log_text):
                return category
    return "unknown"


def _extract_error_summary(log_text: str, max_chars: int = 500) -> str:
    """Extract the most relevant error lines from a CI log."""
    lines = log_text.splitlines()
    error_lines = []
    for i, line in enumerate(lines):
        if any(kw in line.lower() for kw in ("error", "failed", "failure", "assert", "traceback")):
            # Grab this line plus 2 context lines
            start = max(0, i - 1)
            end = min(len(lines), i + 3)
            error_lines.extend(lines[start:end])
            if len("\n".join(error_lines)) > max_chars:
                break

    if error_lines:
        return "\n".join(error_lines)[:max_chars]
    # Fallback: last 500 chars
    return log_text[-max_chars:]


# ---------------------------------------------------------------------------
# Step 1: fetch_failures
# ---------------------------------------------------------------------------

def fetch_failures(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Fetch recent failed CI runs from GitHub Actions."""
    repos: List[str] = []

    # Try config.yaml
    try:
        from hermes_cli.config import load_config as _load_config
        config = _load_config()
        # Try ci_diagnostics repos first, fallback to morning_repo_scan repos
        repos = (
            config.get("workflows", {})
            .get("ci_diagnostics", {})
            .get("repos", [])
        )
        if not repos:
            repos = (
                config.get("workflows", {})
                .get("morning_repo_scan", {})
                .get("repos", [])
            )
    except Exception as exc:
        logger.debug("Could not load config for repo list: %s", exc)

    # Fallback to env var
    if not repos:
        env_repos = os.environ.get("HERMES_SCAN_REPOS", "")
        if env_repos:
            repos = [r.strip() for r in env_repos.split(",") if r.strip()]

    if not repos:
        raise ValueError(
            "No repos configured. Set workflows.ci_diagnostics.repos "
            "in config.yaml or HERMES_SCAN_REPOS env var."
        )

    token = os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN", "")
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    failed_runs: List[Dict[str, Any]] = []

    with httpx.Client(headers=headers, timeout=30.0) as client:
        for repo in repos:
            try:
                resp = client.get(
                    f"https://api.github.com/repos/{repo}/actions/runs",
                    params={"status": "failure", "per_page": 5},
                )
                resp.raise_for_status()
                for run in resp.json().get("workflow_runs", []):
                    failed_runs.append({
                        "repo": repo,
                        "run_id": run["id"],
                        "name": run.get("name", ""),
                        "conclusion": run.get("conclusion", ""),
                        "created_at": run.get("created_at", ""),
                        "url": run.get("html_url", ""),
                    })
            except Exception as exc:
                logger.warning("CI diagnostics: failed to fetch runs for %s: %s", repo, exc)

    logger.info("CI diagnostics: %d failed runs across %d repos", len(failed_runs), len(repos))
    return {"repos": repos, "failed_runs": failed_runs}


# ---------------------------------------------------------------------------
# Step 2: analyze_logs
# ---------------------------------------------------------------------------

def analyze_logs(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Fetch logs for each failed run and categorize the failure."""
    failed_runs = ctx.get("fetch_failures", {}).get("failed_runs", [])
    if not failed_runs:
        return {"diagnostics": [], "note": "No failed runs to analyze"}

    token = os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN", "")
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    diagnostics: List[Dict[str, Any]] = []

    with httpx.Client(headers=headers, timeout=30.0, follow_redirects=True) as client:
        for run in failed_runs:
            repo = run["repo"]
            run_id = run["run_id"]

            log_text = ""
            try:
                # Fetch jobs for this run
                jobs_resp = client.get(
                    f"https://api.github.com/repos/{repo}/actions/runs/{run_id}/jobs",
                    params={"per_page": 10},
                )
                jobs_resp.raise_for_status()
                jobs = jobs_resp.json().get("jobs", [])

                # Get logs from failed jobs
                for job in jobs:
                    if job.get("conclusion") == "failure":
                        try:
                            log_resp = client.get(
                                f"https://api.github.com/repos/{repo}/actions/jobs/{job['id']}/logs",
                            )
                            if log_resp.status_code == 200:
                                log_text += log_resp.text[:10000]  # Cap per job
                        except Exception:
                            pass

            except Exception as exc:
                logger.warning("CI diagnostics: failed to fetch logs for %s run %s: %s", repo, run_id, exc)

            category = _categorize_log(log_text) if log_text else "unknown"
            error_summary = _extract_error_summary(log_text) if log_text else "No logs available"

            diagnostics.append({
                "repo": repo,
                "run_id": run_id,
                "name": run["name"],
                "created_at": run["created_at"],
                "url": run["url"],
                "category": category,
                "error_summary": error_summary,
            })

    return {"diagnostics": diagnostics}


# ---------------------------------------------------------------------------
# Step 3: summarize
# ---------------------------------------------------------------------------

def summarize(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Format diagnostic results into a report and vault note."""
    diagnostics = ctx.get("analyze_logs", {}).get("diagnostics", [])
    today = datetime.now().strftime("%Y-%m-%d")

    # Group by category
    by_category: Dict[str, List[Dict]] = {}
    for d in diagnostics:
        cat = d["category"]
        by_category.setdefault(cat, []).append(d)

    lines = [
        f"# CI Diagnostics — {today}",
        "",
        f"**Total failures:** {len(diagnostics)}",
        f"**Categories:** {', '.join(f'{k} ({len(v)})' for k, v in sorted(by_category.items()))}",
        "",
    ]

    for category, items in sorted(by_category.items()):
        lines.append(f"## {category.replace('_', ' ').title()} ({len(items)})")
        lines.append("")
        for item in items:
            lines.append(f"### {item['repo']} — {item['name']}")
            lines.append(f"- **Run:** [{item['run_id']}]({item['url']})")
            lines.append(f"- **Date:** {item['created_at'][:10]}")
            lines.append(f"- **Error:**")
            lines.append(f"```")
            lines.append(item["error_summary"][:300])
            lines.append(f"```")
            lines.append("")

    summary = "\n".join(lines)
    delivered_to: List[str] = []

    # Write vault note (best-effort, same pattern as morning_repo_scan)
    vault_dir = Path.home() / "brain" / "00_Inbox"
    try:
        from hermes_cli.config import load_config as _load_cfg
        _wf_cfg = _load_cfg().get("workflows", {}).get("ci_diagnostics", {})
        _custom_dir = _wf_cfg.get("vault_dir")
        if _custom_dir:
            vault_dir = Path(_custom_dir).expanduser()
    except Exception:
        pass

    vault_path = vault_dir / f"ci-diagnostics-{today}.md"
    try:
        try:
            from hermes_cli.config import get_safe_roots, get_denied_paths
            safe_roots = get_safe_roots()
            denied_paths = get_denied_paths()
            if safe_roots:
                from tools.file_tools import validate_path_operation
                allowed, reason = validate_path_operation(
                    str(vault_path), "write", safe_roots, denied_paths,
                )
                if not allowed:
                    logger.info("Vault write blocked by path jail: %s", reason)
                    vault_path = None
        except ImportError:
            pass

        if vault_path:
            vault_path.parent.mkdir(parents=True, exist_ok=True)
            vault_path.write_text(summary, encoding="utf-8")
            delivered_to.append("vault")
            logger.info("Wrote vault note: %s", vault_path)
    except Exception as exc:
        logger.warning("Failed to write vault note: %s", exc)

    delivered_to.append("event_bus")

    return {
        "summary": summary,
        "delivered_to": delivered_to,
        "total_failures": len(diagnostics),
        "categories": {k: len(v) for k, v in by_category.items()},
    }


# ---------------------------------------------------------------------------
# Workflow definition
# ---------------------------------------------------------------------------

WORKFLOW = WorkflowDef(
    id="ci-diagnostics",
    name="CI Test Diagnostics",
    trigger_type="cron",
    steps=[
        StepDef(name="fetch_failures", fn=fetch_failures, timeout_s=60),
        StepDef(name="analyze_logs", fn=analyze_logs, timeout_s=120),
        StepDef(name="summarize", fn=summarize, timeout_s=30),
    ],
)
