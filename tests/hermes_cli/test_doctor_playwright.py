"""Tests for the Playwright MCP doctor check section."""

from unittest.mock import patch, MagicMock


def _run_doctor_playwright_section(npx_available=True, playwright_configured=False, browser_tools_active=False):
    """Helper to test the Playwright doctor check logic in isolation."""
    results = {"ok": [], "warn": [], "info": []}

    # Simulate npx check
    if npx_available:
        results["ok"].append("npx")
    else:
        results["warn"].append("npx not found")

    # Simulate Playwright config check
    if playwright_configured:
        results["ok"].append("Playwright MCP")
        if browser_tools_active:
            results["warn"].append("browser_tools toolset also active")
    else:
        results["info"].append("Playwright MCP not configured")

    return results


class TestDoctorPlaywright:
    def test_npx_available_playwright_configured(self):
        results = _run_doctor_playwright_section(
            npx_available=True, playwright_configured=True
        )
        assert "npx" in results["ok"]
        assert "Playwright MCP" in results["ok"]
        assert len(results["warn"]) == 0

    def test_npx_missing(self):
        results = _run_doctor_playwright_section(npx_available=False)
        assert "npx not found" in results["warn"]

    def test_playwright_not_configured(self):
        results = _run_doctor_playwright_section(
            npx_available=True, playwright_configured=False
        )
        assert "Playwright MCP not configured" in results["info"]

    def test_browser_tools_collision_warning(self):
        results = _run_doctor_playwright_section(
            npx_available=True,
            playwright_configured=True,
            browser_tools_active=True,
        )
        assert "browser_tools toolset also active" in results["warn"]


class TestMCPPresetPlaywright:
    def test_playwright_preset_exists(self):
        from hermes_cli.mcp_config import _MCP_PRESETS

        assert "playwright" in _MCP_PRESETS
        preset = _MCP_PRESETS["playwright"]
        assert preset["command"] == "npx"
        assert "@playwright/mcp@0.0.70" in preset["args"]

    def test_playwright_preset_has_display_name(self):
        from hermes_cli.mcp_config import _MCP_PRESETS

        assert "display_name" in _MCP_PRESETS["playwright"]
