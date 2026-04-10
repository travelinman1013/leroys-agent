"""Tests for agent.otel — optional OpenTelemetry / OpenLLMetry integration.

The observability extras may or may not be installed in the test environment.
These tests verify the graceful-no-op behavior when they are NOT installed,
which is the important case: a vanilla Hermes install must boot cleanly
without the extras.
"""

from __future__ import annotations

import importlib
import os

import pytest


@pytest.fixture(autouse=True)
def _reset_otel_state():
    """Reset the otel module singleton state between tests."""
    import agent.otel as otel_mod
    otel_mod._initialized = False
    otel_mod._enabled = False
    otel_mod._tracer = None
    yield
    otel_mod._initialized = False
    otel_mod._enabled = False
    otel_mod._tracer = None


class TestOtelDisabledByDefault:
    def test_import_does_not_raise(self):
        """Importing agent.otel must work on a vanilla install."""
        import agent.otel  # noqa: F401

    def test_init_without_env_var_returns_false(self, monkeypatch):
        monkeypatch.delenv("HERMES_OTLP_ENDPOINT", raising=False)
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        from agent.otel import init_if_configured, is_enabled
        assert init_if_configured() is False
        assert is_enabled() is False

    def test_init_is_idempotent(self, monkeypatch):
        monkeypatch.delenv("HERMES_OTLP_ENDPOINT", raising=False)
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        from agent.otel import init_if_configured
        assert init_if_configured() is False
        # Second call short-circuits on the _initialized flag
        assert init_if_configured() is False

    def test_start_tool_span_is_noop_when_disabled(self, monkeypatch):
        monkeypatch.delenv("HERMES_OTLP_ENDPOINT", raising=False)
        monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
        from agent.otel import start_tool_span, init_if_configured
        init_if_configured()
        with start_tool_span("test_tool", session_id="s1") as span:
            assert span is None


class TestOtelEnabledButSdkMissing:
    """When HERMES_OTLP_ENDPOINT is set but traceloop-sdk is NOT installed,
    init should log a debug message and stay disabled — NOT raise."""

    def test_init_with_endpoint_but_no_sdk(self, monkeypatch):
        monkeypatch.setenv("HERMES_OTLP_ENDPOINT", "http://localhost:4317")
        # Intercept the import so it behaves as if the package isn't
        # installed, regardless of whether it's actually on the path.
        import builtins
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name.startswith("traceloop"):
                raise ImportError(f"mocked missing {name}")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)

        # Reset + reimport
        import agent.otel as otel_mod
        otel_mod._initialized = False
        otel_mod._enabled = False
        assert otel_mod.init_if_configured() is False
        assert otel_mod.is_enabled() is False

    def test_semconv_opt_in_env_set(self, monkeypatch):
        """Calling init with an endpoint should opt into the GenAI semconv,
        even if the SDK fails to initialize after."""
        monkeypatch.setenv("HERMES_OTLP_ENDPOINT", "http://localhost:4317")
        monkeypatch.delenv("OTEL_SEMCONV_STABILITY_OPT_IN", raising=False)

        # Block traceloop so init bails early but after setting the env var
        import builtins
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name.startswith("traceloop"):
                raise ImportError("mocked")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", fake_import)

        import agent.otel as otel_mod
        otel_mod._initialized = False
        otel_mod._enabled = False
        otel_mod.init_if_configured()

        assert os.environ.get("OTEL_SEMCONV_STABILITY_OPT_IN") == "gen_ai_latest_experimental"
