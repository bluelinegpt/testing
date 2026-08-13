import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The short commit SHA of the last commit that actually touched THIS app's
// own folder -- not repo-wide HEAD. This is a monorepo: HEAD is the same
// value for every app regardless of which app's code actually changed, which
// would make this badge disagree with the Deployment Registry screen's own
// per-app commit (Documentation/deployment-registry.json, kept by
// scripts/deployment-registry.mjs). The two must stay computed the same way.
function commitSha(): string {
  try {
    return execSync("git log -1 --format=%h -- .", { cwd: __dirname }).toString().trim() || "dev";
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
