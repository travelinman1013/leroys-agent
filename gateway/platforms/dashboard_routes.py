"""
Dashboard HTTP routes for the Hermes gateway.

This module is deliberately a sidecar to ``gateway/platforms/api_server.py``:
the routes it registers hang off the SAME aiohttp application, share the
SAME bearer-auth middleware and CORS stack, and inherit the SAME Seatbelt
sandbox as the gateway process. There is no second server, no second port,
no second auth scheme.

Route layout
------------

Static UI (TanStack Start bundle served from ``api_server_static/``):
    GET  /dashboard/                       index.html
    GET  /dashboard/<path>                 static assets

REST (JSON):
    GET  /api/dashboard/handshake          localhost-only bootstrap — returns
                                           {token, version, started_at}
    GET  /api/dashboard/state              current snapshot
    GET  /api/dashboard/sessions           paginated list
    GET  /api/dashboard/sessions/{id}      full transcript
    GET  /api/dashboard/sessions/{id}/events   events.ndjson filter
    POST /api/dashboard/approvals/{session_key}  resolve a pending approval
    GET  /api/dashboard/approvals          pending approvals snapshot
    GET  /api/dashboard/tools              tool catalog
    GET  /api/dashboard/skills             skills inventory
    GET  /api/dashboard/mcp                MCP server status
    GET  /api/dashboard/doctor             doctor output as JSON
    GET  /api/dashboard/config             redacted config dump
    GET  /api/dashboard/events             SSE multiplexer (EventBus)
    GET  /api/dashboard/recent             recent events replay

Auth
----
- ``/api/dashboard/handshake`` accepts requests WITHOUT a bearer token IF
  the source IP is 127.0.0.1 / ::1. This is the one-shot bootstrap that
  lets the dashboard UI obtain the token.
- Every other route goes through ``_check_dashboard_auth``, which accepts
  either the existing API server bearer token (``API_SERVER_KEY``) OR the
  dashboard-specific token from ``~/.hermes/dashboard_token``.

Event stream
------------
``GET /api/dashboard/events`` subscribes to the process-wide EventBus and
pipes every event to the client as a ``text/event-stream``. Reuses the
keepalive pattern from ``_handle_run_events``.
"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, TYPE_CHECKING

try:
    from aiohttp import web
    AIOHTTP_AVAILABLE = True
except ImportError:
    AIOHTTP_AVAILABLE = False
    web = None  # type: ignore[assignment]

if TYPE_CHECKING:
    from gateway.platforms.api_server import APIServerAdapter

logger = logging.getLogger(__name__)

# Exposed so the api_server adapter can check whether dashboard routes are
# available before registering them.
DASHBOARD_ROUTES_AVAILABLE = AIOHTTP_AVAILABLE


def _localhost_ip(remote: Optional[str]) -> bool:
    """Return True if the request came from loopback."""
    if not remote:
        return False
    # Strip brackets from IPv6
    host = remote.strip("[]").split("%", 1)[0]
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    return addr.is_loopback


def _redact_secrets(obj: Any) -> Any:
    """Recursively redact likely-secret values in a dict/list structure."""
    _SECRET_KEYS = (
        "key", "token", "secret", "password", "passwd", "pass",
        "api_key", "apikey", "webhook", "bearer",
    )

    if isinstance(obj, dict):
        redacted = {}
        for k, v in obj.items():
            kl = str(k).lower()
            if any(sk in kl for sk in _SECRET_KEYS) and isinstance(v, str) and v:
                redacted[k] = "***REDACTED***"
            else:
                redacted[k] = _redact_secrets(v)
        return redacted
    if isinstance(obj, list):
        return [_redact_secrets(v) for v in obj]
    return obj


class DashboardRoutes:
    """Route handler bundle for the dashboard surface.

    Holds a back-reference to the api_server adapter so we can reuse its
    CORS/auth middleware, SessionDB handle, cron helpers, and the running
    aiohttp app.
    """

    def __init__(self, adapter: "APIServerAdapter") -> None:
        self._adapter = adapter
        self._started_at = time.time()

    # ------------------------------------------------------------------
    # Auth
    # ------------------------------------------------------------------

    def _check_dashboard_auth(self, request: "web.Request") -> Optional["web.Response"]:
        """Validate bearer token for dashboard routes.

        Accepts either the adapter's existing API server key OR the
        dashboard-specific token from ~/.hermes/dashboard_token. Returns
        None if auth is OK, or a 401 response.
        """
        auth_header = request.headers.get("Authorization", "")
        token = ""
        if auth_header.startswith("Bearer "):
            token = auth_header[7:].strip()

        # Adapter API key path (matches existing behavior for /v1/* routes)
        api_key = getattr(self._adapter, "_api_key", "") or ""
        if api_key and token and hmac.compare_digest(token, api_key):
            return None

        # Dashboard token path
        try:
            from hermes_cli.config import get_dashboard_token
            dash_token = get_dashboard_token(mint_if_missing=False) or ""
        except Exception:
            dash_token = ""
        if dash_token and token and hmac.compare_digest(token, dash_token):
            return None

        # Last resort: if no keys are configured anywhere AND the request
        # is from loopback, allow. Matches the legacy "no key = local-only"
        # behavior of _check_auth at api_server.py.
        if not api_key and not dash_token:
            if _localhost_ip(request.remote):
                return None

        return web.json_response(
            {"error": {"message": "Invalid or missing dashboard token",
                       "type": "invalid_request_error",
                       "code": "invalid_api_key"}},
            status=401,
        )

    # ------------------------------------------------------------------
    # GET /api/dashboard/handshake
    # ------------------------------------------------------------------

    async def handle_handshake(self, request: "web.Request") -> "web.Response":
        """Localhost-only bootstrap — mint (if needed) and return the token.

        Called by the dashboard UI on first load. No bearer required, but
        the request MUST come from loopback. If the gateway process is
        running under sandbox-exec, loopback is the only network the
        dashboard can originate from anyway, so this is safe.
        """
        if not _localhost_ip(request.remote):
            return web.json_response(
                {"error": "Handshake only available from localhost"},
                status=403,
            )

        try:
            from hermes_cli.config import get_dashboard_token
            token = get_dashboard_token(mint_if_missing=True)
        except Exception as exc:
            logger.warning("dashboard: handshake failed to get token: %s", exc)
            return web.json_response({"error": "Failed to mint token"}, status=500)

        return web.json_response({
            "token": token,
            "version": _get_hermes_version(),
            "started_at": self._started_at,
            "host": self._adapter._host,
            "port": self._adapter._port,
        })

    # ------------------------------------------------------------------
    # GET /api/dashboard/state
    # ------------------------------------------------------------------

    async def handle_state(self, request: "web.Request") -> "web.Response":
        """Current snapshot: active sessions, pending approvals, cron,
        gateway uptime, model name, sandbox status."""
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        state: Dict[str, Any] = {}
        state["gateway"] = {
            "started_at": self._started_at,
            "uptime_seconds": time.time() - self._started_at,
            "host": self._adapter._host,
            "port": self._adapter._port,
            "sandboxed": bool(os.environ.get("HERMES_SANDBOXED")) or _detect_sandbox_exec(),
        }

        # Model name from config.yaml
        try:
            from hermes_cli.config import load_config
            cfg = load_config() or {}
            model_cfg = cfg.get("model")
            if isinstance(model_cfg, str):
                state["model"] = model_cfg
            elif isinstance(model_cfg, dict):
                state["model"] = model_cfg.get("default")
            else:
                state["model"] = None
        except Exception:
            state["model"] = None

        # Active sessions via SessionDB
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            # "Active" = sessions with no end timestamp, started in the last 24h
            sessions = db.list_sessions_rich(limit=15, offset=0, include_children=False)
            state["active_sessions"] = sessions
        except Exception as exc:
            logger.debug("dashboard: state sessions query failed: %s", exc)
            state["active_sessions"] = []

        # Pending approvals (in-memory)
        try:
            from tools.approval import list_pending_approvals_for_dashboard
            state["pending_approvals"] = list_pending_approvals_for_dashboard()
        except Exception as exc:
            logger.debug("dashboard: state pending approvals failed: %s", exc)
            state["pending_approvals"] = []

        # Cron jobs (first 20)
        try:
            from cron.jobs import list_jobs as _cron_list_jobs
            state["cron_jobs"] = _cron_list_jobs()[:20]
        except Exception as exc:
            logger.debug("dashboard: cron jobs query failed: %s", exc)
            state["cron_jobs"] = []

        # Event bus subscriber count (debug visibility)
        try:
            from gateway.event_bus import get_event_bus
            state["event_bus"] = {
                "subscribers": get_event_bus().subscriber_count(),
                "recent_buffer": len(get_event_bus().recent_events(limit=0)),
            }
        except Exception:
            state["event_bus"] = {"subscribers": 0, "recent_buffer": 0}

        return web.json_response(state)

    # ------------------------------------------------------------------
    # GET /api/dashboard/sessions
    # ------------------------------------------------------------------

    async def handle_sessions(self, request: "web.Request") -> "web.Response":
        """Paginated list of sessions with token counts and previews."""
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        try:
            limit = max(1, min(200, int(request.query.get("limit", "50"))))
            offset = max(0, int(request.query.get("offset", "0")))
        except ValueError:
            return web.json_response({"error": "limit/offset must be integers"}, status=400)

        source = request.query.get("source") or None
        include_children = request.query.get("include_children", "").lower() in ("true", "1")

        try:
            from hermes_state import SessionDB
            db = SessionDB()
            rows = db.list_sessions_rich(
                source=source,
                limit=limit,
                offset=offset,
                include_children=include_children,
            )
            return web.json_response({"sessions": rows, "limit": limit, "offset": offset})
        except Exception as exc:
            logger.exception("dashboard: sessions listing failed")
            return web.json_response({"error": str(exc)}, status=500)

    # ------------------------------------------------------------------
    # GET /api/dashboard/sessions/{id}
    # ------------------------------------------------------------------

    async def handle_session_detail(self, request: "web.Request") -> "web.Response":
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        session_id = request.match_info.get("id", "")
        if not session_id:
            return web.json_response({"error": "session id required"}, status=400)

        try:
            from hermes_state import SessionDB
            db = SessionDB()
            meta = db.get_session(session_id)
            if not meta:
                return web.json_response({"error": "session not found"}, status=404)
            messages = db.get_messages(session_id)
            return web.json_response({"session": meta, "messages": messages})
        except Exception as exc:
            logger.exception("dashboard: session detail failed")
            return web.json_response({"error": str(exc)}, status=500)

    # ------------------------------------------------------------------
    # GET /api/dashboard/sessions/{id}/events
    # ------------------------------------------------------------------

    async def handle_session_events(self, request: "web.Request") -> "web.Response":
        """Filter events.ndjson by session_id."""
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        session_id = request.match_info.get("id", "")
        try:
            limit = max(1, min(1000, int(request.query.get("limit", "200"))))
        except ValueError:
            limit = 200

        events: List[Dict[str, Any]] = []
        try:
            from gateway.event_bus import _default_events_path
            path = _default_events_path()
            if path.exists():
                # Tail-read the last N lines cheaply
                with open(path, "rb") as f:
                    try:
                        f.seek(0, os.SEEK_END)
                        size = f.tell()
                        chunk = min(size, 1024 * 1024)  # 1 MB window
                        f.seek(size - chunk)
                        tail = f.read().decode("utf-8", errors="replace")
                    except OSError:
                        tail = f.read().decode("utf-8", errors="replace")
                for line in tail.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except Exception:
                        continue
                    if event.get("session_id") == session_id:
                        events.append(event)
                events = events[-limit:]
        except Exception as exc:
            logger.debug("dashboard: session events read failed: %s", exc)

        return web.json_response({"events": events})

    # ------------------------------------------------------------------
    # GET /api/dashboard/approvals
    # ------------------------------------------------------------------

    async def handle_list_approvals(self, request: "web.Request") -> "web.Response":
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        try:
            from tools.approval import list_pending_approvals_for_dashboard
            pending = list_pending_approvals_for_dashboard()
        except Exception as exc:
            logger.exception("dashboard: approvals listing failed")
            return web.json_response({"error": str(exc)}, status=500)

        return web.json_response({"pending": pending})

    # ------------------------------------------------------------------
    # POST /api/dashboard/approvals/{session_key}
    # ------------------------------------------------------------------

    async def handle_resolve_approval(self, request: "web.Request") -> "web.Response":
        """Resolve a pending approval.

        Body: {"choice": "once|session|always|deny", "resolve_all": bool}

        The LangGraph-style {"accept", "edit", "response", "ignore"} schema
        is translated:
            accept   -> once
            ignore   -> deny
            edit     -> rejected (clients should POST a new approval)
            response -> rejected (dashboard doesn't support side-channel yet)
        """
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        session_key = request.match_info.get("session_key", "")
        if not session_key:
            return web.json_response({"error": "session_key required"}, status=400)

        try:
            body = await request.json()
        except Exception:
            body = {}

        choice = str(body.get("choice", "")).strip().lower()
        resolve_all = bool(body.get("resolve_all", False))

        # Translate LangGraph schema
        _translation = {"accept": "once", "ignore": "deny"}
        choice = _translation.get(choice, choice)

        if choice not in ("once", "session", "always", "deny"):
            return web.json_response(
                {"error": "choice must be one of: once, session, always, deny (or accept/ignore)"},
                status=400,
            )

        try:
            from tools.approval import resolve_gateway_approval
            n = resolve_gateway_approval(session_key, choice, resolve_all=resolve_all)
        except Exception as exc:
            logger.exception("dashboard: approval resolution failed")
            return web.json_response({"error": str(exc)}, status=500)

        return web.json_response({"resolved": n, "choice": choice})

    # ------------------------------------------------------------------
    # GET /api/dashboard/tools
    # ------------------------------------------------------------------

    async def handle_tools(self, request: "web.Request") -> "web.Response":
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        try:
            from model_tools import registry as _tool_registry
            tool_names = _tool_registry.get_all_tool_names()
            tools = [{"name": n, "toolset": _tool_registry.get_toolset_for_tool(n)} for n in tool_names]
            toolsets = _tool_registry.get_available_toolsets()
        except Exception as exc:
            logger.exception("dashboard: tools listing failed")
            return web.json_response({"error": str(exc)}, status=500)

        return web.json_response({"tools": tools, "toolsets": toolsets})

    # ------------------------------------------------------------------
    # GET /api/dashboard/skills
    # ------------------------------------------------------------------

    async def handle_skills(self, request: "web.Request") -> "web.Response":
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        skills: List[Dict[str, Any]] = []
        try:
            from hermes_cli.config import get_hermes_home
            skills_dir = Path(get_hermes_home()) / "skills"
            if skills_dir.is_dir():
                for child in sorted(skills_dir.iterdir()):
                    if not child.is_dir():
                        continue
                    entry: Dict[str, Any] = {"name": child.name, "path": str(child)}
                    # Try to read SKILL.md frontmatter if present
                    skill_md = child / "SKILL.md"
                    if skill_md.exists():
                        try:
                            text = skill_md.read_text(encoding="utf-8", errors="replace")[:2048]
                            entry["preview"] = text[:200]
                        except Exception:
                            pass
                    skills.append(entry)
        except Exception as exc:
            logger.debug("dashboard: skills listing failed: %s", exc)

        return web.json_response({"skills": skills})

    # ------------------------------------------------------------------
    # GET /api/dashboard/mcp
    # ------------------------------------------------------------------

    async def handle_mcp(self, request: "web.Request") -> "web.Response":
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        mcp_info: List[Dict[str, Any]] = []
        try:
            from hermes_cli.config import load_config
            cfg = load_config() or {}
            servers = cfg.get("mcp_servers") or {}
            if isinstance(servers, dict):
                for name, server_cfg in servers.items():
                    sc = server_cfg if isinstance(server_cfg, dict) else {}
                    mcp_info.append({
                        "name": name,
                        "command": sc.get("command"),
                        "enabled": not sc.get("disabled", False),
                        "env_keys": list((sc.get("env") or {}).keys()),
                    })
            elif isinstance(servers, list):
                for sc in servers:
                    if not isinstance(sc, dict):
                        continue
                    mcp_info.append({
                        "name": sc.get("name"),
                        "command": sc.get("command"),
                        "enabled": not sc.get("disabled", False),
                        "env_keys": list((sc.get("env") or {}).keys()),
                    })
        except Exception as exc:
            logger.debug("dashboard: mcp listing failed: %s", exc)

        return web.json_response({"servers": mcp_info})

    # ------------------------------------------------------------------
    # GET /api/dashboard/doctor
    # ------------------------------------------------------------------

    async def handle_doctor(self, request: "web.Request") -> "web.Response":
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        # Cheap "doctor" — report basic health without re-running the full
        # CLI doctor (which prints to stdout and has side effects).
        checks: List[Dict[str, Any]] = []

        try:
            from hermes_cli.config import load_config
            cfg = load_config() or {}
            checks.append({"name": "config.yaml loaded", "ok": True, "detail": None})
        except Exception as exc:
            cfg = {}
            checks.append({"name": "config.yaml loaded", "ok": False, "detail": str(exc)})

        # EventBus
        try:
            from gateway.event_bus import get_event_bus
            bus = get_event_bus()
            checks.append({
                "name": "event bus",
                "ok": True,
                "detail": f"{bus.subscriber_count()} subscribers",
            })
        except Exception as exc:
            checks.append({"name": "event bus", "ok": False, "detail": str(exc)})

        # Dashboard token
        try:
            from hermes_cli.config import get_dashboard_token
            has_token = bool(get_dashboard_token(mint_if_missing=False))
            checks.append({"name": "dashboard token", "ok": has_token,
                           "detail": "present" if has_token else "missing"})
        except Exception as exc:
            checks.append({"name": "dashboard token", "ok": False, "detail": str(exc)})

        # Sandbox
        sandboxed = _detect_sandbox_exec()
        checks.append({"name": "sandbox-exec", "ok": sandboxed,
                       "detail": "running under Seatbelt" if sandboxed else "not sandboxed"})

        # Approvals mode
        approvals_cfg = (cfg.get("approvals") or {})
        checks.append({
            "name": "approvals mode",
            "ok": True,
            "detail": f"mode={approvals_cfg.get('mode', 'manual')}, "
                      f"non_interactive_policy={approvals_cfg.get('non_interactive_policy', 'allow')}",
        })

        return web.json_response({"checks": checks})

    # ------------------------------------------------------------------
    # GET /api/dashboard/config
    # ------------------------------------------------------------------

    async def handle_config(self, request: "web.Request") -> "web.Response":
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        try:
            from hermes_cli.config import load_config
            cfg = load_config() or {}
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

        return web.json_response({"config": _redact_secrets(cfg)})

    # ------------------------------------------------------------------
    # GET /api/dashboard/recent
    # ------------------------------------------------------------------

    async def handle_recent(self, request: "web.Request") -> "web.Response":
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        try:
            limit = max(1, min(500, int(request.query.get("limit", "100"))))
        except ValueError:
            limit = 100

        try:
            from gateway.event_bus import get_event_bus
            events = get_event_bus().recent_events(limit=limit)
        except Exception as exc:
            logger.exception("dashboard: recent events failed")
            return web.json_response({"error": str(exc)}, status=500)

        return web.json_response({"events": events})

    # ------------------------------------------------------------------
    # GET /api/dashboard/events — SSE multiplexer
    # ------------------------------------------------------------------

    async def handle_events(self, request: "web.Request") -> "web.StreamResponse":
        """SSE stream of EventBus events.

        Keepalive pattern mirrors ``_handle_run_events`` in api_server.py
        (30s timeout → comment-frame keepalive).
        """
        auth_err = self._check_dashboard_auth(request)
        if auth_err:
            return auth_err

        try:
            replay = max(0, min(500, int(request.query.get("replay", "50"))))
        except ValueError:
            replay = 50

        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )
        await response.prepare(request)

        # Send an initial comment so the client knows the stream is live
        try:
            await response.write(b": connected\n\n")
        except Exception:
            return response

        try:
            from gateway.event_bus import get_event_bus
            bus = get_event_bus()
        except Exception as exc:
            logger.error("dashboard: event bus unavailable: %s", exc)
            return response

        try:
            async for event in bus.subscribe(replay_recent=replay):
                try:
                    payload = f"data: {json.dumps(event, default=str)}\n\n"
                    await response.write(payload.encode("utf-8"))
                except (ConnectionResetError, asyncio.CancelledError):
                    break
                except Exception as exc:
                    logger.debug("dashboard: SSE write failed: %s", exc)
                    break
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.debug("dashboard: SSE loop error: %s", exc)

        return response


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_hermes_version() -> str:
    """Best-effort version string for the handshake response."""
    try:
        from importlib.metadata import version
        return version("hermes-agent")
    except Exception:
        pass
    try:
        pyproject = Path(__file__).resolve().parents[2] / "pyproject.toml"
        if pyproject.exists():
            text = pyproject.read_text(encoding="utf-8")
            for line in text.splitlines():
                line = line.strip()
                if line.startswith("version"):
                    # version = "0.8.0"
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return "unknown"


def _detect_sandbox_exec() -> bool:
    """Best-effort detection that we're running under macOS sandbox-exec.

    The Phase 4 wrapper (``scripts/sandbox/hermes-gateway-sandboxed``) does
    not set an env marker. We probe two fingerprints: a writable-path
    failure on a known-denied path, and a sysctl-style env hint. Fall
    back to False on any error.
    """
    # Cheap env marker, if the wrapper ever sets one in the future
    if os.environ.get("HERMES_SANDBOX") or os.environ.get("HERMES_SANDBOXED"):
        return True
    # Real fingerprint: try to open ~/.ssh/config (Phase 4 hard-denies it)
    try:
        ssh_cfg = Path.home() / ".ssh" / "config"
        if ssh_cfg.exists():
            try:
                with open(ssh_cfg, "rb") as f:
                    f.read(1)
                return False  # open succeeded → not sandboxed
            except PermissionError:
                return True
            except OSError:
                return True
    except Exception:
        pass
    return False


# ---------------------------------------------------------------------------
# Registration hook
# ---------------------------------------------------------------------------


def register_dashboard_routes(
    app: "web.Application",
    adapter: "APIServerAdapter",
    static_dir: Optional[Path] = None,
) -> DashboardRoutes:
    """Mount dashboard routes onto the existing aiohttp application.

    Called from ``APIServerAdapter.connect()`` after the cron routes and
    before ``app.router.add_get('/v1/runs/...')``. Safe to call only once
    per app instance.

    Parameters
    ----------
    app:
        The existing aiohttp Application.
    adapter:
        The APIServerAdapter instance. Used to share bearer auth, CORS,
        and SessionDB.
    static_dir:
        Optional path to the built dashboard frontend bundle. If provided
        and the directory exists, the bundle is mounted at ``/dashboard/``.

    Returns
    -------
    DashboardRoutes
        The handler bundle — kept alive by the app (stored in app state).
    """
    if not AIOHTTP_AVAILABLE:
        raise RuntimeError("aiohttp is required for dashboard routes")

    routes = DashboardRoutes(adapter)
    app["dashboard_routes"] = routes  # keep alive

    # REST routes
    app.router.add_get("/api/dashboard/handshake", routes.handle_handshake)
    app.router.add_get("/api/dashboard/state", routes.handle_state)
    app.router.add_get("/api/dashboard/sessions", routes.handle_sessions)
    app.router.add_get("/api/dashboard/sessions/{id}", routes.handle_session_detail)
    app.router.add_get("/api/dashboard/sessions/{id}/events", routes.handle_session_events)
    app.router.add_get("/api/dashboard/approvals", routes.handle_list_approvals)
    app.router.add_post("/api/dashboard/approvals/{session_key}", routes.handle_resolve_approval)
    app.router.add_get("/api/dashboard/tools", routes.handle_tools)
    app.router.add_get("/api/dashboard/skills", routes.handle_skills)
    app.router.add_get("/api/dashboard/mcp", routes.handle_mcp)
    app.router.add_get("/api/dashboard/doctor", routes.handle_doctor)
    app.router.add_get("/api/dashboard/config", routes.handle_config)
    app.router.add_get("/api/dashboard/recent", routes.handle_recent)
    app.router.add_get("/api/dashboard/events", routes.handle_events)

    # Static UI bundle
    if static_dir is not None and static_dir.is_dir():
        app.router.add_static("/dashboard/", path=str(static_dir), show_index=True, append_version=True)
        logger.info("Dashboard UI mounted from %s", static_dir)
    else:
        logger.info("Dashboard UI bundle not present; only /api/dashboard/* routes are active")

    return routes
