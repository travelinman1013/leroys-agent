"""Harness: research-digest — fetch HN, arXiv, GitHub trending into a vault note.

Steps:
  1. fetch_sources  — pull from HN API, arXiv API, GitHub search API
  2. compile_digest — format into Obsidian-compatible Markdown
  3. deliver        — write vault note, publish event

Runs twice weekly (Tue + Fri 7 AM CT) via cron trigger.
Strictly READ-ONLY against all APIs — no mutations.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List

import httpx

from workflow.primitives import StepDef, WorkflowDef

logger = logging.getLogger(__name__)

# Hard cap on HN stories to prevent runaway requests
_HN_MAX_CAP = 30

# Per-request timeout (step timeout is separate, covers the whole step)
_REQUEST_TIMEOUT = 10.0


# ---------------------------------------------------------------------------
# Step 1: fetch_sources
# ---------------------------------------------------------------------------

def fetch_sources(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Fetch from HN, arXiv, and GitHub trending. Partial failures are OK."""
    # Read config
    config: Dict[str, Any] = {}
    try:
        from hermes_cli.config import load_config as _load_config
        config = (
            _load_config()
            .get("workflows", {})
            .get("research_digest", {})
        )
    except Exception as exc:
        logger.debug("Could not load research_digest config: %s", exc)

    hn_top_n = min(config.get("hn_top_n", 15), _HN_MAX_CAP)
    arxiv_categories = config.get("arxiv_categories", ["cs.AI", "cs.LG", "cs.CL"])
    arxiv_max_results = config.get("arxiv_max_results", 10)
    github_trending = config.get("github_trending", True)

    hn_stories: List[Dict[str, Any]] = []
    arxiv_papers: List[Dict[str, Any]] = []
    github_repos: List[Dict[str, Any]] = []
    errors: List[str] = []

    # --- HN ---
    if hn_top_n > 0:
        try:
            hn_stories = _fetch_hn(hn_top_n)
        except Exception as exc:
            errors.append(f"HN: {exc}")
            logger.warning("HN fetch failed: %s", exc)

    # --- arXiv ---
    if arxiv_categories:
        try:
            arxiv_papers = _fetch_arxiv(arxiv_categories, arxiv_max_results)
        except Exception as exc:
            errors.append(f"arXiv: {exc}")
            logger.warning("arXiv fetch failed: %s", exc)

    # --- GitHub ---
    if github_trending:
        try:
            github_repos = _fetch_github_trending()
        except Exception as exc:
            errors.append(f"GitHub: {exc}")
            logger.warning("GitHub trending fetch failed: %s", exc)

    # All sources failed = step error
    if not hn_stories and not arxiv_papers and not github_repos:
        if errors:
            raise RuntimeError(
                f"All sources failed: {'; '.join(errors)}"
            )
        # All sources disabled via config — that's fine, just empty
        logger.info("All sources disabled or returned empty")

    return {
        "hn": hn_stories,
        "arxiv": arxiv_papers,
        "github": github_repos,
        "errors": errors,
    }


def _fetch_hn(top_n: int) -> List[Dict[str, Any]]:
    """Fetch top N HN stories via Firebase API."""
    stories = []
    with httpx.Client(timeout=_REQUEST_TIMEOUT) as client:
        resp = client.get("https://hacker-news.firebaseio.com/v0/topstories.json")
        resp.raise_for_status()
        story_ids = resp.json()[:top_n]

        for sid in story_ids:
            try:
                resp = client.get(
                    f"https://hacker-news.firebaseio.com/v0/item/{sid}.json"
                )
                resp.raise_for_status()
                item = resp.json()
                if item:
                    stories.append({
                        "id": item.get("id"),
                        "title": item.get("title", ""),
                        "url": item.get("url", f"https://news.ycombinator.com/item?id={sid}"),
                        "score": item.get("score", 0),
                        "by": item.get("by", ""),
                    })
            except Exception as exc:
                logger.debug("Failed to fetch HN item %s: %s", sid, exc)
    return stories


def _fetch_arxiv(categories: List[str], max_results: int) -> List[Dict[str, Any]]:
    """Fetch recent papers from arXiv API. Uses defusedxml for XXE protection."""
    import defusedxml.ElementTree as ET

    ns = {"a": "http://www.w3.org/2005/Atom"}
    papers = []

    query = "+OR+".join(f"cat:{cat}" for cat in categories)
    url = (
        f"https://export.arxiv.org/api/query"
        f"?search_query={query}"
        f"&sortBy=submittedDate&sortOrder=descending"
        f"&max_results={max_results}"
    )

    with httpx.Client(timeout=_REQUEST_TIMEOUT) as client:
        resp = client.get(url)
        resp.raise_for_status()

        root = ET.fromstring(resp.text)
        for entry in root.findall("a:entry", ns):
            title_el = entry.find("a:title", ns)
            summary_el = entry.find("a:summary", ns)
            id_el = entry.find("a:id", ns)
            authors = entry.findall("a:author/a:name", ns)

            title = title_el.text.strip().replace("\n", " ") if title_el is not None and title_el.text else ""
            summary = summary_el.text.strip().replace("\n", " ") if summary_el is not None and summary_el.text else ""
            arxiv_id = id_el.text.strip().split("/")[-1] if id_el is not None and id_el.text else ""
            author_names = [a.text for a in authors if a.text]

            papers.append({
                "title": title,
                "authors": author_names[:5],  # Cap display authors
                "arxiv_id": arxiv_id,
                "summary": summary[:200],
                "url": f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else "",
            })

    return papers


def _fetch_github_trending() -> List[Dict[str, Any]]:
    """Fetch repos created in the past 7 days, sorted by stars."""
    token = os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN", "")
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    seven_days_ago = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")

    repos = []
    with httpx.Client(headers=headers, timeout=_REQUEST_TIMEOUT) as client:
        resp = client.get(
            "https://api.github.com/search/repositories",
            params={
                "q": f"created:>{seven_days_ago}",
                "sort": "stars",
                "order": "desc",
                "per_page": 10,
            },
        )
        resp.raise_for_status()
        for item in resp.json().get("items", []):
            repos.append({
                "full_name": item.get("full_name", ""),
                "description": item.get("description", "") or "",
                "stars": item.get("stargazers_count", 0),
                "language": item.get("language", ""),
                "url": item.get("html_url", ""),
            })

    return repos


# ---------------------------------------------------------------------------
# Step 2: compile_digest
# ---------------------------------------------------------------------------

def compile_digest(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Format fetched data into an Obsidian-compatible Markdown note."""
    data = ctx.get("fetch_sources", {})
    hn = data.get("hn", [])
    arxiv = data.get("arxiv", [])
    github = data.get("github", [])
    errors = data.get("errors", [])
    today = datetime.now().strftime("%Y-%m-%d")

    lines = [
        "---",
        "tags: [research-digest, hermes-generated]",
        f"date: {today}",
        "---",
        f"# Research Digest — {today}",
        "",
    ]

    # HN section
    if hn:
        lines.append("## Hacker News Top Stories")
        for i, story in enumerate(hn, 1):
            lines.append(
                f"{i}. [{story['title']}]({story['url']}) — "
                f"{story['score']} pts, by {story['by']}"
            )
        lines.append("")

    # arXiv section
    if arxiv:
        lines.append("## arXiv Papers")
        for paper in arxiv:
            authors_str = ", ".join(paper["authors"][:3])
            if len(paper["authors"]) > 3:
                authors_str += " et al."
            lines.append(
                f"- **{paper['title']}** — {authors_str} ({paper['arxiv_id']})"
            )
            if paper["summary"]:
                lines.append(f"  > {paper['summary']}...")
        lines.append("")

    # GitHub section
    if github:
        lines.append("## GitHub Trending (past 7 days)")
        for repo in github:
            lang = f", {repo['language']}" if repo["language"] else ""
            lines.append(
                f"- **{repo['full_name']}** — {repo['description'][:100]} "
                f"({repo['stars']} stars{lang})"
            )
        lines.append("")

    # Errors section (informational)
    if errors:
        lines.append("## Source Errors")
        for err in errors:
            lines.append(f"- {err}")
        lines.append("")

    digest_md = "\n".join(lines)

    return {
        "digest_md": digest_md,
        "source_counts": {
            "hn": len(hn),
            "arxiv": len(arxiv),
            "github": len(github),
        },
    }


# ---------------------------------------------------------------------------
# Step 3: deliver
# ---------------------------------------------------------------------------

def deliver(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Write the digest to a vault note and publish an event."""
    compile_result = ctx.get("compile_digest", {})
    digest_md = compile_result.get("digest_md", "")
    source_counts = compile_result.get("source_counts", {})
    today = datetime.now().strftime("%Y-%m-%d")

    delivered_to: List[str] = []

    # Vault dir from config (default ~/brain/00_Inbox)
    vault_dir = Path.home() / "brain" / "00_Inbox"
    try:
        from hermes_cli.config import load_config as _load_cfg
        _wf_cfg = _load_cfg().get("workflows", {}).get("research_digest", {})
        _custom_dir = _wf_cfg.get("vault_dir")
        if _custom_dir:
            vault_dir = Path(_custom_dir).expanduser()
    except Exception:
        pass

    vault_path = vault_dir / f"research-digest-{today}.md"

    try:
        # Path safety check (reuse morning-repo-scan pattern)
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
            vault_path.write_text(digest_md, encoding="utf-8")
            delivered_to.append("vault")
            logger.info("Wrote research digest: %s", vault_path)
    except Exception as exc:
        logger.warning("Failed to write vault note: %s", exc)

    # Publish event
    try:
        from gateway.event_bus import publish as _event_publish
        _event_publish(
            "workflow.research_digest.delivered",
            data={
                "date": today,
                "source_counts": source_counts,
                "vault_path": str(vault_path) if vault_path else None,
                "delivered_to": delivered_to,
            },
        )
    except ImportError:
        pass

    delivered_to.append("event_bus")

    return {
        "delivered_to": delivered_to,
        "vault_path": str(vault_path) if vault_path else None,
        "source_counts": source_counts,
    }


# ---------------------------------------------------------------------------
# Workflow definition
# ---------------------------------------------------------------------------

WORKFLOW = WorkflowDef(
    id="research-digest",
    name="Research Digest",
    trigger_type="cron",
    steps=[
        StepDef(name="fetch_sources", fn=fetch_sources, timeout_s=120),
        StepDef(name="compile_digest", fn=compile_digest, timeout_s=30),
        StepDef(name="deliver", fn=deliver, timeout_s=30),
    ],
)
