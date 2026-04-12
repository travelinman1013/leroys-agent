"""Brain content search — fuzzy substring with title-boost and per-source weighting.

2s LRU cache keyed on (query, source).  No external search library —
simple substring matching is fast enough at 500-2000 docs on an M3 Ultra.
"""

from __future__ import annotations

import os
import re
import time
import logging
from functools import lru_cache
from typing import Any

from tools.brain_sources import (
    resolve_source,
    TEXT_EXTENSIONS,
    sanitize_snippet,
    _parse_frontmatter,
    _redact_frontmatter,
    _read_text,
    MAX_DOC_SIZE,
)

logger = logging.getLogger(__name__)

# Score multipliers (Amendment L §1.5).
_TITLE_BOOST = 3.0
_HEADING_BOOST = 2.0
_BODY_BOOST = 1.0
SOURCE_WEIGHTS: dict[str, float] = {
    "memories": 1.5,
    "vault": 1.2,
    "sessions": 0.8,
}

# Max query length (Amendment A row 9).
MAX_QUERY_LEN = 200

# Snippet context chars on each side of match.
SNIPPET_CONTEXT = 40


def search(
    query: str,
    source: str = "*",
    limit: int = 50,
    *,
    _timeout: float = 2.0,
) -> tuple[list[dict[str, Any]], bool]:
    """Search brain content.

    Returns ``(results, partial)`` where *partial* is True if the search
    was cut short by timeout (Amendment A row 8).  Results are sorted by
    descending score.
    """
    if not query or len(query) > MAX_QUERY_LEN:
        raise ValueError(f"query must be 1-{MAX_QUERY_LEN} chars")

    bucket = int(time.time()) // 2  # 2s cache window
    return _cached_search(query, source, limit, bucket, _timeout)


@lru_cache(maxsize=64)
def _cached_search(
    query: str,
    source: str,
    limit: int,
    bucket: int,
    timeout: float,
) -> tuple[list[dict[str, Any]], bool]:
    sources = _resolve_sources(source)
    pattern = re.compile(re.escape(query), re.IGNORECASE)

    results: list[dict[str, Any]] = []
    partial = False
    deadline = time.monotonic() + timeout

    for src_id, root in sources:
        sw = SOURCE_WEIGHTS.get(src_id, 1.0)
        try:
            hits, timed_out = _scan_source(root, src_id, pattern, query, sw, deadline)
            results.extend(hits)
            if timed_out:
                partial = True
                break
        except Exception:
            logger.exception("brain.search_source_error", extra={"source": src_id})

    results.sort(key=lambda h: h["score"], reverse=True)
    return results[:limit], partial


def reset_search_cache() -> None:
    """Clear the search LRU cache.  Tests only."""
    _cached_search.cache_clear()


# ── internal ──────────────────────────────────────────────────────────

def _resolve_sources(source: str) -> list[tuple[str, str]]:
    if source == "*":
        from tools.brain_sources import list_sources
        return [(s["id"], s["root_path"]) for s in list_sources()]
    src = resolve_source(source)
    return [(src.id, src.root)]


def _scan_source(
    root: str,
    source_id: str,
    pattern: re.Pattern,
    raw_query: str,
    source_weight: float,
    deadline: float,
) -> tuple[list[dict[str, Any]], bool]:
    """Walk a source root and score each text file."""
    results: list[dict[str, Any]] = []
    timed_out = False

    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        # Prune excluded dirs in-place.
        dirnames[:] = [
            d for d in dirnames
            if d not in (".obsidian", ".git", ".trash", "node_modules", "__pycache__")
            and not d.startswith(".")
        ]

        for fname in filenames:
            if time.monotonic() > deadline:
                timed_out = True
                return results, timed_out

            _, ext = os.path.splitext(fname)
            if ext.lower() not in TEXT_EXTENSIONS:
                continue

            fpath = os.path.join(dirpath, fname)
            relpath = os.path.relpath(fpath, root)

            try:
                st = os.stat(fpath)
                if st.st_size > MAX_DOC_SIZE:
                    continue
                raw = _read_text(fpath)
            except (OSError, UnicodeDecodeError):
                continue

            body, fm = _parse_frontmatter(raw, fpath)
            fm = _redact_frontmatter(fm, fpath)
            title = _extract_title(fm, body, fname)

            score = _score(pattern, title, body, source_weight)
            if score <= 0:
                continue

            snippet = _build_snippet(body, pattern)

            results.append({
                "source": source_id,
                "path": relpath,
                "title": title,
                "snippet": snippet,
                "score": round(score, 3),
                "last_modified": st.st_mtime,
            })

    return results, timed_out


def _extract_title(fm: dict, body: str, filename: str) -> str:
    """Title from frontmatter > first heading > filename."""
    if fm.get("title"):
        return str(fm["title"])
    match = re.match(r"^#\s+(.+)", body)
    if match:
        return match.group(1).strip()
    name, _ = os.path.splitext(filename)
    return name


def _score(
    pattern: re.Pattern,
    title: str,
    body: str,
    source_weight: float,
) -> float:
    """Compute relevance score."""
    score = 0.0
    if pattern.search(title):
        score += _TITLE_BOOST
    # Check headings in body.
    for line in body.split("\n"):
        if line.startswith("#") and pattern.search(line):
            score += _HEADING_BOOST
            break
    if pattern.search(body):
        score += _BODY_BOOST
    return score * source_weight


def _build_snippet(body: str, pattern: re.Pattern) -> str:
    """Extract a context snippet around the first match."""
    match = pattern.search(body)
    if not match:
        # Title-only match; return first 80 chars of body.
        return sanitize_snippet(body[:80])

    start = max(0, match.start() - SNIPPET_CONTEXT)
    end = min(len(body), match.end() + SNIPPET_CONTEXT)
    raw_snip = body[start:end]
    if start > 0:
        raw_snip = "..." + raw_snip
    if end < len(body):
        raw_snip = raw_snip + "..."
    return sanitize_snippet(raw_snip)
