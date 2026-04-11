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
