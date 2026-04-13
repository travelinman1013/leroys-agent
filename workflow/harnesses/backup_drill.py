"""Harness: backup-drill — verify backup/restore integrity.

Steps:
  1. create_backup       — run hermes backup to temp dir, capture path
  2. restore_and_validate — restore to temp dir, validate contents
  3. report              — format results, publish event

This is a Phase 9b reliability harness. It is the hard acceptance gate
for the phase — the drill must pass before shipping.
"""

from __future__ import annotations

import logging
import os
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

import yaml

from workflow.primitives import StepDef, WorkflowDef

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Step 1: create_backup
# ---------------------------------------------------------------------------

def create_backup(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Create a backup zip to a temp directory."""
    from hermes_constants import get_default_hermes_root

    hermes_root = get_default_hermes_root()
    if not hermes_root.exists():
        raise RuntimeError(f"Hermes home not found: {hermes_root}")

    tmp_dir = tempfile.mkdtemp(prefix="hermes-backup-drill-")
    timestamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    out_path = Path(tmp_dir) / f"hermes-backup-{timestamp}.zip"

    # Import and run the backup function
    from hermes_cli.backup import run_backup

    class _Args:
        output = str(out_path)

    run_backup(_Args())

    if not out_path.exists():
        raise RuntimeError(f"Backup file was not created at {out_path}")

    file_count = 0
    with zipfile.ZipFile(out_path, "r") as zf:
        file_count = len(zf.namelist())

    size_mb = out_path.stat().st_size / (1024 * 1024)
    logger.info("Backup drill: created %s (%.1f MB, %d files)", out_path, size_mb, file_count)

    return {
        "backup_path": str(out_path),
        "tmp_dir": tmp_dir,
        "file_count": file_count,
        "size_mb": round(size_mb, 2),
    }


# ---------------------------------------------------------------------------
# Step 2: restore_and_validate
# ---------------------------------------------------------------------------

_VALIDATION_CHECKS = [
    "config_parseable",
    "state_db_integrity",
    "skills_dir_exists",
    "memories_dir_exists",
]


def restore_and_validate(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Extract backup to temp dir and run validation checks."""
    backup_info = ctx.get("create_backup", {})
    backup_path = backup_info.get("backup_path")
    if not backup_path or not Path(backup_path).exists():
        raise RuntimeError(f"Backup file not found: {backup_path}")

    restore_dir = tempfile.mkdtemp(prefix="hermes-restore-drill-")
    checks: List[Dict[str, Any]] = []
    errors: List[str] = []

    # Extract
    try:
        with zipfile.ZipFile(backup_path, "r") as zf:
            zf.extractall(restore_dir)
    except Exception as exc:
        raise RuntimeError(f"Failed to extract backup: {exc}") from exc

    # Detect prefix (backup may wrap files in a directory)
    restored = Path(restore_dir)
    subdirs = list(restored.iterdir())
    if len(subdirs) == 1 and subdirs[0].is_dir():
        restored = subdirs[0]

    # Check 1: config.yaml parseable
    config_path = restored / "config.yaml"
    if config_path.exists():
        try:
            with open(config_path) as f:
                yaml.safe_load(f)
            checks.append({"name": "config_parseable", "passed": True})
        except Exception as exc:
            checks.append({"name": "config_parseable", "passed": False, "error": str(exc)})
            errors.append(f"config.yaml not parseable: {exc}")
    else:
        checks.append({"name": "config_parseable", "passed": False, "error": "config.yaml not found"})
        errors.append("config.yaml not found in backup")

    # Check 2: state.db integrity
    db_found = False
    for db_name in ("state.db", "hermes_state.db"):
        db_path = restored / db_name
        if db_path.exists():
            db_found = True
            try:
                conn = sqlite3.connect(str(db_path))
                result = conn.execute("PRAGMA integrity_check").fetchone()
                conn.close()
                if result and result[0] == "ok":
                    checks.append({"name": f"{db_name}_integrity", "passed": True})
                else:
                    msg = f"{db_name} integrity check failed: {result}"
                    checks.append({"name": f"{db_name}_integrity", "passed": False, "error": msg})
                    errors.append(msg)
            except Exception as exc:
                checks.append({"name": f"{db_name}_integrity", "passed": False, "error": str(exc)})
                errors.append(f"{db_name} integrity check error: {exc}")

    if not db_found:
        checks.append({"name": "state_db_integrity", "passed": False, "error": "no SQLite DB found"})
        errors.append("No state.db or hermes_state.db found in backup")

    # Check 3: skills directory exists
    skills_dir = restored / "skills"
    if skills_dir.exists() and skills_dir.is_dir():
        checks.append({"name": "skills_dir_exists", "passed": True})
    else:
        checks.append({"name": "skills_dir_exists", "passed": False, "error": "skills/ not found"})
        errors.append("skills/ directory not found in backup")

    # Check 4: memories directory exists
    memories_dir = restored / "memories"
    if memories_dir.exists() and memories_dir.is_dir():
        checks.append({"name": "memories_dir_exists", "passed": True})
    else:
        checks.append({"name": "memories_dir_exists", "passed": False, "error": "memories/ not found"})
        errors.append("memories/ directory not found in backup")

    # Cleanup restore dir
    try:
        shutil.rmtree(restore_dir)
    except Exception:
        pass

    valid = len(errors) == 0
    logger.info("Backup drill validation: %s (%d checks, %d errors)", "PASS" if valid else "FAIL", len(checks), len(errors))

    return {
        "valid": valid,
        "checks": checks,
        "errors": errors,
        "restore_dir": restore_dir,
    }


# ---------------------------------------------------------------------------
# Step 3: report
# ---------------------------------------------------------------------------

def report(ctx: Dict[str, Any]) -> Dict[str, Any]:
    """Format drill results into a summary."""
    backup_info = ctx.get("create_backup", {})
    validation = ctx.get("restore_and_validate", {})
    today = datetime.now().strftime("%Y-%m-%d")

    passed = validation.get("valid", False)
    checks = validation.get("checks", [])
    errors = validation.get("errors", [])

    lines = [
        f"# Backup/Restore Drill — {today}",
        "",
        f"**Result:** {'PASS' if passed else 'FAIL'}",
        f"**Backup size:** {backup_info.get('size_mb', '?')} MB ({backup_info.get('file_count', '?')} files)",
        "",
        "## Validation Checks",
        "",
    ]

    for check in checks:
        status = "PASS" if check["passed"] else "FAIL"
        line = f"- [{status}] {check['name']}"
        if not check["passed"] and check.get("error"):
            line += f" — {check['error']}"
        lines.append(line)

    if errors:
        lines.extend(["", "## Errors", ""])
        for err in errors:
            lines.append(f"- {err}")

    summary = "\n".join(lines)

    # Cleanup backup temp dir
    tmp_dir = backup_info.get("tmp_dir")
    if tmp_dir:
        try:
            shutil.rmtree(tmp_dir)
        except Exception:
            pass

    return {
        "summary": summary,
        "passed": passed,
        "check_count": len(checks),
        "error_count": len(errors),
    }


# ---------------------------------------------------------------------------
# Workflow definition
# ---------------------------------------------------------------------------

WORKFLOW = WorkflowDef(
    id="backup-drill",
    name="Backup/Restore Drill",
    trigger_type="cron",
    steps=[
        StepDef(name="create_backup", fn=create_backup, timeout_s=120),
        StepDef(name="restore_and_validate", fn=restore_and_validate, timeout_s=60),
        StepDef(name="report", fn=report, timeout_s=30),
    ],
)
