"""
Optional OpenTelemetry / OpenLLMetry integration for Hermes.

Hermes ships without OpenTelemetry in the default install. Users who want
historical trace UIs (Arize Phoenix, Langfuse, Jaeger, etc.) can opt in by:

  1. ``pip install -e .[observability]``
  2. Set ``HERMES_OTLP_ENDPOINT=http://localhost:4317`` (or 4318 for HTTP)
  3. Optionally run ``docker compose -f docker-compose.observability.yml up -d``
     to spin up a local Phoenix container at :6006

When the env var is unset OR the SDK is not installed, every function in
this module is a no-op. The agent loop, tool dispatcher, and LLM client
continue running exactly as before.

Design
------
- This module is IMPORTED unconditionally from a couple of Hermes seams
  (``agent/auxiliary_client.py`` for LLM calls, ``model_tools.py`` for
  tool dispatch). It uses lazy try/except imports so the module loads
  cleanly on a vanilla install.
- All wrapper functions ("start_tool_span", "init_if_configured") are
  fail-silent.
- OpenLLMetry's ``Traceloop.init`` is called exactly once per process.
- When tracing is not initialized, ``start_tool_span`` returns a no-op
  context manager so the caller code is identical either way.

Sandbox note
------------
The OTLP endpoint must live on localhost (e.g. :4317 for gRPC, :4318 for
HTTP). Phase 4's Seatbelt profile already allows ``(remote tcp
"localhost:*")``, so adding those ports requires no profile changes —
but see scripts/sandbox/hermes.sb for explicit documentation.
"""

from __future__ import annotations

import contextlib
import logging
import os
from typing import Any, Iterator, Optional

logger = logging.getLogger(__name__)

# Lazy singletons — None when disabled
_initialized: bool = False
_enabled: bool = False
_tracer: Any = None


def _otlp_endpoint() -> Optional[str]:
    """Return the configured OTLP endpoint, or None if observability is off."""
    endpoint = os.environ.get("HERMES_OTLP_ENDPOINT") or os.environ.get(
        "OTEL_EXPORTER_OTLP_ENDPOINT"
    )
    return endpoint or None


def init_if_configured() -> bool:
    """Initialize OpenLLMetry / OpenTelemetry once per process.

    Returns True if tracing is now active, False if disabled or failed.
    Safe to call multiple times — subsequent calls are no-ops.
    """
    global _initialized, _enabled, _tracer

    if _initialized:
        return _enabled

    endpoint = _otlp_endpoint()
    if not endpoint:
        _initialized = True
        _enabled = False
        return False

    # Set the GenAI semconv opt-in flag BEFORE any OTel import so the
    # contrib instrumentations pick up the experimental spec.
    os.environ.setdefault(
        "OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental"
    )

    try:
        from traceloop.sdk import Traceloop  # type: ignore[import-not-found]
    except Exception as exc:
        logger.debug(
            "agent.otel: traceloop-sdk not installed; observability disabled (%s)",
            exc,
        )
        _initialized = True
        _enabled = False
        return False

    try:
        Traceloop.init(
            app_name="hermes-agent",
            api_endpoint=endpoint,
            disable_batch=False,
        )
    except Exception as exc:
        logger.warning("agent.otel: Traceloop.init failed: %s", exc)
        _initialized = True
        _enabled = False
        return False

    # Grab a tracer for our own manually-instrumented spans (tool dispatch,
    # compression events, etc.). Traceloop already instruments OpenAI clients.
    try:
        from opentelemetry import trace  # type: ignore[import-not-found]
        _tracer = trace.get_tracer("hermes.agent", "0.8.0")
    except Exception as exc:
        logger.debug("agent.otel: failed to get tracer (continuing): %s", exc)
        _tracer = None

    _initialized = True
    _enabled = True
    logger.info("agent.otel: OpenTelemetry tracing initialized (%s)", endpoint)
    return True


def is_enabled() -> bool:
    """Return True if tracing is currently active."""
    return _enabled


@contextlib.contextmanager
def start_tool_span(
    tool_name: str,
    *,
    session_id: Optional[str] = None,
    tool_call_id: Optional[str] = None,
) -> Iterator[Any]:
    """Start a ``gen_ai.tool.invoke`` span for a tool dispatch.

    When OTel is disabled this is a no-op context manager — the caller
    can wrap its tool dispatch unconditionally:

        with start_tool_span(name, session_id=...):
            result = registry.dispatch(...)

    When enabled, a span is created under the current trace with the
    OpenTelemetry GenAI semantic conventions
    (https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/).
    """
    if not _enabled or _tracer is None:
        yield None
        return

    try:
        span_ctx = _tracer.start_as_current_span(
            f"gen_ai.tool.invoke {tool_name}",
            attributes={
                "gen_ai.system": "hermes",
                "gen_ai.tool.name": tool_name,
                "gen_ai.tool.call.id": tool_call_id or "",
                "hermes.session.id": session_id or "",
            },
        )
    except Exception as exc:
        logger.debug("agent.otel: start_as_current_span failed: %s", exc)
        yield None
        return

    try:
        with span_ctx as span:
            yield span
    except Exception as exc:
        # Record but don't suppress — the caller's except handler will run
        try:
            if span_ctx and hasattr(span_ctx, "record_exception"):
                span_ctx.record_exception(exc)
        except Exception:
            pass
        raise
