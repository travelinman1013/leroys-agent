/**
 * Promise-based confirmation dialog.
 *
 * Usage:
 *   import { ConfirmProvider, useConfirm } from "@/lib/confirm";
 *
 *   // wrap once at the root:
 *   <ConfirmProvider>{children}</ConfirmProvider>
 *
 *   // call from any handler:
 *   const confirm = useConfirm();
 *   const ok = await confirm({
 *     title: "Delete session?",
 *     description: "This cannot be undone.",
 *     destructive: true,
 *   });
 *   if (!ok) return;
 *
 * Operator's Desk constraint: hairline border, no rounded corners, no
 * dramatic confirm dialogs. Plain text, two buttons, escape-to-cancel.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type Resolver = (ok: boolean) => void;

interface ConfirmContextValue {
  open: (opts: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<Resolver | null>(null);

  const open = useCallback((next: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOpts(next);
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setOpts(null);
  }, []);

  // Escape closes (cancel)
  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opts, close]);

  const value = useMemo(() => ({ open }), [open]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {opts && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget) close(false);
          }}
        >
          <div className="w-full max-w-md border border-rule bg-card p-6">
            <h2 className="mb-2 font-display text-lg leading-tight">
              {opts.title}
            </h2>
            {opts.description && (
              <p className="mb-4 text-sm text-muted-foreground">
                {opts.description}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => close(false)}
                type="button"
              >
                {opts.cancelLabel ?? "Cancel"}
              </Button>
              <Button
                variant={opts.destructive ? "destructive" : "default"}
                size="sm"
                onClick={() => close(true)}
                type="button"
              >
                {opts.confirmLabel ?? "Confirm"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    return async (opts: ConfirmOptions) => {
      // Fallback to native confirm if Provider missing.
      return window.confirm(`${opts.title}\n\n${opts.description ?? ""}`);
    };
  }
  return ctx.open;
}
