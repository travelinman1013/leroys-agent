"""Shared mtime-scoped caching for brain content modules.

Used by brain_tree (tree cache) and brain_backlinks (reverse-index).
Rebuilds only when the filesystem tree under ``root`` has changed,
detected via max mtime across all files.
"""

from __future__ import annotations

import os
import logging
from typing import Callable, Generic, TypeVar

logger = logging.getLogger(__name__)
T = TypeVar("T")


def walk_max_mtime(root: str) -> float:
    """Return the most recent mtime under *root* (recursive scandir).

    Cheap: stat-only, no file reads.  <50ms for a 2000-doc vault on
    an M3 Ultra with SSD.
    """
    max_mt = 0.0
    try:
        for entry in os.scandir(root):
            name = entry.name
            if name.startswith(".") or name == "node_modules":
                continue
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if entry.is_dir(follow_symlinks=False):
                sub = walk_max_mtime(entry.path)
                if sub > max_mt:
                    max_mt = sub
            else:
                if st.st_mtime > max_mt:
                    max_mt = st.st_mtime
    except OSError:
        pass
    return max_mt


class MtimeScopedCache(Generic[T]):
    """Generic cache that rebuilds when the tree under *root* changes.

    Used by ``brain_tree.py`` (tree cache).  ``brain_backlinks.py`` uses
    a similar pattern but with an async reader-writer wrapper on top
    (see Amendment L 1.3 in the plan).
    """

    def __init__(self, root: str, rebuild_fn: Callable[[], T]):
        self.root = root
        self._rebuild_fn = rebuild_fn
        self._value: T | None = None
        self._built_at_mtime: float = 0.0

    def get(self) -> T:
        current = walk_max_mtime(self.root)
        if self._value is None or current > self._built_at_mtime:
            self._value = self._rebuild_fn()
            self._built_at_mtime = current
        return self._value

    def invalidate(self) -> None:
        self._value = None


# ── test helpers ──────────────────────────────────────────────────────

_caches: list[MtimeScopedCache] = []


def _register(cache: MtimeScopedCache) -> None:
    """Track a cache instance so reset_all_brain_caches can clear it."""
    _caches.append(cache)


def reset_all_brain_caches() -> None:
    """Drop all registered brain caches.  Tests only."""
    for c in _caches:
        c.invalidate()
