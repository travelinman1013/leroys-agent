"""Brain content source resolver — maps source IDs to filesystem roots.

Public API (import-lint enforced in tests):
    resolve_source, list_sources, validate_source_path,
    SourceRoot, load_doc, SENSITIVE_KEY_RE
"""

from __future__ import annotations

import html
import hashlib
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

import yaml

from tools.file_tools import validate_path_operation
from hermes_cli.config import get_safe_roots, get_denied_paths

logger = logging.getLogger(__name__)

# Keys whose values are redacted before any API response (Amendment B §4).
SENSITIVE_KEY_RE = re.compile(
    r"(?i)(secret|token|key|password|api[_\-]?key|credential)"
)

# Extensions treated as readable text content.
TEXT_EXTENSIONS = frozenset({".md", ".json", ".txt", ".yaml", ".yml", ".csv"})

# Max file size for inline reading (1 MB).  Larger files get HTTP 413.
MAX_DOC_SIZE = 1_048_576


@dataclass(frozen=True)
class SourceRoot:
    """A named brain content source."""

    id: str
    label: str
    root: str  # absolute, realpath-resolved


def _hermes_home() -> str:
    return os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))


def _resolve_vault_root() -> str:
    """Return the vault root, resolving the ~/brain symlink."""
    brain = os.path.expanduser("~/brain")
    return os.path.realpath(brain) if os.path.exists(brain) else brain


_SOURCE_DEFS: list[tuple[str, str, str]] | None = None


def _get_source_defs() -> list[tuple[str, str, str]]:
    """Lazy-init source definitions (id, label, root)."""
    global _SOURCE_DEFS
    if _SOURCE_DEFS is None:
        hh = _hermes_home()
        _SOURCE_DEFS = [
            ("memories", "Memories", os.path.join(hh, "memories")),
            ("sessions", "Sessions", os.path.join(hh, "sessions")),
            ("vault", "Vault", _resolve_vault_root()),
        ]
    return _SOURCE_DEFS


def reset_source_defs_for_tests() -> None:
    """Clear cached source definitions.  Tests only."""
    global _SOURCE_DEFS
    _SOURCE_DEFS = None


def resolve_source(source_id: str) -> SourceRoot:
    """Map a source ID to its resolved root.  Raises ValueError if unknown."""
    for sid, label, root in _get_source_defs():
        if sid == source_id:
            return SourceRoot(id=sid, label=label, root=root)
    raise ValueError(f"unknown brain source: {source_id!r}")


def list_sources() -> list[dict[str, Any]]:
    """Return source metadata with file counts for ``GET /brain/sources``."""
    results = []
    for sid, label, root in _get_source_defs():
        count = _count_text_files(root)
        results.append({
            "id": sid,
            "label": label,
            "count": count,
            "root_path": root,
        })
    return results


def validate_source_path(source_id: str, relpath: str) -> str:
    """Canonicalize *relpath* against the source root and run path-jail checks.

    Returns the absolute path on success.
    Raises ``PermissionError`` on jail violation.
    Raises ``ValueError`` on traversal or unknown source.
    """
    src = resolve_source(source_id)
    # Reject obvious traversal before joining.
    if ".." in relpath.split(os.sep):
        raise ValueError(f"path traversal rejected: {relpath!r}")

    joined = os.path.normpath(os.path.join(src.root, relpath))
    real = os.path.realpath(joined)

    # Ensure the resolved path is still under the source root.
    real_root = os.path.realpath(src.root)
    if not real.startswith(real_root + os.sep) and real != real_root:
        raise ValueError(f"path escapes source root: {relpath!r}")

    # Run through the existing path jail.
    ok, reason = validate_path_operation(
        real, "read", get_safe_roots(), get_denied_paths()
    )
    if not ok:
        raise PermissionError(reason)

    return real


def load_doc(
    source_id: str,
    relpath: str,
) -> dict[str, Any]:
    """Read a single document and return its parsed content.

    Returns dict with keys: body, frontmatter, path, size, last_modified,
    content_hash.  Frontmatter values matching SENSITIVE_KEY_RE are redacted
    at parse boundary (Amendment M §2.1).
    """
    abspath = validate_source_path(source_id, relpath)

    st = os.stat(abspath)
    if st.st_size > MAX_DOC_SIZE:
        raise _FileTooLarge(abspath, st.st_size)
    if st.st_size == 0:
        return {
            "body": "",
            "frontmatter": {},
            "path": relpath,
            "size": 0,
            "last_modified": st.st_mtime,
            "content_hash": hashlib.sha256(b"").hexdigest(),
        }

    try:
        raw = _read_text(abspath)
    except UnicodeDecodeError:
        raise _BinaryFile(abspath)

    body, fm = _parse_frontmatter(raw, abspath)
    fm = _redact_frontmatter(fm, abspath)

    return {
        "body": body,
        "frontmatter": fm,
        "path": relpath,
        "size": st.st_size,
        "last_modified": st.st_mtime,
        "content_hash": hashlib.sha256(raw.encode()).hexdigest(),
    }


# ── internal helpers ──────────────────────────────────────────────────

def _count_text_files(root: str) -> int:
    """Count text files under *root* using scandir (Amendment O §4.1)."""
    count = 0
    try:
        for entry in os.scandir(root):
            name = entry.name
            if name.startswith(".") or name in ("node_modules", "__pycache__"):
                continue
            if entry.is_dir(follow_symlinks=False):
                count += _count_text_files(entry.path)
            elif entry.is_file(follow_symlinks=False):
                _, ext = os.path.splitext(name)
                if ext.lower() in TEXT_EXTENSIONS:
                    count += 1
    except (OSError, PermissionError):
        pass
    return count


def _read_text(path: str) -> str:
    """Read a file as UTF-8 text.  Raises UnicodeDecodeError on binary."""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _parse_frontmatter(
    raw: str, path: str
) -> tuple[str, dict[str, Any]]:
    """Parse YAML frontmatter from markdown content.

    Returns (body, frontmatter_dict).  On any parse failure, returns
    the full text as body with empty frontmatter and logs a warning
    (Amendment A row 3).
    """
    if not raw.startswith("---"):
        return raw, {}
    # Find closing ---
    end = raw.find("\n---", 3)
    if end == -1:
        return raw, {}
    yaml_block = raw[3:end].strip()
    body = raw[end + 4:].lstrip("\n")
    try:
        fm = yaml.safe_load(yaml_block)
        if not isinstance(fm, dict):
            return raw, {}
        return body, fm
    except yaml.YAMLError as exc:
        logger.warning(
            "brain.frontmatter_parse_error",
            extra={"path": path, "error": str(exc)},
        )
        return raw, {}


def _redact_frontmatter(
    fm: dict[str, Any], path: str
) -> dict[str, Any]:
    """Replace values for sensitive-looking keys with [REDACTED].

    Amendment B §4 + Amendment M §2.1: redaction happens at parse boundary,
    before any caching or indexing.
    """
    redacted = {}
    any_redacted = False
    for k, v in fm.items():
        if SENSITIVE_KEY_RE.search(k):
            redacted[k] = "[REDACTED]"
            any_redacted = True
        elif isinstance(v, dict):
            redacted[k] = _redact_frontmatter(v, path)
        else:
            redacted[k] = v
    if any_redacted:
        logger.warning(
            "brain.frontmatter_redacted",
            extra={"path": path, "keys": [k for k in fm if SENSITIVE_KEY_RE.search(k)]},
        )
    return redacted


def content_hash(text: str) -> str:
    """SHA-256 hex digest of UTF-8 encoded text."""
    return hashlib.sha256(text.encode()).hexdigest()


def strip_markdown_for_snippet(text: str) -> str:
    """Minimal markdown stripping for search snippets (Amendment B §2)."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # [text](url) → text
    text = re.sub(r"\*\*([^*]*)\*\*", r"\1", text)  # **bold** → bold
    text = re.sub(r"`([^`]*)`", r"\1", text)  # `code` → code
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)  # # heading → heading
    return text


def sanitize_snippet(text: str) -> str:
    """HTML-escape a snippet for safe embedding (Amendment B §2)."""
    stripped = strip_markdown_for_snippet(text)
    return html.escape(stripped, quote=False)


# ── custom exceptions ─────────────────────────────────────────────────

class _FileTooLarge(Exception):
    def __init__(self, path: str, size: int):
        self.path = path
        self.size = size
        super().__init__(f"file too large: {path} ({size} bytes)")


class _BinaryFile(Exception):
    def __init__(self, path: str):
        self.path = path
        super().__init__(f"binary file: {path}")


# Re-export for handler use
FileTooLarge = _FileTooLarge
BinaryFile = _BinaryFile
