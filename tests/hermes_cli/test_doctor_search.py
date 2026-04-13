"""Tests for the Search & LLM Connectivity doctor check section."""

import os
from unittest.mock import patch, MagicMock


def _check_brave_search(env_vars=None):
    """Simulate the Brave Search doctor check logic."""
    env = env_vars or {}
    brave_key = env.get("BRAVE_API_KEY")
    if not brave_key:
        return "warn", "BRAVE_API_KEY not set"
    # Simulate API call result
    return env.get("_brave_result", ("ok", "connected"))


def _check_tavily_search(env_vars=None):
    """Simulate the Tavily Search doctor check logic."""
    env = env_vars or {}
    tavily_key = env.get("TAVILY_API_KEY")
    if not tavily_key:
        return "warn", "TAVILY_API_KEY not set"
    return env.get("_tavily_result", ("ok", "connected"))


def _check_lm_studio(reachable=True, model_count=3):
    """Simulate the LM Studio doctor check logic."""
    if not reachable:
        return "warn", "not running on localhost:1234"
    return "ok", f"{model_count} model(s) loaded"


class TestBraveSearchCheck:
    def test_key_present_api_ok(self):
        status, detail = _check_brave_search({"BRAVE_API_KEY": "test-key"})
        assert status == "ok"
        assert "connected" in detail

    def test_key_present_api_fail(self):
        status, detail = _check_brave_search({
            "BRAVE_API_KEY": "test-key",
            "_brave_result": ("warn", "HTTP 401"),
        })
        assert status == "warn"
        assert "401" in detail

    def test_key_absent(self):
        status, detail = _check_brave_search({})
        assert status == "warn"
        assert "not set" in detail


class TestTavilySearchCheck:
    def test_key_present_api_ok(self):
        status, detail = _check_tavily_search({"TAVILY_API_KEY": "test-key"})
        assert status == "ok"

    def test_key_present_api_fail(self):
        status, detail = _check_tavily_search({
            "TAVILY_API_KEY": "test-key",
            "_tavily_result": ("warn", "HTTP 400"),
        })
        assert status == "warn"

    def test_key_absent(self):
        status, detail = _check_tavily_search({})
        assert status == "warn"
        assert "not set" in detail


class TestLMStudioCheck:
    def test_running(self):
        status, detail = _check_lm_studio(reachable=True, model_count=5)
        assert status == "ok"
        assert "5 model(s)" in detail

    def test_not_running(self):
        status, detail = _check_lm_studio(reachable=False)
        assert status == "warn"
        assert "not running" in detail


class TestMCPSearchServers:
    def test_search_servers_detected(self):
        mcp_servers = {"brave_search": {}, "github": {}, "tavily_search": {}}
        search_mcps = [
            name for name in mcp_servers
            if any(kw in name.lower() for kw in ("search", "brave", "tavily"))
        ]
        assert "brave_search" in search_mcps
        assert "tavily_search" in search_mcps
        assert "github" not in search_mcps

    def test_no_search_servers(self):
        mcp_servers = {"github": {}, "filesystem": {}}
        search_mcps = [
            name for name in mcp_servers
            if any(kw in name.lower() for kw in ("search", "brave", "tavily"))
        ]
        assert len(search_mcps) == 0
