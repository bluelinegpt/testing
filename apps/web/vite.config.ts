import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The short commit SHA of HEAD, baked in at build time so a screen can show
// it (see VersionBadge) -- the one reliable way to tell "am I looking at
// local or the Render deploy, and which commit is it actually running"
// without trusting a deploy dashboard that can lag the real build.
//
// Deliberately plain `git rev-parse`, not `git log -- .` scoped to this
// app's folder: the scoped form depends on full git history being available
// to walk backward through, which breaks under a shallow clone (Render's
// build environment) -- it silently falls back to reporting raw HEAD there
// regardless of the path filter, while a full local checkout correctly
// narrows to this app's own last-touching commit. That mismatch is exactly
// what made local and Render disagree. Plain HEAD has no history dependency,
// so it reports the same value everywhere, unconditionally -- the trade-off
// is every app's badge changes on every commit, even ones that never
// touched this app's folder. Must stay identical to how
// Documentation/deployment-registry.json's own commit is computed (see
// scripts/deployment-registry.mjs's currentCommitInfo), or the badge and the
// Deployment Registry screen disagree on what "this app's version" means.
//
// Falls back to "dev" outside a git checkout (e.g. a stripped Docker build
// context) rather than failing the build over a cosmetic label.
function commitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: __dirname }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}

// Documentation/deployment-registry.json lives at the repo root (one catalog
// shared by every app), not inside apps/web -- read and inline it the same
// way as the commit SHA rather than importing across the package boundary,
// which Vite's default fs allow-list would otherwise reject. Falls back to an
// empty catalog rather than failing the build if the file is ever missing.
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
    port: 5177,
    // Serves the API under the web origin in development. Without this the web
    // (127.0.0.1:5177) and the API (localhost:3000) are cross-site, so the
    // browser withholds the SameSite=Lax session cookie and every reload signs
    // the user out — the exact defect this work removes. Set
    // VITE_API_BASE_URL=/api/v1 to use it.
    proxy: {
      "/api": {
        changeOrigin: false,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest, request) => {
            // Mirror serve.mjs/Render: the API origin needs its own Host for
            // routing, while tenant selection uses the original Company Portal
            // host. This is a hostname, not a browser-supplied Company ID, and
            // it only scopes credential verification; it grants no access.
            proxyRequest.setHeader("x-blueline-tenant-host", request.headers.host ?? "");
          });
        },
        target: "http://127.0.0.1:3000",
        ws: true,
      },
    },
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // The default forks pool spawns one worker per CPU (8 here). Each jsdom +
    // React worker needs several hundred MB, which oversubscribes memory on a
    // machine with limited free RAM: workers then swap and either fail to start
    // ("Timeout waiting for worker to respond") or starve mid-test and exceed
    // the 5s test timeout. Whichever async test happens to be running in a
    // starved fork fails, so the failing test varies run to run. Capping the
    // fork count keeps total memory in check, and the raised timeouts absorb
    // transient scheduling jitter without weakening any assertion.
    pool: "forks",
    maxWorkers: 4,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
