"""Dashboard v2 F1 — session control plane route tests."""

from __future__ import annotations

import time

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter, cors_middleware
from gateway.platforms.dashboard_routes import register_dashboard_routes
from gateway.event_bus import reset_event_bus_for_tests


@pytest.fixture(autouse=True)
def _reset_singletons(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    reset_event_bus_for_tests()
    try:
        from hermes_cli.config import reset_dashboard_token_cache
        reset_dashboard_token_cache()
    except Exception:
        pass
    try:
        from hermes_constants import get_hermes_home
        if hasattr(get_hermes_home, "cache_clear"):
            get_hermes_home.cache_clear()
    except Exception:
        pass
    yield
    reset_event_bus_for_tests()


def _make_app() -> tuple[web.Application, APIServerAdapter]:
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    app = web.Application(middlewares=[cors_middleware])
    app["api_server_adapter"] = adapter
    register_dashboard_routes(app, adapter=adapter, static_dir=None)
    return app, adapter


def _seed_session(db, session_id="src", end=True, n_messages=5):
    db.create_session(session_id=session_id, source="cli", model="test")
    db.set_session_title(session_id, f"Title {session_id}")
    for i in range(n_messages):
        db.append_message(
            session_id=session_id,
            role="user" if i % 2 == 0 else "assistant",
            content=f"msg {i}",
            tool_calls=[{"id": f"call_{i}", "function": {"name": "x"}}] if i == 2 else None,
            tool_call_id=f"call_{i}" if i == 2 else None,
            reasoning="thought" if i == 1 else None,
        )
    if end:
        db.end_session(session_id, end_reason="user_exit")
    return session_id


# ---------------------------------------------------------------------------
# fork_session DB-level tests (validator finding #11)
# ---------------------------------------------------------------------------


class TestForkSessionDB:
    def test_fork_preserves_message_count(self, tmp_path):
        from hermes_state import SessionDB
        db = SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "src", n_messages=5)
        new_id = db.fork_session("src", up_to_turn_idx=2)
        assert new_id is not None
        msgs = db.get_messages(new_id)
        assert len(msgs) == 3

    def test_fork_preserves_tool_call_id_and_tool_calls(self, tmp_path):
        from hermes_state import SessionDB
        db = SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "src", n_messages=5)
        new_id = db.fork_session("src")
        msgs = db.get_messages(new_id)
        third = msgs[2]
        assert third["tool_call_id"] == "call_2"
        assert isinstance(third["tool_calls"], list)
        assert third["tool_calls"][0]["id"] == "call_2"

    def test_fork_preserves_reasoning(self, tmp_path):
        from hermes_state import SessionDB
        db = SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "src", n_messages=5)
        new_id = db.fork_session("src")
        msgs = db.get_messages(new_id)
        # The 2nd message had reasoning
        assert msgs[1]["reasoning"] == "thought"

    def test_fork_sets_parent_session_id(self, tmp_path):
        from hermes_state import SessionDB
        db = SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "src")
        new_id = db.fork_session("src")
        new = db.get_session(new_id)
        assert new["parent_session_id"] == "src"

    def test_fork_nonexistent_returns_none(self, tmp_path):
        from hermes_state import SessionDB
        db = SessionDB(db_path=tmp_path / "state.db")
        assert db.fork_session("nope") is None

    def test_fork_full_session_when_up_to_turn_none(self, tmp_path):
        from hermes_state import SessionDB
        db = SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "src", n_messages=4)
        new_id = db.fork_session("src", up_to_turn_idx=None)
        msgs = db.get_messages(new_id)
        assert len(msgs) == 4


# ---------------------------------------------------------------------------
# Search filter tests (DB level)
# ---------------------------------------------------------------------------


class TestSearchFilters:
    def test_q_filter_matches_title(self, tmp_path):
        from hermes_state import SessionDB
        db = SessionDB(db_path=tmp_path / "state.db")
        db.create_session(session_id="a", source="cli")
        db.set_session_title("a", "Refactor login flow")
        db.create_session(session_id="b", source="cli")
        db.set_session_title("b", "Fix bug in dashboard")
        rows = db.search_sessions(q="refactor")
        assert len(rows) == 1
        assert rows[0]["id"] == "a"

    def test_started_after_filter(self, tmp_path):
        from hermes_state import SessionDB
        db = SessionDB(db_path=tmp_path / "state.db")
        db.create_session(session_id="old", source="cli")
        # Manually backdate via SQL
        db._conn.execute("UPDATE sessions SET started_at = 1000 WHERE id = 'old'")
        db._conn.commit()
        db.create_session(session_id="new", source="cli")
        rows = db.search_sessions(started_after=2000)
        ids = {r["id"] for r in rows}
        assert "new" in ids
        assert "old" not in ids


# ---------------------------------------------------------------------------
# REST route tests
# ---------------------------------------------------------------------------


class TestF1Routes:
    @pytest.mark.asyncio
    async def test_delete_session_route(self):
        app, _ = _make_app()
        from hermes_state import SessionDB
        db = SessionDB()
        _seed_session(db, "to-delete")
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.delete("/api/dashboard/sessions/to-delete")
            assert resp.status == 200
            data = await resp.json()
            assert data["deleted"] is True
        # Confirm gone
        assert db.get_session("to-delete") is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_returns_404(self):
        app, _ = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.delete("/api/dashboard/sessions/nope")
            assert resp.status == 404

    @pytest.mark.asyncio
    async def test_export_json_round_trip(self):
        app, _ = _make_app()
        from hermes_state import SessionDB
        db = SessionDB()
        _seed_session(db, "exp", n_messages=3)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/sessions/exp/export?format=json")
            assert resp.status == 200
            data = await resp.json()
            assert data["id"] == "exp"
            assert len(data["messages"]) == 3

    @pytest.mark.asyncio
    async def test_export_markdown(self):
        app, _ = _make_app()
        from hermes_state import SessionDB
        db = SessionDB()
        _seed_session(db, "mdsess", n_messages=2)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/sessions/mdsess/export?format=md")
            assert resp.status == 200
            text = await resp.text()
            assert "# Title mdsess" in text or "# Session mdsess" in text
            assert "msg 0" in text

    @pytest.mark.asyncio
    async def test_fork_route(self):
        app, _ = _make_app()
        from hermes_state import SessionDB
        db = SessionDB()
        _seed_session(db, "src", n_messages=4, end=True)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/api/dashboard/sessions/src/fork",
                json={"up_to_turn": 2},
            )
            assert resp.status == 200
            data = await resp.json()
            assert data["parent_id"] == "src"
            assert data["id"].startswith("src_fork_")
        # Confirm new session has 3 messages
        msgs = db.get_messages(data["id"])
        assert len(msgs) == 3

    @pytest.mark.asyncio
    async def test_fork_active_session_returns_409(self):
        app, _ = _make_app()
        from hermes_state import SessionDB
        db = SessionDB()
        _seed_session(db, "active", end=False)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/api/dashboard/sessions/active/fork",
                json={"up_to_turn": 2},
            )
            assert resp.status == 409

    @pytest.mark.asyncio
    async def test_inject_into_ended_session_reopens_and_appends(self):
        app, _ = _make_app()
        from hermes_state import SessionDB
        db = SessionDB()
        _seed_session(db, "ended", end=True, n_messages=2)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/api/dashboard/sessions/ended/inject",
                json={"content": "follow up question"},
            )
            assert resp.status == 200
        sess = db.get_session("ended")
        assert sess["ended_at"] is None  # reopened
        msgs = db.get_messages("ended")
        assert msgs[-1]["content"] == "follow up question"

    @pytest.mark.asyncio
    async def test_inject_requires_content(self):
        app, _ = _make_app()
        from hermes_state import SessionDB
        SessionDB().create_session(session_id="x", source="cli")
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/api/dashboard/sessions/x/inject",
                json={},
            )
            assert resp.status == 400

    @pytest.mark.asyncio
    async def test_reopen_route(self):
        app, _ = _make_app()
        from hermes_state import SessionDB
        db = SessionDB()
        _seed_session(db, "ro", end=True)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post("/api/dashboard/sessions/ro/reopen")
            assert resp.status == 200
        assert db.get_session("ro")["ended_at"] is None

    @pytest.mark.asyncio
    async def test_search_route(self):
        app, _ = _make_app()
        from hermes_state import SessionDB
        db = SessionDB()
        db.create_session(session_id="alpha", source="cli")
        db.set_session_title("alpha", "Refactor module")
        db.create_session(session_id="beta", source="cli")
        db.set_session_title("beta", "Bug fix")
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/sessions/search?q=refactor")
            assert resp.status == 200
            data = await resp.json()
            assert len(data["sessions"]) == 1
            assert data["sessions"][0]["id"] == "alpha"

    @pytest.mark.asyncio
    async def test_bulk_delete_with_partial_failure(self):
        app, _ = _make_app()
        from hermes_state import SessionDB
        db = SessionDB()
        for sid in ("b1", "b2", "b3"):
            _seed_session(db, sid)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/api/dashboard/sessions/bulk",
                json={"action": "delete", "ids": ["b1", "b2", "missing", "b3"]},
            )
            assert resp.status == 200
            data = await resp.json()
            results = {r["id"]: r for r in data["results"]}
            assert results["b1"]["ok"] is True
            assert results["b2"]["ok"] is True
            assert results["missing"]["ok"] is False
            assert "not found" in results["missing"]["error"]
            assert results["b3"]["ok"] is True

    @pytest.mark.asyncio
    async def test_bulk_export(self):
        app, _ = _make_app()
        from hermes_state import SessionDB
        db = SessionDB()
        _seed_session(db, "e1", n_messages=2)
        _seed_session(db, "e2", n_messages=4)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/api/dashboard/sessions/bulk",
                json={"action": "export", "ids": ["e1", "e2"]},
            )
            assert resp.status == 200
            data = await resp.json()
            assert all(r["ok"] for r in data["results"])
            assert {r["message_count"] for r in data["results"]} == {2, 4}


# ---------------------------------------------------------------------------
# Phase 8a — Session Control Plane Tests
# ---------------------------------------------------------------------------


class MockAgent:
    """Fake agent that records interrupt calls."""

    def __init__(self):
        self.interrupted_with = None

    def interrupt(self, msg=None):
        self.interrupted_with = msg

    def get_activity_summary(self):
        return {
            "current_tool": "test_tool",
            "api_call_count": 3,
            "max_iterations": 30,
            "seconds_since_activity": 0.5,
            "last_activity_desc": "running test",
            "last_activity_ts": time.time(),
            "budget_used": 3,
            "budget_max": 30,
        }


class MockSessionStore:
    """Minimal SessionStore stub for runner bridge tests."""

    def __init__(self):
        self._entries = {}
        self._db = None

    def _ensure_loaded(self):
        pass

    def get_or_create_session(self, source, force_new=False):
        """Create a fake session entry."""
        import uuid
        from types import SimpleNamespace
        session_id = f"mock_{uuid.uuid4().hex[:8]}"
        key = f"agent:main:{source.platform.value}:dm:{source.chat_id}"
        entry = SimpleNamespace(
            session_id=session_id,
            session_key=key,
        )
        self._entries[key] = entry
        # Also create in DB if available
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            db.create_session(session_id, source="dashboard", session_key=key)
        except Exception:
            pass
        return entry


class MockRunner:
    """Minimal GatewayRunner stub for control plane tests."""

    def __init__(self):
        self._running_agents = {}
        self._running_agents_ts = {}
        self._pending_messages = {}
        self._running = True
        self.session_store = MockSessionStore()


def _make_app_with_runner(runner=None):
    """Create test app with a mock runner attached to the adapter."""
    app, adapter = _make_app()
    if runner is None:
        runner = MockRunner()
    adapter.gateway_runner = runner
    return app, adapter, runner


class TestSchemaV9:
    """R1: Schema v9 migration tests."""

    def test_schema_v9_fresh_db(self, tmp_path):
        """New DB gets session_key + workflow_run_id columns."""
        import hermes_state
        db = hermes_state.SessionDB(db_path=tmp_path / "fresh.db")
        cols = [
            c[1] for c in
            db._conn.execute("PRAGMA table_info(sessions)").fetchall()
        ]
        assert "session_key" in cols
        assert "workflow_run_id" in cols

    def test_schema_v9_migration_from_v8(self, tmp_path):
        """Existing v8 DB migrates to v9 with new columns."""
        import hermes_state
        # First create a fresh DB (gets v9)
        db_path = tmp_path / "v8.db"
        db = hermes_state.SessionDB(db_path=db_path)
        # Downgrade version to 8, remove v9 columns to simulate v8 state
        db._conn.execute("UPDATE schema_version SET version = 8")
        try:
            db._conn.execute("ALTER TABLE sessions DROP COLUMN session_key")
            db._conn.execute("ALTER TABLE sessions DROP COLUMN workflow_run_id")
        except Exception:
            # SQLite < 3.35 doesn't support DROP COLUMN — skip
            pytest.skip("SQLite version doesn't support DROP COLUMN")
        db._conn.commit()
        db._conn.close()
        # Reopen — should auto-migrate to v9
        db2 = hermes_state.SessionDB(db_path=db_path)
        cols = [
            c[1] for c in
            db2._conn.execute("PRAGMA table_info(sessions)").fetchall()
        ]
        assert "session_key" in cols
        assert "workflow_run_id" in cols
        ver = db2._conn.execute("SELECT version FROM schema_version").fetchone()[0]
        assert ver == 9

    def test_create_session_with_key(self, tmp_path):
        """create_session stores session_key when provided."""
        import hermes_state
        db = hermes_state.SessionDB(db_path=tmp_path / "test.db")
        db.create_session("s1", "dashboard", session_key="sk_s1")
        s = db.get_session("s1")
        assert s["session_key"] == "sk_s1"

    def test_get_session_by_key(self, tmp_path):
        """get_session_by_key returns the active session for a key."""
        import hermes_state
        db = hermes_state.SessionDB(db_path=tmp_path / "test.db")
        db.create_session("s1", "dashboard", session_key="sk_1")
        found = db.get_session_by_key("sk_1")
        assert found is not None
        assert found["id"] == "s1"
        # After ending, should return None
        db.end_session("s1", "done")
        assert db.get_session_by_key("sk_1") is None


class TestSessionControlPlane:
    """Phase 8a — session status, kill, inject, spawn."""

    @pytest.mark.asyncio
    async def test_session_list_includes_status(self, tmp_path, monkeypatch):
        """GET /sessions rows have status field."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
        db = hermes_state.SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "active1", end=False)
        _seed_session(db, "ended1", end=True)

        app, adapter, runner = _make_app_with_runner()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            token = (await resp.json())["token"]
            h = {"Authorization": f"Bearer {token}"}

            resp = await cli.get("/api/dashboard/sessions", headers=h)
            assert resp.status == 200
            data = await resp.json()
            statuses = {s["id"]: s["status"] for s in data["sessions"]}
            assert statuses.get("ended1") == "ended"
            assert statuses.get("active1") == "idle"

    @pytest.mark.asyncio
    async def test_session_detail_includes_activity(self, tmp_path, monkeypatch):
        """GET /sessions/{id} returns activity when session is running."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
        db = hermes_state.SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "running1", end=False)

        app, adapter, runner = _make_app_with_runner()
        mock_agent = MockAgent()
        runner._running_agents["sk_running1"] = mock_agent
        runner._running_agents_ts["sk_running1"] = time.time()
        from types import SimpleNamespace
        runner.session_store._entries["sk_running1"] = SimpleNamespace(session_id="running1")

        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            token = (await resp.json())["token"]
            h = {"Authorization": f"Bearer {token}"}

            resp = await cli.get("/api/dashboard/sessions/running1", headers=h)
            assert resp.status == 200
            data = await resp.json()
            assert data["session"]["status"] == "running"
            assert "activity" in data["session"]
            assert data["session"]["activity"]["current_tool"] == "test_tool"

    @pytest.mark.asyncio
    async def test_kill_running(self, tmp_path, monkeypatch):
        """POST /kill interrupts agent and removes from tracking."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
        db = hermes_state.SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "kill1", end=False)

        app, adapter, runner = _make_app_with_runner()
        mock_agent = MockAgent()
        runner._running_agents["sk_kill1"] = mock_agent
        runner._running_agents_ts["sk_kill1"] = time.time()
        from types import SimpleNamespace
        runner.session_store._entries["sk_kill1"] = SimpleNamespace(session_id="kill1")

        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            token = (await resp.json())["token"]
            h = {"Authorization": f"Bearer {token}"}

            resp = await cli.post("/api/dashboard/sessions/kill1/kill", json={"reason": "test kill"}, headers=h)
            assert resp.status == 200
            data = await resp.json()
            assert data["killed"] is True
            assert data["was_running"] is True
            assert mock_agent.interrupted_with is not None
            assert "sk_kill1" not in runner._running_agents

    @pytest.mark.asyncio
    async def test_kill_not_running(self, tmp_path, monkeypatch):
        """POST /kill returns was_running=false for ended sessions."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
        db = hermes_state.SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "dead1", end=True)

        app, adapter, runner = _make_app_with_runner()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            token = (await resp.json())["token"]
            h = {"Authorization": f"Bearer {token}"}

            resp = await cli.post("/api/dashboard/sessions/dead1/kill", json={}, headers=h)
            assert resp.status == 200
            data = await resp.json()
            assert data["killed"] is False
            assert data["was_running"] is False

    @pytest.mark.asyncio
    async def test_kill_sentinel_state(self, tmp_path, monkeypatch):
        """POST /kill when session is in SENTINEL state still cleans up."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
        db = hermes_state.SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "sentinel1", end=False)

        app, adapter, runner = _make_app_with_runner()
        sentinel = object()
        runner._running_agents["sk_sentinel1"] = sentinel
        from types import SimpleNamespace
        runner.session_store._entries["sk_sentinel1"] = SimpleNamespace(session_id="sentinel1")

        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            token = (await resp.json())["token"]
            h = {"Authorization": f"Bearer {token}"}

            resp = await cli.post("/api/dashboard/sessions/sentinel1/kill", json={}, headers=h)
            assert resp.status == 200
            data = await resp.json()
            assert data["killed"] is True
            assert "sk_sentinel1" not in runner._running_agents

    @pytest.mark.asyncio
    async def test_inject_wakes_agent(self, tmp_path, monkeypatch):
        """POST /inject calls interrupt when agent is running."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
        db = hermes_state.SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "inject1", end=False)

        app, adapter, runner = _make_app_with_runner()
        mock_agent = MockAgent()
        runner._running_agents["sk_inject1"] = mock_agent
        from types import SimpleNamespace
        runner.session_store._entries["sk_inject1"] = SimpleNamespace(session_id="inject1")

        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            token = (await resp.json())["token"]
            h = {"Authorization": f"Bearer {token}"}

            resp = await cli.post("/api/dashboard/sessions/inject1/inject", json={"content": "wake up!"}, headers=h)
            assert resp.status == 200
            data = await resp.json()
            assert data.get("delivered_live") is True
            assert mock_agent.interrupted_with == "wake up!"

    @pytest.mark.asyncio
    async def test_inject_idle(self, tmp_path, monkeypatch):
        """POST /inject appends to DB only when no agent running."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
        db = hermes_state.SessionDB(db_path=tmp_path / "state.db")
        _seed_session(db, "idle1", end=False)

        app, adapter, runner = _make_app_with_runner()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            token = (await resp.json())["token"]
            h = {"Authorization": f"Bearer {token}"}

            resp = await cli.post("/api/dashboard/sessions/idle1/inject", json={"content": "hello idle"}, headers=h)
            assert resp.status == 200
            data = await resp.json()
            assert "delivered_live" not in data
            assert data["message_id"] is not None

    @pytest.mark.asyncio
    async def test_spawn_returns_202(self, tmp_path, monkeypatch):
        """POST /sessions returns 202 with session_id."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")

        app, adapter, runner = _make_app_with_runner()
        async def _fake_run_agent(**kwargs):
            return {"final_response": "done", "api_calls": 1, "completed": True}
        runner._run_agent = _fake_run_agent

        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            token = (await resp.json())["token"]
            h = {"Authorization": f"Bearer {token}"}

            resp = await cli.post("/api/dashboard/sessions", json={"message": "test spawn", "title": "Test"}, headers=h)
            assert resp.status == 202
            data = await resp.json()
            assert "session_id" in data
            assert data["status"] == "spawning"

    @pytest.mark.asyncio
    async def test_spawn_requires_message(self, tmp_path, monkeypatch):
        """POST /sessions without message returns 400."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")

        app, adapter, runner = _make_app_with_runner()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            token = (await resp.json())["token"]
            h = {"Authorization": f"Bearer {token}"}

            resp = await cli.post("/api/dashboard/sessions", json={}, headers=h)
            assert resp.status == 400

    @pytest.mark.asyncio
    async def test_spawn_concurrent_limit(self, tmp_path, monkeypatch):
        """POST /sessions returns 429 when concurrent cap reached."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")

        app, adapter, runner = _make_app_with_runner()
        for i in range(5):
            runner._running_agents[f"agent:main:local:dm:dashboard_fake{i}"] = MockAgent()

        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            token = (await resp.json())["token"]
            h = {"Authorization": f"Bearer {token}"}

            resp = await cli.post("/api/dashboard/sessions", json={"message": "should fail"}, headers=h)
            assert resp.status == 429

    @pytest.mark.asyncio
    async def test_spawn_timeout_max(self, tmp_path, monkeypatch):
        """POST /sessions rejects timeout_seconds > MAX."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")

        app, adapter, runner = _make_app_with_runner()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            token = (await resp.json())["token"]
            h = {"Authorization": f"Bearer {token}"}

            resp = await cli.post("/api/dashboard/sessions", json={"message": "test", "timeout_seconds": 99999}, headers=h)
            assert resp.status == 400

    def test_resolve_session_key_empty_store(self, tmp_path, monkeypatch):
        """Resolver falls back to DB when _entries is empty."""
        import hermes_state
        monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
        db = hermes_state.SessionDB(db_path=tmp_path / "state.db")
        db.create_session("s1", "dashboard", session_key="sk_fallback")

        from gateway.platforms.dashboard_routes import _resolve_session_key
        runner = MockRunner()
        # _entries is empty, should fall back to DB
        result = _resolve_session_key(runner, "s1")
        assert result == "sk_fallback"
