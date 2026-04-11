"""Tests for the dashboard static mount + SPA fallback and the
same-origin CORS loopback auto-allow behavior.

Covers the three priority-0 BLOCKs identified in the
``ashen-tempering-ibis`` Dashboard v2 polish plan:

- B1: ``GET /dashboard/`` used to return an aiohttp directory listing
  because the static mount was registered with ``show_index=True`` and
  no ``index.html`` fallback.
- B2: the router has no basepath client-side, so any client-side route
  like ``/dashboard/sessions`` 404'd on hard refresh without an SPA
  fallback on the backend.
- B4: ``_origin_allowed`` returned ``False`` for every same-origin
  ``Origin``-bearing request when ``API_SERVER_CORS_ORIGINS`` was unset,
  which includes Vite's own module-script asset fetches.

None of these touch the bearer-token auth model or the loopback-only
bind address.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter, cors_middleware
from gateway.platforms.dashboard_routes import register_dashboard_routes
from gateway.event_bus import reset_event_bus_for_tests


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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


def _make_adapter(port: int = 8642, cors_origins: str = "") -> APIServerAdapter:
    extra = {"port": port}
    if cors_origins:
        extra["cors_origins"] = cors_origins
    return APIServerAdapter(PlatformConfig(enabled=True, extra=extra))


def _make_static_dir(tmp_path: Path) -> Path:
    """Build a minimal dashboard bundle layout matching Vite's output."""
    static = tmp_path / "api_server_static"
    static.mkdir()
    (static / "index.html").write_text(
        "<!doctype html><html><head><title>Hermes Dashboard</title></head>"
        "<body><div id='root'></div><script type='module' "
        "src='/dashboard/assets/index-abc.js'></script></body></html>"
    )
    (static / "icon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    assets = static / "assets"
    assets.mkdir()
    (assets / "index-abc.js").write_text("console.log('hermes');")
    (assets / "index-def.css").write_text("body{}")
    return static


def _make_app(adapter: APIServerAdapter, static_dir: Path) -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app["api_server_adapter"] = adapter
    register_dashboard_routes(app, adapter=adapter, static_dir=static_dir)
    return app


# ---------------------------------------------------------------------------
# Static mount + SPA fallback (B1 / B2)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestDashboardStaticRoot:
    """The entry points ``/dashboard`` and ``/dashboard/`` must serve
    ``index.html`` — never a directory listing and never a 404."""

    async def test_trailing_slash_serves_index_html(self, tmp_path):
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(), static_dir)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/dashboard/")
            assert resp.status == 200
            body = await resp.text()
            assert "<!doctype html>" in body
            assert "Hermes Dashboard" in body
            # Previously the aiohttp directory listing included <li>assets/</li>
            assert "<li>" not in body
            assert resp.headers.get("Cache-Control") == "no-store"

    async def test_no_trailing_slash_also_serves_index_html(self, tmp_path):
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(), static_dir)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/dashboard")
            assert resp.status == 200
            body = await resp.text()
            assert "Hermes Dashboard" in body


@pytest.mark.asyncio
class TestDashboardSPAFallback:
    """Client-side routes survive hard refresh and bookmarks."""

    async def test_client_side_route_serves_index_html(self, tmp_path):
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(), static_dir)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/dashboard/sessions")
            assert resp.status == 200
            body = await resp.text()
            assert "Hermes Dashboard" in body

    async def test_nested_client_side_route_serves_index_html(self, tmp_path):
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(), static_dir)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/dashboard/sessions/20260411_091757_abc")
            assert resp.status == 200
            body = await resp.text()
            assert "Hermes Dashboard" in body

    async def test_deeply_nested_route_still_falls_back(self, tmp_path):
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(), static_dir)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/dashboard/cron/job/foo/edit")
            assert resp.status == 200
            body = await resp.text()
            assert "Hermes Dashboard" in body

    async def test_missing_asset_is_404_not_html(self, tmp_path):
        """Extensioned paths that do not resolve to a real file must 404.

        If we returned HTML here, browsers trying to load a <script> or
        <img> would see the HTML body and fail with confusing parse
        errors downstream.
        """
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(), static_dir)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/dashboard/does-not-exist.js")
            assert resp.status == 404
            resp2 = await client.get("/dashboard/foo.png")
            assert resp2.status == 404


@pytest.mark.asyncio
class TestDashboardAssetMount:
    """Real assets at /dashboard/assets/* must still be served."""

    async def test_hashed_js_asset_served(self, tmp_path):
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(), static_dir)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/dashboard/assets/index-abc.js")
            assert resp.status == 200
            body = await resp.text()
            assert "console.log('hermes')" in body

    async def test_hashed_css_asset_served(self, tmp_path):
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(), static_dir)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/dashboard/assets/index-def.css")
            assert resp.status == 200

    async def test_root_level_icon_served(self, tmp_path):
        """``icon.svg`` sits at the static_dir root (not inside assets/).

        The SPA fallback must recognize it as a real file and serve it
        rather than returning the HTML entry point.
        """
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(), static_dir)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/dashboard/icon.svg")
            assert resp.status == 200
            body = await resp.text()
            assert "<svg" in body

    async def test_path_traversal_is_rejected(self, tmp_path):
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(), static_dir)
        async with TestClient(TestServer(app)) as client:
            # aiohttp strips ``..`` from URL paths, but if it ever made
            # it through, the SPA handler's realpath check catches it.
            resp = await client.get("/dashboard/../../../etc/passwd")
            assert resp.status in (404, 400)


@pytest.mark.asyncio
class TestDashboardStaticBundleMissing:
    """When the bundle isn't built, the dashboard mount is skipped."""

    async def test_missing_static_dir_no_mount(self, tmp_path):
        adapter = _make_adapter()
        app = web.Application(middlewares=[cors_middleware])
        app["api_server_adapter"] = adapter
        # static_dir=None — production path when bundle hasn't been built
        register_dashboard_routes(app, adapter=adapter, static_dir=None)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get("/dashboard/")
            assert resp.status == 404


# ---------------------------------------------------------------------------
# CORS loopback auto-allow (B4)
# ---------------------------------------------------------------------------


class TestCorsLoopbackAutoAllow:
    """``_origin_allowed`` auto-allows same-origin loopback when the
    allowlist is empty. Browsers attach ``Origin`` to module scripts
    even on same-origin; without this, the dashboard 403s its own
    asset requests.
    """

    def test_empty_allowlist_allows_127(self):
        adapter = _make_adapter(port=8642)
        assert adapter._origin_allowed("http://127.0.0.1:8642") is True

    def test_empty_allowlist_allows_localhost(self):
        adapter = _make_adapter(port=8642)
        assert adapter._origin_allowed("http://localhost:8642") is True

    def test_empty_allowlist_allows_ipv6_loopback(self):
        adapter = _make_adapter(port=8642)
        assert adapter._origin_allowed("http://[::1]:8642") is True

    def test_empty_allowlist_respects_configured_port(self):
        adapter = _make_adapter(port=9999)
        assert adapter._origin_allowed("http://127.0.0.1:9999") is True
        # Wrong port is not same-origin
        assert adapter._origin_allowed("http://127.0.0.1:8642") is False

    def test_empty_allowlist_rejects_lan_ip(self):
        adapter = _make_adapter(port=8642)
        assert adapter._origin_allowed("http://192.168.1.5:8642") is False

    def test_empty_allowlist_rejects_public_origin(self):
        adapter = _make_adapter(port=8642)
        assert adapter._origin_allowed("https://evil.example") is False

    def test_empty_origin_still_allowed(self):
        """Non-browser clients send no Origin — must keep working."""
        adapter = _make_adapter(port=8642)
        assert adapter._origin_allowed("") is True

    def test_explicit_allowlist_overrides_auto_allow(self):
        adapter = _make_adapter(port=8642, cors_origins="https://my-app.test")
        assert adapter._origin_allowed("https://my-app.test") is True
        # Explicit allowlist does NOT include loopback — respect the
        # operator's choice.
        assert adapter._origin_allowed("http://127.0.0.1:8642") is False

    def test_wildcard_allowlist_allows_everything(self):
        adapter = _make_adapter(port=8642, cors_origins="*")
        assert adapter._origin_allowed("https://evil.example") is True
        assert adapter._origin_allowed("http://127.0.0.1:8642") is True


@pytest.mark.asyncio
class TestCorsMiddlewareSameOriginAssetFetch:
    """End-to-end: a same-origin asset fetch with an Origin header must
    succeed (200), not be 403'd by cors_middleware.
    """

    async def test_asset_fetch_with_same_origin_header(self, tmp_path):
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(port=8642), static_dir)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get(
                "/dashboard/assets/index-abc.js",
                headers={"Origin": "http://127.0.0.1:8642"},
            )
            assert resp.status == 200

    async def test_asset_fetch_from_foreign_origin_is_blocked(self, tmp_path):
        static_dir = _make_static_dir(tmp_path)
        app = _make_app(_make_adapter(port=8642), static_dir)
        async with TestClient(TestServer(app)) as client:
            resp = await client.get(
                "/dashboard/assets/index-abc.js",
                headers={"Origin": "https://evil.example"},
            )
            assert resp.status == 403
