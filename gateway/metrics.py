"""
F5 — Telemetry reader for the dashboard metrics surface.

Walks ``~/.hermes/events.ndjson`` plus its rotated backups (``.1``,
``.2``, ``.3``) and aggregates the result into:

  * Token usage buckets per window
  * Latency percentiles per tool
  * Compression timeline (tokens before/after each compaction)
  * Tool error rate (failed / total per tool name)
  * Live context utilisation (latest llm.call event)

Design notes
------------
- The dashboard's ``/api/dashboard/metrics/*`` routes call into a
  module-level :class:`MetricsReader` so the 30-second result cache
  is shared across requests.
- ``_walk_rotation()`` reads files in chronological order
  (``.3 → .2 → .1 → events.ndjson``) so 24-hour windows that span the
  50 MB rotation boundary still see every event (validator finding
  #23 in the cobalt-steering-heron plan).
- The reader is fail-silent on a malformed line (it continues with
  the next one). It does NOT touch SQLite — purely event-log driven.
- 30s cache invalidation is per-window-key. The cache key is the
  ``(metric_kind, window_seconds)`` tuple, so the cache also responds
  to a different query window without manual invalidation.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

logger = logging.getLogger(__name__)

_CACHE_TTL = 30.0  # seconds
_BACKUP_COUNT = 3


def _default_events_path() -> Path:
    hermes_home = os.environ.get("HERMES_HOME")
    if hermes_home:
        return Path(hermes_home).expanduser() / "events.ndjson"
    return Path.home() / ".hermes" / "events.ndjson"


def _parse_ts(value: Any) -> Optional[float]:
    """Parse a stored event timestamp into a unix-time float."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except Exception:
            return None
    return None


def _percentile(values: List[float], pct: float) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    idx = int(round((pct / 100) * (len(s) - 1)))
    return s[max(0, min(len(s) - 1, idx))]


WINDOW_SECONDS = {
    "1h": 3600,
    "24h": 86400,
    "7d": 604800,
    "30d": 2592000,
}


class MetricsReader:
    """Aggregates rotated events.ndjson into the F5 dashboard metrics."""

    def __init__(self, events_path: Optional[Path] = None) -> None:
        self._path = events_path or _default_events_path()
        self._cache: Dict[Tuple[str, ...], Tuple[float, Any]] = {}

    def _walk_rotation(self) -> Iterator[Dict[str, Any]]:
        """Yield events in chronological order across rotated files."""
        candidates: list[Path] = []
        for i in range(_BACKUP_COUNT, 0, -1):
            p = self._path.with_suffix(self._path.suffix + f".{i}")
            if p.exists():
                candidates.append(p)
        if self._path.exists():
            candidates.append(self._path)
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

    def _events_in_window(self, window_seconds: int) -> Iterator[Dict[str, Any]]:
        cutoff = time.time() - window_seconds
        for ev in self._walk_rotation():
            ts = _parse_ts(ev.get("ts"))
            if ts is None or ts < cutoff:
                continue
            yield ev

    def _cached(self, key: Tuple[str, ...], builder):
        now = time.time()
        cached = self._cache.get(key)
        if cached is not None:
            ts, value = cached
            if now - ts < _CACHE_TTL:
                return value
        value = builder()
        self._cache[key] = (now, value)
        return value

    # ------------------------------------------------------------------
    # Public metric builders
    # ------------------------------------------------------------------

    def tokens(self, window: str = "24h") -> Dict[str, Any]:
        seconds = WINDOW_SECONDS.get(window, WINDOW_SECONDS["24h"])
        return self._cached(("tokens", window), lambda: self._build_tokens(seconds))

    def _build_tokens(self, window_seconds: int) -> Dict[str, Any]:
        # Bucket size: window/24, so 1h → 2.5min, 24h → 1h, 7d → 7h
        bucket_seconds = max(60, window_seconds // 24)
        buckets: Dict[int, Dict[str, int]] = {}
        total_in = 0
        total_out = 0
        for ev in self._events_in_window(window_seconds):
            if ev.get("type") != "llm.call":
                continue
            data = ev.get("data") or {}
            ts = _parse_ts(ev.get("ts")) or 0
            bucket = int(ts // bucket_seconds) * bucket_seconds
            entry = buckets.setdefault(bucket, {"input": 0, "output": 0})
            entry["input"] += int(data.get("input_tokens") or 0)
            entry["output"] += int(data.get("output_tokens") or 0)
            total_in += int(data.get("input_tokens") or 0)
            total_out += int(data.get("output_tokens") or 0)
        sorted_buckets = sorted(buckets.items())
        return {
            "buckets": [
                {"ts": k, "input": v["input"], "output": v["output"]}
                for k, v in sorted_buckets
            ],
            "total": {"input": total_in, "output": total_out},
            "bucket_seconds": bucket_seconds,
        }

    def latency(self, window: str = "24h", group_by: str = "tool") -> Dict[str, Any]:
        seconds = WINDOW_SECONDS.get(window, WINDOW_SECONDS["24h"])
        return self._cached(
            ("latency", window, group_by),
            lambda: self._build_latency(seconds, group_by),
        )

    def _build_latency(self, window_seconds: int, group_by: str) -> Dict[str, Any]:
        groups: Dict[str, list[float]] = {}
        for ev in self._events_in_window(window_seconds):
            if ev.get("type") != "tool.completed":
                continue
            data = ev.get("data") or {}
            latency = data.get("latency_ms")
            if latency is None:
                continue
            key = (
                str(data.get("tool") or "unknown")
                if group_by == "tool"
                else str(ev.get("session_id") or "unknown")
            )
            groups.setdefault(key, []).append(float(latency))
        out: Dict[str, Any] = {}
        for k, vals in groups.items():
            out[k] = {
                "count": len(vals),
                "p50": _percentile(vals, 50),
                "p95": _percentile(vals, 95),
                "p99": _percentile(vals, 99),
                "max": max(vals) if vals else None,
            }
        return {"groups": out, "group_by": group_by}

    def compression(self, window: str = "24h") -> Dict[str, Any]:
        seconds = WINDOW_SECONDS.get(window, WINDOW_SECONDS["24h"])
        return self._cached(
            ("compression", window),
            lambda: self._build_compression(seconds),
        )

    def _build_compression(self, window_seconds: int) -> Dict[str, Any]:
        timeline: list[Dict[str, Any]] = []
        for ev in self._events_in_window(window_seconds):
            if ev.get("type") != "compaction":
                continue
            data = ev.get("data") or {}
            if data.get("phase") != "completed":
                continue
            timeline.append({
                "ts": _parse_ts(ev.get("ts")),
                "session_id": ev.get("session_id"),
                "tokens_before": data.get("tokens_before"),
                "tokens_after": data.get("tokens_after"),
                "n_messages_before": data.get("n_messages_before"),
                "n_messages_after": data.get("n_messages_after"),
            })
        return {"events": timeline, "count": len(timeline)}

    def errors(self, window: str = "24h") -> Dict[str, Any]:
        seconds = WINDOW_SECONDS.get(window, WINDOW_SECONDS["24h"])
        return self._cached(
            ("errors", window),
            lambda: self._build_errors(seconds),
        )

    def _build_errors(self, window_seconds: int) -> Dict[str, Any]:
        per_tool: Dict[str, Dict[str, int]] = {}
        for ev in self._events_in_window(window_seconds):
            if ev.get("type") != "tool.completed":
                continue
            data = ev.get("data") or {}
            tool = str(data.get("tool") or "unknown")
            entry = per_tool.setdefault(tool, {"total": 0, "errors": 0})
            entry["total"] += 1
            if not data.get("ok", True):
                entry["errors"] += 1
        out = {}
        for tool, e in per_tool.items():
            rate = (e["errors"] / e["total"]) if e["total"] else 0.0
            out[tool] = {
                "total": e["total"],
                "errors": e["errors"],
                "error_rate": rate,
            }
        return {"per_tool": out}

    def context(self) -> Dict[str, Any]:
        """Return the latest llm.call event's token usage as live context.

        Walks the tail of events.ndjson (last 256 lines) for the most
        recent llm.call event. Used by the StatusHeader gauge.
        """
        try:
            if not self._path.exists():
                return {"latest": None}
            with open(self._path, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                chunk = min(size, 64 * 1024)
                f.seek(size - chunk)
                tail = f.read().decode("utf-8", errors="replace")
            for line in reversed(tail.splitlines()):
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if ev.get("type") == "llm.call":
                    data = ev.get("data") or {}
                    return {
                        "latest": {
                            "ts": ev.get("ts"),
                            "session_id": ev.get("session_id"),
                            "model": data.get("model"),
                            "input_tokens": data.get("input_tokens"),
                            "output_tokens": data.get("output_tokens"),
                            "total_tokens": data.get("total_tokens"),
                            "latency_ms": data.get("latency_ms"),
                        },
                    }
            return {"latest": None}
        except Exception as exc:
            logger.debug("metrics: context tail read failed: %s", exc)
            return {"latest": None}


# Module-level singleton — shared across dashboard route invocations.
_singleton: Optional[MetricsReader] = None


def get_metrics_reader() -> MetricsReader:
    global _singleton
    if _singleton is None:
        _singleton = MetricsReader()
    return _singleton


def reset_metrics_reader_for_tests() -> None:
    global _singleton
    _singleton = None
