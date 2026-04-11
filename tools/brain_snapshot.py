"""
Brain visualization snapshot builder.

Pure function that walks the four runtime knowledge surfaces (memory,
sessions, capability registry, scheduled intents) and produces a
typed graph of nodes + edges for the dashboard /brain route.

Design notes
------------
- Pure function: no I/O beyond querying the data sources it inspects.
  No file writes, no network, no event publishes. Safe to call from
  the aiohttp request handler via ``asyncio.to_thread`` so the event
  loop never blocks on SQLite.
- Cached in-memory via ``functools.lru_cache(maxsize=1)`` keyed on a
  5-second time bucket. Bursts of dashboard refetches collapse into a
  single rebuild; the cache self-expires when the bucket increments.
  No disk cache, no manual invalidation, no module-import-time event
  bus subscription (which would be a latent bug — see Phase 4 plan
  optimizer note S2).
- Stable node IDs use content hashes for memory entries (so removals
  + re-adds don't shift indices and break frontend pulse mapping).
  Sessions use their existing ID. Tools/skills/MCP/cron use their
  user-facing names.
- Every text field that originates from user input flows through
  ``tools.redaction.redact_text`` before being placed in the snapshot.
  This is the same boundary the dashboard transcript redaction uses
  (Wave 0 / R2 of the brain viz plan).
- Failures in any single section are isolated: if memory loading
  raises, sessions/skills/tools still appear. The brain viz degrades
  gracefully rather than 500-ing the whole route.

Schema
------
``build_brain_snapshot()`` returns:

    {
        "nodes": [{"id", "type", "label", "weight", "metadata"}, ...],
        "edges": [{"source", "target", "kind", "weight"}, ...],
        "stats": {"memory": N, "session": N, "skill": N, "tool": N,
                  "mcp": N, "cron": N, "edges": N},
        "generated_at": <unix_seconds>,
    }

Plan reference: ~/.claude/plans/stateful-noodling-reddy.md (R1).
"""

from __future__ import annotations

import hashlib
import logging
import time
from functools import lru_cache
from typing import Any, Dict, List, Optional, Tuple

from tools.redaction import redact_text

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_brain_snapshot() -> Dict[str, Any]:
    """Return a fresh-or-cached brain snapshot.

    Coalesces concurrent requests into a single rebuild for any 5-second
    window. Inside the window, repeat callers get the cached dict from
    ``_cached``.
    """
    bucket = int(time.time()) // 5
    return _cached(bucket)


def reset_snapshot_cache() -> None:
    """Clear the lru_cache. Used by tests to force a fresh rebuild."""
    _cached.cache_clear()


# ---------------------------------------------------------------------------
# Cached entry point
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _cached(bucket: int) -> Dict[str, Any]:
    """Build a fresh snapshot. Bucket arg pins this to a 5-second window.

    Each section is wrapped in its own try/except so a failure in one
    surface (e.g. SessionDB unavailable) doesn't blank the whole graph.
    """
    nodes: List[Dict[str, Any]] = []
    edges: List[Dict[str, Any]] = []

    for fn in (
        _add_memory_nodes,
        _add_session_nodes,
        _add_skill_nodes,
        _add_tool_nodes,
        _add_mcp_nodes,
        _add_cron_nodes,
    ):
        try:
            fn(nodes, edges)
        except Exception as exc:
            logger.warning("brain_snapshot: %s failed: %s", fn.__name__, exc)

    stats = _summarize(nodes, edges)
    return {
        "nodes": nodes,
        "edges": edges,
        "stats": stats,
        "generated_at": time.time(),
    }


# ---------------------------------------------------------------------------
# Section builders
# ---------------------------------------------------------------------------

def _hash_entry(content: str) -> str:
    """Stable 8-char content hash. Matches the R4 emit-point scheme so
    dashboard pulses can join events to nodes by hash."""
    return hashlib.sha256(
        (content or "").encode("utf-8", errors="replace")
    ).hexdigest()[:8]


def _add_memory_nodes(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> None:
    """One node per MEMORY.md / USER.md entry."""
    from tools.memory_tool import MemoryStore
    store = MemoryStore()
    store.load_from_disk()

    for entry in (store.memory_entries or []):
        h = _hash_entry(entry)
        nodes.append({
            "id": f"memory:{h}",
            "type": "memory",
            "label": redact_text(entry[:60]),
            "weight": 1.0,
            "metadata": {
                "store": "MEMORY.md",
                "summary": redact_text(entry[:200]),
                "hash": h,
            },
        })

    for entry in (store.user_entries or []):
        h = _hash_entry(entry)
        nodes.append({
            "id": f"memory:{h}",
            "type": "memory",
            "label": redact_text(entry[:60]),
            "weight": 1.0,
            "metadata": {
                "store": "USER.md",
                "summary": redact_text(entry[:200]),
                "hash": h,
            },
        })


def _add_session_nodes(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> None:
    """Sessions + child_of edges from parent_session_id."""
    from hermes_state import SessionDB
    db = SessionDB()
    rows = db.list_sessions_rich(include_children=True, limit=500)
    for r in rows:
        sid = r.get("id")
        if not sid:
            continue
        message_count = r.get("message_count") or 0
        nodes.append({
            "id": f"session:{sid}",
            "type": "session",
            "label": redact_text(
                (r.get("title") or sid[:12]) if r.get("title") else sid[:12]
            ),
            "weight": 1.0 + message_count / 50.0,
            "metadata": {
                "started_at": r.get("started_at"),
                "ended_at": r.get("ended_at"),
                "message_count": message_count,
                "input_tokens": r.get("input_tokens"),
                "output_tokens": r.get("output_tokens"),
                "source": r.get("source"),
                "model": r.get("model"),
            },
        })
        if r.get("parent_session_id"):
            edges.append({
                "source": f"session:{r['parent_session_id']}",
                "target": f"session:{sid}",
                "kind": "child_of",
                "weight": 1,
            })


def _add_skill_nodes(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> None:
    """One node per installed hub skill."""
    from tools.skills_hub import HubLockFile
    installed = HubLockFile().list_installed()
    for skill in installed:
        name = skill.get("name") or "unknown"
        nodes.append({
            "id": f"skill:{name}",
            "type": "skill",
            "label": name,
            "weight": 1.0,
            "metadata": {
                "trust_level": skill.get("trust_level"),
                "installed_at": skill.get("installed_at"),
                "scan_verdict": skill.get("scan_verdict"),
            },
        })


def _add_tool_nodes(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> None:
    """One node per registered tool. Triggers tool discovery if not
    already loaded — matches the existing /api/dashboard/tools handler
    pattern."""
    try:
        import model_tools  # noqa: F401  — triggers _discover_tools
    except Exception as exc:
        logger.debug("brain_snapshot: model_tools import failed: %s", exc)
    from tools.registry import registry
    for name in registry.get_all_tool_names():
        nodes.append({
            "id": f"tool:{name}",
            "type": "tool",
            "label": name,
            "weight": 1.0,
            "metadata": {},
        })


def _add_mcp_nodes(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> None:
    """One node per MCP server from config.yaml. Server args/env are
    NEVER included — they can carry credentials."""
    from hermes_cli.config import load_config
    cfg = load_config() or {}
    mcp_servers = cfg.get("mcp_servers") or {}
    if not isinstance(mcp_servers, dict):
        return
    for server_name, server_cfg in mcp_servers.items():
        if not isinstance(server_cfg, dict):
            continue
        nodes.append({
            "id": f"mcp:{server_name}",
            "type": "mcp",
            "label": server_name,
            "weight": 1.0,
            "metadata": {
                "enabled": bool(server_cfg.get("enabled", True)),
                "transport": "http" if server_cfg.get("url") else "stdio",
            },
        })


def _add_cron_nodes(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> None:
    """One node per cron job + scheduled_by edges to skills."""
    from cron.jobs import list_jobs
    jobs = list_jobs(include_disabled=True)
    for job in jobs:
        job_id = job.get("id")
        if not job_id:
            continue
        nodes.append({
            "id": f"cron:{job_id}",
            "type": "cron",
            "label": redact_text((job.get("name") or job_id[:12])),
            "weight": 1.0,
            "metadata": {
                "schedule": job.get("schedule"),
                "enabled": bool(job.get("enabled", True)),
                "next_run": job.get("next_run"),
                "last_run": job.get("last_run"),
            },
        })
        # Edge: cron -> skill (if the cron is bound to a skill)
        for skill_name in _job_skill_names(job):
            edges.append({
                "source": f"cron:{job_id}",
                "target": f"skill:{skill_name}",
                "kind": "scheduled_by",
                "weight": 1,
            })


def _job_skill_names(job: Dict[str, Any]) -> List[str]:
    """Extract skill name(s) from a cron job dict (handles both
    single-skill and multi-skill shapes)."""
    skill = job.get("skill")
    skills = job.get("skills")
    out: List[str] = []
    if isinstance(skill, str) and skill:
        out.append(skill)
    if isinstance(skills, list):
        out.extend(s for s in skills if isinstance(s, str) and s)
    return out


def _summarize(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> Dict[str, int]:
    """Per-type counts for the dashboard header bar. Replaces a separate
    /brain/stats endpoint."""
    counts: Dict[str, int] = {
        "memory": 0,
        "session": 0,
        "skill": 0,
        "tool": 0,
        "mcp": 0,
        "cron": 0,
    }
    for n in nodes:
        t = n.get("type")
        if t in counts:
            counts[t] += 1
    counts["edges"] = len(edges)
    return counts


# ---------------------------------------------------------------------------
# Single-node detail (used by GET /api/dashboard/brain/node/{type}/{id})
# ---------------------------------------------------------------------------

def find_node(node_type: str, node_id: str) -> Optional[Dict[str, Any]]:
    """Look up a single node from the current snapshot. Returns None
    if no node matches.

    The brain handler exposes this as the second endpoint so the
    dashboard drawer can fetch the full metadata for a clicked node
    without re-downloading the whole graph."""
    snapshot = build_brain_snapshot()
    target = f"{node_type}:{node_id}"
    for n in snapshot.get("nodes", []):
        if n.get("id") == target:
            return n
    return None
