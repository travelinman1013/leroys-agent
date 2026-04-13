/**
 * URL search param schemas + localStorage persistence for TanStack Router.
 *
 * Only filters and navigation state go in the URL.  Row selections,
 * dialog drafts, notification permission, and transient UI chrome
 * stay as React useState.
 */
import { z } from "zod";
import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Route-specific Zod schemas (used with TanStack Router validateSearch)
// ---------------------------------------------------------------------------

export const sessionsSearch = z.object({
  q: z.string().default(""),
  source: z.string().default(""),
  fromDays: z.number().default(0),
});
export type SessionsSearch = z.infer<typeof sessionsSearch>;

export const brainSearch = z.object({
  source: z.string().default("vault"),
  path: z.string().optional(),
});
export type BrainSearch = z.infer<typeof brainSearch>;

export const approvalsSearch = z.object({
  pattern: z.string().default(""),
  choice: z.string().default(""),
});
export type ApprovalsSearch = z.infer<typeof approvalsSearch>;

export const workflowsSearch = z.object({
  status: z.string().default(""),
});
export type WorkflowsSearch = z.infer<typeof workflowsSearch>;

export const cronSearch = z.object({
  expanded: z.string().optional(),
});
export type CronSearch = z.infer<typeof cronSearch>;

// ---------------------------------------------------------------------------
// localStorage persistence (cross-session state survival)
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "hermes:search:";

/**
 * Read stored search defaults from localStorage.
 * Returns an empty object if nothing stored or localStorage unavailable.
 */
export function getStoredDefaults(routeKey: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + routeKey);
    if (raw) return JSON.parse(raw);
  } catch {
    // localStorage unavailable (private mode, full, etc.) — non-blocking
  }
  return {};
}

/**
 * Persist non-default search params to localStorage.
 * Strips fields that match their schema default so we only store overrides.
 */
function writeToStorage(
  routeKey: string,
  search: Record<string, unknown>,
): void {
  try {
    // Only store non-empty, non-default values
    const toStore: Record<string, unknown> = {};
    let hasData = false;
    for (const [k, v] of Object.entries(search)) {
      if (v !== undefined && v !== "" && v !== 0) {
        toStore[k] = v;
        hasData = true;
      }
    }
    if (hasData) {
      localStorage.setItem(STORAGE_PREFIX + routeKey, JSON.stringify(toStore));
    } else {
      localStorage.removeItem(STORAGE_PREFIX + routeKey);
    }
  } catch {
    // localStorage unavailable — non-blocking
  }
}

/**
 * React hook that syncs search params to localStorage on change.
 * Call in any route component that uses validateSearch.
 */
export function useSyncSearchToStorage(
  routeKey: string,
  search: Record<string, unknown>,
): void {
  useEffect(() => {
    writeToStorage(routeKey, search);
  }, [routeKey, JSON.stringify(search)]);
}
