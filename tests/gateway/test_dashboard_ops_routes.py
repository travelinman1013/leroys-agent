"""Dashboard v2 F4 — interactive ops routes (cron / tools / skills / mcp)."""

from __future__ import annotations

import pytest
import yaml
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter, cors_middleware
from gateway.platforms.dashboard_routes import register_dashboard_routes
from gateway.event_bus import reset_event_bus_for_tests


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_state
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    reset_event_bus_for_tests()
    # Clear cached path-jail
    try:
        from hermes_cli.config import reset_path_jail_cache
        reset_path_jail_cache()
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


def _seed_config(tmp_path, payload):
    p = tmp_path / "config.yaml"
    p.write_text(yaml.dump(payload, sort_keys=False))


# ---------------------------------------------------------------------------
# Cron parse-schedule + dry-run
# ---------------------------------------------------------------------------


class TestCronRoutes:
    @pytest.mark.asyncio
    async def test_parse_interval(self):
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get(
                "/api/dashboard/jobs/parse-schedule?expr=every%2030m"
            )
            assert resp.status == 200
            data = await resp.json()
            assert data["parsed"]["kind"] == "interval"
            assert data["parsed"]["minutes"] == 30

    @pytest.mark.asyncio
    async def test_parse_invalid(self):
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get(
                "/api/dashboard/jobs/parse-schedule?expr=garbage"
            )
            assert resp.status == 400

    @pytest.mark.asyncio
    async def test_dry_run_does_not_persist(self, tmp_path):
        from cron import jobs as cron_jobs
        before = list(cron_jobs.list_jobs(include_disabled=True))
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/api/dashboard/jobs/dry-run",
                json={"prompt": "ping me", "schedule": "30m"},
            )
            assert resp.status == 200
            data = await resp.json()
            assert data["persisted"] is False
            assert data["spec"]["dry_run"] is True
            assert data["spec"]["id"].startswith("dry-")
        after = list(cron_jobs.list_jobs(include_disabled=True))
        assert len(after) == len(before)


# ---------------------------------------------------------------------------
# Tool toggle
# ---------------------------------------------------------------------------


class TestToolToggle:
    @pytest.mark.asyncio
    async def test_toggle_writes_config(self, tmp_path):
        _seed_config(tmp_path, {
            "approvals": {"mode": "manual"},
            "compression": {"threshold": 0.75},
            "platform_toolsets": {"telegram": {"web": True}},
        })
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/api/dashboard/tools/web/toggle",
                json={"platform": "telegram", "enabled": False},
            )
            assert resp.status == 200
            data = await resp.json()
            assert "platform_toolsets.telegram.web" in data["restart_required"]
        # Verify config.yaml mutated
        with open(tmp_path / "config.yaml") as f:
            cfg = yaml.safe_load(f)
        assert cfg["platform_toolsets"]["telegram"]["web"] is False


# ---------------------------------------------------------------------------
# Skill reload + view
# ---------------------------------------------------------------------------


class TestSkillRoutes:
    @pytest.mark.asyncio
    async def test_reload_404_on_missing(self):
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post("/api/dashboard/skills/nope/reload")
            assert resp.status == 404

    @pytest.mark.asyncio
    async def test_view_full_skill(self, tmp_path):
        skill_dir = tmp_path / "skills" / "demo"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text("# demo\n\nhello")
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/skills/demo/full")
            assert resp.status == 200
            data = await resp.json()
            assert "hello" in data["content"]


# ---------------------------------------------------------------------------
# MCP toggle + health
# ---------------------------------------------------------------------------


class TestMCPRoutes:
    @pytest.mark.asyncio
    async def test_health_404_on_unknown(self, tmp_path):
        _seed_config(tmp_path, {
            "approvals": {"mode": "manual"},
            "mcp_servers": {"github": {"command": "/bin/echo"}},
        })
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/mcp/missing/health")
            assert resp.status == 404

    @pytest.mark.asyncio
    async def test_health_known_server(self, tmp_path):
        _seed_config(tmp_path, {
            "approvals": {"mode": "manual"},
            "mcp_servers": {
                "github": {"command": "/bin/echo", "disabled": False},
            },
        })
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/mcp/github/health")
            assert resp.status == 200
            data = await resp.json()
            assert data["enabled"] is True
            assert data["command"] == "/bin/echo"

    @pytest.mark.asyncio
    async def test_toggle_writes_disabled_flag(self, tmp_path):
        _seed_config(tmp_path, {
            "approvals": {"mode": "manual"},
            "mcp_servers": {"github": {"command": "/bin/echo"}},
        })
        app = _make_app()
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/api/dashboard/mcp/github/toggle",
                json={"enabled": False},
            )
            assert resp.status == 200
        with open(tmp_path / "config.yaml") as f:
            cfg = yaml.safe_load(f)
        assert cfg["mcp_servers"]["github"]["disabled"] is True


def _make_app_dir():
    """Helper used by tests that don't take tmp_path directly."""
    return None
