"""Dashboard v2 F3 — events search/export + approval history routes."""

from __future__ import annotations

import json
import time

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter, cors_middleware
from gateway.platforms.dashboard_routes import register_dashboard_routes
from gateway.event_bus import reset_event_bus_for_tests, get_event_bus


@pytest.fixture(autouse=True)
def _reset_singletons(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # hermes_state.DEFAULT_DB_PATH is cached at import time — patch it so
    # the dashboard handler's bare ``SessionDB()`` resolves to the test
    # tmp_path instead of the real ~/.hermes/state.db.
    import hermes_state
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    reset_event_bus_for_tests()
    try:
        from hermes_cli.config import reset_dashboard_token_cache
        reset_dashboard_token_cache()
    except Exception:
        pass
    # Also clear any pending approvals carried over between tests
    try:
        from tools import approval as approval_mod
        with approval_mod._lock:
            approval_mod._gateway_queues.clear()
            approval_mod._pending.clear()
    except Exception:
        pass
    yield
    reset_event_bus_for_tests()


def _make_app() -> web.Application:
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    app = web.Application(middlewares=[cors_middleware])
    app["api_server_adapter"] = adapter
    register_dashboard_routes(app, adapter=adapter, static_dir=None)
    return app


def _seed_events(tmp_path, events):
    """Write a list of event dicts as NDJSON to events.ndjson."""
    path = tmp_path / "events.ndjson"
    with open(path, "w", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")
    return path


# ---------------------------------------------------------------------------
# /api/dashboard/events/search
# ---------------------------------------------------------------------------


class TestEventsSearch:
    @pytest.mark.asyncio
    async def test_type_wildcard_filter(self, tmp_path):
        # Seed via the live event bus so the same path the runtime uses
        bus = get_event_bus()
        bus.publish("tool.invoked", session_id="s1", data={"tool": "ls"})
        bus.publish("tool.completed", session_id="s1", data={"tool": "ls"})
        bus.publish("approval.requested", session_id="s1", data={"command": "rm"})
        bus.publish("turn.started", session_id="s1", data={})
        # Drain to disk

        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/events/search?types=tool.*")
            assert resp.status == 200
            data = await resp.json()
            types = {e["type"] for e in data["events"]}
            assert types == {"tool.invoked", "tool.completed"}

    @pytest.mark.asyncio
    async def test_exact_type_filter(self, tmp_path):
        bus = get_event_bus()
        bus.publish("tool.invoked", session_id="s1", data={"tool": "ls"})
        bus.publish("approval.requested", session_id="s1", data={"command": "rm"})
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get(
                "/api/dashboard/events/search?types=approval.requested"
            )
            data = await resp.json()
            assert all(e["type"] == "approval.requested" for e in data["events"])

    @pytest.mark.asyncio
    async def test_session_filter(self, tmp_path):
        bus = get_event_bus()
        bus.publish("tool.invoked", session_id="s1", data={"tool": "a"})
        bus.publish("tool.invoked", session_id="s2", data={"tool": "b"})
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/events/search?session=s2")
            data = await resp.json()
            assert all(e["session_id"] == "s2" for e in data["events"])

    @pytest.mark.asyncio
    async def test_q_filter(self, tmp_path):
        bus = get_event_bus()
        bus.publish("tool.invoked", session_id="s1", data={"tool": "ls /tmp"})
        bus.publish("tool.invoked", session_id="s1", data={"tool": "git status"})
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/events/search?q=/tmp")
            data = await resp.json()
            assert any("/tmp" in json.dumps(e["data"]) for e in data["events"])

    @pytest.mark.asyncio
    async def test_limit_honored(self, tmp_path):
        bus = get_event_bus()
        for i in range(20):
            bus.publish("tool.invoked", session_id="s1", data={"i": i})
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/events/search?types=tool.*&limit=5")
            data = await resp.json()
            assert len(data["events"]) == 5


# ---------------------------------------------------------------------------
# /api/dashboard/events/export
# ---------------------------------------------------------------------------


class TestEventsExport:
    @pytest.mark.asyncio
    async def test_export_streams_ndjson(self):
        bus = get_event_bus()
        bus.publish("tool.invoked", session_id="s1", data={"tool": "a"})
        bus.publish("tool.invoked", session_id="s1", data={"tool": "b"})
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/events/export?types=tool.*")
            assert resp.status == 200
            assert "ndjson" in resp.headers["Content-Type"]
            text = await resp.text()
            lines = [l for l in text.splitlines() if l.strip()]
            assert len(lines) == 2
            for line in lines:
                evt = json.loads(line)
                assert evt["type"] == "tool.invoked"


# ---------------------------------------------------------------------------
# /api/dashboard/approvals/history
# ---------------------------------------------------------------------------


class TestApprovalHistoryRoute:
    @pytest.mark.asyncio
    async def test_history_lists_records(self):
        from hermes_state import SessionDB
        db = SessionDB()
        db.record_approval(
            session_id="s1", command="rm", pattern_key="rm -rf",
            description="d", choice="once", resolver="dashboard",
            resolved_at=time.time(), wait_ms=200,
        )
        db.record_approval(
            session_id="s2", command="curl", pattern_key="curl",
            description="d", choice="deny", resolver="dashboard",
            resolved_at=time.time(),
        )
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/approvals/history")
            data = await resp.json()
            assert len(data["rows"]) == 2

    @pytest.mark.asyncio
    async def test_history_choice_filter(self):
        from hermes_state import SessionDB
        db = SessionDB()
        for c in ("once", "once", "deny", "session"):
            db.record_approval(
                session_id="s",
                command="x",
                pattern_key="rm",
                description="d",
                choice=c,
                resolver="dashboard",
                resolved_at=time.time(),
            )
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/approvals/history?choice=once")
            data = await resp.json()
            assert all(r["choice"] == "once" for r in data["rows"])

    @pytest.mark.asyncio
    async def test_stats_route(self):
        from hermes_state import SessionDB
        db = SessionDB()
        for c in ("once", "deny", "once", "deny", "deny"):
            db.record_approval(
                session_id="s",
                command="x",
                pattern_key="rm -rf",
                description="d",
                choice=c,
                resolver="dashboard",
                resolved_at=time.time(),
            )
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/approvals/stats?window=24h")
            data = await resp.json()
            assert "rm -rf" in data["stats"]
            entry = data["stats"]["rm -rf"]
            assert entry["count"] == 5
            assert entry["denied"] == 3

    @pytest.mark.asyncio
    async def test_bulk_resolve_with_partial_failure(self):
        from tools import approval as approval_mod
        # Queue two valid approvals
        for key in ("k1", "k2"):
            entry = approval_mod._ApprovalEntry({
                "command": "rm",
                "pattern_key": "rm -rf",
                "description": "d",
            })
            with approval_mod._lock:
                approval_mod._gateway_queues.setdefault(key, []).append(entry)
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/api/dashboard/approvals/bulk",
                json={"session_keys": ["k1", "k2", "missing"], "choice": "once"},
            )
            data = await resp.json()
            results = {r["session_key"]: r for r in data["results"]}
            assert results["k1"]["ok"] is True
            assert results["k2"]["ok"] is True
            assert results["missing"]["ok"] is False
