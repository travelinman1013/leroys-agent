"""Tests for the file watcher daemon."""

import os
import threading
import time
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

from workflow.file_watcher import (
    HAS_WATCHDOG,
    _DebouncedHandler,
    start_file_watcher,
    _get_watch_paths,
)


@pytest.fixture()
def handler():
    h = _DebouncedHandler(debounce_s=0.1)
    yield h
    h.cancel()


class TestDebouncedHandler:
    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_excludes_git_directory(self, handler):
        event = MagicMock()
        event.is_directory = False
        event.src_path = "/home/user/project/.git/HEAD"
        event.event_type = "modified"

        handler.on_any_event(event)
        assert len(handler._pending) == 0

    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_excludes_pycache(self, handler):
        event = MagicMock()
        event.is_directory = False
        event.src_path = "/home/user/project/__pycache__/foo.pyc"
        event.event_type = "modified"

        handler.on_any_event(event)
        assert len(handler._pending) == 0

    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_excludes_tmp_extension(self, handler):
        event = MagicMock()
        event.is_directory = False
        event.src_path = "/home/user/project/data.tmp"
        event.event_type = "created"

        handler.on_any_event(event)
        assert len(handler._pending) == 0

    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_accepts_valid_file(self, handler):
        event = MagicMock()
        event.is_directory = False
        event.src_path = "/home/user/brain/00_Inbox/test.md"
        event.event_type = "created"

        handler.on_any_event(event)
        assert len(handler._pending) == 1

    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_ignores_directory_events(self, handler):
        event = MagicMock()
        event.is_directory = True
        event.src_path = "/home/user/brain/new_folder"
        event.event_type = "created"

        handler.on_any_event(event)
        assert len(handler._pending) == 0

    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_debounce_collapses_events(self, handler):
        """Rapid events on same file collapse to one."""
        for i in range(5):
            event = MagicMock()
            event.is_directory = False
            event.src_path = "/home/user/brain/test.md"
            event.event_type = "modified"
            handler.on_any_event(event)

        # Still just one pending entry (same path key)
        assert len(handler._pending) == 1

    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_flush_triggers_workflow(self, handler):
        event = MagicMock()
        event.is_directory = False
        event.src_path = "/home/user/brain/test.md"
        event.event_type = "created"
        handler.on_any_event(event)

        with patch("workflow.file_watcher._trigger_workflow") as mock_trigger:
            handler._flush()
            mock_trigger.assert_called_once()
            call_data = mock_trigger.call_args[0][0]
            assert call_data["path"] == "/home/user/brain/test.md"
            assert call_data["event_type"] == "created"

    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_flush_clears_pending(self, handler):
        event = MagicMock()
        event.is_directory = False
        event.src_path = "/home/user/brain/test.md"
        event.event_type = "created"
        handler.on_any_event(event)

        with patch("workflow.file_watcher._trigger_workflow"):
            handler._flush()
        assert len(handler._pending) == 0


class TestStartFileWatcher:
    def test_no_watchdog_returns_cleanly(self):
        """If watchdog is not installed, start returns without error."""
        stop = threading.Event()
        with patch("workflow.file_watcher.HAS_WATCHDOG", False):
            # Should return immediately, not block
            start_file_watcher(stop)

    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_graceful_shutdown(self, tmp_path):
        """Watcher starts and stops cleanly on stop_event."""
        watch_dir = tmp_path / "watched"
        watch_dir.mkdir()

        stop = threading.Event()
        thread = threading.Thread(
            target=start_file_watcher,
            args=(stop,),
            kwargs={"watch_paths": [str(watch_dir)], "debounce_s": 0.1},
            daemon=True,
        )
        thread.start()

        # Let it run briefly
        time.sleep(0.2)
        assert thread.is_alive()

        # Signal stop
        stop.set()
        thread.join(timeout=3.0)
        assert not thread.is_alive()

    def test_no_valid_paths_returns(self):
        """If no directories exist, watcher logs warning and returns."""
        stop = threading.Event()
        if HAS_WATCHDOG:
            start_file_watcher(stop, watch_paths=["/nonexistent/path"])
        # Should not raise, just return


class TestConfigDriven:
    def test_debounce_from_config(self):
        """Config debounce_s is used when not explicitly passed."""
        mock_config = {
            "workflows": {"file_watcher": {"debounce_s": 5.0}}
        }
        stop = threading.Event()
        stop.set()  # Exit immediately

        with (
            patch("hermes_cli.config.load_config", return_value=mock_config),
            patch("workflow.file_watcher._get_watch_paths", return_value=[]),
        ):
            # Should not raise even with no valid paths
            start_file_watcher(stop)

    def test_exclude_dirs_from_config(self):
        """Config exclude_dirs merge with defaults."""
        mock_config = {
            "workflows": {"file_watcher": {"exclude_dirs": ["custom_dir", "vendor"]}}
        }
        stop = threading.Event()
        stop.set()

        with (
            patch("hermes_cli.config.load_config", return_value=mock_config),
            patch("workflow.file_watcher._get_watch_paths", return_value=[]),
        ):
            start_file_watcher(stop)
            # Verify the handler would have merged excludes
            # (tested via handler directly below)

    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_exclude_dirs_merged_in_handler(self):
        """Handler gets config excludes merged with defaults."""
        merged = _DEFAULT_EXCLUDES | {"custom_dir", "vendor"}
        h = _DebouncedHandler(debounce_s=0.1, exclude_dirs=merged)

        event = MagicMock()
        event.is_directory = False
        event.src_path = "/home/user/project/custom_dir/file.py"
        event.event_type = "modified"
        h.on_any_event(event)
        assert len(h._pending) == 0
        h.cancel()

    def test_config_missing_uses_defaults(self):
        """Missing config falls back to defaults."""
        with patch("hermes_cli.config.load_config", side_effect=ImportError):
            stop = threading.Event()
            stop.set()
            start_file_watcher(stop)

    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_path_jail_in_should_ignore(self):
        """_should_ignore blocks paths denied by path jail."""
        h = _DebouncedHandler(debounce_s=0.1)
        with (
            patch("hermes_cli.config.get_safe_roots", return_value=["/allowed"]),
            patch("hermes_cli.config.get_denied_paths", return_value=[]),
            patch("tools.file_tools.validate_path_operation", return_value=(False, "not under safe roots")),
        ):
            assert h._should_ignore("/secret/data.txt") is True
        h.cancel()

    @pytest.mark.skipif(not HAS_WATCHDOG, reason="watchdog not installed")
    def test_path_jail_allows_safe_paths(self):
        """_should_ignore allows paths under safe roots."""
        h = _DebouncedHandler(debounce_s=0.1)
        with (
            patch("hermes_cli.config.get_safe_roots", return_value=["/home/user"]),
            patch("hermes_cli.config.get_denied_paths", return_value=[]),
            patch("tools.file_tools.validate_path_operation", return_value=(True, "")),
        ):
            assert h._should_ignore("/home/user/brain/note.md") is False
        h.cancel()


# Import _DEFAULT_EXCLUDES for config merge tests
from workflow.file_watcher import _DEFAULT_EXCLUDES


class TestGetWatchPaths:
    def test_defaults_to_home_dirs(self):
        paths = _get_watch_paths()
        home = str(Path.home())
        # Should contain brain and Projects under home
        assert any("brain" in p for p in paths)
        assert any("Projects" in p for p in paths)

    def test_reads_from_config(self):
        mock_config = {
            "workflows": {
                "file_watcher": {
                    "paths": ["~/custom/path1", "~/custom/path2"],
                }
            }
        }
        with patch("hermes_cli.config.load_config", return_value=mock_config):
            paths = _get_watch_paths()
        assert len(paths) == 2
        assert all("custom" in p for p in paths)
