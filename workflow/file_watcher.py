"""File watcher daemon — monitors directories for changes and triggers workflows.

Runs as a gateway background thread alongside the cron ticker. Uses watchdog
for FSEvents (macOS) / inotify (Linux) filesystem monitoring. Gracefully
no-ops if watchdog is not installed.

Design:
  - Debounce: rapid changes to the same file within debounce_s are collapsed
  - Exclude patterns: .git, __pycache__, .DS_Store, *.tmp
  - Each trigger fires the watch-and-notify workflow via run_workflow()
  - Thread-safe: Observer runs in its own thread, callbacks are dispatched
    from the observer thread
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)

# Import guard — watchdog is an optional dependency
try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler, FileSystemEvent
    HAS_WATCHDOG = True
except ImportError:
    HAS_WATCHDOG = False
    Observer = None
    FileSystemEventHandler = object
    FileSystemEvent = None

# Default exclude patterns
_DEFAULT_EXCLUDES: Set[str] = {
    ".git",
    "__pycache__",
    ".DS_Store",
    ".obsidian",
    "node_modules",
}

_DEFAULT_EXCLUDE_EXTENSIONS: Set[str] = {
    ".tmp",
    ".swp",
    ".swo",
    ".pyc",
}


class _DebouncedHandler(FileSystemEventHandler):
    """Accumulates file events and triggers workflow after debounce window."""

    def __init__(self, debounce_s: float = 2.0, exclude_dirs: Set[str] = None,
                 exclude_exts: Set[str] = None):
        super().__init__()
        self._debounce_s = debounce_s
        self._exclude_dirs = exclude_dirs or _DEFAULT_EXCLUDES
        self._exclude_exts = exclude_exts or _DEFAULT_EXCLUDE_EXTENSIONS
        self._pending: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._timer: Optional[threading.Timer] = None

    def _should_ignore(self, path: str) -> bool:
        parts = Path(path).parts
        for part in parts:
            if part in self._exclude_dirs:
                return True
        ext = Path(path).suffix
        if ext in self._exclude_exts:
            return True

        # Path jail check — block events from denied paths
        try:
            from hermes_cli.config import get_safe_roots, get_denied_paths
            safe_roots = get_safe_roots()
            denied_paths = get_denied_paths()
            if safe_roots:
                from tools.file_tools import validate_path_operation
                allowed, reason = validate_path_operation(
                    path, "read", safe_roots, denied_paths,
                )
                if not allowed:
                    logger.debug("File watcher ignoring denied path: %s (%s)", path, reason)
                    return True
        except ImportError:
            pass

        return False

    def on_any_event(self, event):
        if event.is_directory:
            return
        src_path = event.src_path
        if self._should_ignore(src_path):
            return

        with self._lock:
            self._pending[src_path] = {
                "path": src_path,
                "event_type": event.event_type,  # created, modified, deleted, moved
                "timestamp": time.time(),
            }
            # Reset debounce timer
            if self._timer:
                self._timer.cancel()
            self._timer = threading.Timer(self._debounce_s, self._flush)
            self._timer.daemon = True
            self._timer.start()

    def _flush(self):
        """Fire accumulated events after debounce window."""
        with self._lock:
            events = list(self._pending.values())
            self._pending.clear()

        for evt in events:
            try:
                _trigger_workflow(evt)
            except Exception as exc:
                logger.error("Failed to trigger workflow for %s: %s", evt["path"], exc)

    def cancel(self):
        """Cancel any pending debounce timer."""
        with self._lock:
            if self._timer:
                self._timer.cancel()
                self._timer = None


def _trigger_workflow(event_data: Dict[str, Any]) -> None:
    """Run the watch-and-notify workflow for a file change event."""
    try:
        from workflow.harnesses import get_harness
        from workflow.engine import run_workflow
    except ImportError:
        logger.warning("Workflow engine not available — skipping file change trigger")
        return

    try:
        wf = get_harness("watch-and-notify")
    except KeyError:
        logger.warning("watch-and-notify harness not registered")
        return

    result = run_workflow(wf, trigger_meta=event_data)
    if result.status != "completed":
        logger.warning(
            "watch-and-notify workflow failed for %s: %s",
            event_data.get("path"), result.error,
        )


def _get_watch_paths() -> List[str]:
    """Read watch paths from config or use defaults."""
    defaults = [
        str(Path.home() / "brain"),
        str(Path.home() / "Projects"),
    ]

    try:
        from hermes_cli.config import load_config
        config = load_config()
        paths = (
            config.get("workflows", {})
            .get("file_watcher", {})
            .get("paths", [])
        )
        if paths:
            return [os.path.expanduser(p) for p in paths]
    except Exception:
        pass

    return defaults


def start_file_watcher(
    stop_event: threading.Event,
    watch_paths: Optional[List[str]] = None,
    debounce_s: float = 2.0,
) -> None:
    """Background thread entry point. Watches directories via watchdog.

    Called from gateway/run.py alongside the cron ticker.

    Args:
        stop_event: Set this to stop the watcher cleanly.
        watch_paths: Directories to watch. If None, reads from config.
        debounce_s: Seconds to wait after last change before triggering.
    """
    if not HAS_WATCHDOG:
        logger.info("File watcher disabled — watchdog package not installed")
        return

    # Read config for debounce/excludes if not explicitly passed
    watcher_config: Dict[str, Any] = {}
    try:
        from hermes_cli.config import load_config
        watcher_config = (
            load_config()
            .get("workflows", {})
            .get("file_watcher", {})
        )
    except Exception:
        pass

    if debounce_s == 2.0 and "debounce_s" in watcher_config:
        debounce_s = float(watcher_config["debounce_s"])

    # Merge config exclude_dirs with defaults
    exclude_dirs = set(_DEFAULT_EXCLUDES)
    config_excludes = watcher_config.get("exclude_dirs", [])
    if config_excludes:
        exclude_dirs |= set(config_excludes)

    paths = watch_paths or _get_watch_paths()
    valid_paths = [p for p in paths if os.path.isdir(p)]
    if not valid_paths:
        logger.warning("File watcher: no valid directories to watch (%s)", paths)
        return

    handler = _DebouncedHandler(debounce_s=debounce_s, exclude_dirs=exclude_dirs)
    observer = Observer()

    for path in valid_paths:
        observer.schedule(handler, path, recursive=True)
        logger.info("File watcher: watching %s", path)

    observer.start()
    logger.info("File watcher started (%d directories, debounce=%.1fs)", len(valid_paths), debounce_s)

    try:
        while not stop_event.is_set():
            stop_event.wait(timeout=1.0)
            # Observer liveness check — restart if the thread died
            if not observer.is_alive():
                logger.warning("File watcher observer died — restarting")
                try:
                    observer.stop()
                    observer.join(timeout=2.0)
                except Exception:
                    pass
                observer = Observer()
                for path in valid_paths:
                    observer.schedule(handler, path, recursive=True)
                observer.start()
    finally:
        handler.cancel()
        observer.stop()
        observer.join(timeout=5.0)
        logger.info("File watcher stopped")
