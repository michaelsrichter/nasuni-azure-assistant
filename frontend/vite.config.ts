import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The evaluation service (eval/service/app.py) handles /api/eval/*.
      // Listed first so it wins over the broader /api rule below.
      '/api/eval': {
        target: 'http://localhost:8099',
        changeOrigin: true,
      },
      '/api': {
        // Proxy SPA /api calls to the local token-proxy sidecar (port 8090),
        // which forwards to the locally-run hosted agent on :8088.
        target: 'http://localhost:8090',
        changeOrigin: true
      }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false
  }
});
