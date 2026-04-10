/**
 * ApprovalCard — LangGraph Agent Inbox-style approval card.
 *
 * Renders a pending dangerous-command approval with four actions mapped
 * to Hermes' existing scope model:
 *   Accept once  → "once"
 *   This session → "session"
 *   Always       → "always"
 *   Deny         → "deny"
 */

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type PendingApproval } from "@/lib/api";
import { relTimeFromUnix } from "@/lib/utils";
import { Check, Clock, Infinity, X, Shield } from "lucide-react";

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
    <Card className="border-amber-900/50 bg-amber-950/10">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Shield className="size-4 text-amber-400" />
            Approval requested
          </CardTitle>
          <Badge variant="warn" className="font-mono text-[10px]">
            {approval.pattern_key}
          </Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          Session{" "}
          <span className="font-mono">{approval.session_key.slice(0, 24)}</span>
          {" · "}
          {relTimeFromUnix(approval.queued_at)}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <pre className="rounded-md bg-black/40 p-2 font-mono text-xs text-amber-100 whitespace-pre-wrap break-all">
          {approval.command}
        </pre>
        {approval.description && (
          <p className="text-xs text-muted-foreground">{approval.description}</p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="default"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("once")}
          >
            <Check className="size-3.5" />
            Once
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("session")}
          >
            <Clock className="size-3.5" />
            Session
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("always")}
          >
            <Infinity className="size-3.5" />
            Always
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("deny")}
          >
            <X className="size-3.5" />
            Deny
          </Button>
        </div>
        {mutation.isError && (
          <p className="text-xs text-destructive">
            {(mutation.error as Error).message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
