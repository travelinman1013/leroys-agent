/**
 * BrainSearchBox — inline sidebar search with 250ms debounce.
 *
 * Calls api.brainSearch(q, source). Shows results inline below input.
 * Click a result to navigate to that doc.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api, type BrainSearchHit } from "@/lib/api";
import { Input } from "@/components/ui/input";

type Props = {
  source?: string;
  onSelect?: (source: string, path: string) => void;
};

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function BrainSearchBox({ source, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 250);
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useQuery({
    queryKey: ["dashboard", "brain", "search", debounced, source ?? "*"],
    queryFn: () => api.brainSearch(debounced, source ?? "*", 20),
    enabled: debounced.length >= 2,
    staleTime: 10_000,
  });

  const handleSelect = useCallback(
    (hit: BrainSearchHit) => {
      onSelect?.(hit.source, hit.path);
      setQuery("");
    },
    [onSelect],
  );

  const results = debounced.length >= 2 ? (search.data?.results ?? []) : [];

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-ink-faint" />
        <Input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search docs..."
          className="h-8 pl-8 text-[12px]"
        />
      </div>
      {debounced.length >= 2 && (
        <div className="mt-1">
          {search.isLoading && (
            <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-marker text-ink-faint loading-cursor">
              searching
            </div>
          )}
          {!search.isLoading && results.length === 0 && (
            <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-marker text-ink-faint">
              no results
            </div>
          )}
          {results.map((hit) => (
            <button
              key={`${hit.source}:${hit.path}`}
              onClick={() => handleSelect(hit)}
              className="flex w-full flex-col gap-0.5 border-b border-rule/40 px-2 py-1.5 text-left transition-colors duration-120 ease-operator hover:bg-surface"
            >
              <span className="truncate font-mono text-[12px] text-ink">
                {hit.title || hit.path}
              </span>
              <span className="truncate font-mono text-[10px] text-ink-faint">
                {hit.source}/{hit.path}
              </span>
              {hit.snippet && (
                <span className="line-clamp-2 font-body text-[12px] text-ink-muted">
                  {hit.snippet}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
