"""Tests for gateway/metrics.py — events.ndjson aggregation."""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from gateway.metrics import MetricsReader, reset_metrics_reader_for_tests


@pytest.fixture(autouse=True)
def _reset(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    reset_metrics_reader_for_tests()
    yield


def _write_events(path: Path, events):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for ev in events:
            f.write(json.dumps(ev) + "\n")


def _iso(secs: float) -> str:
    return datetime.fromtimestamp(secs, tz=timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Token bucket math
# ---------------------------------------------------------------------------


class TestTokens:
    def test_aggregate_input_output(self, tmp_path):
        path = tmp_path / "events.ndjson"
        now = time.time()
        _write_events(path, [
            {
                "type": "llm.call",
                "ts": _iso(now - 60),
                "data": {"input_tokens": 100, "output_tokens": 50},
            },
            {
                "type": "llm.call",
                "ts": _iso(now - 30),
                "data": {"input_tokens": 200, "output_tokens": 75},
            },
            {
                "type": "tool.invoked",
                "ts": _iso(now - 20),
                "data": {},
            },
        ])
        reader = MetricsReader(events_path=path)
        result = reader.tokens("1h")
        assert result["total"]["input"] == 300
        assert result["total"]["output"] == 125

    def test_window_filter(self, tmp_path):
        path = tmp_path / "events.ndjson"
        now = time.time()
        _write_events(path, [
            {"type": "llm.call", "ts": _iso(now - 7200), "data": {"input_tokens": 1000, "output_tokens": 0}},
            {"type": "llm.call", "ts": _iso(now - 60), "data": {"input_tokens": 50, "output_tokens": 0}},
        ])
        reader = MetricsReader(events_path=path)
        result = reader.tokens("1h")
        # Old event excluded
        assert result["total"]["input"] == 50


# ---------------------------------------------------------------------------
# Latency percentiles
# ---------------------------------------------------------------------------


class TestLatency:
    def test_p50_p95(self, tmp_path):
        path = tmp_path / "events.ndjson"
        now = time.time()
        events = [
            {
                "type": "tool.completed",
                "ts": _iso(now - 60),
                "data": {"tool": "ls", "latency_ms": v, "ok": True},
            }
            for v in (10, 20, 30, 40, 50, 60, 70, 80, 90, 100)
        ]
        _write_events(path, events)
        reader = MetricsReader(events_path=path)
        result = reader.latency("1h")
        ls = result["groups"]["ls"]
        assert ls["count"] == 10
        assert 40 <= ls["p50"] <= 60
        assert ls["p95"] >= 90


# ---------------------------------------------------------------------------
# Compression timeline
# ---------------------------------------------------------------------------


class TestCompression:
    def test_only_completed_events(self, tmp_path):
        path = tmp_path / "events.ndjson"
        now = time.time()
        _write_events(path, [
            {
                "type": "compaction",
                "ts": _iso(now - 60),
                "data": {"phase": "started", "tokens_before": 1000},
            },
            {
                "type": "compaction",
                "ts": _iso(now - 50),
                "data": {
                    "phase": "completed",
                    "tokens_before": 1000,
                    "tokens_after": 400,
                    "n_messages_before": 20,
                    "n_messages_after": 8,
                },
            },
        ])
        reader = MetricsReader(events_path=path)
        result = reader.compression("1h")
        assert result["count"] == 1
        assert result["events"][0]["tokens_after"] == 400


# ---------------------------------------------------------------------------
# Error rate
# ---------------------------------------------------------------------------


class TestErrors:
    def test_per_tool_error_rate(self, tmp_path):
        path = tmp_path / "events.ndjson"
        now = time.time()
        events = []
        for i in range(8):
            events.append({
                "type": "tool.completed",
                "ts": _iso(now - i),
                "data": {"tool": "execute_code", "ok": i % 4 != 0},
            })
        _write_events(path, events)
        reader = MetricsReader(events_path=path)
        result = reader.errors("1h")
        execute = result["per_tool"]["execute_code"]
        assert execute["total"] == 8
        assert execute["errors"] == 2
        assert execute["error_rate"] == 0.25


# ---------------------------------------------------------------------------
# Live context
# ---------------------------------------------------------------------------


class TestContext:
    def test_returns_latest_llm_call(self, tmp_path):
        path = tmp_path / "events.ndjson"
        now = time.time()
        _write_events(path, [
            {
                "type": "llm.call",
                "ts": _iso(now - 60),
                "data": {"input_tokens": 10, "output_tokens": 5},
            },
            {
                "type": "tool.invoked",
                "ts": _iso(now - 30),
                "data": {},
            },
            {
                "type": "llm.call",
                "ts": _iso(now - 10),
                "data": {"input_tokens": 100, "output_tokens": 50, "model": "gemma"},
            },
        ])
        reader = MetricsReader(events_path=path)
        result = reader.context()
        assert result["latest"] is not None
        assert result["latest"]["model"] == "gemma"
        assert result["latest"]["input_tokens"] == 100


# ---------------------------------------------------------------------------
# Rotation walk (validator finding #23)
# ---------------------------------------------------------------------------


class TestRotation:
    def test_walks_rotated_files(self, tmp_path):
        base = tmp_path / "events.ndjson"
        rotated = tmp_path / "events.ndjson.1"
        now = time.time()
        _write_events(rotated, [
            {
                "type": "llm.call",
                "ts": _iso(now - 1800),  # within 1h
                "data": {"input_tokens": 10, "output_tokens": 5},
            },
        ])
        _write_events(base, [
            {
                "type": "llm.call",
                "ts": _iso(now - 60),
                "data": {"input_tokens": 90, "output_tokens": 45},
            },
        ])
        reader = MetricsReader(events_path=base)
        result = reader.tokens("1h")
        # Both rotated AND current file events sum
        assert result["total"]["input"] == 100
        assert result["total"]["output"] == 50

    def test_rotation_excludes_old(self, tmp_path):
        base = tmp_path / "events.ndjson"
        rotated2 = tmp_path / "events.ndjson.2"
        now = time.time()
        _write_events(rotated2, [
            {
                "type": "llm.call",
                "ts": _iso(now - 7200),  # outside 1h window
                "data": {"input_tokens": 999, "output_tokens": 0},
            },
        ])
        _write_events(base, [
            {
                "type": "llm.call",
                "ts": _iso(now - 60),
                "data": {"input_tokens": 1, "output_tokens": 0},
            },
        ])
        reader = MetricsReader(events_path=base)
        result = reader.tokens("1h")
        assert result["total"]["input"] == 1


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


class TestCache:
    def test_repeat_call_uses_cache(self, tmp_path):
        path = tmp_path / "events.ndjson"
        now = time.time()
        _write_events(path, [
            {"type": "llm.call", "ts": _iso(now - 30), "data": {"input_tokens": 5, "output_tokens": 2}},
        ])
        reader = MetricsReader(events_path=path)
        first = reader.tokens("1h")
        # Mutate the file — cached read should not see the change
        _write_events(path, [
            {"type": "llm.call", "ts": _iso(now - 30), "data": {"input_tokens": 999, "output_tokens": 999}},
        ])
        second = reader.tokens("1h")
        assert first == second
