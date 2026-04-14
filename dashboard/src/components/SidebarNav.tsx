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
  { to: "/desk", label: "Desk", num: "02" },
  { to: "/brain", label: "Brain", num: "03" },
  { to: "/approvals", label: "Approvals", num: "04" },
  { to: "/cron", label: "Schedule", num: "05" },
  { to: "/skills", label: "Skills", num: "06" },
  { to: "/mcp", label: "MCP", num: "07" },
  { to: "/keys", label: "Keys", num: "08" },
  { to: "/health", label: "Health", num: "09" },
  { to: "/config", label: "Config", num: "10" },
];

interface SidebarNavProps {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

function isActive(pathname: string, to: string): boolean {
  return to === "/" ? pathname === "/" : pathname.startsWith(to);
}

export function SidebarNav({ collapsed, onToggle, mobileOpen, onMobileClose }: SidebarNavProps) {
  const location = useRouterState({ select: (s) => s.location });

  // Mobile overlay mode: full-width sidebar over a dark backdrop.
  // Rendered below md breakpoint only (hidden on desktop via CSS).
  if (mobileOpen) {
    return (
      <>
        {/* Backdrop */}
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onMobileClose}
          aria-hidden
        />
        {/* Overlay sidebar */}
        <nav className="fixed inset-y-0 left-0 z-50 flex w-full max-w-xs flex-col border-r border-rule bg-bg-alt md:hidden">
          <div className="flex items-center justify-between border-b border-rule px-5 py-4 font-mono text-[9px] uppercase tracking-marker text-ink-faint">
            <span>─── ROUTES ────</span>
            <button
              type="button"
              onClick={onMobileClose}
              aria-label="Close menu"
              className="font-mono text-[18px] leading-none text-ink-faint transition-colors duration-120 ease-operator hover:text-oxide"
            >
              ×
            </button>
          </div>
          <ul className="flex flex-col">
            {items.map((item) => {
              const active = isActive(location.pathname, item.to);
              return (
                <li key={item.to} className="border-b border-rule/60">
                  <Link
                    to={item.to}
                    onClick={onMobileClose}
                    className={cn(
                      "flex items-baseline gap-3 px-5 py-4 font-mono text-[12px] uppercase tracking-marker transition-colors duration-120 ease-operator",
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
      </>
    );
  }

  // Desktop sidebar — hidden below md breakpoint (mobile uses overlay above).
  // Collapsed mode: a 16px rail. No icons (DESIGN.md §9 anti-slop
  // forbids icon-only sidebars). Active route indicated by a 2px
  // oxide vertical bar aligned with the row that would hold it in
  // the expanded layout. The entire rail is a button that re-expands
  // the sidebar; hairline rows between items preserve the patch-bay
  // rhythm so the active bar lands where the user expects.
  if (collapsed) {
    return (
      <nav
        role="button"
        tabIndex={0}
        aria-label="Expand sidebar (⌘\\)"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="group hidden w-4 shrink-0 cursor-e-resize flex-col border-r border-rule bg-bg-alt transition-colors duration-120 ease-operator hover:bg-surface md:flex"
        title="Expand sidebar (⌘\\)"
      >
        {/* Header row spacer — matches the expanded ──ROUTES── row */}
        <div className="h-[41px] shrink-0 border-b border-rule" />
        <ul className="flex flex-col">
          {items.map((item) => {
            const active = isActive(location.pathname, item.to);
            return (
              <li
                key={item.to}
                className="relative h-[38px] border-b border-rule/60"
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-0.5 bg-oxide"
                  />
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  // Expanded mode: full patch-bay nav. Toggle button lives in the
  // header row (top-right) — matches the approach in VS Code,
  // Linear, etc. where the collapse control stays inside the
  // sidebar container rather than the page chrome.
  return (
    <nav className="hidden w-44 shrink-0 flex-col border-r border-rule bg-bg-alt md:flex">
      <div className="flex items-center justify-between border-b border-rule px-5 py-4 font-mono text-[9px] uppercase tracking-marker text-ink-faint">
        <span>─── ROUTES ────</span>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse sidebar (⌘\\)"
          title="Collapse sidebar (⌘\\)"
          className="font-mono text-[11px] leading-none text-ink-faint transition-colors duration-120 ease-operator hover:text-oxide"
        >
          ‹
        </button>
      </div>
      <ul className="flex flex-col">
        {items.map((item) => {
          const active = isActive(location.pathname, item.to);
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
