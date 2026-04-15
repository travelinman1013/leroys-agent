/**
 * ApprovalCard — Operator's Desk lab-notebook approval card.
 *
 * Hairline border with an oxide left rule, mono lab label, italic stamp
 * "ask", mono command block. Four actions in the LangGraph Agent Inbox
 * shape (once / session / always / deny). See DESIGN.md §6 (preview §05).
 */

import { Button } from "@/components/ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type PendingApproval } from "@/lib/api";
import { relTimeFromUnix } from "@/lib/utils";

type Props = {
  approval: PendingApproval;
};

export function ApprovalCard({ approval }: Props) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (choice: "once" | "session" | "always" | "deny") =>
      api.resolveApproval(approval.session_key, choice),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard", "state"] });
      qc.invalidateQueries({ queryKey: ["dashboard", "approvals"] });
    },
  });

  return (
    <div className="relative grid grid-cols-1 gap-6 border border-oxide-edge bg-bg p-6 md:grid-cols-[1fr_auto] md:items-end">
      {/* oxide left rule */}
      <span className="absolute inset-y-0 left-0 w-[3px] bg-oxide" />

      <div className="pl-3">
        <div className="font-mono text-[10px] uppercase tracking-marker text-oxide">
          ─── APPROVAL REQUIRED · {approval.pattern_key.toUpperCase()} ───────
        </div>
        <p className="mt-2 font-stamp text-[28px] italic leading-tight text-ink">
          Leroys wants to <em className="text-oxide">{approval.pattern_key}</em>
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          Session{" "}
          <span className="font-mono text-ink">
            {approval.session_key.slice(0, 24)}
          </span>{" "}
          · queued {relTimeFromUnix(approval.queued_at)}
          {approval.description && (
            <>
              {" · "}
              {approval.description}
            </>
          )}
        </p>
        <pre className="mt-3 whitespace-pre-wrap break-all border border-rule bg-bg-alt px-3.5 py-2.5 font-mono text-[12px] text-ink">
          {approval.command}
        </pre>
        {mutation.isError && (
          <p className="mt-2 font-mono text-[11px] uppercase tracking-marker text-danger">
            {(mutation.error as Error).message}
          </p>
        )}
      </div>

      <div className="flex min-w-[160px] flex-col gap-2 pl-3 md:pl-0">
        <Button
          size="sm"
          variant="default"
          className="w-full"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate("once")}
        >
          Approve once
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="w-full"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate("session")}
        >
          Session
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="w-full"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate("always")}
        >
          Always
        </Button>
        <Button
          size="sm"
          variant="destructive"
          className="w-full"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate("deny")}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}
