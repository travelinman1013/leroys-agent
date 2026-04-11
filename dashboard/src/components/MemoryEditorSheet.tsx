/**
 * F2 — Memory editor sheet.
 *
 * Edits a single memory entry by content hash. Used from the brain
 * detail card "EDIT" button. Calls api.replaceMemory which routes
 * through MemoryStore.replace (file lock + threat scan enforced
 * server-side).
 */

import { useEffect, useState } from "react";
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
import { useQueryClient } from "@tanstack/react-query";

type Store = "MEMORY.md" | "USER.md";
type Mode = "edit" | "create";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  store: Store;
  hash?: string;
  initialContent?: string;
}

const STORE_LIMITS: Record<Store, number> = {
  "MEMORY.md": 2200,
  "USER.md": 1375,
};

export function MemoryEditorSheet({
  open,
  onOpenChange,
  mode,
  store,
  hash,
  initialContent,
}: Props) {
  const [content, setContent] = useState(initialContent ?? "");
  const queryClient = useQueryClient();

  useEffect(() => {
    setContent(initialContent ?? "");
  }, [initialContent, open]);

  const limit = STORE_LIMITS[store];
  const overLimit = content.length > limit;

  const invalidateBrain = () => {
    queryClient.invalidateQueries({
      queryKey: ["dashboard", "brain", "graph"],
    });
  };

  const create = useApiMutation({
    mutationFn: () => api.addMemory({ store, content }),
    successMessage: `Added to ${store}`,
    onSuccess: () => {
      onOpenChange(false);
      invalidateBrain();
    },
  });

  const replace = useApiMutation({
    mutationFn: () => api.replaceMemory(hash!, store, content),
    successMessage: `Updated entry in ${store}`,
    onSuccess: () => {
      onOpenChange(false);
      invalidateBrain();
    },
  });

  const submit = () => {
    if (overLimit) return;
    if (mode === "create") create.mutate();
    else if (hash) replace.mutate();
  };

  const isPending = create.isPending || replace.isPending;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>
            {mode === "create" ? "ADD MEMORY" : "EDIT MEMORY"} · {store}
          </SheetTitle>
          <SheetDescription>
            Entries are injected into the system prompt at session start.
            Threat scan applies — no injection prompts, no exfil patterns.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <Textarea
            rows={14}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={
              mode === "create"
                ? "What should the agent remember?"
                : ""
            }
            className={overLimit ? "border-danger" : undefined}
          />
          <div className="mt-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            <span>{store}</span>
            <span
              className={
                overLimit
                  ? "text-danger"
                  : content.length > limit * 0.85
                  ? "text-oxide"
                  : ""
              }
            >
              {content.length.toLocaleString()} / {limit.toLocaleString()} chars
            </span>
          </div>
        </SheetBody>
        <SheetFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            CANCEL
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isPending || overLimit || !content.trim()}
            onClick={submit}
          >
            {isPending ? "SAVING…" : mode === "create" ? "ADD" : "SAVE"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
