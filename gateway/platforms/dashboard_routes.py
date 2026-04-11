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
import functools
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


# Free-form text redactor (regex-based) — applied to message content,
# tool args, system prompts before they leave the gateway process.
# Companion to ``_redact_secrets`` (which handles dict-key heuristics).
from tools.redaction import redact_text  # noqa: E402


# ---------------------------------------------------------------------------
# Dashboard v2 Wave 0 — shared handler scaffolding
# ---------------------------------------------------------------------------


def require_dashboard_auth(fn):
    """Decorator applying ``self._check_dashboard_auth`` before the handler.

    Saves ~3 lines per handler. Apply to every dashboard route except
    ``handle_handshake`` (which has its own loopback-only check) and
    routes that need to differentiate auth modes.
    """
    @functools.wraps(fn)
    async def wrapper(self, request: "web.Request", *args, **kwargs):
        err = self._check_dashboard_auth(request)
        if err is not None:
            return err
        return await fn(self, request, *args, **kwargs)
    return wrapper


def _json_ok(data: Any, status: int = 200) -> "web.Response":
    """Standard JSON success response."""
    return web.json_response(data, status=status)


def _json_err(exc: BaseException, status: int = 500) -> "web.Response":
    """Standard JSON error response. Logs the traceback."""
    logger.exception("dashboard handler error: %s", exc)
    return web.json_response(
        {"error": str(exc) or exc.__class__.__name__}, status=status,
    )


def _tail_read_ndjson(
    filter_fn=None,
    limit: int = 500,
    tail_bytes: int = 1024 * 1024,
    path: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """Read the tail of ``events.ndjson`` and return parsed events.

    Reused by F3 event search/export plus the legacy session-events
    handler. Tails ~1 MB by default; the caller can bump ``tail_bytes``
    for wider scans (the F3 routes set this from a query param).

    Args:
        filter_fn: Optional callable taking the parsed event dict and
            returning True to keep, False to drop.
        limit: Maximum number of events to return (most-recent wins).
        tail_bytes: Window size at the END of the file to read.
        path: Override the events.ndjson path (test hook).
    """
    from gateway.event_bus import _default_events_path
    target = path or _default_events_path()
    out: List[Dict[str, Any]] = []
    if not target.exists():
        return out
    try:
        with open(target, "rb") as f:
            try:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                chunk = min(size, tail_bytes)
                f.seek(size - chunk)
                tail = f.read().decode("utf-8", errors="replace")
            except OSError:
                tail = f.read().decode("utf-8", errors="replace")
    except OSError:
        return out

    for line in tail.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        if filter_fn is None or filter_fn(event):
            out.append(event)
    if limit > 0:
        return out[-limit:]
    return out


def _parse_ts(value: Any) -> Optional[float]:
    """Parse a stored event timestamp into a unix-time float.

    The event bus writes ``ts`` as ISO-8601 with microsecond precision
    (``datetime.now(tz).isoformat()``). Older entries may be a float.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            from datetime import datetime
            # Tolerate trailing Z or +00:00
            v = value.replace("Z", "+00:00")
            return datetime.fromisoformat(v).timestamp()
        except Exception:
            return None
    return None


def _walk_ndjson_rotation(
    base_path: Optional[Path] = None,
    backup_count: int = 3,
):
    """Yield NDJSON event dicts in chronological order across rotated files.

    Walks ``events.ndjson.3`` → ``events.ndjson.2`` → ``events.ndjson.1`` →
    ``events.ndjson`` so a 24h query that spans rotation boundaries reads
    every event in timestamp order. Used by F5 metrics aggregation.
    """
    from gateway.event_bus import _default_events_path
    base = base_path or _default_events_path()
    candidates: List[Path] = []
    for i in range(backup_count, 0, -1):
        p = base.with_suffix(base.suffix + f".{i}")
        if p.exists():
            candidates.append(p)
    if base.exists():
        candidates.append(base)
    for p in candidates:
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except Exception:
                        continue
        except OSError:
            continue


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

    @require_dashboard_auth
    async def handle_state(self, request: "web.Request") -> "web.Response":
        """Current snapshot: active sessions, pending approvals, cron,
        gateway uptime, model name, sandbox status."""
        state: Dict[str, Any] = {}
        state["gateway"] = {
            "started_at": self._started_at,
            "uptime_seconds": time.time() - self._started_at,
            "host": self._adapter._host,
            "port": self._adapter._port,
            "sandboxed": bool(os.environ.get("HERMES_SANDBOXED")) or _detect_seatbelt_sandbox(),
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

    @require_dashboard_auth
    async def handle_sessions(self, request: "web.Request") -> "web.Response":
        """Paginated list of sessions with token counts and previews."""
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
            # Scrub free-form text fields in the preview rows. Titles can
            # contain pasted user input; first_user_message + last_assistant
            # are by definition transcript bodies.
            _PREVIEW_TEXT_FIELDS = (
                "title", "first_user_message", "last_assistant_message",
                "preview", "summary",
            )
            for r in rows:
                for col in _PREVIEW_TEXT_FIELDS:
                    if r.get(col):
                        r[col] = redact_text(r[col])
            return web.json_response({"sessions": rows, "limit": limit, "offset": offset})
        except Exception as exc:
            logger.exception("dashboard: sessions listing failed")
            return web.json_response({"error": str(exc)}, status=500)

    # ------------------------------------------------------------------
    # GET /api/dashboard/sessions/{id}
    # ------------------------------------------------------------------

    @require_dashboard_auth
    async def handle_session_detail(self, request: "web.Request") -> "web.Response":
        session_id = request.match_info.get("id", "")
        if not session_id:
            return web.json_response({"error": "session id required"}, status=400)

        try:
            from hermes_state import SessionDB
            db = SessionDB()
            meta = db.get_session(session_id)
            if not meta:
                return web.json_response({"error": "session not found"}, status=404)

            # Scrub free-form text columns on the session row. Phase 4
            # security requirement: nothing leaves this process unredacted.
            _META_TEXT_FIELDS = (
                "system_prompt", "model_config", "billing_base_url",
                "title", "first_user_message", "last_assistant_message",
            )
            for col in _META_TEXT_FIELDS:
                if meta.get(col):
                    meta[col] = redact_text(meta[col])

            # Scrub every message body, reasoning trace, and tool_calls
            # JSON blob in place. Defensive copy of each row before mutation
            # so we don't poison whatever else holds the SessionDB cursor.
            messages = []
            for raw in db.get_messages(session_id):
                m = dict(raw)
                if m.get("content"):
                    m["content"] = redact_text(m["content"])
                if m.get("reasoning"):
                    m["reasoning"] = redact_text(m["reasoning"])
                if m.get("tool_calls") and isinstance(m["tool_calls"], str):
                    m["tool_calls"] = redact_text(m["tool_calls"])
                messages.append(m)
            return web.json_response({"session": meta, "messages": messages})
        except Exception as exc:
            logger.exception("dashboard: session detail failed")
            return web.json_response({"error": str(exc)}, status=500)

    # ------------------------------------------------------------------
    # GET /api/dashboard/sessions/{id}/events
    # ------------------------------------------------------------------

    @require_dashboard_auth
    async def handle_session_events(self, request: "web.Request") -> "web.Response":
        """Filter events.ndjson by session_id."""
        session_id = request.match_info.get("id", "")
        try:
            limit = max(1, min(1000, int(request.query.get("limit", "200"))))
        except ValueError:
            limit = 200

        try:
            events = _tail_read_ndjson(
                filter_fn=lambda e: e.get("session_id") == session_id,
                limit=limit,
            )
        except Exception as exc:
            logger.debug("dashboard: session events read failed: %s", exc)
            events = []

        return web.json_response({"events": events})

    # ------------------------------------------------------------------
    # GET /api/dashboard/approvals
    # ------------------------------------------------------------------

    @require_dashboard_auth
    async def handle_list_approvals(self, request: "web.Request") -> "web.Response":
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

    @require_dashboard_auth
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

    @require_dashboard_auth
    async def handle_tools(self, request: "web.Request") -> "web.Response":
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

    @require_dashboard_auth
    async def handle_skills(self, request: "web.Request") -> "web.Response":
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

    @require_dashboard_auth
    async def handle_mcp(self, request: "web.Request") -> "web.Response":
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

    @require_dashboard_auth
    async def handle_doctor(self, request: "web.Request") -> "web.Response":
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
        sandboxed = _detect_seatbelt_sandbox()
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

    @require_dashboard_auth
    async def handle_config(self, request: "web.Request") -> "web.Response":
        try:
            from hermes_cli.config import load_config
            cfg = load_config() or {}
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=500)

        return web.json_response({"config": _redact_secrets(cfg)})

    # ------------------------------------------------------------------
    # GET /api/dashboard/recent
    # ------------------------------------------------------------------

    @require_dashboard_auth
    async def handle_recent(self, request: "web.Request") -> "web.Response":
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
    # GET /api/dashboard/brain/graph — typed knowledge graph snapshot
    # ------------------------------------------------------------------

    # ==================================================================
    # F1 — Session Control Plane (Dashboard v2)
    # ==================================================================

    @require_dashboard_auth
    async def handle_session_search(self, request: "web.Request") -> "web.Response":
        """Search sessions with optional title query, source, and date range.

        Query params:
            q: substring against title
            source: exact match against ``source`` column
            from / to: unix timestamps
            limit / offset: pagination
        """
        try:
            limit = max(1, min(200, int(request.query.get("limit", "50"))))
            offset = max(0, int(request.query.get("offset", "0")))
        except ValueError:
            return _json_err(ValueError("limit/offset must be integers"), 400)
        q = request.query.get("q") or None
        source = request.query.get("source") or None
        try:
            t_from = float(request.query["from"]) if "from" in request.query else None
            t_to = float(request.query["to"]) if "to" in request.query else None
        except ValueError:
            return _json_err(ValueError("from/to must be numeric unix ts"), 400)
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            rows = db.search_sessions(
                source=source,
                limit=limit,
                offset=offset,
                q=q,
                started_after=t_from,
                started_before=t_to,
            )
            for r in rows:
                if r.get("title"):
                    r["title"] = redact_text(r["title"])
            return _json_ok({"sessions": rows, "limit": limit, "offset": offset})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_delete_session(self, request: "web.Request") -> "web.Response":
        session_id = request.match_info.get("id", "")
        if not session_id:
            return _json_err(ValueError("session id required"), 400)
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            ok = db.delete_session(session_id)
            if not ok:
                return _json_err(LookupError("session not found"), 404)
            try:
                from gateway.event_bus import publish as _publish_event
                _publish_event(
                    "session.deleted",
                    session_id=session_id,
                    data={"resolver": "dashboard"},
                )
            except Exception:
                pass
            return _json_ok({"deleted": True, "id": session_id})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_export_session(self, request: "web.Request") -> "web.Response":
        session_id = request.match_info.get("id", "")
        fmt = (request.query.get("format") or "json").lower()
        if not session_id:
            return _json_err(ValueError("session id required"), 400)
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            if fmt == "md" or fmt == "markdown":
                md = db.render_session_markdown(session_id)
                if md is None:
                    return _json_err(LookupError("session not found"), 404)
                return web.Response(
                    text=md,
                    content_type="text/markdown",
                    headers={
                        "Content-Disposition":
                            f'attachment; filename="{session_id}.md"',
                    },
                )
            data = db.export_session(session_id)
            if data is None:
                return _json_err(LookupError("session not found"), 404)
            try:
                from gateway.event_bus import publish as _publish_event
                _publish_event(
                    "session.exported",
                    session_id=session_id,
                    data={"format": fmt},
                )
            except Exception:
                pass
            return web.json_response(
                data,
                headers={
                    "Content-Disposition":
                        f'attachment; filename="{session_id}.json"',
                },
            )
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_fork_session(self, request: "web.Request") -> "web.Response":
        session_id = request.match_info.get("id", "")
        if not session_id:
            return _json_err(ValueError("session id required"), 400)
        try:
            body = await request.json()
        except Exception:
            body = {}
        up_to_turn = body.get("up_to_turn")
        title = body.get("title")
        try:
            up_to_turn_idx = int(up_to_turn) if up_to_turn is not None else None
        except (TypeError, ValueError):
            return _json_err(ValueError("up_to_turn must be an integer"), 400)
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            src = db.get_session(session_id)
            if not src:
                return _json_err(LookupError("source session not found"), 404)
            if src.get("ended_at") is None:
                return _json_err(
                    ValueError("cannot fork an active session — wait for it to end"),
                    409,
                )
            new_id = db.fork_session(
                session_id, up_to_turn_idx=up_to_turn_idx, title=title,
            )
            try:
                from gateway.event_bus import publish as _publish_event
                _publish_event(
                    "session.forked",
                    session_id=new_id,
                    data={"parent_id": session_id, "up_to_turn": up_to_turn_idx},
                )
            except Exception:
                pass
            return _json_ok({"id": new_id, "parent_id": session_id})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_inject_message(self, request: "web.Request") -> "web.Response":
        session_id = request.match_info.get("id", "")
        if not session_id:
            return _json_err(ValueError("session id required"), 400)
        try:
            body = await request.json()
        except Exception:
            body = {}
        content = body.get("content")
        role = body.get("role", "user")
        if not content or not isinstance(content, str):
            return _json_err(ValueError("content (str) required"), 400)
        if role not in ("user", "system"):
            return _json_err(ValueError("role must be 'user' or 'system'"), 400)
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            session = db.get_session(session_id)
            if not session:
                return _json_err(LookupError("session not found"), 404)
            # Reopen if ended, then append
            if session.get("ended_at") is not None:
                db.reopen_session(session_id)
            msg_id = db.append_message(
                session_id=session_id, role=role, content=content,
            )
            try:
                from gateway.event_bus import publish as _publish_event
                _publish_event(
                    "session.injected",
                    session_id=session_id,
                    data={"message_id": msg_id, "role": role},
                )
            except Exception:
                pass
            return _json_ok({"id": session_id, "message_id": msg_id})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_reopen_session(self, request: "web.Request") -> "web.Response":
        session_id = request.match_info.get("id", "")
        if not session_id:
            return _json_err(ValueError("session id required"), 400)
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            session = db.get_session(session_id)
            if not session:
                return _json_err(LookupError("session not found"), 404)
            db.reopen_session(session_id)
            try:
                from gateway.event_bus import publish as _publish_event
                _publish_event(
                    "session.reopened",
                    session_id=session_id,
                    data={"resolver": "dashboard"},
                )
            except Exception:
                pass
            return _json_ok({"id": session_id, "reopened": True})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_session_bulk(self, request: "web.Request") -> "web.Response":
        """Bulk action over a list of session IDs.

        Body: ``{ids: [...], action: "delete" | "export"}``.
        Returns ``{results: [{id, ok, error?}, ...]}``.
        """
        try:
            body = await request.json()
        except Exception:
            body = {}
        ids = body.get("ids") or []
        action = (body.get("action") or "").lower()
        if not isinstance(ids, list) or not ids:
            return _json_err(ValueError("ids (non-empty list) required"), 400)
        if action not in ("delete", "export"):
            return _json_err(ValueError("action must be 'delete' or 'export'"), 400)

        from hermes_state import SessionDB
        db = SessionDB()
        results: list[dict] = []
        for raw_id in ids:
            sid = str(raw_id)
            row = {"id": sid, "ok": False}
            try:
                if action == "delete":
                    deleted = db.delete_session(sid)
                    row["ok"] = deleted
                    if not deleted:
                        row["error"] = "not found"
                else:  # export
                    data = db.export_session(sid)
                    if data is None:
                        row["error"] = "not found"
                    else:
                        row["ok"] = True
                        row["message_count"] = len(data.get("messages", []))
            except Exception as exc:
                row["error"] = str(exc)
            results.append(row)
        return _json_ok({"results": results, "action": action})

    # ==================================================================
    # F2 — Brain/Memory Editor (Dashboard v2)
    # ==================================================================

    # ==================================================================
    # F3 — Live Console v2 + Approval Command Center (Dashboard v2)
    # ==================================================================

    @require_dashboard_auth
    async def handle_events_search(self, request: "web.Request") -> "web.Response":
        """Filter events.ndjson by event-type wildcard, free-text query,
        session id, and time window. Walks rotated files when ``window``
        spans the rotation boundary.
        """
        try:
            limit = max(1, min(2000, int(request.query.get("limit", "500"))))
        except ValueError:
            return _json_err(ValueError("limit must be int"), 400)

        type_param = request.query.get("types") or ""
        type_filters = [t.strip() for t in type_param.split(",") if t.strip()]
        query = (request.query.get("q") or "").lower()
        session_filter = request.query.get("session") or None
        try:
            t_from = float(request.query["from"]) if "from" in request.query else None
            t_to = float(request.query["to"]) if "to" in request.query else None
        except ValueError:
            return _json_err(ValueError("from/to must be numeric unix ts"), 400)

        def _match_type(event_type: str) -> bool:
            if not type_filters:
                return True
            for pat in type_filters:
                if pat.endswith(".*"):
                    if event_type.startswith(pat[:-2]):
                        return True
                elif event_type == pat:
                    return True
            return False

        def _match_event(e: Dict[str, Any]) -> bool:
            etype = e.get("type", "")
            if not _match_type(etype):
                return False
            if session_filter and e.get("session_id") != session_filter:
                return False
            if t_from is not None or t_to is not None:
                ts = _parse_ts(e.get("ts"))
                if ts is None:
                    return False
                if t_from is not None and ts < t_from:
                    return False
                if t_to is not None and ts > t_to:
                    return False
            if query:
                # Search the data dict + type
                blob = (etype + " " + json.dumps(e.get("data") or {}, default=str)).lower()
                if query not in blob:
                    return False
            return True

        try:
            # If a window is specified, walk all rotated files; else tail-read.
            if t_from is not None or t_to is not None:
                events: list[dict] = []
                for raw in _walk_ndjson_rotation():
                    if _match_event(raw):
                        events.append(raw)
                events = events[-limit:]
            else:
                events = _tail_read_ndjson(
                    filter_fn=_match_event, limit=limit, tail_bytes=4 * 1024 * 1024,
                )
            return _json_ok({"events": events, "count": len(events)})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_events_export(self, request: "web.Request") -> "web.Response":
        """Stream filtered events as application/x-ndjson.

        Honors the same query params as /events/search but returns NDJSON
        for download instead of a JSON envelope. Capped at 50k events to
        keep dashboard exports reasonable.
        """
        type_param = request.query.get("types") or ""
        type_filters = [t.strip() for t in type_param.split(",") if t.strip()]
        try:
            t_from = float(request.query["from"]) if "from" in request.query else None
            t_to = float(request.query["to"]) if "to" in request.query else None
        except ValueError:
            return _json_err(ValueError("from/to must be numeric unix ts"), 400)

        def _match_type(event_type: str) -> bool:
            if not type_filters:
                return True
            for pat in type_filters:
                if pat.endswith(".*"):
                    if event_type.startswith(pat[:-2]):
                        return True
                elif event_type == pat:
                    return True
            return False

        def _match_event(e: Dict[str, Any]) -> bool:
            if not _match_type(e.get("type", "")):
                return False
            if t_from is not None or t_to is not None:
                ts = _parse_ts(e.get("ts"))
                if ts is None:
                    return False
                if t_from is not None and ts < t_from:
                    return False
                if t_to is not None and ts > t_to:
                    return False
            return True

        response = web.StreamResponse(
            status=200,
            headers={
                "Content-Type": "application/x-ndjson",
                "Content-Disposition": 'attachment; filename="hermes-events.ndjson"',
                "X-Accel-Buffering": "no",
            },
        )
        await response.prepare(request)
        try:
            cap = 50000
            n = 0
            for raw in _walk_ndjson_rotation():
                if not _match_event(raw):
                    continue
                line = json.dumps(raw, default=str) + "\n"
                await response.write(line.encode("utf-8"))
                n += 1
                if n >= cap:
                    break
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        except Exception as exc:
            logger.debug("dashboard: events export failed: %s", exc)
        return response

    @require_dashboard_auth
    async def handle_approvals_history(self, request: "web.Request") -> "web.Response":
        try:
            limit = max(1, min(500, int(request.query.get("limit", "100"))))
            offset = max(0, int(request.query.get("offset", "0")))
        except ValueError:
            return _json_err(ValueError("limit/offset must be int"), 400)
        pattern = request.query.get("pattern") or None
        session = request.query.get("session") or None
        choice = request.query.get("choice") or None
        try:
            since = float(request.query["since"]) if "since" in request.query else None
        except ValueError:
            return _json_err(ValueError("since must be numeric"), 400)
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            rows = db.list_approval_history(
                limit=limit, offset=offset,
                session_id=session, pattern_key=pattern,
                choice=choice, since=since,
            )
            return _json_ok({"rows": rows, "limit": limit, "offset": offset})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_approvals_stats(self, request: "web.Request") -> "web.Response":
        window = request.query.get("window", "7d")
        seconds_map = {"1h": 3600, "24h": 86400, "7d": 604800, "30d": 2592000}
        delta = seconds_map.get(window, 604800)
        since = time.time() - delta
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            stats = db.approval_history_stats(since=since)
            return _json_ok({"stats": stats, "window": window, "since": since})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_approvals_bulk(self, request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            body = {}
        keys = body.get("session_keys") or []
        choice = (body.get("choice") or "").lower()
        if not isinstance(keys, list) or not keys:
            return _json_err(ValueError("session_keys (non-empty list) required"), 400)
        if choice not in ("once", "session", "always", "deny", "accept", "ignore"):
            return _json_err(ValueError("choice required"), 400)
        # LangGraph schema translation matches handle_resolve_approval
        translation = {"accept": "once", "ignore": "deny"}
        choice = translation.get(choice, choice)

        from tools.approval import resolve_gateway_approval
        results: list[dict] = []
        for key in keys:
            row = {"session_key": str(key), "ok": False}
            try:
                n = resolve_gateway_approval(str(key), choice)
                row["resolved"] = n
                row["ok"] = n > 0
                if n == 0:
                    row["error"] = "no pending approval"
            except Exception as exc:
                row["error"] = str(exc)
            results.append(row)
        return _json_ok({"results": results, "choice": choice})

    @require_dashboard_auth
    async def handle_brain_memory_add(self, request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            body = {}
        store = (body.get("store") or "").strip()
        content = body.get("content")
        target = self._memory_target_from_store(store)
        if target is None:
            return _json_err(ValueError("store must be 'MEMORY.md' or 'USER.md'"), 400)
        if not content or not isinstance(content, str):
            return _json_err(ValueError("content (str) required"), 400)
        try:
            from tools.memory_tool import MemoryStore
            store_obj = MemoryStore()
            store_obj.load_from_disk()
            result = store_obj.add(target, content)
            if not result.get("success"):
                return _json_err(ValueError(result.get("error", "add failed")), 400)
            return _json_ok({"ok": True, "result": result})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_brain_memory_replace(self, request: "web.Request") -> "web.Response":
        store_param = request.query.get("store") or "MEMORY.md"
        target = self._memory_target_from_store(store_param)
        if target is None:
            return _json_err(ValueError("store query must be MEMORY.md or USER.md"), 400)
        hash8 = request.match_info.get("hash", "")
        if not hash8:
            return _json_err(ValueError("hash required"), 400)
        try:
            body = await request.json()
        except Exception:
            body = {}
        new_content = body.get("content")
        if not new_content or not isinstance(new_content, str):
            return _json_err(ValueError("content (str) required"), 400)
        try:
            from tools.memory_tool import MemoryStore
            store_obj = MemoryStore()
            store_obj.load_from_disk()
            old_entry = store_obj.find_entry_by_hash(target, hash8)
            if old_entry is None:
                return _json_err(LookupError("no entry matches hash"), 404)
            result = store_obj.replace(target, old_entry, new_content)
            if not result.get("success"):
                return _json_err(ValueError(result.get("error", "replace failed")), 400)
            return _json_ok({"ok": True, "result": result})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_brain_memory_delete(self, request: "web.Request") -> "web.Response":
        store_param = request.query.get("store") or "MEMORY.md"
        target = self._memory_target_from_store(store_param)
        if target is None:
            return _json_err(ValueError("store query must be MEMORY.md or USER.md"), 400)
        hash8 = request.match_info.get("hash", "")
        if not hash8:
            return _json_err(ValueError("hash required"), 400)
        try:
            from tools.memory_tool import MemoryStore
            store_obj = MemoryStore()
            store_obj.load_from_disk()
            entry = store_obj.find_entry_by_hash(target, hash8)
            if entry is None:
                return _json_err(LookupError("no entry matches hash"), 404)
            result = store_obj.remove(target, entry)
            if not result.get("success"):
                return _json_err(ValueError(result.get("error", "remove failed")), 400)
            return _json_ok({"ok": True, "result": result})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_brain_memory_export(self, request: "web.Request") -> "web.Response":
        store_param = request.query.get("store") or "both"
        try:
            from tools.memory_tool import MemoryStore
            store_obj = MemoryStore()
            store_obj.load_from_disk()
            payload: Dict[str, Any] = {}
            if store_param in ("MEMORY.md", "memory", "both"):
                payload["MEMORY.md"] = {
                    "raw": store_obj.export_raw("memory"),
                    "entries": list(store_obj.memory_entries),
                }
            if store_param in ("USER.md", "user", "both"):
                payload["USER.md"] = {
                    "raw": store_obj.export_raw("user"),
                    "entries": list(store_obj.user_entries),
                }
            return _json_ok(payload)
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_brain_memory_import(self, request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            body = {}
        store_param = body.get("store") or ""
        target = self._memory_target_from_store(store_param)
        if target is None:
            return _json_err(ValueError("store must be 'MEMORY.md' or 'USER.md'"), 400)
        raw = body.get("raw_content")
        if not isinstance(raw, str):
            return _json_err(ValueError("raw_content (str) required"), 400)
        mode = (body.get("mode") or "replace").lower()
        try:
            from tools.memory_tool import MemoryStore
            store_obj = MemoryStore()
            store_obj.load_from_disk()
            result = store_obj.import_raw(target, raw, mode=mode)
            if not result.get("success"):
                return _json_err(ValueError(result.get("error", "import failed")), 400)
            return _json_ok({"ok": True, "result": result})
        except Exception as exc:
            return _json_err(exc)

    @staticmethod
    def _memory_target_from_store(store: str) -> Optional[str]:
        s = (store or "").strip().upper()
        if s in ("MEMORY.MD", "MEMORY"):
            return "memory"
        if s in ("USER.MD", "USER"):
            return "user"
        return None

    @require_dashboard_auth
    async def handle_brain_graph(self, request: "web.Request") -> "web.Response":
        """Return the brain visualization snapshot.

        Walks the four runtime knowledge surfaces (memory, sessions,
        capability registry, scheduled intents) and returns a typed
        graph of nodes + edges. Pure compute via
        ``tools.brain_snapshot.build_brain_snapshot``; the in-memory
        ``lru_cache`` coalesces concurrent requests into a single rebuild
        per 5-second window. Wrapped in ``asyncio.to_thread`` so the
        SQLite + filesystem queries don't stall the event loop.
        """
        try:
            from tools.brain_snapshot import build_brain_snapshot
            snapshot = await asyncio.to_thread(build_brain_snapshot)
        except Exception as exc:
            logger.exception("dashboard: brain graph build failed")
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response(snapshot)

    # ------------------------------------------------------------------
    # GET /api/dashboard/brain/node/{type}/{id} — single node detail
    # ------------------------------------------------------------------

    @require_dashboard_auth
    async def handle_brain_node(self, request: "web.Request") -> "web.Response":
        """Look up a single node from the current brain snapshot.

        The dashboard drawer fetches this when the user clicks a node
        so we don't have to round-trip the whole graph for every
        click. Returns 404 if the node was not present in the latest
        rebuild (e.g. it was removed since the snapshot was cached).
        """
        node_type = request.match_info.get("type", "")
        node_id = request.match_info.get("id", "")
        if not node_type or not node_id:
            return web.json_response({"error": "type and id required"}, status=400)
        try:
            from tools.brain_snapshot import find_node
            node = await asyncio.to_thread(find_node, node_type, node_id)
        except Exception as exc:
            logger.exception("dashboard: brain node lookup failed")
            return web.json_response({"error": str(exc)}, status=500)
        if node is None:
            return web.json_response({"error": "node not found"}, status=404)
        return web.json_response({"node": node})

    # ------------------------------------------------------------------
    # GET /api/dashboard/events — SSE multiplexer
    # ------------------------------------------------------------------

    @require_dashboard_auth
    async def handle_events(self, request: "web.Request") -> "web.StreamResponse":
        """SSE stream of EventBus events.

        Keepalive pattern mirrors ``_handle_run_events`` in api_server.py
        (30s timeout → comment-frame keepalive).
        """
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


def _detect_seatbelt_sandbox() -> bool:
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
    # F1 — Static segments (search/bulk) MUST be registered BEFORE the
    # dynamic /sessions/{id} route so aiohttp matches them first.
    app.router.add_get("/api/dashboard/sessions/search", routes.handle_session_search)
    app.router.add_post("/api/dashboard/sessions/bulk", routes.handle_session_bulk)
    app.router.add_get("/api/dashboard/sessions/{id}", routes.handle_session_detail)
    app.router.add_get("/api/dashboard/sessions/{id}/events", routes.handle_session_events)
    app.router.add_delete("/api/dashboard/sessions/{id}", routes.handle_delete_session)
    app.router.add_get("/api/dashboard/sessions/{id}/export", routes.handle_export_session)
    app.router.add_post("/api/dashboard/sessions/{id}/fork", routes.handle_fork_session)
    app.router.add_post("/api/dashboard/sessions/{id}/inject", routes.handle_inject_message)
    app.router.add_post("/api/dashboard/sessions/{id}/reopen", routes.handle_reopen_session)
    app.router.add_get("/api/dashboard/approvals", routes.handle_list_approvals)
    # F3 — Live Console v2 + Approval Command Center
    app.router.add_get("/api/dashboard/approvals/history", routes.handle_approvals_history)
    app.router.add_get("/api/dashboard/approvals/stats", routes.handle_approvals_stats)
    app.router.add_post("/api/dashboard/approvals/bulk", routes.handle_approvals_bulk)
    app.router.add_post("/api/dashboard/approvals/{session_key}", routes.handle_resolve_approval)
    app.router.add_get("/api/dashboard/events/search", routes.handle_events_search)
    app.router.add_get("/api/dashboard/events/export", routes.handle_events_export)
    app.router.add_get("/api/dashboard/tools", routes.handle_tools)
    app.router.add_get("/api/dashboard/skills", routes.handle_skills)
    app.router.add_get("/api/dashboard/mcp", routes.handle_mcp)
    app.router.add_get("/api/dashboard/doctor", routes.handle_doctor)
    app.router.add_get("/api/dashboard/config", routes.handle_config)
    app.router.add_get("/api/dashboard/recent", routes.handle_recent)
    app.router.add_get("/api/dashboard/events", routes.handle_events)

    # Brain visualization (Wave-1 R1 of stateful-noodling-reddy plan)
    app.router.add_get("/api/dashboard/brain/graph", routes.handle_brain_graph)
    app.router.add_get(
        "/api/dashboard/brain/node/{type}/{id}", routes.handle_brain_node,
    )
    # F2 — Brain/Memory Editor (Dashboard v2)
    app.router.add_post("/api/dashboard/brain/memory", routes.handle_brain_memory_add)
    app.router.add_put(
        "/api/dashboard/brain/memory/{hash}", routes.handle_brain_memory_replace
    )
    app.router.add_delete(
        "/api/dashboard/brain/memory/{hash}", routes.handle_brain_memory_delete
    )
    app.router.add_get("/api/dashboard/brain/export", routes.handle_brain_memory_export)
    app.router.add_post("/api/dashboard/brain/import", routes.handle_brain_memory_import)

    # Static UI bundle
    if static_dir is not None and static_dir.is_dir():
        app.router.add_static("/dashboard/", path=str(static_dir), show_index=True, append_version=True)
        logger.info("Dashboard UI mounted from %s", static_dir)
    else:
        logger.info("Dashboard UI bundle not present; only /api/dashboard/* routes are active")

    return routes
