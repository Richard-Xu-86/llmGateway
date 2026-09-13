import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@gw/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Same-origin in dev, so the WebSocket needs no CORS dance and the
      // browser sends the subprotocol through untouched.
      '/api': { target: 'http://localhost:4020', ws: true },
    },
  },
});
