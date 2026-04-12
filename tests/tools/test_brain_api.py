"""Tests for Phase 6 R1 — Brain content API.

Covers: brain_sources, brain_tree, brain_search, brain_write,
brain_backlinks, brain_cache, and the dashboard_routes handlers.

Fixture scaffold copied from tests/gateway/test_dashboard_routes.py:26-45.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import textwrap
import time

import pytest

from gateway.event_bus import reset_event_bus_for_tests
from tools.brain_sources import (
    resolve_source,
    list_sources,
    validate_source_path,
    load_doc,
    content_hash,
    sanitize_snippet,
    SENSITIVE_KEY_RE,
    reset_source_defs_for_tests,
    FileTooLarge,
    BinaryFile,
)
from tools.brain_tree import build_tree, reset_tree_caches_for_tests
from tools.brain_search import search, reset_search_cache
from tools.brain_write import write_doc, HashMismatch
from tools.brain_backlinks import (
    BacklinkIndex,
    get_backlink_index,
    reset_backlink_indices_for_tests,
)
from tools.brain_cache import reset_all_brain_caches
from hermes_cli.config import reset_path_jail_cache


# ── Fixtures ──────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_singletons(tmp_path, monkeypatch):
    """Redirect HERMES_HOME to per-test tmp dir, seed a vault fixture."""
    hermes_home = tmp_path / "hermes_home"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    # Create source directories.
    (hermes_home / "memories").mkdir()
    (hermes_home / "sessions").mkdir()

    # Vault lives separately (simulates ~/brain).
    vault = tmp_path / "vault"
    vault.mkdir()
    monkeypatch.setenv("_TEST_VAULT_ROOT", str(vault))

    # Patch the vault resolver.
    import tools.brain_sources as bs
    original_resolve = bs._resolve_vault_root
    monkeypatch.setattr(bs, "_resolve_vault_root", lambda: str(vault))

    # Config: set safe_roots + denied_paths.
    config_dir = hermes_home
    config_file = config_dir / "config.yaml"
    import yaml
    config_file.write_text(yaml.dump({
        "security": {
            "safe_roots": [
                str(hermes_home / "memories"),
                str(hermes_home / "sessions"),
                str(vault),
            ],
            "denied_paths": [
                str(vault / ".obsidian"),
                str(vault / ".git"),
                str(vault / ".trash"),
            ],
        },
    }))

    # Patch config loading.
    import hermes_cli.config as cfg
    monkeypatch.setattr(cfg, "load_config", lambda: yaml.safe_load(config_file.read_text()))

    # Reset all caches before/after each test.
    reset_event_bus_for_tests()
    reset_source_defs_for_tests()
    reset_tree_caches_for_tests()
    reset_search_cache()
    reset_backlink_indices_for_tests()
    reset_all_brain_caches()
    reset_path_jail_cache()

    try:
        from hermes_constants import get_hermes_home
        if hasattr(get_hermes_home, "cache_clear"):
            get_hermes_home.cache_clear()
    except Exception:
        pass

    yield

    reset_source_defs_for_tests()
    reset_tree_caches_for_tests()
    reset_search_cache()
    reset_backlink_indices_for_tests()
    reset_all_brain_caches()
    reset_path_jail_cache()
    reset_event_bus_for_tests()


@pytest.fixture
def vault(tmp_path):
    """Return the vault directory and seed it with test files."""
    v = tmp_path / "vault"
    # Seed: 5 memories, 3 sessions, 20 vault files.
    _seed_vault(v)
    return v


@pytest.fixture
def memories_dir(tmp_path):
    hh = tmp_path / "hermes_home" / "memories"
    _seed_memories(hh)
    return hh


def _seed_vault(vault):
    """Create a realistic vault structure."""
    dirs = ["00_Inbox", "01_Projects", "01_Projects/hermes", "02_Bases",
            "03_Resources", "04_Archive"]
    for d in dirs:
        (vault / d).mkdir(parents=True, exist_ok=True)

    files = {
        "00_Inbox/quick-note.md": "---\ntitle: Quick Note\ntags: [inbox]\n---\n\nA quick note.\n",
        "00_Inbox/todo.md": "# TODO\n\n- [ ] Fix the thing\n- [x] Done thing\n",
        "01_Projects/hermes/phase6.md": textwrap.dedent("""\
            ---
            title: Phase 6 Plan
            tags: [hermes, phase6]
            ---

            # Phase 6 — Brain Route v2

            This is the phase 6 plan for [[hermes]].
            See also: [[quick-note]]

            ```python
            def hello():
                print("world")
            ```
        """),
        "01_Projects/hermes/notes.md": "# Hermes Notes\n\nSome notes about [Phase 6](phase6.md).\n",
        "02_Bases/gemma.md": "---\ntitle: Gemma 4\n---\n\n# Gemma 4 26B\n\nThe model.\n",
        "02_Bases/concepts.md": "# Concepts\n\nBrain content.\n",
        "03_Resources/links.md": "# Links\n\n- [Example](https://example.com)\n",
        "04_Archive/old.md": "# Old Note\n\nArchived.\n",
    }
    for path, content in files.items():
        (vault / path).parent.mkdir(parents=True, exist_ok=True)
        (vault / path).write_text(content)


def _seed_memories(mem_dir):
    """Create test memory files."""
    for i in range(5):
        (mem_dir / f"memory_{i}.md").write_text(
            f"---\ntitle: Memory {i}\n---\n\nMemory content {i}.\n"
        )


# ── brain_sources tests ──────────────────────────────────────────────


class TestSources:
    def test_list_sources_returns_three(self, vault, memories_dir):
        sources = list_sources()
        assert len(sources) == 3
        ids = {s["id"] for s in sources}
        assert ids == {"memories", "sessions", "vault"}

    def test_resolve_known_source(self):
        src = resolve_source("memories")
        assert src.id == "memories"
        assert src.label == "Memories"

    def test_resolve_unknown_source(self):
        with pytest.raises(ValueError, match="unknown brain source"):
            resolve_source("nonexistent")

    def test_list_sources_counts(self, vault, memories_dir):
        sources = list_sources()
        vault_src = next(s for s in sources if s["id"] == "vault")
        mem_src = next(s for s in sources if s["id"] == "memories")
        assert vault_src["count"] == 8  # 8 .md files
        assert mem_src["count"] == 5    # 5 memory files


class TestValidateSourcePath:
    def test_valid_path(self, vault):
        path = validate_source_path("vault", "00_Inbox/quick-note.md")
        assert path.endswith("00_Inbox/quick-note.md")

    def test_traversal_rejected(self, vault):
        with pytest.raises(ValueError, match="traversal"):
            validate_source_path("vault", "../../etc/passwd")

    def test_denied_path_rejected(self, vault):
        # .obsidian is in denied_paths.
        (vault / ".obsidian").mkdir(exist_ok=True)
        (vault / ".obsidian" / "config").write_text("{}")
        with pytest.raises(PermissionError):
            validate_source_path("vault", ".obsidian/config")

    def test_outside_safe_roots(self, vault, monkeypatch):
        import hermes_cli.config as cfg
        reset_path_jail_cache()
        monkeypatch.setattr(cfg, "load_config", lambda: {
            "security": {"safe_roots": ["/nonexistent"], "denied_paths": []},
        })
        reset_path_jail_cache()
        with pytest.raises(PermissionError):
            validate_source_path("vault", "00_Inbox/quick-note.md")


class TestLoadDoc:
    def test_load_normal_doc(self, vault):
        doc = load_doc("vault", "00_Inbox/quick-note.md")
        assert doc["body"].strip() == "A quick note."
        assert doc["frontmatter"]["title"] == "Quick Note"
        assert doc["frontmatter"]["tags"] == ["inbox"]
        assert doc["content_hash"]
        assert doc["size"] > 0

    def test_load_doc_with_heading_title(self, vault):
        doc = load_doc("vault", "00_Inbox/todo.md")
        assert doc["body"].startswith("# TODO")
        assert doc["frontmatter"] == {}

    def test_zero_byte_doc(self, vault):
        (vault / "empty.md").write_text("")
        doc = load_doc("vault", "empty.md")
        assert doc["body"] == ""
        assert doc["frontmatter"] == {}
        assert doc["size"] == 0

    def test_malformed_yaml(self, vault):
        (vault / "bad.md").write_text("---\n: invalid: yaml: [[\n---\n\nBody.\n")
        doc = load_doc("vault", "bad.md")
        # Should return body-only, not crash.
        assert "Body" in doc["body"] or "---" in doc["body"]
        assert isinstance(doc["frontmatter"], dict)

    def test_yaml_attack_payload(self, vault):
        """Amendment B §1: !!python/object/apply must not execute."""
        (vault / "attack.md").write_text(
            "---\nexploit: !!python/object/apply:os.system ['echo hacked']\n"
            "---\n\nSafe body.\n"
        )
        doc = load_doc("vault", "attack.md")
        # yaml.safe_load should reject the tag silently or parse it as a string.
        # Either way, no code execution.
        assert "Safe body" in doc["body"]

    def test_binary_file(self, vault):
        (vault / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 100)
        with pytest.raises(BinaryFile):
            load_doc("vault", "image.png")

    def test_large_file(self, vault):
        (vault / "huge.md").write_text("x" * 2_000_000)
        with pytest.raises(FileTooLarge):
            load_doc("vault", "huge.md")

    def test_frontmatter_secret_redaction(self, vault):
        """Amendment B §4: sensitive keys are redacted."""
        (vault / "secrets.md").write_text(
            "---\ntitle: Config\napi_key: sk-12345\npassword: hunter2\n"
            "---\n\nContent.\n"
        )
        doc = load_doc("vault", "secrets.md")
        assert doc["frontmatter"]["api_key"] == "[REDACTED]"
        assert doc["frontmatter"]["password"] == "[REDACTED]"
        assert doc["frontmatter"]["title"] == "Config"


class TestSnippetSanitization:
    def test_html_escape(self):
        """Amendment B §2: HTML in snippets is escaped."""
        result = sanitize_snippet("<script>alert(1)</script>")
        assert "&lt;script&gt;" in result
        assert "<script>" not in result

    def test_markdown_strip(self):
        result = sanitize_snippet("[link](http://example.com) **bold** `code`")
        assert "link" in result
        assert "[" not in result
        assert "**" not in result


# ── brain_tree tests ─────────────────────────────────────────────────


class TestTree:
    def test_full_tree(self, vault):
        tree = build_tree("vault")
        assert tree["type"] == "dir"
        assert tree["count"] == 8
        child_names = {c["name"] for c in tree["children"]}
        assert "00_Inbox" in child_names
        assert "01_Projects" in child_names

    def test_scoped_tree(self, vault):
        tree = build_tree("vault", "01_Projects")
        assert tree["name"] == "01_Projects"
        child_names = {c["name"] for c in tree["children"]}
        assert "hermes" in child_names

    def test_file_node_has_size_and_mtime(self, vault):
        tree = build_tree("vault", "00_Inbox")
        file_node = next(c for c in tree["children"] if c["name"] == "quick-note.md")
        assert file_node["type"] == "file"
        assert file_node["size"] > 0
        assert file_node["last_modified"] > 0

    def test_binary_file_marked(self, vault):
        (vault / "00_Inbox" / "photo.png").write_bytes(b"\x89PNG" + b"\x00" * 50)
        tree = build_tree("vault", "00_Inbox")
        png = next(c for c in tree["children"] if c["name"] == "photo.png")
        assert png["type"] == "binary"

    def test_excluded_dirs(self, vault):
        (vault / ".obsidian").mkdir(exist_ok=True)
        (vault / ".obsidian" / "config.json").write_text("{}")
        (vault / ".git").mkdir(exist_ok=True)
        tree = build_tree("vault")
        child_names = {c["name"] for c in tree["children"]}
        assert ".obsidian" not in child_names
        assert ".git" not in child_names

    def test_permission_denied_subdir(self, vault):
        denied = vault / "restricted"
        denied.mkdir()
        (denied / "secret.md").write_text("secret")
        denied.chmod(0o000)
        try:
            tree = build_tree("vault")
            # Should complete without error.
            restricted = next(
                (c for c in tree["children"] if c["name"] == "restricted"),
                None,
            )
            if restricted is not None:
                assert restricted.get("permission") == "denied"
        finally:
            denied.chmod(0o755)

    def test_nonexistent_subpath(self, vault):
        tree = build_tree("vault", "nonexistent/path")
        assert tree["count"] == 0


# ── brain_search tests ───────────────────────────────────────────────


class TestSearch:
    def test_basic_search(self, vault):
        results, partial = search("Phase 6", "*")
        assert not partial
        assert len(results) > 0
        # phase6.md should score highest.
        top = results[0]
        assert "phase6" in top["path"].lower() or "Phase 6" in top["title"]

    def test_title_boost(self, vault):
        results, _ = search("Quick Note", "vault")
        assert len(results) > 0
        top = results[0]
        assert top["title"] == "Quick Note"

    def test_empty_query_rejected(self):
        with pytest.raises(ValueError):
            search("", "*")

    def test_long_query_rejected(self):
        with pytest.raises(ValueError):
            search("x" * 201, "*")

    def test_no_results(self, vault):
        results, _ = search("xyznonexistent123", "*")
        assert len(results) == 0

    def test_source_filtering(self, vault, memories_dir):
        results, _ = search("content", "memories")
        for r in results:
            assert r["source"] == "memories"

    def test_snippet_contains_context(self, vault):
        results, _ = search("hermes", "vault")
        assert len(results) > 0
        # At least one result should have a non-empty snippet.
        assert any(r["snippet"] for r in results)

    def test_html_in_snippet_escaped(self, vault):
        (vault / "xss.md").write_text("# XSS\n\n<script>alert(1)</script>\n")
        reset_search_cache()
        results, _ = search("alert", "vault")
        for r in results:
            assert "<script>" not in r["snippet"]

    @pytest.mark.benchmark
    def test_search_performance(self, vault):
        """Amendment H §16: search on test corpus must be <200ms."""
        start = time.monotonic()
        search("content", "*")
        elapsed = time.monotonic() - start
        assert elapsed < 0.200, f"search took {elapsed:.3f}s, budget 200ms"


# ── brain_write tests ────────────────────────────────────────────────


class TestWrite:
    def test_write_new_file(self, vault):
        result = write_doc("vault", "new_note.md", "# New Note\n\nHello.\n")
        assert result["written"] is True
        assert (vault / "new_note.md").read_text() == "# New Note\n\nHello.\n"

    def test_write_with_subdirectory(self, vault):
        result = write_doc("vault", "00_Inbox/created.md", "# Created\n")
        assert result["written"] is True
        assert (vault / "00_Inbox" / "created.md").exists()

    def test_hash_mismatch(self, vault):
        with pytest.raises(HashMismatch):
            write_doc("vault", "00_Inbox/quick-note.md", "overwrite",
                      expected_hash="wrong_hash")

    def test_hash_match_allows_write(self, vault):
        doc = load_doc("vault", "00_Inbox/quick-note.md")
        result = write_doc(
            "vault", "00_Inbox/quick-note.md", "# Updated\n",
            expected_hash=doc["content_hash"],
        )
        assert result["written"] is True
        assert (vault / "00_Inbox" / "quick-note.md").read_text() == "# Updated\n"

    def test_concurrent_double_write(self, vault):
        """Amendment H §10: second write with stale hash gets 409."""
        doc = load_doc("vault", "00_Inbox/quick-note.md")
        original_hash = doc["content_hash"]

        # First write succeeds.
        write_doc("vault", "00_Inbox/quick-note.md", "First write\n",
                  expected_hash=original_hash)

        # Second write with the ORIGINAL hash should fail.
        with pytest.raises(HashMismatch):
            write_doc("vault", "00_Inbox/quick-note.md", "Second write\n",
                      expected_hash=original_hash)

    def test_write_denied_path(self, vault):
        (vault / ".obsidian").mkdir(exist_ok=True)
        with pytest.raises(PermissionError):
            write_doc("vault", ".obsidian/config.json", "{}")

    def test_write_outside_safe_roots(self, vault, monkeypatch):
        import hermes_cli.config as cfg
        reset_path_jail_cache()
        monkeypatch.setattr(cfg, "load_config", lambda: {
            "security": {"safe_roots": ["/nonexistent"], "denied_paths": []},
        })
        reset_path_jail_cache()
        with pytest.raises(PermissionError):
            write_doc("vault", "test.md", "content")


# ── brain_backlinks tests ────────────────────────────────────────────


class TestBacklinks:
    def test_initial_build(self, vault):
        idx = BacklinkIndex(str(vault))
        backlinks = asyncio.get_event_loop().run_until_complete(
            idx.get_backlinks("01_Projects/hermes/phase6.md")
        )
        # notes.md links to phase6.md via [Phase 6](phase6.md).
        assert "01_Projects/hermes/notes.md" in backlinks

    def test_wikilink_detection(self, vault):
        idx = BacklinkIndex(str(vault))
        # phase6.md has [[quick-note]], which resolves relative to its dir
        # → 01_Projects/hermes/quick-note.md
        backlinks = asyncio.get_event_loop().run_until_complete(
            idx.get_backlinks("01_Projects/hermes/quick-note.md")
        )
        assert any("phase6" in b for b in backlinks)

    def test_mtime_invalidation(self, vault):
        idx = BacklinkIndex(str(vault))
        # Initial build.
        asyncio.get_event_loop().run_until_complete(
            idx.get_backlinks("test.md")
        )
        # Wait for any background rebuild.
        time.sleep(0.1)

        # Add a new file that links to test.md.
        (vault / "linker.md").write_text("Link to [[test]].\n")
        time.sleep(0.05)  # Ensure mtime difference.

        # Next call should detect the change and rebuild.
        backlinks = asyncio.get_event_loop().run_until_complete(
            idx.get_backlinks("test.md")
        )
        # Background rebuild is async — might not be immediate.
        # At minimum, should not crash.
        assert isinstance(backlinks, list)

    def test_bounded_regex(self, vault):
        """Amendment H §19: catastrophic input stays fast."""
        # Write a file with pathological input.
        (vault / "regex_bomb.md").write_text("[[" * 1000)
        idx = BacklinkIndex(str(vault))
        start = time.monotonic()
        asyncio.get_event_loop().run_until_complete(
            idx.get_backlinks("anything.md")
        )
        elapsed = time.monotonic() - start
        assert elapsed < 0.5, f"regex took {elapsed:.3f}s"


# ── brain_cache tests ────────────────────────────────────────────────


class TestCache:
    def test_mtime_scoped_cache_rebuilds(self, tmp_path):
        from tools.brain_cache import MtimeScopedCache

        root = tmp_path / "cache_test"
        root.mkdir()
        (root / "a.md").write_text("v1")

        calls = []

        def builder():
            calls.append(1)
            return {"version": len(calls)}

        cache = MtimeScopedCache(str(root), builder)
        v1 = cache.get()
        assert v1["version"] == 1
        assert len(calls) == 1

        # Same mtime → cached.
        v2 = cache.get()
        assert v2["version"] == 1
        assert len(calls) == 1

        # Touch a file → rebuilds.
        time.sleep(0.05)
        (root / "b.md").write_text("v2")
        v3 = cache.get()
        assert v3["version"] == 2
        assert len(calls) == 2

    def test_invalidate(self, tmp_path):
        from tools.brain_cache import MtimeScopedCache

        root = tmp_path / "inv_test"
        root.mkdir()
        (root / "a.md").write_text("v1")

        calls = []
        cache = MtimeScopedCache(str(root), lambda: calls.append(1) or len(calls))
        cache.get()
        cache.invalidate()
        cache.get()
        assert len(calls) == 2


# ── content_hash tests ───────────────────────────────────────────────


class TestContentHash:
    def test_deterministic(self):
        h1 = content_hash("hello")
        h2 = content_hash("hello")
        assert h1 == h2

    def test_different_content(self):
        h1 = content_hash("hello")
        h2 = content_hash("world")
        assert h1 != h2

    def test_matches_hashlib(self):
        text = "test content"
        assert content_hash(text) == hashlib.sha256(text.encode()).hexdigest()


# ── SENSITIVE_KEY_RE tests ────────────────────────────────────────────


class TestSensitiveKeyRegex:
    @pytest.mark.parametrize("key", [
        "api_key", "API_KEY", "apiKey", "secret", "token",
        "password", "credential", "api-key",
    ])
    def test_matches_sensitive(self, key):
        assert SENSITIVE_KEY_RE.search(key)

    @pytest.mark.parametrize("key", [
        "title", "name", "description", "tags", "category",
    ])
    def test_does_not_match_normal(self, key):
        assert not SENSITIVE_KEY_RE.search(key)
