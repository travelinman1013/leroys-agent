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


# ---------------------------------------------------------------------------
# Phase 8a — session control plane helpers
# ---------------------------------------------------------------------------

# Sentinel imported for SENTINEL-state checks in kill/inject
_AGENT_PENDING_SENTINEL = None  # Populated lazily from gateway.run


def _get_agent_sentinel():
    """Lazy import to avoid circular import with gateway.run."""
    global _AGENT_PENDING_SENTINEL
    if _AGENT_PENDING_SENTINEL is None:
        try:
            from gateway.run import _AGENT_PENDING_SENTINEL as _s
            _AGENT_PENDING_SENTINEL = _s
        except ImportError:
            pass
    return _AGENT_PENDING_SENTINEL


def _resolve_session_key(runner, session_id: str) -> Optional[str]:
    """Resolve a session_id to its session_key via SessionStore or DB.

    Fast path: iterate the in-memory ``SessionStore._entries`` dict.
    Slow path: query the ``session_key`` column added in schema v9.
    """
    if runner is None:
        return None
    store = getattr(runner, "session_store", None)
    if store is not None:
        if hasattr(store, '_ensure_loaded'):
            store._ensure_loaded()
        for key, entry in getattr(store, '_entries', {}).items():
            if getattr(entry, 'session_id', None) == session_id:
                return key
    # Slow path: DB lookup (v9 session_key column)
    try:
        from hermes_state import SessionDB
        db = SessionDB()
        session = db.get_session(session_id)
        if session and session.get("session_key"):
            return session["session_key"]
    except Exception:
        pass
    return None


def _enrich_sessions_with_status(rows: list, runner) -> None:
    """Annotate session rows with live status from ``_running_agents``.

    Modifies *rows* in place.  Each row gains:
      - ``status``: ``"running"`` | ``"idle"`` | ``"ended"``
      - ``running_since``: float timestamp (only when running)
    """
    if runner is None:
        for r in rows:
            r["status"] = "ended" if r.get("ended_at") else "idle"
        return

    running_agents = getattr(runner, "_running_agents", {})
    running_ts = getattr(runner, "_running_agents_ts", {})

    # Build reverse map: session_id → session_key (O(n) once)
    store = getattr(runner, "session_store", None)
    sid_to_key: Dict[str, str] = {}
    if store is not None:
        if hasattr(store, '_ensure_loaded'):
            store._ensure_loaded()
        for key, entry in getattr(store, '_entries', {}).items():
            sid = getattr(entry, 'session_id', None)
            if sid:
                sid_to_key[sid] = key

    for r in rows:
        sk = r.get("session_key") or sid_to_key.get(r["id"])
        if sk and sk in running_agents:
            r["status"] = "running"
            ts = running_ts.get(sk)
            if ts:
                r["running_since"] = ts
        elif r.get("ended_at"):
            r["status"] = "ended"
        else:
            r["status"] = "idle"


def _build_timeline(since: float, limit: int) -> list[dict[str, Any]]:
    """Build a chronological timeline of recent edits across all brain sources.

    Scans all three sources for files modified after *since*, sorts by
    mtime descending, caps at *limit*.  Title comes from frontmatter
    ``title:`` or first ``#`` heading or filename.
    """
    import re as _re
    from tools.brain_sources import list_sources, TEXT_EXTENSIONS

    entries: list[dict[str, Any]] = []
    for src in list_sources():
        root = src["root_path"]
        source_id = src["id"]
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = [
                d for d in dirnames
                if d not in (".obsidian", ".git", ".trash", "node_modules",
                             "__pycache__")
                and not d.startswith(".")
            ]
            for fname in filenames:
                _, ext = os.path.splitext(fname)
                if ext.lower() not in TEXT_EXTENSIONS:
                    continue
                fpath = os.path.join(dirpath, fname)
                try:
                    st = os.stat(fpath)
                except OSError:
                    continue
                if st.st_mtime <= since:
                    continue
                relpath = os.path.relpath(fpath, root)
                # Quick title extraction without reading full file.
                title = os.path.splitext(fname)[0]
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        head = f.read(512)
                    # Try frontmatter title.
                    if head.startswith("---"):
                        end = head.find("\n---", 3)
                        if end != -1:
                            import yaml
                            try:
                                fm = yaml.safe_load(head[3:end])
                                if isinstance(fm, dict) and fm.get("title"):
                                    title = str(fm["title"])
                            except Exception:
                                pass
                    # Try first heading.
                    if title == os.path.splitext(fname)[0]:
                        m = _re.match(r"^#\s+(.+)", head, _re.MULTILINE)
                        if m:
                            title = m.group(1).strip()
                except (OSError, UnicodeDecodeError):
                    pass

                entries.append({
                    "source": source_id,
                    "path": relpath,
                    "title": title,
                    "op": "edited",
                    "ts": st.st_mtime,
                })

    entries.sort(key=lambda e: e["ts"], reverse=True)
    return entries[:limit]


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
            # Phase 8a: enrich with live status from _running_agents
            runner = getattr(self._adapter, "gateway_runner", None)
            _enrich_sessions_with_status(rows, runner)
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

            # Phase 8a: enrich with live status + activity
            runner = getattr(self._adapter, "gateway_runner", None)
            _enrich_sessions_with_status([meta], runner)
            if meta.get("status") == "running" and runner:
                _sk = _resolve_session_key(runner, session_id)
                if _sk:
                    agent = getattr(runner, "_running_agents", {}).get(_sk)
                    sentinel = _get_agent_sentinel()
                    if agent and (sentinel is None or agent is not sentinel):
                        try:
                            meta["activity"] = agent.get_activity_summary()
                        except Exception:
                            pass

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
            # Phase 8a: enrich with live status
            runner = getattr(self._adapter, "gateway_runner", None)
            _enrich_sessions_with_status(rows, runner)
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
            # Phase 8a: deliver to running agent via interrupt if live
            delivered_live = False
            runner = getattr(self._adapter, "gateway_runner", None)
            if runner:
                _sk = _resolve_session_key(runner, session_id)
                if _sk and _sk in getattr(runner, "_running_agents", {}):
                    agent = runner._running_agents.get(_sk)
                    sentinel = _get_agent_sentinel()
                    if agent and (sentinel is None or agent is not sentinel):
                        try:
                            agent.interrupt(content)
                            delivered_live = True
                        except Exception:
                            pass
            resp = {"id": session_id, "message_id": msg_id}
            if delivered_live:
                resp["delivered_live"] = True
            return _json_ok(resp)
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

    # ------------------------------------------------------------------
    # POST /api/dashboard/sessions/{id}/kill — Phase 8a
    # ------------------------------------------------------------------

    @require_dashboard_auth
    async def handle_kill_session(self, request: "web.Request") -> "web.Response":
        """Kill a running agent session from the dashboard.

        Replicates the /stop pattern from gateway/run.py:1958-1970.
        """
        session_id = request.match_info.get("id", "")
        if not session_id:
            return _json_err(ValueError("session id required"), 400)
        try:
            body = await request.json()
        except Exception:
            body = {}
        reason = body.get("reason", "dashboard_kill")

        runner = getattr(self._adapter, "gateway_runner", None)
        if not runner:
            return _json_ok({"session_id": session_id, "killed": False, "was_running": False})

        _sk = _resolve_session_key(runner, session_id)
        running_agents = getattr(runner, "_running_agents", {})

        if not _sk or _sk not in running_agents:
            return _json_ok({"session_id": session_id, "killed": False, "was_running": False})

        agent = running_agents.get(_sk)
        sentinel = _get_agent_sentinel()

        # Interrupt the agent (matches /stop at run.py:1960)
        if agent and (sentinel is None or agent is not sentinel):
            try:
                agent.interrupt(f"Kill requested from dashboard: {reason}")
            except Exception:
                pass

        # Force-clean tracking dicts (same pattern as /stop at run.py:1967-1968)
        # Known race: _run_agent's finally block may also try to delete this key.
        # That's safe — it checks `if session_key in self._running_agents` first.
        running_agents.pop(_sk, None)
        getattr(runner, "_running_agents_ts", {}).pop(_sk, None)
        getattr(runner, "_pending_messages", {}).pop(_sk, None)

        # End the session in the DB
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            db.end_session(session_id, reason)
        except Exception:
            pass

        # Publish event
        try:
            from gateway.event_bus import publish as _publish_event
            _publish_event(
                "session.killed",
                session_id=session_id,
                data={"session_key": _sk, "reason": reason},
            )
        except Exception:
            pass

        return _json_ok({"session_id": session_id, "killed": True, "was_running": True})

    # ------------------------------------------------------------------
    # POST /api/dashboard/sessions — Spawn — Phase 8a
    # ------------------------------------------------------------------

    MAX_CONCURRENT_DASHBOARD_SESSIONS = 5
    MAX_TIMEOUT_SECONDS = 3600
    DEFAULT_TIMEOUT_SECONDS = 1800

    @require_dashboard_auth
    async def handle_spawn_session(self, request: "web.Request") -> "web.Response":
        """Spawn a new agent session from the dashboard.

        Returns 202 Accepted immediately. The agent runs as a background
        asyncio task. Monitor via SSE events or the session detail endpoint.
        """
        try:
            body = await request.json()
        except Exception:
            body = {}

        message = body.get("message")
        if not message or not isinstance(message, str):
            return _json_err(ValueError("message (str) required"), 400)

        title = body.get("title")
        timeout_s = body.get("timeout_seconds", self.DEFAULT_TIMEOUT_SECONDS)
        try:
            timeout_s = int(timeout_s)
        except (TypeError, ValueError):
            timeout_s = self.DEFAULT_TIMEOUT_SECONDS
        if timeout_s > self.MAX_TIMEOUT_SECONDS:
            return _json_err(
                ValueError(f"timeout_seconds exceeds max ({self.MAX_TIMEOUT_SECONDS})"),
                400,
            )
        timeout_s = max(30, timeout_s)  # Floor at 30s

        budget_usd = body.get("budget_usd")
        try:
            if budget_usd is not None:
                budget_usd = float(budget_usd)
                if budget_usd <= 0:
                    budget_usd = None
        except (TypeError, ValueError):
            budget_usd = None

        runner = getattr(self._adapter, "gateway_runner", None)
        if not runner:
            return _json_err(RuntimeError("gateway runner not available"), 503)

        # Concurrent session cap
        running_agents = getattr(runner, "_running_agents", {})
        dashboard_count = sum(
            1 for k in running_agents if "dashboard_" in k
        )
        if dashboard_count >= self.MAX_CONCURRENT_DASHBOARD_SESSIONS:
            return web.json_response(
                {"error": f"concurrent dashboard session limit ({self.MAX_CONCURRENT_DASHBOARD_SESSIONS}) reached"},
                status=429,
            )

        # Create session via SessionStore
        import uuid
        chat_id = f"dashboard_{uuid.uuid4().hex[:8]}"
        try:
            from gateway.config import Platform
            from gateway.session import SessionSource
            source = SessionSource(
                platform=Platform.LOCAL,
                chat_id=chat_id,
                chat_type="dm",
                user_name="operator",
            )
        except ImportError:
            return _json_err(RuntimeError("gateway config unavailable"), 503)

        try:
            store = runner.session_store
            entry = store.get_or_create_session(source, force_new=True)
            session_id = entry.session_id
            session_key = None
            # Resolve the session_key that SessionStore generated
            for k, e in store._entries.items():
                if e.session_id == session_id:
                    session_key = k
                    break
        except Exception as exc:
            return _json_err(exc)

        # Set title if provided
        if title:
            try:
                from hermes_state import SessionDB
                db = SessionDB()
                db.set_session_title(session_id, title)
            except Exception:
                pass

        # Update source to "dashboard" in DB and persist budget cap
        try:
            from hermes_state import SessionDB
            db = SessionDB()
            db._execute_write(
                lambda conn: conn.execute(
                    "UPDATE sessions SET source = ?, budget_usd = ? WHERE id = ?",
                    ("dashboard", budget_usd, session_id),
                )
            )
        except Exception:
            pass

        # Publish spawned event
        try:
            from gateway.event_bus import publish as _publish_event
            _publish_event(
                "session.spawned",
                session_id=session_id,
                data={
                    "session_key": session_key,
                    "message_preview": message[:200],
                    "source": "dashboard",
                },
            )
        except Exception:
            pass

        # Fire-and-forget: launch the agent in a background task
        loop = asyncio.get_event_loop()
        task = loop.create_task(
            self._spawn_dashboard_agent(
                runner, source, session_id, session_key, message, timeout_s,
                budget_usd=budget_usd,
            )
        )
        # Register in background tasks so stop() can cancel it
        bg_tasks = getattr(runner, "_background_tasks", None)
        if bg_tasks is not None and isinstance(bg_tasks, set):
            bg_tasks.add(task)
            task.add_done_callback(bg_tasks.discard)

        return web.json_response(
            {"session_id": session_id, "session_key": session_key, "status": "spawning"},
            status=202,
        )

    async def _spawn_dashboard_agent(
        self,
        runner,
        source,
        session_id: str,
        session_key: Optional[str],
        message: str,
        timeout_s: int,
        budget_usd: Optional[float] = None,
    ) -> None:
        """Background task: run an agent for a dashboard-spawned session."""
        # Abort if gateway is shutting down
        if not getattr(runner, "_running", True):
            return

        if not session_key:
            return

        # Place sentinel to prevent double-spawn
        sentinel = _get_agent_sentinel()
        runner._running_agents[session_key] = sentinel
        runner._running_agents_ts[session_key] = time.time()

        # Store budget cap so agent can pick it up after construction
        if budget_usd:
            if not hasattr(runner, "_session_budgets"):
                runner._session_budgets = {}
            runner._session_budgets[session_key] = budget_usd

        # Timeout watchdog — fires agent.interrupt() after wall-clock limit.
        # Do NOT use asyncio.wait_for() — it cancels the coroutine but does
        # NOT kill the thread pool executor thread where the agent runs.
        agent_holder = [None]
        watchdog_fired = False

        async def _timeout_watchdog():
            nonlocal watchdog_fired
            await asyncio.sleep(timeout_s)
            agent = agent_holder[0]
            if agent:
                watchdog_fired = True
                try:
                    agent.interrupt(f"Wall-clock timeout ({timeout_s}s)")
                except Exception:
                    pass

        watchdog = asyncio.get_event_loop().create_task(_timeout_watchdog())

        try:
            # Build context prompt via existing helper
            context_prompt = ""
            try:
                from gateway.session import build_session_context_prompt, SessionContext
                ctx = SessionContext(source=source)
                context_prompt = build_session_context_prompt(ctx)
            except Exception:
                context_prompt = "Source: Dashboard (operator-spawned session)"

            # Run the agent — _run_agent handles thread pool execution,
            # progress monitoring, and cleanup in its finally block.
            result = await runner._run_agent(
                message=message,
                context_prompt=context_prompt,
                history=[],
                source=source,
                session_id=session_id,
                session_key=session_key,
            )

            # Publish completion event
            event_type = "session.killed" if watchdog_fired else "session.completed"
            event_data = {
                "session_id": session_id,
                "api_calls": result.get("api_calls", 0) if result else 0,
            }
            if watchdog_fired:
                event_data["reason"] = "timeout"
            else:
                resp = (result or {}).get("final_response", "")
                event_data["response_preview"] = resp[:200] if resp else ""
            try:
                from gateway.event_bus import publish as _publish_event
                _publish_event(event_type, session_id=session_id, data=event_data)
            except Exception:
                pass

        except asyncio.CancelledError:
            # Gateway shutting down — clean up
            logger.info("Dashboard spawn task cancelled (shutdown): %s", session_id)
        except Exception as exc:
            logger.exception("Dashboard spawn failed: %s", exc)
            try:
                from gateway.event_bus import publish as _publish_event
                _publish_event(
                    "session.killed",
                    session_id=session_id,
                    data={"reason": f"error: {exc}"},
                )
            except Exception:
                pass
        finally:
            watchdog.cancel()
            try:
                await watchdog
            except asyncio.CancelledError:
                pass
            # Safety net: ensure _running_agents is cleaned up even if
            # _run_agent's finally block didn't fire (e.g., exception before
            # _run_agent was reached).
            runner._running_agents.pop(session_key, None)
            runner._running_agents_ts.pop(session_key, None)

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
    # F5 — Telemetry + Safe Config Editor (Dashboard v2)
    # ==================================================================

    @require_dashboard_auth
    async def handle_metrics_tokens(self, request: "web.Request") -> "web.Response":
        window = request.query.get("window", "24h")
        try:
            from gateway.metrics import get_metrics_reader
            return _json_ok(get_metrics_reader().tokens(window))
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_metrics_latency(self, request: "web.Request") -> "web.Response":
        window = request.query.get("window", "24h")
        group_by = request.query.get("group_by", "tool")
        try:
            from gateway.metrics import get_metrics_reader
            return _json_ok(get_metrics_reader().latency(window, group_by))
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_metrics_compression(self, request: "web.Request") -> "web.Response":
        window = request.query.get("window", "24h")
        try:
            from gateway.metrics import get_metrics_reader
            return _json_ok(get_metrics_reader().compression(window))
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_metrics_errors(self, request: "web.Request") -> "web.Response":
        window = request.query.get("window", "24h")
        try:
            from gateway.metrics import get_metrics_reader
            return _json_ok(get_metrics_reader().errors(window))
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_metrics_context(self, request: "web.Request") -> "web.Response":
        try:
            from gateway.metrics import get_metrics_reader
            return _json_ok(get_metrics_reader().context())
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_config_put(self, request: "web.Request") -> "web.Response":
        """Apply allowlisted config mutations.

        Body: ``{"mutations": {"approvals.mode": "manual", ...}}``.
        """
        try:
            body = await request.json()
        except Exception:
            body = {}
        mutations = body.get("mutations") or {}
        if not isinstance(mutations, dict) or not mutations:
            return _json_err(ValueError("mutations (dict) required"), 400)
        try:
            from hermes_cli.config import apply_config_mutations
            result = apply_config_mutations(mutations)
            return _json_ok(result)
        except PermissionError as exc:
            return _json_err(exc, 403)
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_config_backups(self, request: "web.Request") -> "web.Response":
        try:
            from hermes_cli.config import list_config_backups
            return _json_ok({"backups": list_config_backups()})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_config_rollback(self, request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            body = {}
        filename = body.get("to") or body.get("filename")
        if not filename:
            return _json_err(ValueError("'to' (filename) required"), 400)
        try:
            from hermes_cli.config import restore_config_backup
            return _json_ok(restore_config_backup(filename))
        except FileNotFoundError as exc:
            return _json_err(exc, 404)
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_security_paths(self, request: "web.Request") -> "web.Response":
        """Get or modify safe_roots and denied_paths.

        GET returns current lists.
        POST body: ``{action: "add"|"remove", target: "safe_roots"|"denied_paths", path: "..."}``
        Removal of critical denied_paths is blocked by DENIED_PATHS_REMOVAL_BLOCKLIST.
        All changes go through the existing backup + save pipeline.
        """
        if request.method == "GET":
            try:
                from hermes_cli.config import get_safe_roots, get_denied_paths
                from hermes_cli.config import DENIED_PATHS_REMOVAL_BLOCKLIST
                return _json_ok({
                    "safe_roots": get_safe_roots(),
                    "denied_paths": get_denied_paths(),
                    "removal_blocklist": sorted(DENIED_PATHS_REMOVAL_BLOCKLIST),
                })
            except Exception as exc:
                return _json_err(exc)

        # POST — add or remove a path
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)

        action = body.get("action", "")
        target = body.get("target", "")
        path = body.get("path", "").strip()

        if action not in ("add", "remove"):
            return web.json_response(
                {"error": "action must be 'add' or 'remove'"}, status=400
            )
        if target not in ("safe_roots", "denied_paths"):
            return web.json_response(
                {"error": "target must be 'safe_roots' or 'denied_paths'"},
                status=400,
            )
        if not path:
            return web.json_response(
                {"error": "path is required"}, status=400
            )

        try:
            from hermes_cli.config import (
                load_config,
                save_config,
                reset_path_jail_cache,
                DENIED_PATHS_REMOVAL_BLOCKLIST,
            )
            from hermes_cli.config import _backup_config_to_dated_file

            # Block removal of critical denied_paths.
            if action == "remove" and target == "denied_paths":
                expanded = os.path.expanduser(path)
                for blocked in DENIED_PATHS_REMOVAL_BLOCKLIST:
                    blocked_expanded = os.path.expanduser(blocked)
                    if expanded == blocked_expanded or path == blocked:
                        return web.json_response(
                            {"error": f"cannot remove protected path: {path}"},
                            status=403,
                        )

            cfg = load_config()
            _backup_config_to_dated_file(cfg)

            security = cfg.setdefault("security", {})
            current_list: list = security.get(target, [])
            if not isinstance(current_list, list):
                current_list = []

            expanded_path = os.path.expanduser(path)

            if action == "add":
                # Store with tilde for readability if it's under $HOME.
                store_path = path
                home = os.path.expanduser("~")
                if expanded_path.startswith(home + os.sep):
                    store_path = "~" + expanded_path[len(home):]
                already = any(
                    os.path.expanduser(p) == expanded_path
                    for p in current_list
                )
                if not already:
                    current_list.append(store_path)
            elif action == "remove":
                current_list = [
                    p for p in current_list
                    if os.path.expanduser(p) != expanded_path
                ]

            security[target] = current_list
            save_config(cfg)
            reset_path_jail_cache()

            return _json_ok({
                "ok": True,
                "action": action,
                "target": target,
                "path": path,
                target: current_list,
                "restart_required": True,
            })
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_gateway_info(self, request: "web.Request") -> "web.Response":
        info: Dict[str, Any] = {
            "pid": os.getpid(),
            "uptime_seconds": time.time() - self._started_at,
            "host": self._adapter._host,
            "port": self._adapter._port,
        }
        try:
            import resource
            usage = resource.getrusage(resource.RUSAGE_SELF)
            info["max_rss"] = usage.ru_maxrss
            info["user_time"] = usage.ru_utime
            info["system_time"] = usage.ru_stime
        except Exception:
            pass
        return _json_ok(info)

    @require_dashboard_auth
    async def handle_cost_summary(self, request: "web.Request") -> "web.Response":
        """Aggregate cost for today and this week."""
        try:
            from hermes_state import SessionDB
            import time as _t
            db = SessionDB()
            now = _t.time()
            # Start of today (midnight local)
            import datetime as _dt
            today_start = _dt.datetime.combine(
                _dt.date.today(), _dt.time.min
            ).timestamp()
            # Start of this week (Monday midnight)
            today = _dt.date.today()
            week_start = _dt.datetime.combine(
                today - _dt.timedelta(days=today.weekday()), _dt.time.min
            ).timestamp()

            row_today = db._conn.execute(
                "SELECT COALESCE(SUM(estimated_cost_usd), 0) "
                "FROM sessions WHERE started_at >= ?",
                (today_start,),
            ).fetchone()
            row_week = db._conn.execute(
                "SELECT COALESCE(SUM(estimated_cost_usd), 0) "
                "FROM sessions WHERE started_at >= ?",
                (week_start,),
            ).fetchone()
            cost_today = row_today[0] if row_today else 0
            cost_week = row_week[0] if row_week else 0
            threshold = 5.0
            try:
                cfg = _load_gateway_config()
                threshold = float(
                    cfg.get("dashboard", {}).get("cost_alert_threshold_usd", 5.0)
                )
            except Exception:
                pass
            return _json_ok({
                "today_usd": round(cost_today, 4),
                "week_usd": round(cost_week, 4),
                "threshold_usd": threshold,
                "above_threshold": cost_today > threshold,
            })
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_gateway_restart_command(self, request: "web.Request") -> "web.Response":
        """Return the launchctl command for the user to run.

        Does NOT execute it — the dashboard cannot shell out from inside
        the Seatbelt sandbox. The frontend shows the string in a dialog.
        """
        try:
            uid = os.getuid()
        except AttributeError:
            uid = 0
        return _json_ok({
            "command": f"launchctl kickstart -k gui/{uid}/ai.hermes.gateway",
            "note": "Run this in your terminal — the dashboard cannot exec from sandbox.",
        })

    # ==================================================================
    # F4 — Interactive Ops (Cron / Tools / Skills / MCP) — Dashboard v2
    # ==================================================================

    @require_dashboard_auth
    async def handle_cron_parse_schedule(self, request: "web.Request") -> "web.Response":
        expr = request.query.get("expr", "").strip()
        if not expr:
            return _json_err(ValueError("expr query required"), 400)
        try:
            from cron.jobs import parse_schedule
            return _json_ok({"parsed": parse_schedule(expr)})
        except Exception as exc:
            return _json_err(exc, 400)

    @require_dashboard_auth
    async def handle_cron_dry_run(self, request: "web.Request") -> "web.Response":
        try:
            body = await request.json()
        except Exception:
            body = {}
        prompt = (body.get("prompt") or "").strip()
        schedule = (body.get("schedule") or "30m").strip()
        if not prompt:
            return _json_err(ValueError("prompt required"), 400)
        try:
            from cron.jobs import dry_run_spec
            spec = dry_run_spec(
                prompt,
                schedule,
                name=body.get("name"),
                deliver=body.get("deliver"),
                skill=body.get("skill"),
                skills=body.get("skills"),
            )
            try:
                from gateway.event_bus import publish as _publish_event
                _publish_event(
                    "cron.fired",
                    session_id=f"dry_run_{spec['id']}",
                    data={
                        "phase": "dry-run",
                        "job_id": spec["id"],
                        "job_name": spec["name"],
                        "dry_run": True,
                    },
                )
            except Exception:
                pass
            return _json_ok({"spec": spec, "persisted": False})
        except Exception as exc:
            return _json_err(exc, 400)

    @require_dashboard_auth
    async def handle_tool_toggle(self, request: "web.Request") -> "web.Response":
        name = request.match_info.get("name", "")
        if not name:
            return _json_err(ValueError("tool name required"), 400)
        try:
            body = await request.json()
        except Exception:
            body = {}
        platform = body.get("platform", "")
        enabled = bool(body.get("enabled", True))
        if not platform:
            return _json_err(ValueError("platform field required"), 400)
        try:
            from hermes_cli.config import apply_config_mutations
            result = apply_config_mutations({
                f"platform_toolsets.{platform}.{name}": enabled,
            })
            return _json_ok(result)
        except PermissionError as exc:
            return _json_err(exc, 403)
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_tool_schema(self, request: "web.Request") -> "web.Response":
        name = request.match_info.get("name", "")
        if not name:
            return _json_err(ValueError("tool name required"), 400)
        try:
            from model_tools import registry as _tool_registry
            spec = None
            try:
                tool_specs = _tool_registry.get_tool_specs()
                for s in tool_specs:
                    fn = s.get("function") or {}
                    if fn.get("name") == name:
                        spec = s
                        break
            except Exception:
                pass
            if spec is None:
                return _json_err(LookupError("tool not found"), 404)
            return _json_ok({"name": name, "spec": spec})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_tool_invoke(self, request: "web.Request") -> "web.Response":
        """SECURITY-CRITICAL: dashboard-initiated tool invocation.

        EVERY invocation funnels through ``handle_function_call`` which
        applies path jail (R3) before dispatch and the standard
        approval gate via the ``hermes_tools.terminal`` RPC for shell
        commands. The handler ALSO scans args for the ``force`` smuggle
        and known dangerous params, and pre-checks dangerous command
        patterns before invoking the dispatcher.

        Test coverage:
            tests/gateway/test_tool_invoke_security.py
        """
        name = request.match_info.get("name", "")
        if not name:
            return _json_err(ValueError("tool name required"), 400)
        try:
            body = await request.json()
        except Exception:
            body = {}
        args = body.get("args") or {}
        if not isinstance(args, dict):
            return _json_err(ValueError("args must be a dict"), 400)
        session_id = body.get("session_id") or f"dashboard-invoke-{int(time.time())}"

        # ── Strip the ``force`` smuggle at every level. Phase 4 R1 closed
        # the kwarg path; the dashboard route applies its own scrub so a
        # later regression in execute_code's blocked-param list cannot
        # leak via the dashboard.
        def _scrub_force(obj: Any) -> Any:
            if isinstance(obj, dict):
                return {
                    k: _scrub_force(v)
                    for k, v in obj.items()
                    if k not in ("force", "skip_approval", "unsafe", "bypass")
                }
            if isinstance(obj, list):
                return [_scrub_force(v) for v in obj]
            return obj

        scrubbed_args = _scrub_force(args)

        # ── Pre-check for dangerous shell commands so we surface a 202
        # needs_approval response BEFORE we hand the call to
        # handle_function_call. This makes the gate visible from the UI
        # without weakening the existing in-process gate that runs
        # underneath at hermes_tools.terminal.
        try:
            from tools.approval import detect_dangerous_command
            command_str = ""
            if name in ("execute_code", "terminal", "shell"):
                command_str = str(scrubbed_args.get("command", ""))
            if command_str:
                is_dangerous, pattern_key, description = detect_dangerous_command(command_str)
                if is_dangerous:
                    return _json_ok({
                        "needs_approval": True,
                        "pattern_key": pattern_key,
                        "description": description,
                        "command": command_str,
                    }, status=202)
        except Exception:
            pass

        # ── Dispatch through the normal pipeline. Path jail (R3) runs
        # inside handle_function_call before any tool code executes.
        try:
            from model_tools import handle_function_call
            os_env_marker = os.environ.get("HERMES_GATEWAY_SESSION")
            os.environ["HERMES_GATEWAY_SESSION"] = "1"
            try:
                result = handle_function_call(
                    name,
                    scrubbed_args,
                    session_id=session_id,
                )
            finally:
                if os_env_marker is None:
                    os.environ.pop("HERMES_GATEWAY_SESSION", None)
                else:
                    os.environ["HERMES_GATEWAY_SESSION"] = os_env_marker
            return _json_ok({"result": result, "tool": name})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_skill_reload(self, request: "web.Request") -> "web.Response":
        name = request.match_info.get("name", "")
        if not name:
            return _json_err(ValueError("skill name required"), 400)
        try:
            from hermes_cli.config import get_hermes_home
            skill_dir = Path(get_hermes_home()) / "skills" / name
            if not skill_dir.is_dir():
                return _json_err(LookupError("skill not found"), 404)
            try:
                from gateway.event_bus import publish as _publish_event
                _publish_event(
                    "skill.reloaded",
                    session_id=None,
                    data={"skill": name, "resolver": "dashboard"},
                )
            except Exception:
                pass
            return _json_ok({"reloaded": True, "name": name})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_skill_full(self, request: "web.Request") -> "web.Response":
        name = request.match_info.get("name", "")
        if not name:
            return _json_err(ValueError("skill name required"), 400)
        try:
            from hermes_cli.config import get_hermes_home
            skill_dir = Path(get_hermes_home()) / "skills" / name
            md_path = skill_dir / "SKILL.md"
            if not md_path.exists():
                return _json_err(LookupError("SKILL.md not found"), 404)
            text = md_path.read_text(encoding="utf-8", errors="replace")
            return _json_ok({"name": name, "content": text})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_mcp_toggle(self, request: "web.Request") -> "web.Response":
        name = request.match_info.get("name", "")
        if not name:
            return _json_err(ValueError("server name required"), 400)
        try:
            body = await request.json()
        except Exception:
            body = {}
        enabled = bool(body.get("enabled", True))
        try:
            from hermes_cli.config import apply_config_mutations
            # ``disabled`` is the inverse — store both for clarity.
            result = apply_config_mutations({
                f"mcp_servers.{name}.disabled": not enabled,
            })
            return _json_ok(result)
        except PermissionError as exc:
            return _json_err(exc, 403)
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_mcp_health(self, request: "web.Request") -> "web.Response":
        name = request.match_info.get("name", "")
        if not name:
            return _json_err(ValueError("server name required"), 400)
        try:
            from hermes_cli.config import load_config
            cfg = load_config() or {}
            servers = cfg.get("mcp_servers") or {}
            entry = servers.get(name) if isinstance(servers, dict) else None
            if entry is None:
                return _json_err(LookupError("mcp server not configured"), 404)
            return _json_ok({
                "name": name,
                "configured": True,
                "enabled": not entry.get("disabled", False),
                "command": entry.get("command"),
            })
        except Exception as exc:
            return _json_err(exc)

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
    # Phase 6 R1 — Brain content API (sources, tree, doc, search,
    #              timeline, doc write)
    # ------------------------------------------------------------------

    @require_dashboard_auth
    async def handle_brain_sources(self, request: "web.Request") -> "web.Response":
        """Return the list of brain content sources with file counts."""
        try:
            from tools.brain_sources import list_sources
            sources = await asyncio.to_thread(list_sources)
        except Exception as exc:
            return _json_err(exc)
        return _json_ok(sources)

    @require_dashboard_auth
    async def handle_brain_tree(self, request: "web.Request") -> "web.Response":
        """Return a hierarchical tree for a brain source.

        Query params: ``source`` (required), ``path`` (optional subpath).
        """
        source = request.query.get("source", "")
        subpath = request.query.get("path", "")
        if not source:
            return web.json_response(
                {"error": "missing required param: source"}, status=400
            )
        try:
            from tools.brain_tree import build_tree
            tree = await asyncio.to_thread(build_tree, source, subpath)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except PermissionError as exc:
            return web.json_response({"error": str(exc)}, status=403)
        except Exception as exc:
            return _json_err(exc)
        return _json_ok(tree)

    @require_dashboard_auth
    async def handle_brain_doc(self, request: "web.Request") -> "web.Response":
        """Return a single document with body, frontmatter, backlinks.

        Query params: ``source`` (required), ``path`` (required).
        Uses query-string params (not path params) because vault paths
        contain slashes and %2F encoding is sometimes rejected by
        intermediate proxies (Amendment L §1.2).
        """
        source = request.query.get("source", "")
        path = request.query.get("path", "")
        if not source or not path:
            return web.json_response(
                {"error": "missing required params: source, path"}, status=400
            )
        try:
            from tools.brain_sources import load_doc, FileTooLarge, BinaryFile
            doc = await asyncio.to_thread(load_doc, source, path)

            # Attach backlinks asynchronously.
            from tools.brain_backlinks import get_backlink_index
            from tools.brain_sources import resolve_source
            src = resolve_source(source)
            idx = get_backlink_index(src.root)
            backlinks = await idx.get_backlinks(path)
            doc["backlinks"] = backlinks

        except FileTooLarge as exc:
            return web.json_response(
                {"error": "file too large", "size": exc.size, "path": exc.path},
                status=413,
            )
        except BinaryFile as exc:
            return web.json_response(
                {"error": "binary file", "path": exc.path},
                status=415,
            )
        except UnicodeDecodeError:
            return web.json_response(
                {"error": "unsupported encoding"}, status=415
            )
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except PermissionError as exc:
            return web.json_response({"error": str(exc)}, status=403)
        except FileNotFoundError:
            return web.json_response({"error": "not found"}, status=404)
        except Exception as exc:
            return _json_err(exc)
        return _json_ok(doc)

    @require_dashboard_auth
    async def handle_brain_search(self, request: "web.Request") -> "web.Response":
        """Fuzzy search across brain content sources.

        Query params: ``q`` (required), ``source`` (default ``*``),
        ``limit`` (default 50).
        """
        q = request.query.get("q", "")
        source = request.query.get("source", "*")
        try:
            limit = min(200, max(1, int(request.query.get("limit", "50"))))
        except ValueError:
            limit = 50

        if not q:
            return web.json_response(
                {"error": "missing required param: q"}, status=400
            )
        if len(q) > 200:
            return web.json_response(
                {"error": "query too long (max 200 chars)"}, status=400
            )

        try:
            from tools.brain_search import search
            results, partial = await asyncio.to_thread(search, q, source, limit)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return _json_err(exc)

        resp: dict[str, Any] = {"results": results}
        if partial:
            resp["partial"] = True

        # Publish search event (gated by verbosity, Amendment O §4.3).
        try:
            from gateway.event_bus import publish
            publish(
                "brain.search",
                data={"q": q, "source": source, "hits": len(results),
                      "partial": partial},
            )
        except Exception:
            pass

        status = 206 if partial else 200
        return web.json_response(resp, status=status)

    @require_dashboard_auth
    async def handle_brain_timeline(self, request: "web.Request") -> "web.Response":
        """Chronological feed of recent edits across all sources.

        Query params: ``since`` (ISO 8601, optional), ``limit`` (default 100).
        """
        import datetime

        since_raw = request.query.get("since", "")
        try:
            limit = min(500, max(1, int(request.query.get("limit", "100"))))
        except ValueError:
            limit = 100

        since: float = 0.0
        if since_raw:
            try:
                dt = datetime.datetime.fromisoformat(since_raw)
                since = dt.timestamp()
            except ValueError:
                return web.json_response(
                    {"error": "invalid since param (use ISO 8601)"}, status=400
                )

        try:
            entries = await asyncio.to_thread(
                _build_timeline, since, limit
            )
        except Exception as exc:
            return _json_err(exc)
        return _json_ok(entries)

    @require_dashboard_auth
    async def handle_brain_doc_write(self, request: "web.Request") -> "web.Response":
        """Write a brain document (approval-gated, hash-based OCC).

        Body: ``{source, path, content, expected_hash?}``.

        The write goes through the existing approval gate pattern — this
        endpoint resolves the I/O after approval has been granted.
        Amendment A row 10: if the approval callback is not registered,
        fail closed with 503.
        """
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON body"}, status=400)

        source = body.get("source", "")
        path = body.get("path", "")
        content = body.get("content")
        expected_hash = body.get("expected_hash")

        if not source or not path or content is None:
            return web.json_response(
                {"error": "missing required fields: source, path, content"},
                status=400,
            )

        try:
            from tools.brain_write import write_doc, HashMismatch
            result = await asyncio.to_thread(
                write_doc, source, path, content, expected_hash
            )
        except HashMismatch as exc:
            return web.json_response(
                {"error": "conflict", "current_hash": exc.actual},
                status=409,
            )
        except PermissionError as exc:
            return web.json_response({"error": str(exc)}, status=403)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return _json_err(exc)

        # Publish write event (always, per Amendment O §4.3).
        try:
            from gateway.event_bus import publish
            publish(
                "brain.doc.written",
                data={
                    "source": source,
                    "path": path,
                    "size": result.get("size", 0),
                    "content_hash": result.get("content_hash", ""),
                },
            )
        except Exception:
            # Amendment A row 13: write already succeeded; log warning.
            logger.warning("brain.event_publish_failed", exc_info=True)

        return _json_ok(result, status=201)

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

    # -----------------------------------------------------------------
    # Phase 7: Workflow inspectability
    # -----------------------------------------------------------------

    @require_dashboard_auth
    async def handle_workflow_runs(self, request: "web.Request") -> "web.Response":
        """GET /api/dashboard/workflows — paginated workflow run list."""
        try:
            limit = max(1, min(200, int(request.query.get("limit", "50"))))
            offset = max(0, int(request.query.get("offset", "0")))
            status = request.query.get("status") or None

            from hermes_state import SessionDB
            db = SessionDB()
            runs = db.list_workflow_runs(limit=limit, offset=offset, status=status)
            return web.json_response({"runs": runs, "limit": limit, "offset": offset})
        except Exception as exc:
            return _json_err(exc)

    @require_dashboard_auth
    async def handle_workflow_run_detail(self, request: "web.Request") -> "web.Response":
        """GET /api/dashboard/workflows/{id} — single run with checkpoints."""
        try:
            run_id = request.match_info["id"]

            from hermes_state import SessionDB
            db = SessionDB()
            run = db.get_workflow_run(run_id)
            if run is None:
                return web.json_response({"error": "Workflow run not found"}, status=404)
            return web.json_response({"run": run})
        except Exception as exc:
            return _json_err(exc)


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
    # Phase 8a: spawn MUST be registered BEFORE {id} routes — aiohttp
    # matches routes in registration order, and POST /sessions would be
    # shadowed by POST /sessions/{id}/... if registered after.
    app.router.add_post("/api/dashboard/sessions", routes.handle_spawn_session)
    app.router.add_get("/api/dashboard/sessions/{id}", routes.handle_session_detail)
    app.router.add_get("/api/dashboard/sessions/{id}/events", routes.handle_session_events)
    app.router.add_delete("/api/dashboard/sessions/{id}", routes.handle_delete_session)
    app.router.add_get("/api/dashboard/sessions/{id}/export", routes.handle_export_session)
    app.router.add_post("/api/dashboard/sessions/{id}/fork", routes.handle_fork_session)
    app.router.add_post("/api/dashboard/sessions/{id}/inject", routes.handle_inject_message)
    app.router.add_post("/api/dashboard/sessions/{id}/reopen", routes.handle_reopen_session)
    app.router.add_post("/api/dashboard/sessions/{id}/kill", routes.handle_kill_session)
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
    # F5 — Telemetry + Safe Config Editor (Dashboard v2)
    app.router.add_get("/api/dashboard/metrics/tokens", routes.handle_metrics_tokens)
    app.router.add_get("/api/dashboard/metrics/latency", routes.handle_metrics_latency)
    app.router.add_get("/api/dashboard/metrics/compression", routes.handle_metrics_compression)
    app.router.add_get("/api/dashboard/metrics/errors", routes.handle_metrics_errors)
    app.router.add_get("/api/dashboard/metrics/context", routes.handle_metrics_context)
    app.router.add_put("/api/dashboard/config", routes.handle_config_put)
    app.router.add_get("/api/dashboard/config/backups", routes.handle_config_backups)
    app.router.add_post("/api/dashboard/config/rollback", routes.handle_config_rollback)
    app.router.add_get("/api/dashboard/security/paths", routes.handle_security_paths)
    app.router.add_post("/api/dashboard/security/paths", routes.handle_security_paths)
    app.router.add_get("/api/dashboard/gateway/info", routes.handle_gateway_info)
    app.router.add_get("/api/dashboard/cost/summary", routes.handle_cost_summary)
    app.router.add_get("/api/dashboard/gateway/restart-command", routes.handle_gateway_restart_command)

    # F4 — Interactive Ops (Dashboard v2)
    app.router.add_get("/api/dashboard/jobs/parse-schedule", routes.handle_cron_parse_schedule)
    app.router.add_post("/api/dashboard/jobs/dry-run", routes.handle_cron_dry_run)
    app.router.add_post("/api/dashboard/tools/{name}/toggle", routes.handle_tool_toggle)
    app.router.add_get("/api/dashboard/tools/{name}/schema", routes.handle_tool_schema)
    app.router.add_post("/api/dashboard/tools/{name}/invoke", routes.handle_tool_invoke)
    app.router.add_post("/api/dashboard/skills/{name}/reload", routes.handle_skill_reload)
    app.router.add_get("/api/dashboard/skills/{name}/full", routes.handle_skill_full)
    app.router.add_post("/api/dashboard/mcp/{name}/toggle", routes.handle_mcp_toggle)
    app.router.add_get("/api/dashboard/mcp/{name}/health", routes.handle_mcp_health)

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

    # Phase 6 R1 — Brain content API
    app.router.add_get("/api/dashboard/brain/sources", routes.handle_brain_sources)
    app.router.add_get("/api/dashboard/brain/tree", routes.handle_brain_tree)
    app.router.add_get("/api/dashboard/brain/doc", routes.handle_brain_doc)
    app.router.add_get("/api/dashboard/brain/search", routes.handle_brain_search)
    app.router.add_get("/api/dashboard/brain/timeline", routes.handle_brain_timeline)
    app.router.add_post("/api/dashboard/brain/doc", routes.handle_brain_doc_write)

    # Phase 7 — Workflow inspectability
    app.router.add_get("/api/dashboard/workflows", routes.handle_workflow_runs)
    app.router.add_get("/api/dashboard/workflows/{id}", routes.handle_workflow_run_detail)

    # Static UI bundle
    #
    # Split into (1) a real static mount for hashed Vite assets and
    # (2) an SPA-fallback catch-all that serves ``index.html`` for every
    # other ``/dashboard/*`` URL. Without the fallback, a hard refresh on
    # a client-side route like ``/dashboard/sessions`` 404s at the aiohttp
    # layer, and bare ``/dashboard/`` lands on a directory listing instead
    # of the React entry point. The previous ``show_index=True`` behavior
    # exposed a listing of the build directory to the browser.
    #
    # The catch-all verifies that arbitrary file requests stay inside
    # ``static_dir`` via a realpath check — the fallback only kicks in
    # when the requested path does NOT resolve to a real file. Paths
    # with a file extension that do not exist return 404 so the browser
    # sees a proper missing-asset error (instead of HTML that would
    # confuse a <script> or <img> loader).
    if static_dir is not None and static_dir.is_dir():
        assets_dir = static_dir / "assets"
        if assets_dir.is_dir():
            app.router.add_static(
                "/dashboard/assets/",
                path=str(assets_dir),
                append_version=True,
            )

        async def _dashboard_spa(request: "web.Request") -> "web.Response":
            tail = request.match_info.get("tail", "")
            # Fast refusal of traversal attempts — never resolve ``..``
            if ".." in tail.split("/"):
                return web.Response(status=404, text="Not Found")
            candidate: Optional[Path] = None
            if tail:
                try:
                    resolved = (static_dir / tail).resolve()
                    root = static_dir.resolve()
                    # resolved must be root itself or strictly inside it
                    if resolved == root or str(resolved).startswith(str(root) + os.sep):
                        if resolved.is_file():
                            candidate = resolved
                except OSError:
                    candidate = None
            if candidate is not None:
                return web.FileResponse(path=candidate)
            # SPA fallback: extensioned requests that did not resolve to a
            # real file are genuine 404s (missing assets). Anything else
            # is a client-side route and should boot the SPA.
            last_segment = tail.rsplit("/", 1)[-1] if tail else ""
            if "." in last_segment:
                return web.Response(status=404, text="Not Found")
            index_path = static_dir / "index.html"
            if not index_path.is_file():
                return web.Response(status=404, text="Dashboard bundle not present")
            response = web.FileResponse(path=index_path)
            response.headers["Cache-Control"] = "no-store"
            return response

        app.router.add_get("/dashboard", _dashboard_spa)
        app.router.add_get("/dashboard/", _dashboard_spa)
        app.router.add_get(r"/dashboard/{tail:.*}", _dashboard_spa)
        logger.info("Dashboard UI mounted from %s", static_dir)
    else:
        logger.info("Dashboard UI bundle not present; only /api/dashboard/* routes are active")

    return routes
