import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "node:path";

// Dashboard is served from /dashboard/ by the Hermes gateway (aiohttp).
// In production, the built bundle lives at gateway/platforms/api_server_static/
// and is served by app.router.add_static("/dashboard/", ...).
//
// In dev, Vite runs on :5173 and proxies /api/* to the gateway on :8642.

const GATEWAY_URL = process.env.VITE_GATEWAY_URL || "http://127.0.0.1:8642";

export default defineConfig({
  base: "/dashboard/",
  plugins: [
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      autoCodeSplitting: true,
    }),
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: GATEWAY_URL,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          router: ["@tanstack/react-router", "@tanstack/react-query"],
          ui: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-tabs",
            "@radix-ui/react-tooltip",
          ],
          // Brain-viz graph library lives in its own chunk so it doesn't
          // bloat the main bundle for users on other routes (lazy-loaded
          // alongside the /brain route via TanStack Router code-splitting).
          graph: ["react-force-graph-2d"],
        },
      },
    },
  },
});
