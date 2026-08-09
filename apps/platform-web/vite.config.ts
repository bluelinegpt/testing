import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
