import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Performance run on a large generated shop (npm run perf). Not part of the normal test run. */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
    },
  },
  test: {
    include: ['tests/perf/**/*.perf.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 60 * 60_000,
    hookTimeout: 60 * 60_000,
  },
});
