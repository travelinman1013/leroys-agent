import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { StatusHeader } from "@/components/StatusHeader";
import { SidebarNav } from "@/components/SidebarNav";
import { useSidebarCollapse } from "@/lib/useSidebarCollapse";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  // Sidebar collapse state hoisted to the root so SidebarNav (which
  // renders the toggle button) and the layout (which owns the flex
  // container) share a single source of truth. See
  // `lib/useSidebarCollapse.ts` for the resize + shortcut behavior.
  const { collapsed, toggle } = useSidebarCollapse();
  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      <StatusHeader />
      <div className="flex flex-1 overflow-hidden">
        <SidebarNav collapsed={collapsed} onToggle={toggle} />
        <main className="relative flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
