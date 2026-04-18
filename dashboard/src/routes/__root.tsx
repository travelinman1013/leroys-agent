import { createRootRouteWithContext, Outlet, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { StatusHeader } from "@/components/StatusHeader";
import { TerminalPanel } from "@/components/TerminalPanel";
import { useKeyboardShortcut } from "@/lib/useKeyboardShortcut";
import { subscribeEvents } from "@/lib/api";
import type { HermesEvent } from "@/lib/api";
import { isDesktop, nativeNotify } from "@/lib/native";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  const navigate = useNavigate();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const toggleTerminal = useCallback(() => setTerminalOpen((o) => !o), []);
  useKeyboardShortcut("`", toggleTerminal);

  // Browser notifications — managed at root so they fire on any route
  const [notifPerm, setNotifPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );

  const requestNotif = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setNotifPerm(result);
    localStorage.setItem("hermes-notif-asked", "1");
  }, []);

  const dismissNotif = useCallback(() => {
    localStorage.setItem("hermes-notif-asked", "1");
    setNotifPerm("denied");
  }, []);

  const desktop = isDesktop();
  const notifAsked = typeof localStorage !== "undefined" && localStorage.getItem("hermes-notif-asked") === "1";
  const showNotifStrip = !desktop && notifPerm === "default" && !notifAsked;

  // SSE listener for approval + budget notifications
  useEffect(() => {
    if (!desktop && notifPerm !== "granted") return;
    const unsub = subscribeEvents(
      (event: HermesEvent) => {
        if (!desktop && !document.hidden) return; // Browser: only when tab unfocused

        if (event.type === "approval.requested") {
          const cmd = (event.data?.command as string) || "unknown";
          if (desktop) {
            nativeNotify("Approval needed", cmd.slice(0, 60));
          } else {
            try {
              const n = new Notification("Approval needed", {
                body: cmd.slice(0, 60),
                tag: `approval-${event.data?.session_key ?? Date.now()}`,
              });
              n.onclick = () => { window.focus(); navigate({ to: "/approvals" }); };
            } catch { /* Notification API unavailable */ }
          }
        }

        if (event.type === "session.budget_exceeded") {
          const cost = (event.data?.estimated_cost as number)?.toFixed(2) ?? "?";
          const cap = (event.data?.budget_cap as number)?.toFixed(2) ?? "?";
          if (desktop) {
            nativeNotify("Budget exceeded", `$${cost} > $${cap} cap`);
          } else {
            try {
              const n = new Notification("Budget exceeded", {
                body: `$${cost} > $${cap} cap`,
                tag: `budget-${event.data?.session_id ?? Date.now()}`,
              });
              n.onclick = () => { window.focus(); navigate({ to: "/desk" }); };
            } catch { /* Notification API unavailable */ }
          }
        }
      },
      { replay: 0 },
    );
    return unsub;
  }, [desktop, notifPerm, navigate]);

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <StatusHeader onTerminalToggle={toggleTerminal} />
      <TerminalPanel open={terminalOpen} onOpenChange={setTerminalOpen} />
      {showNotifStrip && (
        <div className="flex items-center justify-between border-b border-rule bg-bg-alt px-10 py-1.5 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          <span>Enable notifications for approvals?</span>
          <span className="flex gap-3">
            <button onClick={requestNotif} className="text-oxide hover:underline">Accept</button>
            <button onClick={dismissNotif} className="text-ink-faint hover:underline">Dismiss</button>
          </span>
        </div>
      )}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
