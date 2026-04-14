/**
 * /workflows — redirects to /cron (consolidated in Phase 11 P4).
 *
 * Workflow management is now part of the cron page. This route exists
 * only to avoid breaking bookmarks.
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/workflows")({
  beforeLoad: () => {
    throw redirect({ to: "/cron" });
  },
});
