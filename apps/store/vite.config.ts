import { execSync } from "node:child_process";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The short commit SHA of the last commit that actually touched THIS app's
// own folder -- not repo-wide HEAD, which in a monorepo is the same value
// for every app regardless of which app's code actually changed. Used by
// VersionBadge and by error-reporting-client.ts's crash reports (so a crash
// can be tied to an exact build). Must stay computed the same way as
// Documentation/deployment-registry.json's own per-app commit (see
// scripts/deployment-registry.mjs). Falls back to "dev" outside a git
// checkout rather than failing the build over a cosmetic label.
function commitSha(): string {
  try {
    return execSync("git log -1 --format=%h -- .", { cwd: __dirname }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(commitSha()),
  },
  plugins: [react()],
  server: {
    // 5175: the Delivery Portal owns 5174 and the API owns 3000. 5173 and 8787
    // belong to other applications on this machine and must not be used.
    port: 5175,
    // Serves the API under the Store origin in development, exactly as the
    // Delivery Portal does. The Store is anonymous today, but customer sessions
    // are coming, and an absolute cross-site API origin is precisely what made
    // the browser withhold a SameSite=Lax cookie last time. Same-origin from
    // the start means that problem never has to be solved twice.
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
    // `tsconfig.server-test.json` compiles `server/**/*.test.ts` into
    // `dist-server-test/` purely so `tsc -b` can typecheck it (§73's
    // production-server tests use Node's `http`/dynamic `import()`, outside
    // `tsconfig.app.json`'s browser-only project). Vitest's own default
    // include glob matches compiled `.js` test files too, so without this
    // exclude every server test would run TWICE -- once from source, once
    // from the stale compiled copy, racing on the same ports.
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-server/**", "**/dist-server-test/**"],
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Same rationale as the Delivery Portal: one jsdom+React worker per CPU
    // oversubscribes memory on this machine and produces failures that move
    // between tests run to run.
    pool: "forks",
    maxWorkers: 4,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
