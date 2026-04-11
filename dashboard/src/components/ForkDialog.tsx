/**
 * F1 — Fork session dialog. Lets the user pick a turn boundary and a
 * title before forking. Used from the session detail view.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function ForkDialog({
  open,
  onOpenChange,
  upToTurn,
  defaultTitle,
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  upToTurn: number;
  defaultTitle?: string;
  isPending?: boolean;
  onConfirm: (title: string) => void;
}) {
  const [title, setTitle] = useState(defaultTitle ?? "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fork session at turn {upToTurn + 1}</DialogTitle>
          <DialogDescription>
            Creates a child session containing the first {upToTurn + 1} turns
            of this transcript. The new session is linked to its parent and
            can be replayed independently.
          </DialogDescription>
        </DialogHeader>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            new title (optional)
          </span>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="will default to '<source title> (fork)'"
            className="mt-1"
          />
        </label>
        <DialogFooter>
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
            disabled={isPending}
            onClick={() => onConfirm(title.trim())}
          >
            {isPending ? "FORKING…" : "FORK"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
