import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { bootstrapTheme } from "./lib/theme";
import { ToastProvider } from "./lib/notifications";
import { ConfirmProvider } from "./lib/confirm";
import "./index.css";

// Apply Operator's Desk theme before React paints — avoids a dark→light flash
// when the user has chosen light mode in a prior session.
bootstrapTheme();

// TanStack Query — server state cache & revalidation
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

// TanStack Router — client-side routing.
//
// The dashboard is served under the /dashboard/ path prefix (see the
// aiohttp static mount + SPA fallback in gateway/platforms/dashboard_routes.py).
// Without ``basepath``, every <Link to="/foo"> would emit an href of
// ``/foo`` instead of ``/dashboard/foo``, which (a) leaks outside the
// dashboard prefix the moment the user clicks, (b) 404s on hard refresh
// once the URL bar reads ``/foo``, and (c) breaks bookmarks. The
// loopback same-origin CORS fix in api_server.py complements this — both
// are required for the dashboard to survive a hard refresh.
const router = createRouter({
  routeTree,
  basepath: "/dashboard",
  defaultPreload: "intent",
  context: { queryClient },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
