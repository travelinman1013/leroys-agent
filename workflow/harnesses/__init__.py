"""Registry of harness workflow definitions."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from workflow.primitives import WorkflowDef

_HARNESSES: dict[str, type] = {}


def get_harness(name: str) -> "WorkflowDef":
    """Return a WorkflowDef by registered name. Raises KeyError if unknown."""
    # Lazy imports to avoid circular deps and keep gateway startup fast.
    if not _HARNESSES:
        from workflow.harnesses.morning_repo_scan import WORKFLOW as mrs
        from workflow.harnesses.watch_and_notify import WORKFLOW as wan
        from workflow.harnesses.research_digest import WORKFLOW as rd

        _HARNESSES["morning-repo-scan"] = mrs
        _HARNESSES["watch-and-notify"] = wan
        _HARNESSES["research-digest"] = rd

    if name not in _HARNESSES:
        raise KeyError(
            f"Unknown workflow harness: {name!r}. "
            f"Available: {', '.join(sorted(_HARNESSES))}"
        )
    return _HARNESSES[name]
