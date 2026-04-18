"""Background thread that monitors gateway health and fires notifications."""

import threading
import time
import urllib.request
import urllib.error

import webview


class GatewayMonitor:
    """Polls gateway /health every interval seconds. Notifies on state changes."""

    def __init__(self, port: int = 8642, interval: float = 5.0):
        self._url = f"http://127.0.0.1:{port}/health"
        self._interval = interval
        self._alive = True
        self._was_up: bool | None = None  # None = unknown
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._alive = False

    @property
    def is_up(self) -> bool:
        return self._was_up is True

    def _check(self) -> bool:
        try:
            req = urllib.request.Request(self._url, method="GET")
            with urllib.request.urlopen(req, timeout=2):
                return True
        except (urllib.error.URLError, OSError):
            return False

    def _loop(self) -> None:
        while self._alive:
            up = self._check()
            if self._was_up is not None and up != self._was_up:
                self._on_state_change(up)
            self._was_up = up
            time.sleep(self._interval)

    def _on_state_change(self, up: bool) -> None:
        """Inject a JS event into the webview when gateway state changes."""
        window = webview.active_window()
        if not window:
            return
        if up:
            window.evaluate_js(
                "document.title = 'Leroys';"
                "console.log('[desktop] Gateway reconnected');"
            )
        else:
            window.evaluate_js(
                "document.title = 'Leroys — Gateway Down';"
                "console.log('[desktop] Gateway down');"
            )
