/**
 * /brain — Hermes' brain: three-pane document reader + editor.
 *
 * Phase 6 R2 — replaces the original star-chart-only page with a
 * full knowledge-base browser. The star chart moves to a Sheet
 * accessible via Cmd+G or the header button.
 *
 * Layout (>= 1200px): sidebar (cols 1-3) | reader (cols 4-10) | meta (cols 11-12)
 * < 1200px: sidebar becomes a drawer, < 900px: meta becomes bottom sheet.
 *
 * State is internal (activeSource, activePath, editing) — no nested routes.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Map, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetBody,
} from "@/components/ui/sheet";

import { SectionMarker } from "@/components/brain/SectionMarker";
import { BrainSourceTabs } from "@/components/brain/BrainSourceTabs";
import { BrainTree } from "@/components/brain/BrainTree";
import { BrainSearchBox } from "@/components/brain/BrainSearchBox";
import { BrainTimeline } from "@/components/brain/BrainTimeline";
import { BrainReader } from "@/components/brain/BrainReader";
import { BrainEditor } from "@/components/brain/BrainEditor";
import { BrainMetaPanel } from "@/components/brain/BrainMetaPanel";
import { BrainGraphSheet } from "@/components/brain/BrainGraphSheet";

export const Route = createFileRoute("/brain")({
  component: BrainPage,
});

function BrainPage() {
  const [activeSource, setActiveSource] = useState("vault");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [metaSheetOpen, setMetaSheetOpen] = useState(false);

  // Fetch sources for total count
  const sources = useQuery({
    queryKey: ["dashboard", "brain", "sources"],
    queryFn: api.brainSources,
    staleTime: 60_000,
  });

  const totalDocs = useMemo(() => {
    if (!sources.data) return 0;
    return sources.data.reduce((sum, s) => sum + s.count, 0);
  }, [sources.data]);

  // Fetch current doc for meta panel + editor
  const doc = useQuery({
    queryKey: ["dashboard", "brain", "doc", activeSource, activePath],
    queryFn: () => api.brainDoc(activeSource, activePath!),
    enabled: !!activePath,
    staleTime: 15_000,
  });

  const handleSelectPath = useCallback((path: string) => {
    setActivePath(path);
    setEditing(false);
    setSidebarOpen(false);
  }, []);

  const handleSearchSelect = useCallback((source: string, path: string) => {
    setActiveSource(source);
    setActivePath(path);
    setEditing(false);
    setSidebarOpen(false);
  }, []);

  const handleTimelineSelect = useCallback((source: string, path: string) => {
    setActiveSource(source);
    setActivePath(path);
    setEditing(false);
  }, []);

  const handleBacklink = useCallback((path: string) => {
    setActivePath(path);
    setEditing(false);
  }, []);

  const handleEditToggle = useCallback(() => {
    setEditing((p) => !p);
  }, []);

  const handleEditorClose = useCallback(() => {
    setEditing(false);
  }, []);

  const handleEditorSaved = useCallback(() => {
    setEditing(false);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "g") {
        e.preventDefault();
        setGraphOpen((p) => !p);
      } else if (meta && e.key === "k") {
        e.preventDefault();
        // Focus search — sidebar must be visible on mobile
        setSidebarOpen(true);
      } else if (meta && e.key === "e" && activePath) {
        e.preventDefault();
        setEditing((p) => !p);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activePath]);

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Header */}
      <header className="grid shrink-0 grid-cols-[1fr_auto] items-end gap-6 border-b border-rule px-10 pb-6 pt-9">
        <div>
          <h1 className="page-stamp text-[56px]">
            the <em>brain</em>
          </h1>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
            KNOWLEDGE BASE BROWSER &middot; CMD+K SEARCH &middot; CMD+G STAR
            CHART
          </p>
        </div>
        <div className="flex items-end gap-6">
          {totalDocs > 0 && (
            <div className="text-right">
              <div className="font-display text-[56px] font-bold leading-none tracking-big tabular-nums text-oxide">
                {totalDocs}
              </div>
              <div className="mt-2 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
                DOCUMENTS
              </div>
            </div>
          )}
          {/* Sidebar toggle (mobile) */}
          <Button
            size="icon"
            variant="ghost"
            className="xl:hidden"
            onClick={() => setSidebarOpen((p) => !p)}
            title="Toggle sidebar"
          >
            {sidebarOpen ? (
              <PanelLeftClose className="size-4" />
            ) : (
              <PanelLeftOpen className="size-4" />
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setGraphOpen(true)}
            title="Star chart (Cmd+G)"
          >
            <Map className="size-3" />
            STAR CHART
          </Button>
        </div>
      </header>

      {/* Three-pane layout */}
      <div className="relative flex min-h-0 flex-1">
        {/* Sidebar — visible inline >= 1200px, drawer below */}
        <aside
          className={cn(
            "hidden w-[280px] shrink-0 flex-col border-r border-rule bg-bg-alt xl:flex",
          )}
        >
          <SidebarContent
            activeSource={activeSource}
            activePath={activePath ?? undefined}
            onSourceChange={setActiveSource}
            onSelectPath={handleSelectPath}
            onSearchSelect={handleSearchSelect}
            onTimelineSelect={handleTimelineSelect}
          />
        </aside>

        {/* Sidebar drawer for < 1200px */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" width="w-[300px]" className="rounded-none xl:hidden">
            <SheetHeader>
              <SheetTitle className="font-mono text-[10px] uppercase tracking-marker">
                BROWSER
              </SheetTitle>
              <SheetDescription className="sr-only">
                Brain file browser sidebar
              </SheetDescription>
            </SheetHeader>
            <SheetBody className="px-0">
              <SidebarContent
                activeSource={activeSource}
                activePath={activePath ?? undefined}
                onSourceChange={setActiveSource}
                onSelectPath={handleSelectPath}
                onSearchSelect={handleSearchSelect}
                onTimelineSelect={handleTimelineSelect}
              />
            </SheetBody>
          </SheetContent>
        </Sheet>

        {/* Center pane — reader or editor */}
        <main className="flex min-w-0 flex-1 flex-col">
          {activePath ? (
            editing && doc.data ? (
              <BrainEditor
                source={activeSource}
                path={activePath}
                initialContent={doc.data.body}
                contentHash={doc.data.content_hash}
                onClose={handleEditorClose}
                onSaved={handleEditorSaved}
              />
            ) : (
              <BrainReader source={activeSource} path={activePath} />
            )
          ) : (
            <WelcomeState />
          )}
        </main>

        {/* Meta panel — inline >= 1200px, bottom sheet on small screens */}
        {activePath && (
          <>
            {/* Desktop meta panel */}
            <aside className="hidden w-[220px] shrink-0 border-l border-rule bg-bg-alt xl:block">
              <BrainMetaPanel
                doc={doc.data ?? null}
                source={activeSource}
                onEdit={handleEditToggle}
                onSelectBacklink={handleBacklink}
              />
            </aside>

            {/* Mobile meta trigger */}
            <div className="absolute bottom-4 right-4 xl:hidden">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setMetaSheetOpen(true)}
              >
                INFO
              </Button>
            </div>

            {/* Mobile meta sheet */}
            <Sheet open={metaSheetOpen} onOpenChange={setMetaSheetOpen}>
              <SheetContent side="bottom" className="rounded-none xl:hidden">
                <SheetHeader>
                  <SheetTitle className="font-mono text-[10px] uppercase tracking-marker">
                    DOCUMENT INFO
                  </SheetTitle>
                  <SheetDescription className="sr-only">
                    Document metadata and actions
                  </SheetDescription>
                </SheetHeader>
                <SheetBody>
                  <BrainMetaPanel
                    doc={doc.data ?? null}
                    source={activeSource}
                    onEdit={() => {
                      setMetaSheetOpen(false);
                      handleEditToggle();
                    }}
                    onSelectBacklink={(p) => {
                      setMetaSheetOpen(false);
                      handleBacklink(p);
                    }}
                  />
                </SheetBody>
              </SheetContent>
            </Sheet>
          </>
        )}
      </div>

      {/* Star chart sheet */}
      <BrainGraphSheet open={graphOpen} onOpenChange={setGraphOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar content — shared between inline and drawer modes
// ---------------------------------------------------------------------------

function SidebarContent({
  activeSource,
  activePath,
  onSourceChange,
  onSelectPath,
  onSearchSelect,
  onTimelineSelect,
}: {
  activeSource: string;
  activePath?: string;
  onSourceChange: (source: string) => void;
  onSelectPath: (path: string) => void;
  onSearchSelect: (source: string, path: string) => void;
  onTimelineSelect: (source: string, path: string) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-3 py-4">
      {/* Search */}
      <BrainSearchBox source={activeSource} onSelect={onSearchSelect} />

      {/* Sources */}
      <div>
        <SectionMarker label="SOURCES" className="mb-2" />
        <BrainSourceTabs
          activeSource={activeSource}
          onSourceChange={onSourceChange}
        />
      </div>

      {/* Tree */}
      <div className="min-h-0 flex-1">
        <SectionMarker label="TREE" className="mb-2" />
        <BrainTree
          source={activeSource}
          activePath={activePath}
          onSelect={onSelectPath}
        />
      </div>

      {/* Timeline */}
      <div>
        <SectionMarker label="TIMELINE" className="mb-2" />
        <BrainTimeline
          source={activeSource}
          onSelect={onTimelineSelect}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Welcome state — shown when no document is selected
// ---------------------------------------------------------------------------

function WelcomeState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-12">
      <h2 className="page-stamp text-[32px]">
        select a <em>document</em>
      </h2>
      <p className="max-w-md text-center font-body text-[15px] leading-relaxed text-ink-muted">
        Browse the file tree on the left, or press Cmd+K to search across
        all sources. Cmd+G opens the star chart.
      </p>
      <div className="mt-4 flex gap-6 font-mono text-[10px] uppercase tracking-marker text-ink-faint">
        <span>CMD+K SEARCH</span>
        <span>CMD+E EDIT</span>
        <span>CMD+G GRAPH</span>
      </div>
    </div>
  );
}
