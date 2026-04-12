"""Harness A: morning-repo-scan — cron-triggered multi-step workflow.

Steps:
  1. fetch_repos  — read repo list from config or env
  2. scan_repos   — check each for stale PRs and broken CI (READ-ONLY)
  3. summarize    — format markdown, write vault note, return summary

This is a Phase 7 harness workflow for proving workflow primitives.
It is strictly READ-ONLY against GitHub — no mutations, no merges,
no comments.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List

import httpx

from workflow.primitives import StepDef, WorkflowDef

logger = logging.getLogger(__name__)

# How many days old a PR must be to be considered "stale"
_STALE_PR_DAYS = 7



# ---------------------------------------------------------------------------
# Step 1: fetch_repos
# ---------------------------------------------------------------------------

def fetch_repos(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Read the list of repos to scan from config or env."""
    repos: List[str] = []

    # Try config.yaml first
    try:
        from hermes_cli.config import load_config as _load_config
        config = _load_config()
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
            "No repos configured. Set workflows.morning_repo_scan.repos "
            "in config.yaml or HERMES_SCAN_REPOS env var."
        )

    logger.info("Morning repo scan: %d repos to scan", len(repos))
    return {"repos": repos}


# ---------------------------------------------------------------------------
# Step 2: scan_repos
# ---------------------------------------------------------------------------

def scan_repos(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Scan each repo for stale PRs and broken CI. Strictly GET-only."""
    repos = ctx.get("fetch_repos", {}).get("repos", [])
    if not repos:
        return {"findings": [], "error": "No repos to scan"}

    token = os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN", "")
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    cutoff = datetime.now(timezone.utc) - timedelta(days=_STALE_PR_DAYS)
    findings: List[Dict[str, Any]] = []

    with httpx.Client(headers=headers, timeout=30.0) as client:
        for repo in repos:
            finding: Dict[str, Any] = {
                "repo": repo,
                "stale_prs": [],
                "broken_ci": [],
                "error": None,
            }

            try:
                # Stale PRs — open PRs updated before cutoff
                resp = client.get(
                    f"https://api.github.com/repos/{repo}/pulls",
                    params={"state": "open", "sort": "updated", "direction": "asc", "per_page": 20},
                )
                resp.raise_for_status()
                for pr in resp.json():
                    updated = pr.get("updated_at", "")
                    if updated and updated < cutoff.isoformat():
                        finding["stale_prs"].append({
                            "number": pr["number"],
                            "title": pr["title"],
                            "updated_at": updated,
                            "url": pr["html_url"],
                        })

                # Broken CI — recent failed workflow runs
                resp = client.get(
                    f"https://api.github.com/repos/{repo}/actions/runs",
                    params={"status": "failure", "per_page": 5},
                )
                resp.raise_for_status()
                for run in resp.json().get("workflow_runs", []):
                    finding["broken_ci"].append({
                        "id": run["id"],
                        "name": run.get("name", ""),
                        "conclusion": run.get("conclusion", ""),
                        "created_at": run.get("created_at", ""),
                        "url": run.get("html_url", ""),
                    })

            except httpx.HTTPStatusError as exc:
                finding["error"] = f"HTTP {exc.response.status_code}: {exc.response.text[:200]}"
                logger.warning("Repo scan failed for %s: %s", repo, finding["error"])
            except Exception as exc:
                finding["error"] = str(exc)
                logger.warning("Repo scan error for %s: %s", repo, exc)

            findings.append(finding)

    return {"findings": findings}


# ---------------------------------------------------------------------------
# Step 3: summarize
# ---------------------------------------------------------------------------

def summarize(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Format findings into Markdown, optionally write a vault note."""
    findings = ctx.get("scan_repos", {}).get("findings", [])
    today = datetime.now().strftime("%Y-%m-%d")

    lines = [f"# Morning Repo Scan — {today}", ""]

    has_issues = False
    for f in findings:
        repo = f["repo"]
        lines.append(f"## {repo}")

        if f.get("error"):
            lines.append(f"- Error scanning: {f['error']}")
            lines.append("")
            continue

        stale = f.get("stale_prs", [])
        broken = f.get("broken_ci", [])

        if not stale and not broken:
            lines.append("- All clear")
        else:
            has_issues = True
            if stale:
                lines.append(f"### Stale PRs ({len(stale)})")
                for pr in stale:
                    lines.append(f"- #{pr['number']}: {pr['title']} (last updated {pr['updated_at'][:10]})")
            if broken:
                lines.append(f"### Broken CI ({len(broken)})")
                for run in broken:
                    lines.append(f"- {run['name']}: {run['conclusion']} ({run['created_at'][:10]})")

        lines.append("")

    summary = "\n".join(lines)
    delivered_to: List[str] = []

    # Write vault note (best-effort)
    # Vault dir is configurable via config.yaml; defaults to ~/brain/00_Inbox
    vault_dir = Path.home() / "brain" / "00_Inbox"
    try:
        from hermes_cli.config import load_config as _load_cfg
        _wf_cfg = _load_cfg().get("workflows", {}).get("morning_repo_scan", {})
        _custom_dir = _wf_cfg.get("vault_dir")
        if _custom_dir:
            vault_dir = Path(_custom_dir).expanduser()
    except Exception:
        pass
    vault_path = vault_dir / f"repo-scan-{today}.md"
    try:
        # Check path safety if path jail is configured
        try:
            from hermes_cli.config import get_safe_roots, get_denied_paths
            safe_roots = get_safe_roots()
            denied_paths = get_denied_paths()
            if safe_roots:  # path jail only active when safe_roots is configured
                from tools.file_tools import validate_path_operation
                allowed, reason = validate_path_operation(
                    str(vault_path), "write", safe_roots, denied_paths,
                )
                if not allowed:
                    logger.info("Vault write blocked by path jail: %s", reason)
                    vault_path = None
        except ImportError:
            pass  # No path jail available (tests, CLI mode)

        if vault_path:
            vault_path.parent.mkdir(parents=True, exist_ok=True)
            vault_path.write_text(summary, encoding="utf-8")
            delivered_to.append("vault")
            logger.info("Wrote vault note: %s", vault_path)
    except Exception as exc:
        logger.warning("Failed to write vault note: %s", exc)

    delivered_to.append("event_bus")  # Events always published by engine

    return {
        "summary": summary,
        "delivered_to": delivered_to,
        "has_issues": has_issues,
        "repo_count": len(findings),
    }


# ---------------------------------------------------------------------------
# Workflow definition
# ---------------------------------------------------------------------------

WORKFLOW = WorkflowDef(
    id="morning-repo-scan",
    name="Morning Repo Scan",
    trigger_type="cron",
    steps=[
        StepDef(name="fetch_repos", fn=fetch_repos, timeout_s=30),
        StepDef(name="scan_repos", fn=scan_repos, timeout_s=120),
        StepDef(name="summarize", fn=summarize, timeout_s=30),
    ],
)
