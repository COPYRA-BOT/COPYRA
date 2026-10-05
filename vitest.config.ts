import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.spec.ts', 'apps/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/generated/**'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['default'],
    pool: 'forks',
    fileParallelism: false,
  },
});
