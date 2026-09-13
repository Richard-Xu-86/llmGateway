import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@gw/shared/keys': fileURLToPath(new URL('./packages/shared/src/keys.ts', import.meta.url)),
      '@gw/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
