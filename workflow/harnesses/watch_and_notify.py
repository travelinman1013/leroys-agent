"""Harness B: watch-and-notify — event-driven file change workflow.

Steps:
  1. detect_change  — validate trigger path, extract metadata
  2. classify_change — rules-based classification + priority assignment
  3. act_on_change  — route to event bus (low) or Discord notification (high)

This is a Phase 7 harness workflow for proving event-driven primitives.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict

from workflow.primitives import StepDef, WorkflowDef

logger = logging.getLogger(__name__)

# Event bus import — may fail in tests/CLI mode
try:
    from gateway.event_bus import publish as _event_publish
except ImportError:
    def _event_publish(*a, **kw):
        pass

# Classification rules
_BRAIN_INBOX = "brain/00_Inbox"
_BRAIN_PROJECTS = "brain/01_Projects"


# ---------------------------------------------------------------------------
# Step 1: detect_change
# ---------------------------------------------------------------------------

def detect_change(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Validate the trigger path and extract file metadata."""
    meta = ctx.get("trigger_meta", {})
    path = meta.get("path", "")
    event_type = meta.get("event_type", "unknown")

    if not path:
        raise ValueError("No path in trigger_meta")

    # Path safety check (defense-in-depth — file_watcher._should_ignore is primary)
    try:
        from hermes_cli.config import get_safe_roots, get_denied_paths
        safe_roots = get_safe_roots()
        denied_paths = get_denied_paths()
        if safe_roots:
            from tools.file_tools import validate_path_operation
            allowed, reason = validate_path_operation(
                path, "read", safe_roots, denied_paths,
            )
            if not allowed:
                logger.info("watch-and-notify: blocked path %s (%s)", path, reason)
                return {
                    "path": path,
                    "event_type": event_type,
                    "blocked": True,
                    "block_reason": reason,
                }
    except ImportError:
        pass

    p = Path(path)
    return {
        "path": str(p),
        "event_type": event_type,
        "filename": p.name,
        "extension": p.suffix.lower(),
        "parent_dir": str(p.parent),
        "blocked": False,
    }


# ---------------------------------------------------------------------------
# Step 2: classify_change
# ---------------------------------------------------------------------------

def classify_change(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Rules-based classification with priority assignment."""
    info = ctx.get("detect_change", {})

    # Short-circuit if path was blocked by path jail
    if info.get("blocked"):
        return {
            "classification": "blocked",
            "priority": "none",
            "description": f"Blocked: {info.get('block_reason', 'denied path')}",
        }

    path = info.get("path", "")
    ext = info.get("extension", "")
    event_type = info.get("event_type", "")
    filename = info.get("filename", "")

    classification = "file_change"
    priority = "low"
    description = f"{event_type}: {filename}"

    # Brain vault rules
    if _BRAIN_INBOX in path:
        if event_type == "created" and ext == ".md":
            classification = "new_note"
            priority = "medium"
            description = f"New note in Inbox: {filename}"
        elif event_type == "deleted":
            classification = "note_deleted"
            priority = "low"
            description = f"Note deleted from Inbox: {filename}"
        elif event_type == "modified" and ext == ".md":
            classification = "note_modified"
            priority = "low"
            description = f"Note modified in Inbox: {filename}"
    elif _BRAIN_PROJECTS in path:
        if event_type == "created" and ext == ".md":
            classification = "project_note"
            priority = "medium"
            description = f"New project note: {filename}"

    # Projects directory rules
    elif "Projects" in path:
        if ext == ".py":
            classification = "code_change"
            priority = "low"
            description = f"Python file {event_type}: {filename}"
        elif ext in (".ts", ".tsx", ".js", ".jsx"):
            classification = "code_change"
            priority = "low"
            description = f"JS/TS file {event_type}: {filename}"
        elif event_type == "deleted":
            classification = "file_deleted"
            priority = "low"
            description = f"File deleted: {filename}"

    return {
        "classification": classification,
        "priority": priority,
        "description": description,
    }


# ---------------------------------------------------------------------------
# Step 3: act_on_change
# ---------------------------------------------------------------------------

def act_on_change(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Route actions based on classification and priority."""
    info = ctx.get("classify_change", {})
    classification = info.get("classification", "file_change")
    priority = info.get("priority", "low")
    description = info.get("description", "")
    detect = ctx.get("detect_change", {})
    path = detect.get("path", "")

    # Skip notification for blocked events
    if classification == "blocked":
        return {
            "action": "blocked",
            "channels": [],
            "classification": "blocked",
            "priority": "none",
        }

    channels = ["event_bus"]  # Always publish to event bus

    # Publish file change event (always)
    try:
        _event_publish(
            "workflow.file_change",
            data={
                "path": path,
                "event_type": detect.get("event_type", ""),
                "classification": classification,
                "priority": priority,
                "description": description,
            },
        )
    except Exception:
        pass

    # Medium/high priority: also notify via Discord
    if priority in ("medium", "high"):
        channels.append("discord")
        # Use the cron delivery mechanism for Discord notification
        try:
            _event_publish(
                "workflow.notification",
                data={
                    "message": f"📁 {description}",
                    "source": "watch-and-notify",
                    "priority": priority,
                },
            )
        except Exception:
            pass
        logger.info("watch-and-notify: %s (priority=%s)", description, priority)

    return {
        "action": "notified",
        "channels": channels,
        "classification": classification,
        "priority": priority,
    }


# ---------------------------------------------------------------------------
# Workflow definition
# ---------------------------------------------------------------------------

WORKFLOW = WorkflowDef(
    id="watch-and-notify",
    name="Watch and Notify",
    trigger_type="file_watch",
    steps=[
        StepDef(name="detect_change", fn=detect_change, timeout_s=10),
        StepDef(name="classify_change", fn=classify_change, timeout_s=10),
        StepDef(name="act_on_change", fn=act_on_change, timeout_s=30),
    ],
)
