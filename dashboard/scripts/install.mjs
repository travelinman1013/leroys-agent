#!/usr/bin/env node
/**
 * install.mjs — copy dashboard/dist/ → ../gateway/platforms/api_server_static/
 *
 * Runs as a post-build step so the Hermes gateway can serve the static
 * bundle at /dashboard/. Kept in JS (not shell) so it works on any OS
 * without bash/rsync.
 */

import { cp, rm, mkdir, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "../dist");
const DEST = resolve(__dirname, "../../gateway/platforms/api_server_static");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(DIST))) {
    console.error(`[install] dist/ does not exist — run \`npm run build\` first.`);
    process.exit(1);
  }

  if (await exists(DEST)) {
    await rm(DEST, { recursive: true, force: true });
  }
  await mkdir(DEST, { recursive: true });
  await cp(DIST, DEST, { recursive: true });
  console.log(`[install] ✓ copied ${DIST} → ${DEST}`);
}

main().catch((err) => {
  console.error("[install] failed:", err);
  process.exit(1);
});
