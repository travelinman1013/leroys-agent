/**
 * BrainTree — hierarchical file tree for the brain sidebar.
 *
 * Dense: 12px mono, hairline rows. Expand/collapse directories with
 * arrow icons. Click a file to select it. Keyboard navigation:
 * up/down to move, enter to open, left/right to collapse/expand.
 */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { ChevronRight, File, Folder, FolderOpen, Ban } from "lucide-react";
import { api, type BrainTreeNode } from "@/lib/api";
import { cn } from "@/lib/utils";

type Props = {
  source: string;
  activePath?: string;
  onSelect?: (path: string) => void;
};

export function BrainTree({ source, activePath, onSelect }: Props) {
  const tree = useQuery({
    queryKey: ["dashboard", "brain", "tree", source],
    queryFn: () => api.brainTree(source),
    staleTime: 30_000,
  });

  const containerRef = useRef<HTMLDivElement>(null);

  if (tree.isLoading) {
    return (
      <div className="px-2 py-2 font-mono text-[11px] uppercase tracking-marker text-ink-faint loading-cursor">
        loading tree
      </div>
    );
  }

  if (tree.error) {
    return (
      <div className="px-2 py-2 font-mono text-[11px] uppercase tracking-marker text-danger">
        failed to load tree
      </div>
    );
  }

  if (!tree.data) return null;

  const rootChildren = tree.data.children ?? [tree.data];

  return (
    <div
      ref={containerRef}
      className="overflow-y-auto"
      role="tree"
    >
      {rootChildren.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  activePath,
  onSelect,
}: {
  node: BrainTreeNode;
  depth: number;
  activePath?: string;
  onSelect?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const isDir = node.type === "dir";
  const isBinary = node.type === "binary";
  const isActive = node.path === activePath;

  const handleClick = useCallback(() => {
    if (isDir) {
      setExpanded((p) => !p);
    } else if (!isBinary && onSelect) {
      onSelect(node.path);
    }
  }, [isDir, isBinary, node.path, onSelect]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleClick();
        e.preventDefault();
      } else if (e.key === "ArrowRight" && isDir && !expanded) {
        setExpanded(true);
        e.preventDefault();
      } else if (e.key === "ArrowLeft" && isDir && expanded) {
        setExpanded(false);
        e.preventDefault();
      }
    },
    [handleClick, isDir, expanded],
  );

  const paddingLeft = 8 + depth * 14;

  return (
    <div role="treeitem" aria-expanded={isDir ? expanded : undefined}>
      <button
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        disabled={isBinary}
        style={{ paddingLeft }}
        className={cn(
          "flex w-full items-center gap-1.5 border-b border-rule/40 py-1 pr-2 text-left font-mono text-[12px] transition-colors duration-120 ease-operator",
          isActive
            ? "bg-oxide-wash text-oxide"
            : isBinary
              ? "cursor-not-allowed text-ink-faint"
              : "text-ink-2 hover:bg-surface hover:text-ink",
        )}
      >
        {isDir ? (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 transition-transform duration-120",
              expanded && "rotate-90",
            )}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {isDir ? (
          expanded ? (
            <FolderOpen className="size-3 shrink-0 text-ink-muted" />
          ) : (
            <Folder className="size-3 shrink-0 text-ink-muted" />
          )
        ) : isBinary ? (
          <Ban className="size-3 shrink-0 text-ink-faint" />
        ) : (
          <File className="size-3 shrink-0 text-ink-muted" />
        )}
        <span className="min-w-0 truncate">{node.name}</span>
        {isDir && node.count !== undefined && (
          <span className="ml-auto shrink-0 tabular-nums text-ink-faint">
            {node.count}
          </span>
        )}
      </button>
      {isDir && expanded && node.children && (
        <div role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
