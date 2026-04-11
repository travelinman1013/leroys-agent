"""
Gateway-wide event bus for the dashboard & observability surface.

Purpose
-------
The agent loop, tool dispatcher, cron scheduler, session store, and approval
gate all emit structured events into a single in-process pubsub. Consumers
(today: the dashboard SSE endpoint; later: otel exporter, webhooks, etc.)
subscribe via an async iterator and receive a live stream.

Design
------
- **Thread-safe `publish()`** — callable from the sync agent thread without
  awaiting an event loop. If no asyncio loop is attached, the event is
  buffered into a lock-protected deque and flushed on the next async tick.
- **Per-subscriber bounded queue with drop-oldest** — a slow dashboard tab
  can never block the agent loop. If a subscriber falls more than 1024
  events behind, the oldest events are silently dropped.
- **NDJSON tee file** — every event is appended to `~/.hermes/events.ndjson`
  (rotated at 50 MB, keeps 3 backups). The dashboard replays recent history
  from this file after a gateway restart.
- **Fail-silent** — publish never raises. The agent loop must not break
  because a dashboard consumer misbehaves.
- **Lazy singleton** — `get_event_bus()` returns the process-wide instance,
  constructed on first access. Safe to call from anywhere.

Event schema (borrowed from OpenHands V1)
----------------------------------------
    {
        "type": "session.started" | "turn.started" | "turn.ended"
              | "tool.invoked" | "tool.completed"
              | "llm.call"
              | "approval.requested" | "approval.resolved"
              | "compaction"
              | "cron.fired"
              | "session.ended"
              # Brain-viz events (Wave-1 R4 of stateful-noodling-reddy plan):
              | "memory.added" | "memory.replaced" | "memory.removed"
              | "skill.installed" | "skill.removed"
              | "mcp.connected" | "mcp.disconnected",
        "ts": "2026-04-10T12:34:56.789012+00:00",
        "session_id": "<optional>",
        "data": { ... }
    }

Note: there is NO runtime whitelist on event types — `publish()` accepts
any string. The list above is documentation of the types currently emitted
by code in this repo. Adding a new emit-point requires no changes here
(though updating this comment is polite).

Sandbox note
------------
The tee file lives under `~/.hermes/` which is already whitelisted R/W by
the Phase 4 Seatbelt profile (`scripts/sandbox/hermes.sb`). No profile
changes are required.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Deque, Dict, List, Optional

logger = logging.getLogger(__name__)

# Limits and rotation settings
_SUBSCRIBER_QUEUE_MAXSIZE = 1024
_PRE_LOOP_BUFFER_MAXSIZE = 2048
_NDJSON_ROTATE_BYTES = 50 * 1024 * 1024  # 50 MB
_NDJSON_BACKUP_COUNT = 3
_FLUSH_INTERVAL_SECONDS = 0.5
_FLUSH_BATCH_SIZE = 50


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _default_events_path() -> Path:
    """Return ~/.hermes/events.ndjson without importing hermes_cli.config.

    Importing hermes_cli.config is cheap but not free, and event_bus is
    imported at gateway boot before the config has loaded. We replicate the
    minimal directory lookup here.
    """
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        return Path(hermes_home).expanduser() / "events.ndjson"
    return Path.home() / ".hermes" / "events.ndjson"


class _Subscriber:
    """One async consumer of the event stream.

    Wraps a bounded asyncio.Queue with drop-oldest semantics. Public API is
    `put()` (non-blocking from any thread) and the async iteration protocol
    on the parent EventBus, which reads from this queue.
    """

    __slots__ = ("queue", "drops", "loop")

    def __init__(self, loop: asyncio.AbstractEventLoop, maxsize: int) -> None:
        self.loop = loop
        self.queue: asyncio.Queue[Optional[Dict[str, Any]]] = asyncio.Queue(maxsize=maxsize)
        self.drops = 0

    def put_threadsafe(self, event: Dict[str, Any]) -> None:
        """Enqueue from any thread. Drops oldest on overflow."""
        def _put() -> None:
            try:
                self.queue.put_nowait(event)
            except asyncio.QueueFull:
                # Drop oldest and retry once. Accumulate a drop counter so
                # we can expose backpressure metrics later.
                try:
                    _ = self.queue.get_nowait()
                    self.drops += 1
                except asyncio.QueueEmpty:
                    pass
                try:
                    self.queue.put_nowait(event)
                except asyncio.QueueFull:
                    # Queue is saturated — give up silently.
                    self.drops += 1

        # call_soon_threadsafe is the only way to touch asyncio.Queue from
        # a non-loop thread without hitting "attached to a different loop"
        try:
            self.loop.call_soon_threadsafe(_put)
        except RuntimeError:
            # Loop is closed — drop the event silently.
            self.drops += 1


class EventBus:
    """Process-wide event bus.

    Use `get_event_bus()` to access the singleton. Direct instantiation is
    only for tests.
    """

    def __init__(
        self,
        events_path: Optional[Path] = None,
        rotate_bytes: int = _NDJSON_ROTATE_BYTES,
        backup_count: int = _NDJSON_BACKUP_COUNT,
    ) -> None:
        self._events_path = events_path or _default_events_path()
        self._rotate_bytes = rotate_bytes
        self._backup_count = backup_count

        # Pre-loop buffer: events published before any asyncio loop is
        # attached (e.g. during CLI usage or very early gateway boot).
        # Protected by a threading.Lock so sync agent threads can append.
        self._pre_loop_buffer: Deque[Dict[str, Any]] = deque(maxlen=_PRE_LOOP_BUFFER_MAXSIZE)
        self._pre_loop_lock = threading.Lock()

        # Once attached, `_loop` is the loop that owns all subscribers and
        # the flush task. publish() uses call_soon_threadsafe to reach it.
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        # Subscribers (dashboard SSE consumers). Mutated only from the
        # owning loop, so no lock is needed once `_loop` is set.
        self._subscribers: List[_Subscriber] = []

        # File I/O for the NDJSON tee. Access is guarded by a threading
        # lock so publish() can append synchronously when no loop is
        # attached, while the async flush task can take over later.
        self._file_lock = threading.Lock()

        # Flush task handle (so we can cancel cleanly on shutdown).
        self._flush_task: Optional[asyncio.Task] = None
        self._started = False

        # Optional in-memory ring buffer for recent events — useful for
        # replay-after-reconnect and for tests.
        self._recent: Deque[Dict[str, Any]] = deque(maxlen=500)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the bus to an asyncio loop and start the flush task.

        Called from gateway boot once the aiohttp app has its loop.
        Idempotent — safe to call multiple times with the same loop.
        """
        if self._loop is loop and self._started:
            return
        self._loop = loop
        if not self._started:
            try:
                self._flush_task = loop.create_task(self._flush_forever())
                self._started = True
            except RuntimeError:
                # Loop not running yet — will be started when it is.
                self._flush_task = None
                self._started = False

        # Drain any events that were buffered before the loop attached.
        self._drain_pre_loop_buffer()

    async def start(self) -> None:
        """Async-friendly alternative to attach_loop.

        Attaches to the currently running loop. Use from an async context
        (e.g., aiohttp `on_startup`).
        """
        loop = asyncio.get_running_loop()
        self.attach_loop(loop)

    async def stop(self) -> None:
        """Cancel the flush task and drain remaining events to disk."""
        if self._flush_task is not None:
            self._flush_task.cancel()
            try:
                await self._flush_task
            except (asyncio.CancelledError, Exception):
                pass
            self._flush_task = None
        self._started = False
        # Best-effort final flush
        with self._pre_loop_lock:
            pending = list(self._pre_loop_buffer)
            self._pre_loop_buffer.clear()
        for event in pending:
            self._write_ndjson(event)

    # ------------------------------------------------------------------
    # Publish
    # ------------------------------------------------------------------

    def publish(
        self,
        event_type: str,
        *,
        session_id: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Thread-safe, fail-silent event publish.

        Callable from the sync agent thread, from an asyncio task, or from
        a background worker. NEVER raises — a broken event bus must not
        break the agent loop.
        """
        try:
            event = {
                "type": event_type,
                "ts": _utc_now_iso(),
                "session_id": session_id,
                "data": dict(data) if data else {},
            }
        except Exception:
            # Even constructing the event failed — give up.
            return

        # Remember it for recent-events replay (bounded deque, thread-safe
        # enough for our needs — the GIL serializes deque.append).
        try:
            self._recent.append(event)
        except Exception:
            pass

        # If a loop is attached, fan out immediately to subscribers.
        loop = self._loop
        if loop is not None:
            for sub in list(self._subscribers):
                try:
                    sub.put_threadsafe(event)
                except Exception:
                    pass
            # The NDJSON tee happens on the flush task's tick so we don't
            # hold up the publish call with disk I/O. Stash into the
            # pre_loop_buffer (reused as the flush queue) for the task to
            # pick up.
            with self._pre_loop_lock:
                self._pre_loop_buffer.append(event)
        else:
            # No loop yet — buffer for later and write synchronously to
            # disk so CLI users still get events.ndjson.
            with self._pre_loop_lock:
                self._pre_loop_buffer.append(event)
            try:
                self._write_ndjson(event)
            except Exception as exc:
                logger.debug("event_bus: pre-loop ndjson write failed: %s", exc)

    # ------------------------------------------------------------------
    # Subscribe (async)
    # ------------------------------------------------------------------

    async def subscribe(
        self,
        *,
        replay_recent: int = 0,
    ) -> AsyncIterator[Dict[str, Any]]:
        """Async iterator of live events.

        Yields events in arrival order. If `replay_recent` > 0, yields up
        to that many buffered events before switching to live mode — so a
        freshly-connected dashboard tab doesn't see an empty stream.

        Usage
        -----
            async for event in bus.subscribe():
                await send_sse(event)
        """
        loop = asyncio.get_running_loop()
        # Make sure the bus knows about this loop (first caller usually
        # wins, subsequent calls are no-ops).
        self.attach_loop(loop)

        sub = _Subscriber(loop=loop, maxsize=_SUBSCRIBER_QUEUE_MAXSIZE)
        self._subscribers.append(sub)

        # Replay recent events into this subscriber's queue before any
        # live ones, so ordering is preserved.
        if replay_recent > 0:
            recent = list(self._recent)[-replay_recent:]
            for event in recent:
                try:
                    sub.queue.put_nowait(event)
                except asyncio.QueueFull:
                    break

        try:
            while True:
                event = await sub.queue.get()
                if event is None:
                    break
                yield event
        finally:
            try:
                self._subscribers.remove(sub)
            except ValueError:
                pass

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def recent_events(self, limit: int = 100) -> List[Dict[str, Any]]:
        recent = list(self._recent)
        if limit <= 0:
            return recent
        return recent[-limit:]

    # ------------------------------------------------------------------
    # Internal: flush task & NDJSON tee
    # ------------------------------------------------------------------

    async def _flush_forever(self) -> None:
        """Periodically drain buffered events to the NDJSON tee."""
        while True:
            try:
                await asyncio.sleep(_FLUSH_INTERVAL_SECONDS)
                self._drain_pre_loop_buffer(batch_size=_FLUSH_BATCH_SIZE)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("event_bus: flush task error: %s", exc)

    def _drain_pre_loop_buffer(self, batch_size: Optional[int] = None) -> None:
        """Pop up to `batch_size` events off the pre-loop buffer and tee.

        If batch_size is None, drains the whole buffer.
        """
        with self._pre_loop_lock:
            if not self._pre_loop_buffer:
                return
            if batch_size is None or batch_size >= len(self._pre_loop_buffer):
                pending = list(self._pre_loop_buffer)
                self._pre_loop_buffer.clear()
            else:
                pending = [self._pre_loop_buffer.popleft() for _ in range(batch_size)]

        for event in pending:
            self._write_ndjson(event)

    def _write_ndjson(self, event: Dict[str, Any]) -> None:
        """Append a single event as one NDJSON line, rotating if needed."""
        try:
            path = self._events_path
            path.parent.mkdir(parents=True, exist_ok=True)
            with self._file_lock:
                self._maybe_rotate(path)
                line = json.dumps(event, ensure_ascii=False, default=str) + "\n"
                # Open append-text mode so the OS handles atomic
                # line-level appends (on POSIX with O_APPEND this is safe
                # across threads within one process).
                with open(path, "a", encoding="utf-8") as f:
                    f.write(line)
        except Exception as exc:
            logger.debug("event_bus: ndjson write failed: %s", exc)

    def _maybe_rotate(self, path: Path) -> None:
        """Rotate NDJSON file if it exceeds the size threshold."""
        try:
            if not path.exists():
                return
            if path.stat().st_size < self._rotate_bytes:
                return

            # Shift backups: .2 -> .3, .1 -> .2, base -> .1
            for i in range(self._backup_count, 0, -1):
                src = path.with_suffix(path.suffix + f".{i}")
                if i == self._backup_count and src.exists():
                    try:
                        src.unlink()
                    except Exception:
                        pass
                    continue
                dst = path.with_suffix(path.suffix + f".{i + 1}")
                if src.exists():
                    try:
                        src.rename(dst)
                    except Exception:
                        pass
            try:
                path.rename(path.with_suffix(path.suffix + ".1"))
            except Exception:
                pass
        except Exception as exc:
            logger.debug("event_bus: rotation failed: %s", exc)


# ---------------------------------------------------------------------------
# Singleton accessor
# ---------------------------------------------------------------------------

_singleton_lock = threading.Lock()
_singleton: Optional[EventBus] = None


def get_event_bus() -> EventBus:
    """Return the process-wide EventBus, constructing it on first access."""
    global _singleton
    if _singleton is not None:
        return _singleton
    with _singleton_lock:
        if _singleton is None:
            _singleton = EventBus()
    return _singleton


def reset_event_bus_for_tests() -> None:
    """Drop the singleton. Tests only."""
    global _singleton
    with _singleton_lock:
        _singleton = None


# ---------------------------------------------------------------------------
# Convenience: a module-level publish() that mirrors `get_event_bus().publish`
# Keeps emit-points at call sites one-liners instead of two-liners.
# ---------------------------------------------------------------------------

def publish(
    event_type: str,
    *,
    session_id: Optional[str] = None,
    data: Optional[Dict[str, Any]] = None,
) -> None:
    """Shortcut for ``get_event_bus().publish(...)``."""
    try:
        get_event_bus().publish(event_type, session_id=session_id, data=data)
    except Exception:
        # Module-level shortcut must never raise.
        pass
