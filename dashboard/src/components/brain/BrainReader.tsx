/**
 * BrainReader — center pane document renderer.
 *
 * Fetches a doc via api.brainDoc and renders it through the Prose
 * component. Shows frontmatter as a subtle key-value table above
 * the body. Handles loading (oxide cursor), error, and empty states.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Prose } from "./Prose";

type Props = {
  source: string;
  path: string;
};

export function BrainReader({ source, path }: Props) {
  const doc = useQuery({
    queryKey: ["dashboard", "brain", "doc", source, path],
    queryFn: () => api.brainDoc(source, path),
    staleTime: 15_000,
  });

  if (doc.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="font-mono text-[11px] uppercase tracking-marker text-ink-muted loading-cursor">
          loading document
        </span>
      </div>
    );
  }

  if (doc.error) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="font-mono text-[11px] uppercase tracking-marker text-danger">
          failed to load: {String(doc.error)}
        </span>
      </div>
    );
  }

  if (!doc.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="font-mono text-[11px] uppercase tracking-marker text-ink-faint">
          document not found
        </span>
      </div>
    );
  }

  const { body, frontmatter } = doc.data;
  const fmEntries = Object.entries(frontmatter).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );

  return (
    <div className="h-full overflow-y-auto px-10 py-8">
      {fmEntries.length > 0 && (
        <div className="mb-6 border-b border-rule pb-4">
          <dl className="space-y-1">
            {fmEntries.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[120px_1fr] gap-3">
                <dt className="truncate font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                  {k}
                </dt>
                <dd className="break-words font-mono text-[12px] tabular-nums text-ink-2">
                  {typeof v === "object" ? JSON.stringify(v) : String(v)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {body ? (
        <Prose body={body} />
      ) : (
        <div className="py-12 text-center font-mono text-[11px] uppercase tracking-marker text-ink-faint">
          empty document
        </div>
      )}
    </div>
  );
}
