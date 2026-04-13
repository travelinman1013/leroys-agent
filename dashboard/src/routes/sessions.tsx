/**
 * /sessions — Redirect to /desk (session list absorbed by Desk in Phase 10).
 *
 * The child route /sessions/$id still renders the editorial transcript.
 * TanStack Router runs parent beforeLoad BEFORE children, so we use a
 * component redirect (not beforeLoad) to preserve the child route.
 */

import {
  createFileRoute,
  Navigate,
  Outlet,
  useMatchRoute,
} from "@tanstack/react-router";
import { sessionsSearch } from "@/lib/searchParams";

export const Route = createFileRoute("/sessions")({
  component: SessionsRedirect,
  validateSearch: sessionsSearch,
});

function SessionsRedirect() {
  const matchRoute = useMatchRoute();

  // If a child route matches (e.g. /sessions/$id), render it
  if (matchRoute({ to: "/sessions/$id" })) {
    return <Outlet />;
  }

  // Otherwise redirect list view to /desk
  return <Navigate to="/desk" />;
}
