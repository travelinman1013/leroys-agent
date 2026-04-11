import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { StatusHeader } from "@/components/StatusHeader";
import { SidebarNav } from "@/components/SidebarNav";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <StatusHeader />
      <div className="flex flex-1 overflow-hidden">
        <SidebarNav />
        <main className="relative flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
