/**
 * Sidebar collapse state for the Operator's Desk dashboard.
 *
 * Behavior (from ~/.claude/plans/ashen-tempering-ibis.md §2 Commit 3c):
 *
 * 1. Auto-collapse at viewport widths below `BREAKPOINT_PX`. This
 *    keeps the sidebar out of the way on narrow laptops without
 *    forcing the user to toggle it manually.
 *
 * 2. Keyboard shortcut: ⌘\ on Mac, Ctrl+\ elsewhere. Matches the
 *    convention used by VS Code, Linear, and most tools the user
 *    already lives in.
 *
 * 3. Session-only persistence. We do NOT write to localStorage so
 *    that opening a new window always starts at the resize-aware
 *    default. The alternative — persisting across sessions — would
 *    conflict with the auto-collapse: a collapse chosen on a narrow
 *    window would stick when the user next opens a wide window, and
 *    vice versa. The rule is "each session starts from the default
 *    for its current viewport side, and the user can override for
 *    this session until the viewport crosses the breakpoint."
 *
 * 4. Crossing the breakpoint on resize resets the state to the
 *    auto-default for the new side. This wipes the user override
 *    from the previous side — each side owns its own override.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboardShortcut } from "./useKeyboardShortcut";

export const SIDEBAR_BREAKPOINT_PX = 1280;
export const MOBILE_BREAKPOINT_PX = 768;

function isNarrowViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth < SIDEBAR_BREAKPOINT_PX;
}

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth < MOBILE_BREAKPOINT_PX;
}

export function useSidebarCollapse() {
  // Start collapsed if the viewport is narrow on first render.
  const [collapsed, setCollapsed] = useState<boolean>(() => isNarrowViewport());
  // Mobile overlay state: below 768px the sidebar is an overlay
  // that opens/closes independently of the desktop collapse state.
  const [mobileOpen, setMobileOpen] = useState(false);
  // Track the current side of the breakpoint so we can detect a
  // crossing and reset state. Initial value matches the initial
  // `collapsed` state — same input.
  const lastNarrowRef = useRef<boolean>(isNarrowViewport());
  const lastMobileRef = useRef<boolean>(isMobileViewport());

  const toggle = useCallback(() => {
    if (isMobileViewport()) {
      setMobileOpen((current) => !current);
    } else {
      setCollapsed((current) => !current);
    }
  }, []);

  const closeMobile = useCallback(() => {
    setMobileOpen(false);
  }, []);

  // Auto-adjust on viewport resize when crossing breakpoints.
  useEffect(() => {
    const onResize = () => {
      const narrow = isNarrowViewport();
      const mobile = isMobileViewport();

      // Close mobile overlay when resizing above mobile breakpoint
      if (!mobile && lastMobileRef.current) {
        setMobileOpen(false);
      }

      if (narrow !== lastNarrowRef.current) {
        lastNarrowRef.current = narrow;
        // Crossed — reset to the auto-default for the new side.
        setCollapsed(narrow);
      }
      lastMobileRef.current = mobile;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Keyboard shortcut: ⌘\ / Ctrl+\ toggle.
  useKeyboardShortcut("\\", toggle);

  return { collapsed, toggle, mobileOpen, closeMobile };
}
