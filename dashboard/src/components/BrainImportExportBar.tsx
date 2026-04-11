/**
 * F2 — Brain memory import / export bar.
 *
 * Export: pulls JSON dumps of MEMORY.md and USER.md and triggers
 * a browser download. Import: prompts for a file, then POSTs the raw
 * content to the import route. Threat scan applies server-side.
 */

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useApiMutation } from "@/lib/mutations";
import { api } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";

type Store = "MEMORY.md" | "USER.md";

export function BrainImportExportBar() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importDialog, setImportDialog] = useState<{
    open: boolean;
    store: Store;
    raw: string;
    mode: "replace" | "append";
  }>({ open: false, store: "MEMORY.md", raw: "", mode: "replace" });

  const importMutation = useApiMutation({
    mutationFn: () =>
      api.importMemory({
        store: importDialog.store,
        raw_content: importDialog.raw,
        mode: importDialog.mode,
      }),
    successMessage: ({}, _) => `Imported into ${importDialog.store}`,
    onSuccess: () => {
      setImportDialog((p) => ({ ...p, open: false, raw: "" }));
      queryClient.invalidateQueries({
        queryKey: ["dashboard", "brain", "graph"],
      });
    },
  });

  const exportBoth = async () => {
    const data = await api.exportMemory("both");
    for (const [name, payload] of Object.entries(data)) {
      const blob = new Blob([payload.raw], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const guessed: Store =
      file.name.toLowerCase().includes("user") ? "USER.md" : "MEMORY.md";
    setImportDialog({
      open: true,
      store: guessed,
      raw: text,
      mode: "replace",
    });
    // reset so the same file can be re-selected
    e.target.value = "";
  };

  return (
    <>
      <div className="flex items-center justify-end gap-2 border-b border-rule bg-bg-alt px-10 py-2 font-mono text-[10px] uppercase tracking-marker">
        <span className="text-ink-faint">─── BRAIN ──</span>
        <Button size="sm" variant="outline" onClick={exportBoth}>
          EXPORT
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
        >
          IMPORT
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={onFile}
        />
      </div>

      <Dialog
        open={importDialog.open}
        onOpenChange={(o) => setImportDialog((p) => ({ ...p, open: o }))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import memory</DialogTitle>
            <DialogDescription>
              Pick the target store, review the parsed content, then import.
              Replace overwrites everything; append merges with existing
              entries (skipping duplicates).
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <label className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
              store
              <select
                value={importDialog.store}
                onChange={(e) =>
                  setImportDialog((p) => ({ ...p, store: e.target.value as Store }))
                }
                className="mt-1 block w-full border border-rule bg-bg px-2 py-1 font-mono text-[11px] uppercase text-ink"
              >
                <option value="MEMORY.md">MEMORY.md</option>
                <option value="USER.md">USER.md</option>
              </select>
            </label>
            <label className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
              mode
              <select
                value={importDialog.mode}
                onChange={(e) =>
                  setImportDialog((p) => ({
                    ...p,
                    mode: e.target.value as "replace" | "append",
                  }))
                }
                className="mt-1 block w-full border border-rule bg-bg px-2 py-1 font-mono text-[11px] uppercase text-ink"
              >
                <option value="replace">replace (overwrite)</option>
                <option value="append">append (merge)</option>
              </select>
            </label>
          </div>
          <div className="mt-3">
            <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
              parsed content
            </span>
            <Textarea
              rows={10}
              value={importDialog.raw}
              onChange={(e) =>
                setImportDialog((p) => ({ ...p, raw: e.target.value }))
              }
              className="mt-1"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setImportDialog((p) => ({ ...p, open: false }))
              }
            >
              CANCEL
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={importMutation.isPending || !importDialog.raw.trim()}
              onClick={() => importMutation.mutate()}
            >
              {importMutation.isPending ? "IMPORTING…" : "IMPORT"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
