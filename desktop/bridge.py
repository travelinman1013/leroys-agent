"""Native bridge — Python methods exposed to the dashboard JS via pywebview."""

import os
import subprocess


class HermesBridge:
    """Exposed as window.pywebview.api in the WKWebView."""

    _uid = os.getuid()
    _service = f"gui/{_uid}/ai.hermes.gateway"

    def notify(self, title: str, body: str) -> None:
        """Send a macOS notification via osascript (no permission prompt)."""
        script = (
            f'display notification "{body}" '
            f'with title "{title}" sound name "Submarine"'
        )
        subprocess.Popen(
            ["osascript", "-e", script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def gateway_status(self) -> dict:
        """Check if the gateway launchd service is running."""
        try:
            result = subprocess.run(
                ["launchctl", "print", self._service],
                capture_output=True,
                text=True,
            )
            running = result.returncode == 0
        except Exception:
            running = False
        return {"running": running, "port": 8642}

    def restart_gateway(self) -> dict:
        """Restart the gateway via launchctl kickstart."""
        try:
            subprocess.run(
                ["launchctl", "kickstart", "-k", self._service],
                check=True,
                capture_output=True,
            )
            return {"ok": True}
        except subprocess.CalledProcessError as e:
            return {"ok": False, "error": e.stderr.decode()[:200]}

    def get_system_theme(self) -> str:
        """Return 'dark' or 'light' based on macOS appearance."""
        try:
            result = subprocess.run(
                ["defaults", "read", "-g", "AppleInterfaceStyle"],
                capture_output=True,
                text=True,
            )
            return "dark" if result.returncode == 0 else "light"
        except Exception:
            return "light"

    def open_in_browser(self, url: str) -> None:
        """Open a URL in the default browser."""
        subprocess.Popen(
            ["open", url],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def open_in_finder(self, path: str) -> None:
        """Reveal a file in Finder."""
        subprocess.Popen(
            ["open", "-R", path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def hard_reload(self) -> None:
        """Reload the webview with a cache-busting URL."""
        import webview
        from desktop.menu import _cache_bust_url

        window = webview.active_window()
        if window:
            window.load_url(_cache_bust_url(window.get_current_url()))
