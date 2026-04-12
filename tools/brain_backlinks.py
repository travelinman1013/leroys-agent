"""Brain backlink reverse-index — async reader-writer pattern.

Readers never block.  Rebuild runs in a background thread when vault
changes are detected via max-mtime check.  Staleness is bounded by one
request cycle (Amendment L §1.3).
"""

from __future__ import annotations

import asyncio
import os
import re
import logging
from typing import Any

from tools.brain_cache import walk_max_mtime
from tools.brain_sources import TEXT_EXTENSIONS, MAX_DOC_SIZE

logger = logging.getLogger(__name__)

# Bounded regex for [[WikiLink]] extraction (Amendment F).
# Max 200 chars per link, no nested brackets.
_WIKILINK_RE = re.compile(
    r"\[\[([^\[\]|#]{1,200})(?:\|[^\[\]]{0,200})?\]\]"
)
# Standard markdown links: [text](path)
_MDLINK_RE = re.compile(
    r"\[(?:[^\]]{0,200})\]\(([^)]{1,200})\)"
)


class BacklinkIndex:
    """Per-source backlink reverse-index with async reader-writer semantics.

    - ``get_backlinks()`` returns immediately from the last-known-good index.
    - If the vault has changed (mtime check), a background rebuild is spawned.
    - Rebuild swaps the dict atomically when done; readers see the new index
      on the next call.
    """

    def __init__(self, source_root: str):
        self.root = source_root
        self._index: dict[str, frozenset[str]] = {}
        self._built_at_mtime: float = 0.0
        self._rebuild_in_flight: bool = False

    async def get_backlinks(self, doc_path: str) -> list[str]:
        """Return sorted list of paths that link to *doc_path*."""
        current_mtime = walk_max_mtime(self.root)
        if current_mtime > self._built_at_mtime and not self._rebuild_in_flight:
            if not self._index:
                # First build: synchronous so the caller gets real data.
                await self._rebuild_async(current_mtime)
            else:
                # Subsequent rebuilds: background (readers never block).
                asyncio.create_task(self._rebuild_async(current_mtime))
        return sorted(self._index.get(doc_path, frozenset()))

    @property
    def size(self) -> int:
        """Number of docs that have incoming backlinks."""
        return len(self._index)

    async def _rebuild_async(self, target_mtime: float) -> None:
        self._rebuild_in_flight = True
        try:
            new_index = await asyncio.to_thread(self._build_index_sync)
            self._index = new_index  # atomic dict swap
            self._built_at_mtime = target_mtime
            logger.info(
                "brain.backlink_index.rebuilt",
                extra={"root": self.root, "targets": len(new_index)},
            )
        except Exception:
            logger.exception(
                "brain.backlink_index.rebuild_failed",
                extra={"root": self.root},
            )
        finally:
            self._rebuild_in_flight = False

    def _build_index_sync(self) -> dict[str, frozenset[str]]:
        """O(N) walk: read every .md file, scan for links, build reverse dict."""
        forward: dict[str, set[str]] = {}  # source_path → set(target_paths)
        reverse: dict[str, set[str]] = {}  # target_path → set(source_paths)

        for dirpath, dirnames, filenames in os.walk(self.root, followlinks=False):
            dirnames[:] = [
                d for d in dirnames
                if d not in (".obsidian", ".git", ".trash", "node_modules", "__pycache__")
                and not d.startswith(".")
            ]
            for fname in filenames:
                _, ext = os.path.splitext(fname)
                if ext.lower() != ".md":
                    continue

                fpath = os.path.join(dirpath, fname)
                relpath = os.path.relpath(fpath, self.root)

                try:
                    st = os.stat(fpath)
                    if st.st_size > MAX_DOC_SIZE:
                        continue
                    with open(fpath, "r", encoding="utf-8") as f:
                        body = f.read()
                except (OSError, UnicodeDecodeError):
                    continue

                targets = set()

                # WikiLinks: [[Target]] or [[Target|alias]] or [[Target#heading]]
                for match in _WIKILINK_RE.finditer(body):
                    link = match.group(1).strip()
                    # Normalize: resolve relative to same directory, add .md if needed
                    target = _normalize_link(link, relpath)
                    if target:
                        targets.add(target)

                # Markdown links: [text](path.md) — only relative paths
                for match in _MDLINK_RE.finditer(body):
                    href = match.group(1).strip()
                    if href.startswith("http://") or href.startswith("https://"):
                        continue
                    if href.startswith("#"):
                        continue
                    target = _normalize_link(href, relpath)
                    if target:
                        targets.add(target)

                forward[relpath] = targets
                for t in targets:
                    reverse.setdefault(t, set()).add(relpath)

        return {k: frozenset(v) for k, v in reverse.items()}


# ── module-level registry (Amendment L §1.4) ──────────────────────────

_indices: dict[str, BacklinkIndex] = {}


def get_backlink_index(source_root: str) -> BacklinkIndex:
    """Return or create a BacklinkIndex for *source_root*."""
    if source_root not in _indices:
        _indices[source_root] = BacklinkIndex(source_root)
    return _indices[source_root]


def reset_backlink_indices_for_tests() -> None:
    """Drop all indices.  Tests only."""
    _indices.clear()


# ── helpers ───────────────────────────────────────────────────────────

def _normalize_link(link: str, from_relpath: str) -> str | None:
    """Normalize a link target relative to the linking file's directory.

    Returns a normalized relpath or None if the link is unparseable.
    """
    # Strip heading anchors.
    if "#" in link:
        link = link.split("#")[0]
    if not link:
        return None

    # Add .md extension if not present.
    if not os.path.splitext(link)[1]:
        link = link + ".md"

    # Resolve relative to the directory of the linking file.
    from_dir = os.path.dirname(from_relpath)
    joined = os.path.normpath(os.path.join(from_dir, link))

    # Reject traversal above root.
    if joined.startswith(".."):
        return None

    return joined
