# Hermes Dashboard

Local-first orchestration & monitoring UI for the Hermes Agent gateway.

## Stack

- **React 19** + **TypeScript** strict mode
- **Vite** (SWC plugin) for dev + build
- **TanStack Router** (file-based) and **TanStack Query** (server state)
- **shadcn/ui** primitives (Radix under the hood) + **Tailwind CSS v3**
- **lucide-react** icons

## Architecture

The dashboard is a pure static SPA. `npm run build` produces `dist/`, which
is then copied by `scripts/install.mjs` into
`gateway/platforms/api_server_static/`. The Hermes gateway's aiohttp server
mounts that directory at `/dashboard/` via
`register_dashboard_routes(app, adapter, static_dir=...)`.

The UI talks to the gateway over:

- `GET /api/dashboard/*` — typed JSON endpoints
- `GET /api/dashboard/events` — SSE multiplexer on the in-process EventBus

Auth is a bearer token bootstrapped via
`GET /api/dashboard/handshake` (localhost-only) and cached in
`sessionStorage`.

## Scripts

```bash
# One-time install
npm install

# Development — Vite at :5173, proxies /api to 127.0.0.1:8642
npm run dev

# Production build
npm run build

# Copy built bundle into the gateway static dir
npm run install-bundle

# Type check only
npm run typecheck
```

The repo root also exposes make targets (via `scripts/dashboard.sh` if you
prefer shell):

```bash
make dashboard-build   # install deps, build, copy to api_server_static/
make dashboard-dev     # start Vite dev server
```

After `make dashboard-build`, restart the gateway to pick up the new bundle:

```bash
launchctl kickstart -k gui/$(id -u)/ai.hermes.gateway
```

Then visit http://127.0.0.1:8642/dashboard/

## Sandbox compliance

The dashboard runs entirely inside the existing Hermes gateway process,
which is sandboxed under `scripts/sandbox/hermes.sb`. No new ports, no
new network rules, no new filesystem access — everything the dashboard
reads (sessions, events, config, skills) was already accessible to the
gateway.

## Routes

| Route | Description |
|---|---|
| `/` | Live Console — realtime event stream + approval queue + session sidebar |
| `/sessions` | Paginated session list with token cost + preview |
| `/sessions/$id` | Session detail — full transcript, tool calls, metadata |
| `/cron` | Cron job CRUD — run/pause/resume/delete |
| `/tools` | Tool registry grouped by toolset |
| `/skills` | Skills inventory with previews |
| `/mcp` | MCP server configuration and status |
| `/health` | Doctor checks + redacted runtime config dump |
