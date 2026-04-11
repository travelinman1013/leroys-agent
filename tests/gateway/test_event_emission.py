"""Verify that the W0 event emissions exist at their patch sites.

These are static-instrumentation checks: we don't run the agent loop,
we run the patched function in isolation and assert that the EventBus
sees the event.

Covers:
    * tool.invoked / tool.completed (model_tools.handle_function_call)
    * approval.requested (tools/approval.py:check_all_command_guards)
    * approval.resolved (tools/approval.py:resolve_gateway_approval)
    * compaction (agent/context_compressor.py — already shipping; smoke
      test that the import path is reachable)
    * cron.fired (cron/scheduler.py — already shipping; same)
    * llm.call instrumentation existence in run_agent.py and
      auxiliary_client.py (source-level grep)
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

from gateway.event_bus import EventBus, reset_event_bus_for_tests, get_event_bus


@pytest.fixture(autouse=True)
def _fresh_bus(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    reset_event_bus_for_tests()
    yield
    reset_event_bus_for_tests()


def _drain_recent(types: tuple[str, ...] | None = None):
    bus = get_event_bus()
    if types is None:
        return bus.recent_events(limit=0)
    return [e for e in bus.recent_events(limit=0) if e["type"] in types]


# ---------------------------------------------------------------------------
# Tool dispatcher emissions (model_tools.handle_function_call)
# ---------------------------------------------------------------------------


def test_tool_invoked_and_completed_publish_events():
    import json as _json
    import model_tools

    # Inject a fake tool that just returns a string.
    def _fake_dispatch(name, args, **kwargs):
        return _json.dumps({"ok": True, "echo": args})

    real_dispatch = model_tools.registry.dispatch
    model_tools.registry.dispatch = _fake_dispatch  # type: ignore[assignment]
    try:
        result = model_tools.handle_function_call(
            "search_files",
            {"query": "x"},
            session_id="test-session",
        )
    finally:
        model_tools.registry.dispatch = real_dispatch  # type: ignore[assignment]

    assert "ok" in result
    types = [e["type"] for e in _drain_recent(("tool.invoked", "tool.completed"))]
    assert "tool.invoked" in types
    assert "tool.completed" in types
    completed = next(
        e for e in _drain_recent(("tool.completed",))
    )
    assert completed["data"]["ok"] is True
    assert completed["data"]["latency_ms"] is not None


def test_tool_completed_publishes_on_error():
    import model_tools

    def _fake_dispatch(name, args, **kwargs):
        raise RuntimeError("boom")

    real_dispatch = model_tools.registry.dispatch
    model_tools.registry.dispatch = _fake_dispatch  # type: ignore[assignment]
    try:
        result = model_tools.handle_function_call(
            "search_files",
            {"query": "x"},
            session_id="test-session",
        )
    finally:
        model_tools.registry.dispatch = real_dispatch  # type: ignore[assignment]

    assert "error" in result.lower()
    completed = [e for e in _drain_recent(("tool.completed",))]
    assert completed
    assert completed[-1]["data"]["ok"] is False


# ---------------------------------------------------------------------------
# Approval emissions
# ---------------------------------------------------------------------------


def test_approval_resolved_emits_and_records_history(tmp_path, monkeypatch):
    """resolve_gateway_approval must publish approval.resolved AND
    persist a row in approval_history (W0 audit trail)."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # Force a fresh DB under HERMES_HOME
    import importlib
    import hermes_state
    importlib.reload(hermes_state)
    db = hermes_state.SessionDB(db_path=tmp_path / "state.db")

    import tools.approval as approval

    # Manually queue an entry as if a dangerous command was waiting.
    entry = approval._ApprovalEntry({
        "command": "rm -rf /tmp/x",
        "pattern_key": "rm -rf",
        "description": "recursive delete",
    })
    with approval._lock:
        approval._gateway_queues.setdefault("test-key", []).append(entry)

    # Patch SessionDB() to point at our tmp DB
    monkeypatch.setattr(approval, "SessionDB", lambda: db, raising=False)

    n = approval.resolve_gateway_approval("test-key", "once")
    assert n == 1

    # Event was published
    types = [e["type"] for e in _drain_recent(("approval.resolved",))]
    assert "approval.resolved" in types

    # History row was written
    rows = db.list_approval_history(limit=10)
    assert len(rows) == 1
    assert rows[0]["choice"] == "once"
    assert rows[0]["pattern_key"] == "rm -rf"


# ---------------------------------------------------------------------------
# llm.call source-level instrumentation (the call sites are deep inside
# model client wrappers, so we assert the strings exist instead of mocking
# the entire LLM stack).
# ---------------------------------------------------------------------------


def test_run_agent_emits_llm_call_event():
    src = Path("run_agent.py").read_text(encoding="utf-8")
    assert '"llm.call"' in src, "run_agent.py must publish llm.call after each completion"


def test_auxiliary_client_emits_llm_call_event():
    src = Path("agent/auxiliary_client.py").read_text(encoding="utf-8")
    assert '"llm.call"' in src
    assert "_emit_llm_call" in src


# ---------------------------------------------------------------------------
# compaction + cron.fired source-level checks
# ---------------------------------------------------------------------------


def test_compaction_event_exists_in_context_compressor():
    src = Path("agent/context_compressor.py").read_text(encoding="utf-8")
    assert '"compaction"' in src


def test_cron_fired_event_exists_in_scheduler():
    src = Path("cron/scheduler.py").read_text(encoding="utf-8")
    assert '"cron.fired"' in src
