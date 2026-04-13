import { createRootRouteWithContext, Outlet, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { StatusHeader } from "@/components/StatusHeader";
import { SidebarNav } from "@/components/SidebarNav";
import { useSidebarCollapse } from "@/lib/useSidebarCollapse";
import { subscribeEvents } from "@/lib/api";
import type { HermesEvent } from "@/lib/api";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  const { collapsed, toggle } = useSidebarCollapse();
  const navigate = useNavigate();

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

  const notifAsked = typeof localStorage !== "undefined" && localStorage.getItem("hermes-notif-asked") === "1";
  const showNotifStrip = notifPerm === "default" && !notifAsked;

  // SSE listener for approval + budget notifications
  useEffect(() => {
    if (notifPerm !== "granted") return;
    const unsub = subscribeEvents(
      (event: HermesEvent) => {
        if (!document.hidden) return; // Only notify when tab is unfocused

        if (event.type === "approval.requested") {
          const cmd = (event.data?.command as string) || "unknown";
          try {
            const n = new Notification("Approval needed", {
              body: cmd.slice(0, 60),
              tag: `approval-${event.data?.session_key ?? Date.now()}`,
            });
            n.onclick = () => { window.focus(); navigate({ to: "/approvals" }); };
          } catch { /* Notification API unavailable */ }
        }

        if (event.type === "session.budget_exceeded") {
          const cost = (event.data?.estimated_cost as number)?.toFixed(2) ?? "?";
          const cap = (event.data?.budget_cap as number)?.toFixed(2) ?? "?";
          try {
            const n = new Notification("Budget exceeded", {
              body: `$${cost} > $${cap} cap`,
              tag: `budget-${event.data?.session_id ?? Date.now()}`,
            });
            n.onclick = () => { window.focus(); navigate({ to: "/desk" }); };
          } catch { /* Notification API unavailable */ }
        }
      },
      { replay: 0 },
    );
    return unsub;
  }, [notifPerm, navigate]);

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <StatusHeader />
      {showNotifStrip && (
        <div className="flex items-center justify-between border-b border-rule bg-bg-alt px-10 py-1.5 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          <span>Enable notifications for approvals?</span>
          <span className="flex gap-3">
            <button onClick={requestNotif} className="text-oxide hover:underline">Accept</button>
            <button onClick={dismissNotif} className="text-ink-faint hover:underline">Dismiss</button>
          </span>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <SidebarNav collapsed={collapsed} onToggle={toggle} />
        <main className="relative flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
