import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
