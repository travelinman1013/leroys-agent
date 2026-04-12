/**
 * BrainEditor — monospace textarea for editing brain documents.
 *
 * Replaces BrainReader when edit mode is toggled. Save dispatches
 * api.brainDocWrite. Shows pending state (textarea dims, oxide bar
 * with "Waiting for approval"). Cancel exits edit mode. Unsaved
 * content warns via beforeunload.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useApiMutation } from "@/lib/mutations";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  source: string;
  path: string;
  initialContent: string;
  contentHash: string;
  onClose: () => void;
  onSaved: () => void;
};

export function BrainEditor({
  source,
  path,
  initialContent,
  contentHash,
  onClose,
  onSaved,
}: Props) {
  const [content, setContent] = useState(initialContent);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isDirty = content !== initialContent;

  // Warn on unload if dirty
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const save = useApiMutation({
    mutationFn: () =>
      api.brainDocWrite({
        source,
        path,
        content,
        expected_hash: contentHash,
      }),
    successMessage: "Document saved",
    invalidate: [
      ["dashboard", "brain", "doc", source, path],
      ["dashboard", "brain", "tree", source],
      ["dashboard", "brain", "timeline"],
    ],
    onSuccess: () => {
      onSaved();
    },
  });

  const handleSave = useCallback(() => {
    save.mutate();
  }, [save]);

  const handleCancel = useCallback(() => {
    if (isDirty) {
      const confirmed = window.confirm(
        "You have unsaved changes. Discard them?",
      );
      if (!confirmed) return;
    }
    onClose();
  }, [isDirty, onClose]);

  // Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && !save.isPending) {
          handleSave();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDirty, save.isPending, handleSave]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b border-rule px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            editing
          </span>
          <span className="truncate font-mono text-[12px] text-ink-2">
            {path}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleCancel}
            disabled={save.isPending}
          >
            CANCEL
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || save.isPending}
          >
            {save.isPending ? "SAVING..." : "SAVE"}
          </Button>
        </div>
      </div>

      {/* Pending approval bar */}
      {save.isPending && (
        <div className="shrink-0 border-b border-oxide bg-oxide-wash px-6 py-2 font-mono text-[10px] uppercase tracking-marker text-oxide">
          Waiting for approval...
        </div>
      )}

      {/* Editor area */}
      <div className="relative flex-1">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className={cn(
            "h-full w-full resize-none border-none bg-bg p-6 font-mono text-[13px] leading-snug text-ink outline-none",
            save.isPending && "opacity-60",
          )}
          disabled={save.isPending}
        />
      </div>
    </div>
  );
}
