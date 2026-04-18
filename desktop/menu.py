"""Native macOS menu bar for the Leroys desktop app.

Provides Edit menu (required for Cmd+C/V in WKWebView) and View menu.
"""

import webview


def create_menu() -> list[webview.Menu]:
    """Build the native menu bar items."""
    return [
        webview.Menu(
            "Edit",
            [
                webview.menu.MenuAction("Cut", _cut),
                webview.menu.MenuAction("Copy", _copy),
                webview.menu.MenuAction("Paste", _paste),
                webview.menu.MenuSeparator(),
                webview.menu.MenuAction("Select All", _select_all),
            ],
        ),
        webview.Menu(
            "View",
            [
                webview.menu.MenuAction("Reload", _reload),
            ],
        ),
    ]


def _cut():
    _exec_js("document.execCommand('cut')")


def _copy():
    _exec_js("document.execCommand('copy')")


def _paste():
    _exec_js("document.execCommand('paste')")


def _select_all():
    _exec_js("document.execCommand('selectAll')")


def _reload():
    window = webview.active_window()
    if window:
        window.load_url(window.get_current_url())


def _exec_js(js: str) -> None:
    window = webview.active_window()
    if window:
        window.evaluate_js(js)
