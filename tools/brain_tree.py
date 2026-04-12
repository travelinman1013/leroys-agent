"""Brain content tree walker — hierarchical directory listing per source.

Caches per-source tree via MtimeScopedCache; invalidated automatically
when the filesystem changes and surgically via ``invalidate_source()``.
"""

from __future__ import annotations

import os
import logging
from typing import Any

from tools.brain_sources import (
    resolve_source,
    validate_source_path,
    TEXT_EXTENSIONS,
)
from tools.brain_cache import MtimeScopedCache, _register

logger = logging.getLogger(__name__)

# Module-level caches keyed on source_id.
_tree_caches: dict[str, MtimeScopedCache[dict[str, Any]]] = {}


def build_tree(source_id: str, subpath: str = "") -> dict[str, Any]:
    """Return a hierarchical tree for *source_id*, optionally scoped to *subpath*.

    Each node: ``{name, type, path, children?, count?, last_modified, permission?}``.
    Files only included if their extension is in TEXT_EXTENSIONS.
    Excludes ``.obsidian``, ``.git``, ``.trash``, ``node_modules`` dirs.
    """
    src = resolve_source(source_id)
    root = src.root

    # Get or create the cached full tree for this source.
    cache = _get_cache(source_id, root)
    full_tree = cache.get()

    if not subpath:
        return full_tree

    # Navigate to the requested subpath.
    parts = [p for p in subpath.split("/") if p]
    node = full_tree
    for part in parts:
        children = node.get("children", [])
        found = None
        for child in children:
            if child["name"] == part:
                found = child
                break
        if found is None:
            return {"name": part, "type": "dir", "path": subpath, "children": [], "count": 0}
        node = found

    return node


def invalidate_source(source_id: str) -> None:
    """Surgically invalidate the tree cache for one source after a write."""
    if source_id in _tree_caches:
        _tree_caches[source_id].invalidate()


def reset_tree_caches_for_tests() -> None:
    """Drop all tree caches.  Tests only."""
    _tree_caches.clear()


# ── internal ──────────────────────────────────────────────────────────

_EXCLUDED_DIRS = frozenset({".obsidian", ".git", ".trash", "node_modules", "__pycache__"})


def _get_cache(source_id: str, root: str) -> MtimeScopedCache[dict[str, Any]]:
    if source_id not in _tree_caches:
        cache: MtimeScopedCache[dict[str, Any]] = MtimeScopedCache(
            root, lambda: _walk_tree(root, "")
        )
        _tree_caches[source_id] = cache
        _register(cache)
    return _tree_caches[source_id]


def _walk_tree(root: str, relpath: str) -> dict[str, Any]:
    """Recursively walk *root/relpath* and build the tree dict.

    Amendment A: follows ``os.walk(followlinks=False)`` to avoid symlink
    cycles.  Permission denied on subdirs → marked with ``permission: "denied"``.
    """
    abspath = os.path.join(root, relpath) if relpath else root
    name = os.path.basename(abspath) or os.path.basename(root)

    node: dict[str, Any] = {
        "name": name,
        "type": "dir",
        "path": relpath,
        "children": [],
        "count": 0,
        "last_modified": 0.0,
    }

    try:
        entries = sorted(os.scandir(abspath), key=lambda e: (not e.is_dir(), e.name.lower()))
    except PermissionError:
        node["permission"] = "denied"
        logger.warning("brain.tree_permission_denied", extra={"path": abspath})
        return node
    except OSError as exc:
        logger.warning("brain.tree_os_error", extra={"path": abspath, "error": str(exc)})
        return node

    max_mtime = 0.0

    for entry in entries:
        ename = entry.name
        if ename.startswith(".") and ename in _EXCLUDED_DIRS:
            continue
        if ename in _EXCLUDED_DIRS:
            continue

        child_rel = os.path.join(relpath, ename) if relpath else ename

        try:
            st = entry.stat(follow_symlinks=False)
        except OSError:
            continue

        if entry.is_dir(follow_symlinks=False):
            child = _walk_tree(root, child_rel)
            node["children"].append(child)
            node["count"] += child["count"]
            if child["last_modified"] > max_mtime:
                max_mtime = child["last_modified"]
        elif entry.is_file(follow_symlinks=False):
            _, ext = os.path.splitext(ename)
            ext_lower = ext.lower()
            is_text = ext_lower in TEXT_EXTENSIONS
            child_node: dict[str, Any] = {
                "name": ename,
                "type": "file" if is_text else "binary",
                "path": child_rel,
                "last_modified": st.st_mtime,
                "size": st.st_size,
            }
            node["children"].append(child_node)
            if is_text:
                node["count"] += 1
            if st.st_mtime > max_mtime:
                max_mtime = st.st_mtime

    node["last_modified"] = max_mtime
    return node
