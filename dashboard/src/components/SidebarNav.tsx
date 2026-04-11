import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  num: string;
};

// patch-bay nav: numbered, mono UPPERCASE, hairline-divided.
const items: NavItem[] = [
  { to: "/", label: "Live", num: "01" },
  { to: "/brain", label: "Brain", num: "02" },
  { to: "/sessions", label: "Sessions", num: "03" },
  { to: "/approvals", label: "Approvals", num: "04" },
  { to: "/cron", label: "Cron", num: "05" },
  { to: "/tools", label: "Tools", num: "06" },
  { to: "/skills", label: "Skills", num: "07" },
  { to: "/mcp", label: "MCP", num: "08" },
  { to: "/health", label: "Health", num: "09" },
];

export function SidebarNav() {
  const location = useRouterState({ select: (s) => s.location });

  return (
    <nav className="flex w-44 shrink-0 flex-col border-r border-rule bg-bg-alt">
      <div className="border-b border-rule px-5 py-4 font-mono text-[9px] uppercase tracking-marker text-ink-faint">
        ─── ROUTES ────
      </div>
      <ul className="flex flex-col">
        {items.map((item) => {
          const active =
            item.to === "/"
              ? location.pathname === "/"
              : location.pathname.startsWith(item.to);
          return (
            <li key={item.to} className="border-b border-rule/60">
              <Link
                to={item.to}
                className={cn(
                  "flex items-baseline gap-3 px-5 py-3 font-mono text-[11px] uppercase tracking-marker transition-colors duration-120 ease-operator",
                  active
                    ? "bg-oxide-wash text-oxide"
                    : "text-ink-2 hover:bg-oxide-wash/40 hover:text-ink",
                )}
              >
                <span
                  className={cn(
                    "tabular-nums",
                    active ? "text-oxide" : "text-ink-faint",
                  )}
                >
                  {item.num}
                </span>
                <span>{item.label}</span>
                {active && <span className="ml-auto text-oxide">─</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
