"""
Secret + PII redaction for free-form strings.

This module is a neutral helper used by the dashboard backend (to scrub
session transcripts before they leave the gateway process) and by tool
emit-points that publish previews to the in-process event bus. It lives
in ``tools/`` rather than ``gateway/`` so consumers in either layer can
import it without creating a ``tools -> gateway`` dependency cycle.

Design notes
------------
- Patterns are applied in declaration order. Specific patterns (Discord
  webhooks, AWS keys) come BEFORE the generic ``[A-Z_]{3,}=...`` env-var
  pattern, otherwise the generic eats the structured matches.
- Match substitutions use a ``[REDACTED:<KIND>]`` marker so it's clear
  in the UI that something was scrubbed and what kind.
- ``redact_text`` is length-capped at 16 KB by default (truncate with a
  trailing ``…[truncated]`` marker) to bound memory pressure when a
  caller passes a huge blob.
- All regexes are pre-compiled at module import time.
- The PEM-block pattern uses ``re.DOTALL`` so it can span newlines.

This module deliberately does NOT redact dicts or lists — that's
``_redact_secrets`` in ``gateway/platforms/dashboard_routes.py`` which
operates on key-name heuristics. This module operates on free-form
text content.
"""

from __future__ import annotations

import re
from typing import List, Tuple

# (kind, compiled_pattern). Order matters — specific before generic.
_REDACTION_PATTERNS: List[Tuple[str, "re.Pattern[str]"]] = [
    # GitHub PATs
    ("GH_PAT", re.compile(r"ghp_[A-Za-z0-9]{36}")),
    ("GH_PAT", re.compile(r"github_pat_[A-Za-z0-9_]{82}")),
    # OpenAI keys (project-scoped or legacy)
    ("OPENAI_KEY", re.compile(r"sk-(?:proj-)?[A-Za-z0-9\-_]{32,}")),
    # Anthropic keys
    ("ANTHROPIC_KEY", re.compile(r"sk-ant-[A-Za-z0-9\-_]{40,}")),
    # Discord webhook URLs
    (
        "DISCORD_WEBHOOK",
        re.compile(r"https://discord(?:app)?\.com/api/webhooks/\d+/[\w-]+"),
    ),
    # Telegram bot tokens (e.g. 123456789:ABCdefGhIJKlmnoPqrsTuvwxyz0123456789).
    # Real tokens are typically 35 chars after the colon but length varies a
    # little; widen the body to {30,50} so we don't miss legitimate matches.
    ("TELEGRAM_TOKEN", re.compile(r"\b\d{9,10}:[A-Za-z0-9_-]{30,50}\b")),
    # Slack tokens
    ("SLACK_TOKEN", re.compile(r"xox[baprs]-[0-9A-Za-z-]{10,48}")),
    # AWS access key IDs (and the literal-looking secret right after,
    # if present in environment-variable shape)
    ("AWS_KEY", re.compile(r"AKIA[0-9A-Z]{16}")),
    # JWT (header.payload.signature). May leak PII in claims.
    (
        "JWT",
        re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b"),
    ),
    # Bearer auth headers in copy-pasted requests
    (
        "BEARER",
        re.compile(r"(?i)Authorization:\s*Bearer\s+[\w\-._~+/]+=*"),
    ),
    # PEM blocks (private keys + certs). DOTALL so the body can span lines.
    (
        "PEM_BLOCK",
        re.compile(
            r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?"
            r"(?:PRIVATE KEY|CERTIFICATE)-----"
            r"[\s\S]*?"
            r"-----END[^-]*-----",
        ),
    ),
    # Email addresses (RFC-lite — good enough for transcripts)
    (
        "EMAIL",
        re.compile(
            r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
        ),
    ),
    # US phone numbers in common formats. Loose; intentional.
    (
        "PHONE",
        re.compile(
            r"(?<!\d)\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}(?!\d)"
        ),
    ),
    # GENERIC: env-var-shape token assignments. Last because it's hungry.
    (
        "ENV_VAR",
        re.compile(r"\b[A-Z][A-Z0-9_]{2,}=[\w\-/+=.]{20,}"),
    ),
]


_TRUNCATE_MARKER = "…[truncated]"


def redact_text(s: str, max_chars: int = 16384) -> str:
    """Return a redacted copy of ``s``.

    - Substitutes each ``_REDACTION_PATTERNS`` match with
      ``[REDACTED:<KIND>]``.
    - If the input is longer than ``max_chars``, truncates the head and
      appends ``…[truncated]``. Truncation happens BEFORE substitution
      so the regex engine never has to scan a 10 MB blob.
    - Non-string inputs are coerced via ``str()`` (defensive — callers
      should still pass strings).
    """
    if s is None:
        return ""
    if not isinstance(s, str):
        s = str(s)
    if not s:
        return s

    if len(s) > max_chars:
        s = s[:max_chars] + _TRUNCATE_MARKER

    for kind, pattern in _REDACTION_PATTERNS:
        s = pattern.sub(f"[REDACTED:{kind}]", s)

    return s
