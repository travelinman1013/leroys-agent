"""Tests for gateway.event_bus — the dashboard & observability pubsub."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import pytest

from gateway.event_bus import (
    EventBus,
    _NDJSON_BACKUP_COUNT,
    get_event_bus,
    publish,
    reset_event_bus_for_tests,
)


@pytest.fixture(autouse=True)
def _reset_singleton():
    reset_event_bus_for_tests()
    yield
    reset_event_bus_for_tests()


@pytest.fixture
def tmp_bus(tmp_path):
    path = tmp_path / "events.ndjson"
    bus = EventBus(events_path=path, rotate_bytes=2048, backup_count=2)
    yield bus, path


# ---------------------------------------------------------------------------
# publish() — sync path (no loop attached)
# ---------------------------------------------------------------------------


def test_publish_writes_ndjson_without_loop(tmp_bus):
    bus, path = tmp_bus
    bus.publish("test.event", session_id="s1", data={"k": "v"})

    assert path.exists()
    lines = path.read_text().splitlines()
    assert len(lines) == 1

    event = json.loads(lines[0])
    assert event["type"] == "test.event"
    assert event["session_id"] == "s1"
    assert event["data"] == {"k": "v"}
    assert "ts" in event


def test_publish_is_fail_silent_with_bad_data(tmp_bus):
    bus, _ = tmp_bus
    # Non-serializable objects: should still emit via `default=str`
    class Unsafe:
        def __repr__(self):
            return "<Unsafe>"

    bus.publish("ok", data={"obj": Unsafe()})
    # No exception raised, event landed in recent
    assert len(bus.recent_events()) == 1


def test_publish_never_raises_on_fs_error(tmp_path):
    # Point at a path under a file (not a dir) so mkdir will fail
    fake_parent = tmp_path / "impossible"
    fake_parent.write_text("not a dir")
    bus = EventBus(events_path=fake_parent / "sub" / "events.ndjson")
    bus.publish("test.event", data={"n": 1})  # must not raise


# ---------------------------------------------------------------------------
# recent_events() ring buffer
# ---------------------------------------------------------------------------


def test_recent_events_tracks_last_published(tmp_bus):
    bus, _ = tmp_bus
    for i in range(10):
        bus.publish("count", data={"i": i})

    recent = bus.recent_events(limit=5)
    assert len(recent) == 5
    assert [e["data"]["i"] for e in recent] == [5, 6, 7, 8, 9]


# ---------------------------------------------------------------------------
# subscribe() — async path with loop attached
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_subscribe_receives_published_events(tmp_bus):
    bus, _ = tmp_bus
    await bus.start()

    received: list = []

    async def consumer():
        async for event in bus.subscribe():
            received.append(event)
            if len(received) >= 3:
                break

    task = asyncio.create_task(consumer())
    # Give the subscriber a chance to register
    await asyncio.sleep(0.05)

    bus.publish("a", data={"n": 1})
    bus.publish("b", data={"n": 2})
    bus.publish("c", data={"n": 3})

    await asyncio.wait_for(task, timeout=2.0)

    assert [e["type"] for e in received] == ["a", "b", "c"]
    assert [e["data"]["n"] for e in received] == [1, 2, 3]


@pytest.mark.asyncio
async def test_subscribe_replays_recent(tmp_bus):
    bus, _ = tmp_bus
    await bus.start()

    # Publish some events BEFORE subscribing
    bus.publish("before.1", data={})
    bus.publish("before.2", data={})
    bus.publish("before.3", data={})

    received: list = []

    async def consumer():
        async for event in bus.subscribe(replay_recent=10):
            received.append(event)
            if len(received) >= 3:
                break

    await asyncio.wait_for(consumer(), timeout=2.0)
    assert [e["type"] for e in received] == ["before.1", "before.2", "before.3"]


@pytest.mark.asyncio
async def test_cross_thread_publish_reaches_subscriber(tmp_bus):
    """Publishing from a sync thread must still reach async subscribers."""
    bus, _ = tmp_bus
    await bus.start()

    received: list = []

    async def consumer():
        async for event in bus.subscribe():
            received.append(event)
            if len(received) >= 5:
                break

    task = asyncio.create_task(consumer())
    await asyncio.sleep(0.05)

    def worker():
        for i in range(5):
            bus.publish("thread.event", data={"i": i})
            time.sleep(0.001)

    t = threading.Thread(target=worker)
    t.start()
    t.join()

    await asyncio.wait_for(task, timeout=2.0)
    assert len(received) == 5
    assert [e["data"]["i"] for e in received] == [0, 1, 2, 3, 4]


@pytest.mark.asyncio
async def test_slow_subscriber_gets_drop_oldest(tmp_bus):
    """A subscriber that never reads must not block the bus."""
    bus, _ = tmp_bus
    await bus.start()

    # Register a subscriber but never read from it. Publishing > maxsize
    # events must not deadlock or raise.
    from gateway.event_bus import _Subscriber

    loop = asyncio.get_running_loop()
    sub = _Subscriber(loop=loop, maxsize=4)
    bus._subscribers.append(sub)

    for i in range(100):
        bus.publish("flood", data={"i": i})

    # Give call_soon_threadsafe callbacks a chance to run
    await asyncio.sleep(0.1)

    # Queue should be capped at 4 + counted drops
    assert sub.queue.qsize() <= 4
    assert sub.drops > 0

    bus._subscribers.remove(sub)


# ---------------------------------------------------------------------------
# NDJSON rotation
# ---------------------------------------------------------------------------


def test_ndjson_rotates_when_threshold_exceeded(tmp_path):
    path = tmp_path / "events.ndjson"
    # Tiny rotation threshold so one large event triggers it
    bus = EventBus(events_path=path, rotate_bytes=200, backup_count=2)

    # First event to create the file
    bus.publish("seed", data={"payload": "x" * 50})
    assert path.exists()

    # Now flood until we exceed the threshold multiple times
    for i in range(20):
        bus.publish("big", data={"payload": "x" * 50, "i": i})

    # We expect rotated backups to exist
    backup1 = path.with_suffix(path.suffix + ".1")
    assert backup1.exists(), "Expected at least one rotated backup"


def test_ndjson_rotation_respects_backup_count(tmp_path):
    path = tmp_path / "events.ndjson"
    bus = EventBus(events_path=path, rotate_bytes=100, backup_count=2)

    for i in range(200):
        bus.publish("rot", data={"payload": "y" * 40, "i": i})

    # With backup_count=2 we should see at most .1 and .2
    assert path.with_suffix(path.suffix + ".1").exists()
    # .3 must not exist (over the backup cap)
    assert not path.with_suffix(path.suffix + ".3").exists()


# ---------------------------------------------------------------------------
# Module-level shortcuts
# ---------------------------------------------------------------------------


def test_module_level_publish_uses_singleton(tmp_path, monkeypatch):
    # Redirect the default events path so we don't pollute the user's ~/.hermes
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    reset_event_bus_for_tests()

    publish("module.shortcut", data={"n": 1})

    bus = get_event_bus()
    assert bus.recent_events()[-1]["type"] == "module.shortcut"
    assert (tmp_path / "events.ndjson").exists()


def test_get_event_bus_is_singleton():
    a = get_event_bus()
    b = get_event_bus()
    assert a is b
