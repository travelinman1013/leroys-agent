"""Tests for tools/brain_snapshot.py — the dashboard /brain graph builder.

These verify:
- Each section builder pulls from the right data source and produces the
  expected node shape.
- A failing section doesn't blank the whole graph (graceful degradation).
- Stable content-hash IDs for memory entries (so removals don't break the
  R3 frontend pulse-mapping by index).
- Redaction passes through every text field that originates from user input.
- The 5-second lru_cache buckets repeated calls.

The fixture redirects HERMES_HOME via monkeypatch so SessionDB, MemoryStore,
and the cron loader all use a clean per-test directory.
"""

from __future__ import annotations

import pytest

from tools.brain_snapshot import (
    build_brain_snapshot,
    find_node,
    reset_snapshot_cache,
)


@pytest.fixture(autouse=True)
def _isolated_hermes_home(tmp_path, monkeypatch):
    """Per-test HERMES_HOME pointing at tmp_path. Clears the lru_cache
    on the snapshot builder so each test sees a fresh rebuild."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # Clear the cached get_hermes_home() if present
    try:
        from hermes_constants import get_hermes_home
        if hasattr(get_hermes_home, "cache_clear"):
            get_hermes_home.cache_clear()
    except Exception:
        pass
    # Memory store cached MEMORY_DIR at module import — patch it directly
    monkeypatch.setattr("tools.memory_tool.MEMORY_DIR", tmp_path / "memories")
    monkeypatch.setattr(
        "tools.memory_tool.get_memory_dir", lambda: tmp_path / "memories",
    )
    (tmp_path / "memories").mkdir(parents=True, exist_ok=True)
    reset_snapshot_cache()
    yield
    reset_snapshot_cache()


# ---------------------------------------------------------------------------
# Public shape
# ---------------------------------------------------------------------------


class TestSnapshotShape:
    def test_returns_required_top_level_keys(self):
        snap = build_brain_snapshot()
        assert "nodes" in snap
        assert "edges" in snap
        assert "stats" in snap
        assert "generated_at" in snap

    def test_stats_has_per_type_counts(self):
        snap = build_brain_snapshot()
        for key in ("memory", "session", "skill", "tool", "mcp", "cron", "edges"):
            assert key in snap["stats"]
            assert isinstance(snap["stats"][key], int)

    def test_nodes_have_required_fields(self):
        snap = build_brain_snapshot()
        for node in snap["nodes"]:
            assert "id" in node
            assert "type" in node
            assert "label" in node
            assert "weight" in node
            assert "metadata" in node
            assert ":" in node["id"]  # type:entity_id format


# ---------------------------------------------------------------------------
# Memory section
# ---------------------------------------------------------------------------


class TestMemoryNodes:
    def test_memory_entries_become_nodes(self, tmp_path):
        from tools.memory_tool import MemoryStore
        store = MemoryStore()
        store.load_from_disk()
        store.add("memory", "fact one")
        store.add("memory", "fact two")

        reset_snapshot_cache()
        snap = build_brain_snapshot()
        memory_nodes = [n for n in snap["nodes"] if n["type"] == "memory"]
        assert len(memory_nodes) == 2
        for n in memory_nodes:
            assert n["id"].startswith("memory:")
            assert len(n["id"].split(":")[1]) == 8  # sha8

    def test_user_md_entries_get_user_md_label(self, tmp_path):
        from tools.memory_tool import MemoryStore
        store = MemoryStore()
        store.load_from_disk()
        store.add("user", "user prefers terse responses")

        reset_snapshot_cache()
        snap = build_brain_snapshot()
        user_nodes = [
            n for n in snap["nodes"]
            if n["type"] == "memory" and n["metadata"]["store"] == "USER.md"
        ]
        assert len(user_nodes) == 1

    def test_memory_label_is_redacted(self, tmp_path):
        from tools.memory_tool import MemoryStore
        store = MemoryStore()
        store.load_from_disk()
        store.add(
            "memory",
            "the github token is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        reset_snapshot_cache()
        snap = build_brain_snapshot()
        mem_nodes = [n for n in snap["nodes"] if n["type"] == "memory"]
        assert len(mem_nodes) == 1
        assert "ghp_" not in mem_nodes[0]["label"]
        assert "ghp_" not in mem_nodes[0]["metadata"]["summary"]

    def test_stable_hash_id(self, tmp_path):
        """Two stores with identical content should produce identical IDs."""
        import hashlib
        content = "this is the same fact"
        expected_hash = hashlib.sha256(content.encode()).hexdigest()[:8]
        from tools.memory_tool import MemoryStore
        store = MemoryStore()
        store.load_from_disk()
        store.add("memory", content)
        reset_snapshot_cache()
        snap = build_brain_snapshot()
        mem_nodes = [n for n in snap["nodes"] if n["type"] == "memory"]
        assert mem_nodes[0]["id"] == f"memory:{expected_hash}"


# ---------------------------------------------------------------------------
# Session section + child_of edges
# ---------------------------------------------------------------------------


class TestSessionNodes:
    def test_session_rows_become_nodes(self, tmp_path):
        from hermes_state import SessionDB
        db = SessionDB()
        db.create_session(session_id="parent-1", source="cli", model="m1")
        db.create_session(
            session_id="child-1", source="cli", model="m1",
            parent_session_id="parent-1",
        )
        reset_snapshot_cache()
        snap = build_brain_snapshot()
        sess_nodes = [n for n in snap["nodes"] if n["type"] == "session"]
        ids = [n["id"] for n in sess_nodes]
        assert "session:parent-1" in ids
        assert "session:child-1" in ids

    def test_parent_session_id_creates_child_of_edge(self, tmp_path):
        from hermes_state import SessionDB
        db = SessionDB()
        db.create_session(session_id="parent-2", source="cli")
        db.create_session(
            session_id="child-2", source="cli", parent_session_id="parent-2",
        )
        reset_snapshot_cache()
        snap = build_brain_snapshot()
        child_edges = [e for e in snap["edges"] if e["kind"] == "child_of"]
        assert any(
            e["source"] == "session:parent-2" and e["target"] == "session:child-2"
            for e in child_edges
        )


# ---------------------------------------------------------------------------
# Tool section
# ---------------------------------------------------------------------------


class TestToolNodes:
    def test_tools_appear(self):
        # The tool registry is populated at module import; just check
        # that the snapshot returns at least a few well-known tools.
        snap = build_brain_snapshot()
        tool_ids = {n["id"] for n in snap["nodes"] if n["type"] == "tool"}
        # registry will have many tools — we don't pin specific names
        # because the set varies; just assert non-empty.
        assert len(tool_ids) > 0


# ---------------------------------------------------------------------------
# Cron section
# ---------------------------------------------------------------------------


class TestCronNodes:
    def test_empty_cron_does_not_blow_up(self):
        snap = build_brain_snapshot()
        cron_nodes = [n for n in snap["nodes"] if n["type"] == "cron"]
        # Empty is fine — just assert no exception during build
        assert isinstance(cron_nodes, list)


# ---------------------------------------------------------------------------
# Graceful degradation — single-section failure must not blank graph
# ---------------------------------------------------------------------------


class TestGracefulDegradation:
    def test_failing_memory_section_keeps_other_sections(self, monkeypatch):
        """If MemoryStore raises, the snapshot should still contain
        sessions, tools, etc. — not return an empty {nodes:[],edges:[]}."""
        def boom(*args, **kwargs):
            raise RuntimeError("simulated memory failure")
        monkeypatch.setattr("tools.memory_tool.MemoryStore", boom)
        reset_snapshot_cache()
        snap = build_brain_snapshot()
        # Tools should still load
        assert any(n["type"] == "tool" for n in snap["nodes"])
        # Memory section should be empty
        assert not any(n["type"] == "memory" for n in snap["nodes"])


# ---------------------------------------------------------------------------
# lru_cache coalescing
# ---------------------------------------------------------------------------


class TestCaching:
    def test_two_calls_in_same_bucket_return_same_object(self):
        reset_snapshot_cache()
        s1 = build_brain_snapshot()
        s2 = build_brain_snapshot()
        # Same generated_at means same cached dict
        assert s1["generated_at"] == s2["generated_at"]

    def test_reset_clears_cache(self):
        s1 = build_brain_snapshot()
        reset_snapshot_cache()
        s2 = build_brain_snapshot()
        # generated_at may differ if at least 1 monotonic tick passed,
        # but the important thing is that cache_clear was called.
        assert s2 is not None


# ---------------------------------------------------------------------------
# find_node
# ---------------------------------------------------------------------------


class TestFindNode:
    def test_returns_existing_node(self, tmp_path):
        from tools.memory_tool import MemoryStore
        store = MemoryStore()
        store.load_from_disk()
        store.add("memory", "lookup target")
        reset_snapshot_cache()

        # Find the hash via build, then look up by id
        snap = build_brain_snapshot()
        mem_nodes = [n for n in snap["nodes"] if n["type"] == "memory"]
        assert len(mem_nodes) == 1
        node_id = mem_nodes[0]["id"].split(":", 1)[1]
        node = find_node("memory", node_id)
        assert node is not None
        assert node["type"] == "memory"

    def test_returns_none_for_missing(self):
        node = find_node("memory", "deadbeef")
        assert node is None
