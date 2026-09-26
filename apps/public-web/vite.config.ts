import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function getAppVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'local';
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      // Substitutes the API base into index.html's preconnect hints. Done
      // here (not Vite's %ENV% html replacement) because VITE_API_BASE_URL
      // lives in the service environment / repo-root .env, outside this
      // app's envDir, so the built-in replacement never sees it. Falls back
      // to the same '/api/v1' default as src/api-base.ts, which makes the
      // preconnect a harmless same-origin no-op in local builds.
      name: 'tawseelhub-preconnect-api-origin',
      transformIndexHtml(html: string) {
        return html.replaceAll('%VITE_API_BASE_URL%', process.env.VITE_API_BASE_URL ?? '/api/v1');
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(getAppVersion()),
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true } },
  },
});
