"""Workflow dataclasses — definitions, results, and step contracts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional


@dataclass
class StepDef:
    """A single step in a workflow definition."""

    name: str
    fn: Callable[[Dict[str, Any]], Dict[str, Any]]
    timeout_s: float = 600.0
    skip_on_error: bool = False


@dataclass
class WorkflowDef:
    """Immutable definition of a multi-step workflow."""

    id: str
    name: str
    trigger_type: str  # "cron" | "file_watch"
    steps: List[StepDef]
    trigger_meta: Dict[str, Any] = field(default_factory=dict)


@dataclass
class StepResult:
    """Outcome of a single step execution."""

    step_name: str
    step_index: int
    status: str  # "completed" | "failed" | "skipped"
    output: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    started_at: float = 0.0
    ended_at: float = 0.0


@dataclass
class WorkflowRunResult:
    """Outcome of a full workflow execution."""

    run_id: str
    workflow_id: str
    status: str  # "completed" | "failed" | "cancelled"
    steps: List[StepResult] = field(default_factory=list)
    started_at: float = 0.0
    ended_at: float = 0.0
    error: Optional[str] = None
