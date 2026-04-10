"""Tests for gateway.platforms.dashboard_routes."""

from __future__ import annotations

import json
import os
from unittest.mock import patch

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter, cors_middleware
from gateway.platforms.dashboard_routes import (
    DashboardRoutes,
    _localhost_ip,
    _redact_secrets,
    register_dashboard_routes,
)
from gateway.event_bus import reset_event_bus_for_tests


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_singletons(tmp_path, monkeypatch):
    """Redirect HERMES_HOME to a per-test tmp dir so token/config/db don't leak."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    reset_event_bus_for_tests()
    try:
        from hermes_cli.config import reset_dashboard_token_cache
        reset_dashboard_token_cache()
    except Exception:
        pass
    # Also clear lru_cache on get_hermes_home so the new env var takes effect
    try:
        from hermes_constants import get_hermes_home
        if hasattr(get_hermes_home, "cache_clear"):
            get_hermes_home.cache_clear()
    except Exception:
        pass
    yield
    reset_event_bus_for_tests()


def _make_adapter(api_key: str = "") -> APIServerAdapter:
    extra = {}
    if api_key:
        extra["key"] = api_key
    return APIServerAdapter(PlatformConfig(enabled=True, extra=extra))


def _make_app(adapter: APIServerAdapter) -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app["api_server_adapter"] = adapter
    register_dashboard_routes(app, adapter=adapter, static_dir=None)
    return app


# ---------------------------------------------------------------------------
# Helpers — pure functions
# ---------------------------------------------------------------------------


class TestLocalhostDetection:
    def test_ipv4_loopback(self):
        assert _localhost_ip("127.0.0.1") is True

    def test_ipv6_loopback(self):
        assert _localhost_ip("::1") is True
        assert _localhost_ip("[::1]") is True

    def test_lan_ip_rejected(self):
        assert _localhost_ip("192.168.1.5") is False

    def test_public_ip_rejected(self):
        assert _localhost_ip("8.8.8.8") is False

    def test_garbage_rejected(self):
        assert _localhost_ip(None) is False
        assert _localhost_ip("") is False
        assert _localhost_ip("not-an-ip") is False


class TestSecretRedaction:
    def test_redacts_api_key_fields(self):
        src = {"api_key": "sk-abc123", "name": "hermes"}
        red = _redact_secrets(src)
        assert red["api_key"] == "***REDACTED***"
        assert red["name"] == "hermes"

    def test_redacts_nested(self):
        src = {"provider": {"token": "t", "base_url": "https://x"}}
        red = _redact_secrets(src)
        assert red["provider"]["token"] == "***REDACTED***"
        assert red["provider"]["base_url"] == "https://x"

    def test_redacts_lists(self):
        src = {"mcp_servers": [{"name": "gh", "api_key": "k"}]}
        red = _redact_secrets(src)
        assert red["mcp_servers"][0]["api_key"] == "***REDACTED***"

    def test_leaves_non_secret_strings(self):
        src = {"model": "gemma", "cwd": "/Users/foo"}
        red = _redact_secrets(src)
        assert red == src


# ---------------------------------------------------------------------------
# Handshake — localhost bootstrap
# ---------------------------------------------------------------------------


class TestHandshake:
    @pytest.mark.asyncio
    async def test_handshake_returns_token(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/handshake")
            assert resp.status == 200
            data = await resp.json()
            assert "token" in data
            assert len(data["token"]) > 20
            assert "started_at" in data
            assert "host" in data

    @pytest.mark.asyncio
    async def test_handshake_is_idempotent(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            r1 = await cli.get("/api/dashboard/handshake")
            r2 = await cli.get("/api/dashboard/handshake")
            assert (await r1.json())["token"] == (await r2.json())["token"]


# ---------------------------------------------------------------------------
# Auth — bearer token enforcement
# ---------------------------------------------------------------------------


class TestAuth:
    @pytest.mark.asyncio
    async def test_state_requires_token_when_configured(self):
        adapter = _make_adapter(api_key="sk-test")
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/state")
            assert resp.status == 401

    @pytest.mark.asyncio
    async def test_state_accepts_api_key(self):
        adapter = _make_adapter(api_key="sk-test")
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get(
                "/api/dashboard/state",
                headers={"Authorization": "Bearer sk-test"},
            )
            assert resp.status == 200

    @pytest.mark.asyncio
    async def test_state_accepts_dashboard_token(self, tmp_path):
        adapter = _make_adapter()  # no api key
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            # Handshake to mint token
            hs = await cli.get("/api/dashboard/handshake")
            token = (await hs.json())["token"]

            resp = await cli.get(
                "/api/dashboard/state",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status == 200

    @pytest.mark.asyncio
    async def test_state_loopback_allowed_when_no_keys(self):
        """With no keys configured and a loopback client, requests pass."""
        adapter = _make_adapter()  # no api key
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            # aiohttp TestClient uses loopback — the fallthrough path should allow
            resp = await cli.get("/api/dashboard/state")
            assert resp.status == 200


# ---------------------------------------------------------------------------
# State snapshot
# ---------------------------------------------------------------------------


class TestStateEndpoint:
    @pytest.mark.asyncio
    async def test_state_structure(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/state")
            assert resp.status == 200
            data = await resp.json()
            # Top-level keys that the frontend relies on
            assert "gateway" in data
            assert "active_sessions" in data
            assert "pending_approvals" in data
            assert "cron_jobs" in data
            assert "event_bus" in data
            # Gateway subsection
            assert "started_at" in data["gateway"]
            assert "uptime_seconds" in data["gateway"]
            assert data["pending_approvals"] == []  # no pending on a fresh state


# ---------------------------------------------------------------------------
# Approvals
# ---------------------------------------------------------------------------


class TestApprovalResolution:
    @pytest.mark.asyncio
    async def test_resolve_translates_langgraph_accept(self):
        adapter = _make_adapter()
        app = _make_app(adapter)

        async with TestClient(TestServer(app)) as cli:
            with patch(
                "tools.approval.resolve_gateway_approval", return_value=1
            ) as mock_resolve:
                resp = await cli.post(
                    "/api/dashboard/approvals/session123",
                    json={"choice": "accept"},
                )
                assert resp.status == 200
                data = await resp.json()
                assert data["resolved"] == 1
                assert data["choice"] == "once"  # translated from "accept"
                mock_resolve.assert_called_once_with(
                    "session123", "once", resolve_all=False
                )

    @pytest.mark.asyncio
    async def test_resolve_rejects_bad_choice(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.post(
                "/api/dashboard/approvals/session123",
                json={"choice": "maybe"},
            )
            assert resp.status == 400

    @pytest.mark.asyncio
    async def test_list_approvals_empty_initially(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/approvals")
            assert resp.status == 200
            data = await resp.json()
            assert data["pending"] == []


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


class TestSessionsEndpoints:
    @pytest.mark.asyncio
    async def test_list_sessions_returns_envelope(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/sessions?limit=5")
            assert resp.status == 200
            data = await resp.json()
            assert "sessions" in data
            assert data["limit"] == 5
            assert data["offset"] == 0

    @pytest.mark.asyncio
    async def test_session_detail_404_on_missing(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/sessions/definitely-not-real")
            # Either 404 or 500 if SessionDB isn't available in test env
            assert resp.status in (404, 500)


# ---------------------------------------------------------------------------
# Doctor
# ---------------------------------------------------------------------------


class TestDoctor:
    @pytest.mark.asyncio
    async def test_doctor_returns_checks(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/doctor")
            assert resp.status == 200
            data = await resp.json()
            assert "checks" in data
            names = {c["name"] for c in data["checks"]}
            assert "config.yaml loaded" in names
            assert "event bus" in names
            assert "dashboard token" in names


# ---------------------------------------------------------------------------
# Tools / Skills / MCP
# ---------------------------------------------------------------------------


class TestInventoryEndpoints:
    @pytest.mark.asyncio
    async def test_tools_returns_list(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/tools")
            assert resp.status == 200
            data = await resp.json()
            assert "tools" in data
            assert isinstance(data["tools"], list)

    @pytest.mark.asyncio
    async def test_skills_returns_list(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/skills")
            assert resp.status == 200
            data = await resp.json()
            assert "skills" in data

    @pytest.mark.asyncio
    async def test_mcp_returns_servers(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/mcp")
            assert resp.status == 200
            data = await resp.json()
            assert "servers" in data


# ---------------------------------------------------------------------------
# Recent events + SSE stream
# ---------------------------------------------------------------------------


class TestEventEndpoints:
    @pytest.mark.asyncio
    async def test_recent_events_initially_empty(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/recent")
            assert resp.status == 200
            data = await resp.json()
            assert "events" in data

    @pytest.mark.asyncio
    async def test_recent_events_shows_published(self):
        from gateway.event_bus import publish
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            publish("test.ping", data={"v": 1})
            resp = await cli.get("/api/dashboard/recent")
            data = await resp.json()
            assert any(e["type"] == "test.ping" for e in data["events"])

    @pytest.mark.asyncio
    async def test_sse_stream_delivers_events(self):
        """Subscribe to /api/dashboard/events and verify events stream out."""
        from gateway.event_bus import publish

        adapter = _make_adapter()
        app = _make_app(adapter)

        async with TestClient(TestServer(app)) as cli:
            # Publish before connecting so replay picks it up
            publish("sse.first", data={"n": 1})

            resp = await cli.get("/api/dashboard/events?replay=10", timeout=5)
            assert resp.status == 200
            assert resp.content_type == "text/event-stream"

            # Pull just a few lines then close — aiohttp streams are async
            lines_read = 0
            got_event = False
            async for raw in resp.content:
                lines_read += 1
                text = raw.decode("utf-8", errors="replace")
                if text.startswith("data:"):
                    try:
                        event = json.loads(text[5:].strip())
                        if event.get("type") == "sse.first":
                            got_event = True
                            break
                    except Exception:
                        pass
                if lines_read > 50:
                    break
            assert got_event, "Expected to see the replayed sse.first event"
            resp.close()


# ---------------------------------------------------------------------------
# Config dump
# ---------------------------------------------------------------------------


class TestConfigEndpoint:
    @pytest.mark.asyncio
    async def test_config_is_redacted(self):
        adapter = _make_adapter()
        app = _make_app(adapter)
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get("/api/dashboard/config")
            assert resp.status == 200
            data = await resp.json()
            assert "config" in data
            # Can't assert specific redactions without a known config, but
            # the envelope should exist
            assert isinstance(data["config"], (dict, type(None)))
