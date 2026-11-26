import { defineConfig } from 'vitest/config';

/** The browser tests (decision 0058): a real browser against the production bundle. Not part of `pnpm test`. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.browser.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
