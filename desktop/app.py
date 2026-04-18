#!/usr/bin/env python3
"""Leroys Desktop — native macOS window for the Hermes dashboard."""

import argparse
import os
import subprocess
import sys
import urllib.request
import urllib.error
from pathlib import Path

# Ensure repo root is on sys.path so `desktop.*` imports work
_repo_root = str(Path(__file__).resolve().parent.parent)
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)

import webview

from desktop.bridge import HermesBridge
from desktop.gateway_monitor import GatewayMonitor
from desktop.menu import create_menu


_ICON_PATH = str(Path(__file__).resolve().parent / "assets" / "Leroys.icns")
GATEWAY_PORT = int(os.environ.get("HERMES_GATEWAY_PORT", "8642"))
GATEWAY_URL = f"http://127.0.0.1:{GATEWAY_PORT}"
DASHBOARD_URL = f"{GATEWAY_URL}/dashboard/"
DEV_URL = "http://127.0.0.1:5173/dashboard/"


def check_gateway(timeout: float = 2.0) -> bool:
    """Return True if the gateway is reachable."""
    try:
        req = urllib.request.Request(f"{GATEWAY_URL}/health", method="GET")
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except (urllib.error.URLError, OSError):
        return False


def start_gateway() -> bool:
    """Attempt to start the gateway via launchctl."""
    uid = os.getuid()
    service = f"gui/{uid}/ai.hermes.gateway"
    try:
        subprocess.run(
            ["launchctl", "kickstart", "-k", service],
            check=True,
            capture_output=True,
        )
        return True
    except subprocess.CalledProcessError:
        return False


def wait_for_gateway(retries: int = 10, delay: float = 1.0) -> bool:
    """Poll gateway health until ready or retries exhausted."""
    import time

    for _ in range(retries):
        if check_gateway():
            return True
        time.sleep(delay)
    return False


def main():
    parser = argparse.ArgumentParser(description="Leroys Desktop")
    parser.add_argument(
        "--dev",
        action="store_true",
        help="Load from Vite dev server (localhost:5173) for HMR",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=GATEWAY_PORT,
        help=f"Gateway port (default: {GATEWAY_PORT})",
    )
    args = parser.parse_args()

    url = DEV_URL if args.dev else DASHBOARD_URL

    if not args.dev and not check_gateway():
        print("Gateway not running. Attempting to start...", file=sys.stderr)
        if start_gateway():
            print("Gateway starting, waiting for health check...", file=sys.stderr)
            if not wait_for_gateway():
                print(
                    "Gateway failed to start. Run: make gateway-restart",
                    file=sys.stderr,
                )
                sys.exit(1)
        else:
            print(
                "Could not start gateway. Run: make gateway-restart",
                file=sys.stderr,
            )
            sys.exit(1)

    bridge = HermesBridge()

    window = webview.create_window(
        title="Leroys",
        url=url,
        width=1280,
        height=800,
        min_size=(800, 600),
        text_select=True,
        js_api=bridge,
    )

    monitor = GatewayMonitor(port=args.port)

    def on_shown():
        monitor.start()

    window.events.shown += on_shown

    webview.start(
        gui="cocoa",
        debug="--dev" in sys.argv,
        menu=create_menu(),
        icon=_ICON_PATH,
    )

    monitor.stop()


if __name__ == "__main__":
    main()
