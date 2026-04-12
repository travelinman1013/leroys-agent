"""Brain content writer — atomic writes with approval gate + hash-based OCC.

Write flow:
1. Validate source + path via path jail
2. Check expected_hash (optimistic concurrency)
3. Write atomically (tempfile in target dir + os.replace)
4. Publish event + invalidate caches

The approval gate is wired at the handler level in dashboard_routes.py,
not in this module.  This module handles the actual file I/O once
approval has been granted.
"""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
from typing import Any

from tools.brain_sources import (
    validate_source_path,
    content_hash,
    load_doc,
)
from tools.brain_tree import invalidate_source
from tools.brain_search import reset_search_cache

logger = logging.getLogger(__name__)


class HashMismatch(Exception):
    """Raised when the expected content hash doesn't match current file."""

    def __init__(self, expected: str, actual: str):
        self.expected = expected
        self.actual = actual
        super().__init__(f"hash mismatch: expected {expected[:12]}..., got {actual[:12]}...")


def write_doc(
    source_id: str,
    relpath: str,
    content: str,
    expected_hash: str | None = None,
) -> dict[str, Any]:
    """Write content to a brain document atomically.

    Args:
        source_id: Source identifier (memories, vault, sessions).
        relpath: Relative path within the source root.
        content: New file content (UTF-8 text).
        expected_hash: If provided, the SHA-256 of the current content.
            Raises HashMismatch on mismatch (409 Conflict).

    Returns:
        Dict with keys: path, source, content_hash, size, written.
    """
    from tools.file_tools import validate_path_operation
    from hermes_cli.config import get_safe_roots, get_denied_paths

    # Validate and resolve path.
    abspath = validate_source_path(source_id, relpath)

    # Check write permission via path jail.
    ok, reason = validate_path_operation(
        abspath, "write", get_safe_roots(), get_denied_paths()
    )
    if not ok:
        raise PermissionError(reason)

    # Optimistic concurrency check (Amendment A row 12).
    if expected_hash is not None:
        if os.path.exists(abspath):
            with open(abspath, "r", encoding="utf-8") as f:
                current = f.read()
            actual_hash = content_hash(current)
            if actual_hash != expected_hash:
                raise HashMismatch(expected_hash, actual_hash)
        else:
            # New file — expected_hash should be empty string or hash of "".
            empty_hash = content_hash("")
            if expected_hash not in ("", empty_hash):
                raise HashMismatch(expected_hash, empty_hash)

    # Atomic write: temp file in the SAME directory to avoid cross-filesystem
    # rename failures (Amendment A row 7 — EXDEV).
    target_dir = os.path.dirname(abspath)
    os.makedirs(target_dir, exist_ok=True)

    new_hash = content_hash(content)
    encoded = content.encode("utf-8")

    fd, tmp_path = tempfile.mkstemp(dir=target_dir, prefix=".brain_write_")
    try:
        os.write(fd, encoded)
        os.close(fd)
        os.replace(tmp_path, abspath)
    except Exception:
        # Clean up temp file on failure.
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    # Invalidate caches after successful write.
    invalidate_source(source_id)
    reset_search_cache()

    logger.info(
        "brain.doc.written",
        extra={
            "source": source_id,
            "path": relpath,
            "size": len(encoded),
            "content_hash": new_hash,
        },
    )

    return {
        "path": relpath,
        "source": source_id,
        "content_hash": new_hash,
        "size": len(encoded),
        "written": True,
    }
