import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  Activity,
  MessageSquare,
  Clock,
  Wrench,
  Sparkles,
  Network,
  HeartPulse,
  Brain,
} from "lucide-react";

type NavItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const items: NavItem[] = [
  { to: "/", label: "Live Console", icon: Activity },
  { to: "/brain", label: "Brain", icon: Brain },
  { to: "/sessions", label: "Sessions", icon: MessageSquare },
  { to: "/cron", label: "Cron", icon: Clock },
  { to: "/tools", label: "Tools", icon: Wrench },
  { to: "/skills", label: "Skills", icon: Sparkles },
  { to: "/mcp", label: "MCP", icon: Network },
  { to: "/health", label: "Health", icon: HeartPulse },
];

export function SidebarNav() {
  const location = useRouterState({ select: (s) => s.location });

  return (
    <nav className="flex w-48 shrink-0 flex-col gap-1 border-r bg-card/30 p-3">
      {items.map((item) => {
        const Icon = item.icon;
        const active =
          item.to === "/"
            ? location.pathname === "/"
            : location.pathname.startsWith(item.to);
        return (
          <Link
            key={item.to}
            to={item.to}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
