"""Registry of harness workflow definitions — built-in + custom."""

from __future__ import annotations

import importlib.util
import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from workflow.primitives import WorkflowDef

logger = logging.getLogger(__name__)

_HARNESSES: dict[str, "WorkflowDef"] = {}
_BUILTIN_IDS: frozenset[str] = frozenset()
_loaded = False


def _load_builtins() -> None:
    """Lazy-load the 5 built-in harnesses."""
    global _BUILTIN_IDS
    from workflow.harnesses.morning_repo_scan import WORKFLOW as mrs
    from workflow.harnesses.watch_and_notify import WORKFLOW as wan
    from workflow.harnesses.research_digest import WORKFLOW as rd
    from workflow.harnesses.backup_drill import WORKFLOW as bd
    from workflow.harnesses.ci_diagnostics import WORKFLOW as cd

    _HARNESSES["morning-repo-scan"] = mrs
    _HARNESSES["watch-and-notify"] = wan
    _HARNESSES["research-digest"] = rd
    _HARNESSES["backup-drill"] = bd
    _HARNESSES["ci-diagnostics"] = cd
    _BUILTIN_IDS = frozenset(_HARNESSES.keys())


def _get_custom_dir() -> Path:
    """Return the custom harnesses directory, creating it if needed."""
    d = Path.home() / ".hermes" / "custom_harnesses"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _scan_custom_harnesses() -> list[str]:
    """Scan ~/.hermes/custom_harnesses/*.py and register any WORKFLOW exports."""
    loaded = []
    custom_dir = _get_custom_dir()
    for py_file in sorted(custom_dir.glob("*.py")):
        if py_file.name.startswith("_"):
            continue
        try:
            spec = importlib.util.spec_from_file_location(
                f"custom_harness_{py_file.stem}_{id(py_file)}", py_file
            )
            if spec is None or spec.loader is None:
                continue
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            wf = getattr(mod, "WORKFLOW", None)
            if wf is None:
                logger.warning("Custom harness %s has no WORKFLOW export, skipping", py_file.name)
                continue
            if wf.id in _BUILTIN_IDS:
                logger.warning(
                    "Custom harness %s collides with built-in '%s', skipping",
                    py_file.name, wf.id,
                )
                continue
            _HARNESSES[wf.id] = wf
            loaded.append(wf.id)
        except Exception as exc:
            logger.warning("Failed to load custom harness %s: %s", py_file.name, exc)
    return loaded


def _ensure_loaded() -> None:
    """Load builtins + custom harnesses on first access."""
    global _loaded
    if not _loaded:
        _load_builtins()
        custom = _scan_custom_harnesses()
        if custom:
            logger.info("Loaded %d custom harness(es): %s", len(custom), ", ".join(custom))
        _loaded = True


def get_harness(name: str) -> "WorkflowDef":
    """Return a WorkflowDef by registered name. Raises KeyError if unknown."""
    _ensure_loaded()
    if name not in _HARNESSES:
        raise KeyError(
            f"Unknown workflow harness: {name!r}. "
            f"Available: {', '.join(sorted(_HARNESSES))}"
        )
    return _HARNESSES[name]


def reload_harnesses() -> dict:
    """Re-scan custom harnesses directory. Returns loaded/custom ID lists."""
    _ensure_loaded()
    # Remove all custom entries
    for hid in list(_HARNESSES):
        if hid not in _BUILTIN_IDS:
            del _HARNESSES[hid]
    custom = _scan_custom_harnesses()
    return {
        "loaded": sorted(_HARNESSES.keys()),
        "custom": custom,
    }


def list_all() -> list[str]:
    """Return all registered harness IDs."""
    _ensure_loaded()
    return sorted(_HARNESSES.keys())


def is_builtin(harness_id: str) -> bool:
    """Return True if the harness is a built-in (not custom)."""
    _ensure_loaded()
    return harness_id in _BUILTIN_IDS
