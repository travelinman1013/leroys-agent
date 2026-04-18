/**
 * Native bridge adapter — detects pywebview desktop environment
 * and wraps bridge calls with browser fallbacks.
 */

declare global {
  interface Window {
    pywebview?: {
      api: {
        notify(title: string, body: string): void;
        gateway_status(): Promise<{ running: boolean; port: number }>;
        restart_gateway(): Promise<{ ok: boolean; error?: string }>;
        get_system_theme(): Promise<string>;
        open_in_browser(url: string): void;
        open_in_finder(path: string): void;
      };
    };
  }
}

/** True when running inside the pywebview desktop shell. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "pywebview" in window;
}

/** Send a notification — native on desktop, browser Notification API otherwise. */
export function nativeNotify(title: string, body: string): void {
  if (isDesktop()) {
    window.pywebview!.api.notify(title, body);
  } else if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    new Notification(title, { body });
  }
}

/** Restart the Hermes gateway (desktop only). */
export async function restartGateway(): Promise<{
  ok: boolean;
  error?: string;
} | null> {
  if (!isDesktop()) return null;
  return window.pywebview!.api.restart_gateway();
}

/** Get gateway running status (desktop only). */
export async function gatewayStatus(): Promise<{
  running: boolean;
  port: number;
} | null> {
  if (!isDesktop()) return null;
  return window.pywebview!.api.gateway_status();
}

/** Open a URL in the default browser (desktop) or new tab (browser). */
export function openExternal(url: string): void {
  if (isDesktop()) {
    window.pywebview!.api.open_in_browser(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}
