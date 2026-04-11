/**
 * /mcp — server status grid (DESIGN.md §6: name · transport · status dot
 * · tool count · last error). Dense, hairline.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export const Route = createFileRoute("/mcp")({
  component: MCPPage,
});

function MCPPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard", "mcp"],
    queryFn: api.mcp,
  });

  const servers = data?.servers ?? [];
  const enabled = servers.filter((s) => s.enabled).length;

  return (
    <div className="bg-bg">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-6 border-b border-rule bg-bg-alt px-10 py-4 font-mono text-[10px] uppercase tracking-marker text-ink-muted">
        <div className="text-ink">MCP</div>
        <div className="flex items-center justify-center gap-7">
          <span className="flex items-baseline gap-2">
            <span>Servers</span>
            <span className="text-ink tabular-nums">{servers.length}</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span>Enabled</span>
            <span className="text-success tabular-nums">{enabled}</span>
          </span>
        </div>
        <div className="text-ink-faint">CONFIG.YAML</div>
      </div>

      <div className="px-10 pb-6 pt-9">
        <h1 className="page-stamp text-[56px]">
          mcp <em>servers</em>
        </h1>
      </div>

      <div className="px-10 pb-16">
        {isLoading && (
          <p className="font-mono text-[11px] uppercase tracking-marker text-ink-muted">
            loading mcp config<span className="loading-cursor ml-2" />
          </p>
        )}
        <table className="w-full border-collapse font-mono text-[12px] tabular-nums text-ink">
          <thead>
            <tr>
              <Th>NAME</Th>
              <Th>STATE</Th>
              <Th>COMMAND</Th>
              <Th>ENV</Th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr
                key={s.name}
                className="border-b border-rule transition-colors duration-120 ease-operator hover:bg-oxide-wash"
              >
                <td className="px-4 py-3 text-ink">
                  <span className="flex items-baseline gap-2">
                    <span
                      className={`inline-block size-1.5 rounded-full ${s.enabled ? "bg-success" : "bg-ink-faint"}`}
                    />
                    {s.name}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={
                      s.enabled
                        ? "text-success uppercase tracking-marker"
                        : "text-ink-faint uppercase tracking-marker"
                    }
                  >
                    {s.enabled ? "enabled" : "disabled"}
                  </span>
                </td>
                <td className="px-4 py-3 text-ink-2">{s.command || "—"}</td>
                <td className="px-4 py-3 text-ink-faint">
                  {s.env_keys.length > 0 ? s.env_keys.join(", ") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {servers.length === 0 && !isLoading && (
          <p className="mt-6 font-mono text-[11px] uppercase tracking-marker text-ink-faint">
            no mcp servers configured
          </p>
        )}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-rule px-4 py-3.5 text-left text-[10px] font-medium uppercase tracking-marker text-ink-muted">
      {children}
    </th>
  );
}
