/**
 * F4 — Tool invoke drawer.
 *
 * Generic JSON-args invoke. The dashboard route enforces the approval
 * gate AND the path jail; this is just the form. If the route comes
 * back as 202 needs_approval the dialog surfaces the message and
 * suggests resolving via /approvals.
 */

import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
  SheetFooter,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useApiMutation } from "@/lib/mutations";
import { api } from "@/lib/api";

export function ToolInvokeDrawer({
  open,
  onOpenChange,
  toolName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toolName: string;
}) {
  const [argsJson, setArgsJson] = useState("{}");
  const [response, setResponse] = useState<unknown>(null);

  const invoke = useApiMutation({
    mutationFn: (args: Record<string, unknown>) => api.invokeTool(toolName, args),
    successMessage: (r) =>
      r?.needs_approval ? "Approval required" : "Tool invoked",
    onSuccess: (r) => setResponse(r),
  });

  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    const value = JSON.parse(argsJson);
    if (typeof value !== "object" || Array.isArray(value)) {
      parseError = "args must be a JSON object";
    } else {
      parsed = value;
    }
  } catch (err) {
    parseError = (err as Error).message;
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent width="w-[560px]">
        <SheetHeader>
          <SheetTitle>INVOKE · {toolName}</SheetTitle>
          <SheetDescription>
            Calls run through the same approval + path-jail gates as the
            agent loop. Dangerous shell commands return 202 needs_approval
            instead of executing.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
              args (JSON object)
            </span>
            <Textarea
              rows={10}
              value={argsJson}
              onChange={(e) => setArgsJson(e.target.value)}
              className={parseError ? "mt-1 border-danger" : "mt-1"}
            />
            {parseError && (
              <p className="mt-1 font-mono text-[10px] uppercase tracking-marker text-danger">
                {parseError}
              </p>
            )}
          </label>

          {response != null && (
            <div className="mt-4">
              <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                response
              </span>
              <pre className="mt-1 max-h-64 overflow-auto border border-rule bg-bg p-3 font-mono text-[11px] text-ink">
                {JSON.stringify(response, null, 2)}
              </pre>
            </div>
          )}
        </SheetBody>
        <SheetFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            CLOSE
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!parsed || invoke.isPending}
            onClick={() => parsed && invoke.mutate(parsed)}
          >
            {invoke.isPending ? "INVOKING…" : "INVOKE"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
