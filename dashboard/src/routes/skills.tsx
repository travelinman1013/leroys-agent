/**
 * /skills — registry, not a marketing surface (DESIGN.md §6).
 * Categorized accordion with search + filter pills.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useState, useMemo } from "react";

export const Route = createFileRoute("/skills")({
  component: SkillsPage,
});

type SkillEntry = {
  name: string;
  description: string;
  tags: string[];
  enabled: boolean;
};

type SkillCategory = {
  name: string;
  description: string | null;
  skills: SkillEntry[];
  skill_count: number;
  enabled_count: number;
};

function SkillsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "skills"],
    queryFn: api.skills,
  });

  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const categories = data?.categories ?? [];
  const totalSkills = data?.total_skills ?? 0;
  const totalEnabled = data?.total_enabled ?? 0;

  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      api.skillToggle(name, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard", "skills"] });
    },
  });

  // Client-side search filter
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q && !activeCategory) return categories;

    return categories
      .filter((cat) => !activeCategory || cat.name === activeCategory)
      .map((cat) => {
        if (!q) return cat;
        const skills = cat.skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q) ||
            s.tags.some((t) => t.toLowerCase().includes(q)),
        );
        if (skills.length === 0) return null;
        return {
          ...cat,
          skills,
          skill_count: skills.length,
          enabled_count: skills.filter((s) => s.enabled).length,
        };
      })
      .filter(Boolean) as SkillCategory[];
  }, [categories, search, activeCategory]);

  const toggleExpand = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="bg-bg">
      {/* Meters strip */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">SKILLS</div>
        <div className="flex items-center justify-center gap-7">
          <span className="flex items-baseline gap-2">
            <span>Installed</span>
            <span className="text-ink tabular-nums">{totalSkills}</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span>Enabled</span>
            <span className="text-ink tabular-nums">{totalEnabled}</span>
          </span>
        </div>
        <div className="text-ink-faint">~/.HERMES/SKILLS</div>
      </div>

      {/* Page stamp */}
      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp text-[56px]">
          installed <em>skills</em>
        </h1>
        <p className="mt-3 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          ─── A REGISTRY · NOT A MARKETING SURFACE ──
        </p>
      </div>

      {/* Search */}
      <div className="px-10 pb-4">
        <input
          type="text"
          placeholder="Search skills and toolsets..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full border border-rule bg-bg-alt px-4 py-2.5 font-mono text-[13px] text-ink placeholder:text-ink-faint focus:border-oxide focus:outline-none"
        />
      </div>

      {/* Category filter pills */}
      <div className="flex gap-2 overflow-x-auto px-10 pb-6">
        <button
          onClick={() => setActiveCategory(null)}
          className={`shrink-0 border px-3 py-1 font-mono text-[10px] uppercase tracking-marker transition-colors duration-120 ease-operator ${
            activeCategory === null
              ? "border-oxide bg-oxide-wash text-oxide"
              : "border-rule text-ink-muted hover:text-ink"
          }`}
        >
          All ({totalSkills})
        </button>
        {categories.map((cat) => (
          <button
            key={cat.name}
            onClick={() =>
              setActiveCategory(activeCategory === cat.name ? null : cat.name)
            }
            className={`shrink-0 border px-3 py-1 font-mono text-[10px] uppercase tracking-marker transition-colors duration-120 ease-operator ${
              activeCategory === cat.name
                ? "border-oxide bg-oxide-wash text-oxide"
                : "border-rule text-ink-muted hover:text-ink"
            }`}
          >
            {cat.name} {cat.skill_count}
          </button>
        ))}
      </div>

      {/* Category accordion */}
      <div className="px-10 pb-16">
        {isLoading && (
          <p className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
            loading skills<span className="loading-cursor ml-2" />
          </p>
        )}

        {!isLoading && filtered.length === 0 && (
          <p className="py-8 text-center font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            no skills match
          </p>
        )}

        <div className="border-t border-rule">
          {filtered.map((cat) => {
            const isExpanded = expanded.has(cat.name);
            return (
              <div key={cat.name} className="border-b border-rule">
                {/* Category header */}
                <button
                  onClick={() => toggleExpand(cat.name)}
                  className="group flex w-full items-center gap-4 px-1 py-4 text-left transition-colors duration-120 ease-operator hover:bg-oxide-wash"
                >
                  <span
                    className="inline-block font-mono text-[14px] text-ink-muted transition-transform duration-180 ease-operator"
                    style={{
                      transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                    }}
                  >
                    ›
                  </span>
                  <span className="font-mono text-[13px] uppercase tracking-marker text-ink">
                    {cat.name}
                  </span>
                  <span className="border border-rule px-2 py-0.5 font-mono text-[9px] uppercase tracking-marker text-ink-muted">
                    {cat.skill_count} skill{cat.skill_count !== 1 ? "s" : ""}
                  </span>
                  <span className="ml-auto border border-oxide/30 bg-oxide-wash px-2 py-0.5 font-mono text-[9px] uppercase tracking-marker text-oxide">
                    {cat.enabled_count}/{cat.skill_count} enabled
                  </span>
                </button>

                {/* Collapsed preview */}
                {!isExpanded && (
                  <div className="pb-3 pl-8 text-[12px] text-ink-2">
                    {cat.skills.map((s) => s.name).join(", ")}
                  </div>
                )}

                {/* Expanded skill rows */}
                {isExpanded && (
                  <div className="pb-2 pl-8">
                    {cat.skills.map((skill) => (
                      <div
                        key={skill.name}
                        className="flex items-start gap-4 border-t border-rule/50 px-1 py-3 transition-colors duration-120 ease-operator hover:bg-oxide-wash"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-3">
                            <span className="font-mono text-[12px] uppercase tracking-marker text-ink">
                              {skill.name}
                            </span>
                            {skill.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {skill.tags.slice(0, 4).map((tag) => (
                                  <span
                                    key={tag}
                                    className="border border-rule px-1.5 py-0 font-mono text-[9px] text-ink-faint"
                                  >
                                    {tag}
                                  </span>
                                ))}
                                {skill.tags.length > 4 && (
                                  <span className="font-mono text-[9px] text-ink-faint">
                                    +{skill.tags.length - 4}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          {skill.description && (
                            <p className="mt-1 truncate text-[12px] text-ink-2">
                              {skill.description}
                            </p>
                          )}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle.mutate({
                              name: skill.name,
                              enabled: !skill.enabled,
                            });
                          }}
                          className="group/tog flex shrink-0 items-center gap-0 border border-rule transition-colors duration-120 ease-operator hover:border-ink-faint"
                        >
                          <span
                            className={`flex h-6 w-7 items-center justify-center transition-colors duration-120 ease-operator ${
                              skill.enabled
                                ? "bg-oxide-wash"
                                : "bg-transparent"
                            }`}
                          >
                            <span
                              className={`block h-2.5 w-2.5 transition-colors duration-120 ease-operator ${
                                skill.enabled
                                  ? "bg-oxide"
                                  : "bg-transparent"
                              }`}
                            />
                          </span>
                          <span
                            className={`flex h-6 w-7 items-center justify-center transition-colors duration-120 ease-operator ${
                              !skill.enabled
                                ? "bg-rule/50"
                                : "bg-transparent"
                            }`}
                          >
                            <span
                              className={`block h-2.5 w-2.5 transition-colors duration-120 ease-operator ${
                                !skill.enabled
                                  ? "bg-ink-faint"
                                  : "bg-transparent"
                              }`}
                            />
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
