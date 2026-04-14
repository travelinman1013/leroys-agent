"""Tests for the dashboard v2 W0 ``apply_config_mutations`` helper.

The allowlist is the security boundary for the dashboard PUT /config
route, so every deny path is exhaustively covered.
"""

from __future__ import annotations

import yaml
import pytest

from hermes_cli import config as cfg_mod


@pytest.fixture(autouse=True)
def _hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    # Reset cached path lookups
    try:
        from hermes_constants import get_hermes_home
        if hasattr(get_hermes_home, "cache_clear"):
            get_hermes_home.cache_clear()
    except Exception:
        pass
    cfg_mod.reset_path_jail_cache()
    # Seed a baseline config so save_config has something to merge
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        yaml.dump(
            {
                "approvals": {"mode": "manual", "non_interactive_policy": "guarded"},
                "compression": {"threshold": 0.75, "target_ratio": 0.3},
                "code_execution": {"max_tool_output": 4000},
            },
            sort_keys=False,
        )
    )
    yield


# ---------------------------------------------------------------------------
# Allowlist enforcement
# ---------------------------------------------------------------------------


def test_allowlist_accepts_compression_threshold():
    out = cfg_mod.apply_config_mutations({"compression.threshold": 0.85})
    assert "compression.threshold" in out["applied"]
    assert "compression.threshold" in out["restart_required"]
    cfg = cfg_mod.load_config()
    assert cfg["compression"]["threshold"] == 0.85


def test_allowlist_accepts_approvals_mode():
    out = cfg_mod.apply_config_mutations({"approvals.mode": "smart"})
    assert "approvals.mode" in out["applied"]
    cfg = cfg_mod.load_config()
    assert cfg["approvals"]["mode"] == "smart"


def test_allowlist_rejects_model_provider():
    with pytest.raises(PermissionError, match="model.provider"):
        cfg_mod.apply_config_mutations({"model.provider": "openai"})


def test_allowlist_accepts_security_safe_roots(tmp_path, monkeypatch):
    """security.safe_roots IS in the allowlist (added in Phase 8a)."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text("security: {}\n")
    out = cfg_mod.apply_config_mutations({"security.safe_roots": ["/tmp"]})
    assert "security.safe_roots" in out["applied"]


def test_allowlist_rejects_arbitrary_top_level():
    with pytest.raises(PermissionError):
        cfg_mod.apply_config_mutations({"unknown_key": True})


def test_empty_mutations_raises():
    with pytest.raises(ValueError):
        cfg_mod.apply_config_mutations({})


def test_partial_failure_does_not_write():
    """If ANY key fails the allowlist, NO key gets written."""
    cfg_before = cfg_mod.load_config()
    with pytest.raises(PermissionError):
        cfg_mod.apply_config_mutations({
            "compression.threshold": 0.95,  # allowed
            "model.provider": "evil",       # denied
        })
    cfg_after = cfg_mod.load_config()
    assert cfg_after["compression"]["threshold"] == cfg_before["compression"]["threshold"]


# ---------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------


def test_first_write_creates_pristine_snapshot(tmp_path):
    cfg_mod.apply_config_mutations({"compression.threshold": 0.8})
    bdir = tmp_path / "config_backups"
    pristine = list(bdir.glob("pristine-*.yaml"))
    assert len(pristine) == 1
    # Pristine should reflect the BEFORE state
    snapshot = yaml.safe_load(pristine[0].read_text())
    assert snapshot["compression"]["threshold"] == 0.75  # original


def test_each_write_creates_dated_backup(tmp_path):
    cfg_mod.apply_config_mutations({"compression.threshold": 0.8})
    cfg_mod.apply_config_mutations({"compression.target_ratio": 0.4})
    bdir = tmp_path / "config_backups"
    dated = sorted(bdir.glob("[0-9]*.yaml"))
    assert len(dated) == 2


def test_restore_backup_round_trip(tmp_path):
    cfg_mod.apply_config_mutations({"compression.threshold": 0.85})
    bdir = tmp_path / "config_backups"
    backups = sorted(bdir.glob("[0-9]*.yaml"))
    assert backups, "expected at least one dated backup"
    # Mutate further so a rollback is meaningful
    cfg_mod.apply_config_mutations({"compression.threshold": 0.9})
    # Restore the first backup (which captured the 0.75 -> ANY transition;
    # the snapshot is the cfg BEFORE 0.85 was written, so 0.75)
    cfg_mod.restore_config_backup(backups[0].name)
    cfg = cfg_mod.load_config()
    assert cfg["compression"]["threshold"] == 0.75


# ---------------------------------------------------------------------------
# Wildcard pattern matching
# ---------------------------------------------------------------------------


def test_platform_toolsets_wildcard_accepted():
    out = cfg_mod.apply_config_mutations({"platform_toolsets.telegram.web": False})
    assert "platform_toolsets.telegram.web" in out["applied"]
    assert "platform_toolsets.telegram.web" in out["restart_required"]


def test_mcp_servers_enabled_wildcard_accepted():
    out = cfg_mod.apply_config_mutations({"mcp_servers.github.enabled": True})
    assert "mcp_servers.github.enabled" in out["applied"]
    assert "mcp_servers.github.enabled" in out["restart_required"]


def test_mcp_servers_command_rejected():
    """Only ``enabled``/``disabled`` are mutable, not ``command`` or ``env``."""
    with pytest.raises(PermissionError):
        cfg_mod.apply_config_mutations({"mcp_servers.github.command": "/bin/sh"})


# ---------------------------------------------------------------------------
# Expanded allowlist (config page overhaul)
# ---------------------------------------------------------------------------


def test_section_wildcards_accept_new_categories():
    """Broad section wildcards allow all fields in newly exposed categories."""
    cases = [
        ("display.personality", "kawaii"),
        ("logging.level", "INFO"),
        ("terminal.timeout", 180),
        ("voice.auto_tts", False),
        ("memory.memory_enabled", True),
        ("discord.require_mention", True),
        ("browser.inactivity_timeout", 120),
        ("tts.provider", "edge"),
        ("stt.enabled", True),
        ("human_delay.mode", "off"),
        ("delegation.max_iterations", 50),
        ("code_execution.timeout", 300),
        ("cron.wrap_response", True),
        ("privacy.redact_pii", False),
        ("network.force_ipv4", False),
        ("smart_model_routing.enabled", False),
        ("checkpoints.enabled", True),
        ("context.engine", "compressor"),
    ]
    for key, val in cases:
        out = cfg_mod.apply_config_mutations({key: val})
        assert key in out["applied"], f"{key} should be allowed"


def test_top_level_scalars_accepted():
    """Top-level keys like model, toolsets, file_read_max_chars are mutable."""
    out = cfg_mod.apply_config_mutations({"model": "test-model"})
    assert "model" in out["applied"]
    cfg = cfg_mod.load_config()
    assert cfg["model"] == "test-model"


def test_auxiliary_deep_wildcard_accepted():
    """auxiliary.*.provider matches through nested service paths."""
    out = cfg_mod.apply_config_mutations({"auxiliary.vision.provider": "auto"})
    assert "auxiliary.vision.provider" in out["applied"]


def test_auxiliary_timeout_accepted():
    out = cfg_mod.apply_config_mutations({"auxiliary.compression.timeout": 120})
    assert "auxiliary.compression.timeout" in out["applied"]


# ---------------------------------------------------------------------------
# Denylist enforcement
# ---------------------------------------------------------------------------


def test_denylist_blocks_config_version():
    with pytest.raises(PermissionError, match="_config_version"):
        cfg_mod.apply_config_mutations({"_config_version": 999})


def test_denylist_blocks_mcp_args():
    with pytest.raises(PermissionError):
        cfg_mod.apply_config_mutations({"mcp_servers.github.args": ["--evil"]})


def test_denylist_blocks_mcp_env():
    with pytest.raises(PermissionError):
        cfg_mod.apply_config_mutations({"mcp_servers.github.env": {"PATH": "/tmp"}})


def test_denylist_blocks_mcp_env_nested():
    with pytest.raises(PermissionError):
        cfg_mod.apply_config_mutations({"mcp_servers.github.env.SECRET": "leaked"})


def test_denylist_overrides_allowlist():
    """Denylist takes precedence — mcp_servers.* allows, but *.command denies."""
    # enabled should still work
    out = cfg_mod.apply_config_mutations({"mcp_servers.github.enabled": True})
    assert "mcp_servers.github.enabled" in out["applied"]
    # command should NOT
    with pytest.raises(PermissionError):
        cfg_mod.apply_config_mutations({"mcp_servers.github.command": "rm -rf /"})
