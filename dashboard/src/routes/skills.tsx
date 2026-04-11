/**
 * /skills — registry, not a marketing surface (DESIGN.md §6).
 * Hairline list rows, mono labels.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const Route = createFileRoute("/skills")({
  component: SkillsPage,
});

function SkillsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "skills"],
    queryFn: api.skills,
  });

  const skills = data?.skills ?? [];

  return (
    <div className="bg-bg">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">SKILLS</div>
        <div className="flex items-center justify-center gap-7">
          <span className="flex items-baseline gap-2">
            <span>Installed</span>
            <span className="text-ink tabular-nums">{skills.length}</span>
          </span>
        </div>
        <div className="text-ink-faint">~/.HERMES/SKILLS</div>
      </div>

      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp text-[56px]">
          installed <em>skills</em>
        </h1>
        <p className="mt-3 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
          ─── A REGISTRY · NOT A MARKETING SURFACE ──
        </p>
      </div>

      <div className="px-10 pb-16">
        {isLoading && (
          <p className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
            loading skills<span className="loading-cursor ml-2" />
          </p>
        )}
        <ul className="border-t border-rule">
          {skills.map((s, idx) => (
            <li
              key={s.name}
              className="grid grid-cols-[40px_220px_1fr] items-baseline gap-6 border-b border-rule px-1 py-3 transition-colors duration-120 ease-operator hover:bg-oxide-wash"
            >
              <span className="font-mono text-[10px] tabular-nums text-ink-faint">
                {String(idx + 1).padStart(3, "0")}
              </span>
              <span className="font-mono text-[12px] uppercase tracking-marker text-ink">
                {s.name}
              </span>
              <span className="truncate text-[13px] text-ink-2">
                {s.preview || s.path.replace(/^.*\/skills\//, "")}
              </span>
            </li>
          ))}
        </ul>
        {skills.length === 0 && !isLoading && (
          <p className="font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            no skills installed
          </p>
        )}
      </div>
    </div>
  );
}
