import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // Serves the API under the web origin in development. Without this the web
    // (127.0.0.1:5174) and the API (localhost:3000) are cross-site, so the
    // browser withholds the SameSite=Lax session cookie and every reload signs
    // the user out — the exact defect this work removes. Set
    // VITE_API_BASE_URL=/api/v1 to use it.
    proxy: {
      "/api": {
        changeOrigin: false,
        target: "http://localhost:3000",
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
