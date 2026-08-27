import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The short commit SHA of HEAD -- deliberately plain `git rev-parse`, not
// `git log -- .` scoped to this app's own folder. The scoped form needs full
// git history to walk backward through a path filter, which breaks under a
// shallow clone (Render's build environment): it silently falls back to
// reporting raw HEAD there regardless of the path filter, while a full local
// checkout correctly narrows to this app's own last-touching commit -- that
// mismatch is exactly what made local and Render disagree. Plain HEAD has no
// history dependency, so it reports the same value everywhere,
// unconditionally. Must stay computed the same way as
// Documentation/deployment-registry.json's own per-app commit
// (scripts/deployment-registry.mjs), or the badge and the Deployment
// Registry screen disagree on what "this app's version" means.
function commitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: __dirname }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}

// Documentation/deployment-registry.json lives at the repo root (one catalog
// shared by every app, kept current by .githooks/post-commit and
// .githooks/pre-push via scripts/deployment-registry.mjs), not inside
// apps/platform-web -- read and inline it the same way as the commit SHA
// rather than importing across the package boundary, which Vite's default fs
// allow-list would otherwise reject. Falls back to an empty catalog rather
// than failing the build if the file is ever missing.
function deploymentRegistry(): unknown {
  try {
    const path = resolve(__dirname, "../../Documentation/deployment-registry.json");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { apps: [] };
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(commitSha()),
    __DEPLOYMENT_REGISTRY__: JSON.stringify(deploymentRegistry()),
  },
  plugins: [react()],
  server: {
    // 5176: the Delivery Portal owns 5174 and the Store owns 5175; the API owns
    // 3000. 5173 and 8787 belong to other applications on this machine and must
    // not be used.
    port: 5176,
    // Serves the API under the Platform origin in development, exactly as the
    // Delivery Portal and the Store do. This is not a convenience: the Platform
    // session is an HttpOnly `SameSite=Lax` cookie, and an absolute
    // cross-site API origin would make the browser withhold it on every
    // navigation — the Portal would appear to sign the administrator out on
    // each reload.
    proxy: {
      "/api": {
        changeOrigin: false,
        target: "http://localhost:3000",
      },
    },
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Same rationale as the Delivery Portal and the Store: one jsdom+React
    // worker per CPU oversubscribes memory on this machine and produces
    // failures that move between tests run to run.
    pool: "forks",
    maxWorkers: 4,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
