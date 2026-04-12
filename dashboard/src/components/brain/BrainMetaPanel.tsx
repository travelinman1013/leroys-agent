/**
 * BrainMetaPanel — right pane metadata for the current document.
 *
 * Dense, 13px mono. Shows path, source, last_modified (relative),
 * size, content_hash (truncated). Backlinks list. Action buttons.
 */

import { Copy, ExternalLink, Pencil } from "lucide-react";
import type { BrainDoc } from "@/lib/api";
import { relTimeFromUnix } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SectionMarker } from "./SectionMarker";

type Props = {
  doc: BrainDoc | null;
  source: string;
  onEdit: () => void;
  onSelectBacklink?: (path: string) => void;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BrainMetaPanel({ doc, source, onEdit, onSelectBacklink }: Props) {
  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <span className="font-mono text-[10px] uppercase tracking-marker text-ink-faint">
          select a document
        </span>
      </div>
    );
  }

  const handleCopyPath = () => {
    navigator.clipboard.writeText(doc.path).catch(() => {
      /* ignore clipboard failures */
    });
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <SectionMarker label="METADATA" className="mb-3" />

      <dl className="space-y-2">
        <MetaRow label="PATH" value={doc.path} />
        <MetaRow label="SOURCE" value={source} />
        <MetaRow label="MODIFIED" value={relTimeFromUnix(doc.last_modified)} />
        <MetaRow label="SIZE" value={formatBytes(doc.size)} />
        <MetaRow label="HASH" value={doc.content_hash.slice(0, 12)} />
      </dl>

      {doc.backlinks.length > 0 && (
        <>
          <SectionMarker label="BACKLINKS" className="mb-2 mt-5" />
          <ul className="space-y-1">
            {doc.backlinks.map((link) => (
              <li key={link}>
                <button
                  onClick={() => onSelectBacklink?.(link)}
                  className="w-full truncate text-left font-mono text-[12px] text-oxide transition-colors duration-120 ease-operator hover:text-oxide-hover"
                >
                  {link}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <SectionMarker label="ACTIONS" className="mb-2 mt-5" />
      <div className="flex flex-col gap-2">
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Pencil className="size-3" />
          EDIT
        </Button>
        <Button size="sm" variant="outline" onClick={handleCopyPath}>
          <Copy className="size-3" />
          COPY PATH
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            navigator.clipboard
              .writeText(`obsidian://open?vault=brain&file=${encodeURIComponent(doc.path)}`)
              .catch(() => {});
          }}
        >
          <ExternalLink className="size-3" />
          OBSIDIAN LINK
        </Button>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-2">
      <dt className="font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        {label}
      </dt>
      <dd className="break-all font-mono text-[13px] tabular-nums text-ink-2">
        {value}
      </dd>
    </div>
  );
}
