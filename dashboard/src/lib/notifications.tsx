/**
 * Minimal toast notification system for the dashboard.
 *
 * Operator's Desk constraint: no rainbow toasts, no purple gradients,
 * no auto-dismiss popovers that obscure transcript text. Toasts are
 * dense, single-line, hairline-bordered, and aligned bottom-right.
 *
 * Usage:
 *   import { ToastProvider, useNotify } from "@/lib/notifications";
 *
 *   // wrap once at the root:
 *   <ToastProvider>{children}</ToastProvider>
 *
 *   // call from any component:
 *   const notify = useNotify();
 *   notify.success("Saved");
 *   notify.error("Save failed: …");
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

type Variant = "success" | "error" | "info";

interface Toast {
  id: number;
  variant: Variant;
  message: string;
}

interface ToastContextValue {
  push: (variant: Variant, message: string, durationMs?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const push = useCallback(
    (variant: Variant, message: string, durationMs = 4000) => {
      const id = ++idRef.current;
      setToasts((prev) => [...prev, { id, variant, message }]);
      if (durationMs > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, durationMs);
      }
    },
    [],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
        aria-live="polite"
        aria-atomic
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              "pointer-events-auto border border-rule bg-card px-3 py-2 text-sm " +
              (t.variant === "error"
                ? "text-destructive"
                : t.variant === "success"
                ? "text-foreground"
                : "text-muted-foreground")
            }
            role="status"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="leading-tight">{t.message}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setToasts((prev) => prev.filter((x) => x.id !== t.id))
                }
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export interface Notify {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

export function useNotify(): Notify {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Tolerant fallback so callers don't crash if Provider is missing in tests.
    return {
      success: (m) => console.info("[toast.success]", m),
      error: (m) => console.error("[toast.error]", m),
      info: (m) => console.info("[toast.info]", m),
    };
  }
  return useMemo<Notify>(
    () => ({
      success: (m) => ctx.push("success", m),
      error: (m) => ctx.push("error", m, 7000),
      info: (m) => ctx.push("info", m),
    }),
    // ctx.push is stable
    [ctx],
  );
}

// Effect helper — useful when triggering toasts inside useEffect without
// stale-closure pitfalls.
export function useToastOnChange(value: unknown, message: string | null) {
  const notify = useNotify();
  useEffect(() => {
    if (value && message) notify.info(message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}
