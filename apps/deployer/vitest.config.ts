import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // integration/ runs on Linux only, with node --test, against the real deployment scripts.
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
