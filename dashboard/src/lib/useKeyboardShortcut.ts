/**
 * Keyboard shortcut hook.
 * Fires `callback` when the given `key` is pressed with Cmd (Mac) or Ctrl.
 */

import { useEffect } from "react";

interface ShortcutOptions {
  shift?: boolean;
}

export function useKeyboardShortcut(
  key: string,
  callback: () => void,
  opts?: ShortcutOptions,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === key && (e.metaKey || e.ctrlKey)) {
        if (opts?.shift && !e.shiftKey) return;
        if (!opts?.shift && e.shiftKey) return;
        e.preventDefault();
        callback();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [key, callback, opts?.shift]);
}
