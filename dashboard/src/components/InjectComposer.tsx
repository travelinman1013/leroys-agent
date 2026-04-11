/**
 * F1 — Inject user message composer.
 *
 * Shown at the bottom of an ENDED session detail. Submitting reopens
 * the session and appends the message — the next agent run will see
 * the injected history.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function InjectComposer({
  isPending,
  onSubmit,
}: {
  isPending: boolean;
  onSubmit: (content: string) => void;
}) {
  const [content, setContent] = useState("");
  const submit = () => {
    const trimmed = content.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setContent("");
  };
  return (
    <div className="mt-10 border border-rule bg-bg-alt p-4">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        inject user message · session will reopen
      </div>
      <Textarea
        rows={3}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="next user turn…"
      />
      <div className="mt-2 flex justify-end">
        <Button
          size="sm"
          disabled={isPending || !content.trim()}
          onClick={submit}
        >
          {isPending ? "INJECTING…" : "INJECT + REOPEN"}
        </Button>
      </div>
    </div>
  );
}
